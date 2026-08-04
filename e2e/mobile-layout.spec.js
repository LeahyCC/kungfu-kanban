// Real-browser layout check for the phone fixes in public/style.css. Boots
// the actual server.js (never this checkout's data/) and drives Chromium
// under touch emulation at a handful of real phone widths — a resized
// desktop browser still reports (hover: hover)/(pointer: fine), so it can't
// see the (hover: none) rules the fixes depend on, and it can't measure
// computed layout the way a text-based CSS assertion would.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

function mkTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-layout-'));
}

function seedTasks(dataDir) {
  const now = new Date().toISOString();
  const statuses = ['backlog', 'queued', 'running', 'review', 'done'];
  const tasks = statuses.map((status, i) => ({
    id: `seed-${status}-${i}`,
    title: `${status} card ${i}`,
    prompt: 'seed card for layout test',
    cwd: ROOT,
    model: 'default',
    effort: 'default',
    permissionMode: 'acceptEdits',
    skills: [],
    skillsAuto: false,
    agent: null,
    worktree: false,
    openPr: false,
    prBaseBranch: null,
    priority: 0,
    acceptanceCriteria: '',
    group: null,
    deps: [],
    schedule: null,
    issueNumber: null,
    status,
    createdAt: now,
    createdBy: 'test',
    retries: 0,
    sessionId: null,
    error: null,
    resultText: null,
    stats: null,
  }));
  fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(tasks, null, 2));
}

function tryBoot(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 30000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', KFK_TEST: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let settled = false;
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (/EADDRINUSE/.test(stderr)) return resolve({ ok: false, detail: 'port already in use' });
      reject(new Error(`test server exited before it came up (code ${code}, signal ${signal}):\n${stderr.slice(-1000)}`));
    });
    const deadline = Date.now() + 15_000;
    (async function poll() {
      while (!settled && Date.now() < deadline) {
        try {
          await fetch(`${base}/api/config`);
          settled = true;
          return resolve({ ok: true, child, base });
        } catch {
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, detail: `server never answered ${base} within 15s` });
      }
    })();
  });
}

async function bootServer(env = {}) {
  let lastDetail = 'unknown';
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await tryBoot(env);
    if (result.ok) return result;
    lastDetail = result.detail;
  }
  throw new Error(`could not boot test server after 5 attempts — last failure: ${lastDetail}`);
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

const WIDTHS = [360, 390, 393, 412, 430];
const HEIGHT = 844;
const MIN_HIT = 44;

async function settleAnimations(page) {
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      el.getAnimations().forEach((a) => a.finish());
    });
  });
}

async function assertInViewport(page, selector, label) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${label} (${selector}) has no bounding box — is it visible?`);
  const vw = await page.evaluate(() => window.innerWidth);
  const vh = await page.evaluate(() => window.innerHeight);
  assert.ok(box.x >= -0.5, `${label} left edge (${box.x}) is off-screen`);
  assert.ok(box.y >= -0.5, `${label} top edge (${box.y}) is off-screen`);
  assert.ok(box.x + box.width <= vw + 0.5, `${label} right edge (${box.x + box.width}) exceeds viewport width ${vw}`);
  assert.ok(box.y + box.height <= vh + 0.5, `${label} bottom edge (${box.y + box.height}) exceeds viewport height ${vh}`);
}

describe('mobile layout (real browser, touch emulation)', () => {
  let child, base, dataDir, browser;

  before(async () => {
    dataDir = mkTempDataDir();
    seedTasks(dataDir);
    ({ child, base } = await bootServer({ KFK_DATA_DIR: dataDir }));
    browser = await chromium.launch();
  });

  after(async () => {
    await browser.close();
    await killChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  for (const width of WIDTHS) {
    test(`no horizontal viewport overflow at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(base);
        await page.waitForSelector('#board .column, #board .column.skel');
        const [innerWidth, clientWidth] = await page.evaluate(() => [
          window.innerWidth,
          document.documentElement.clientWidth,
        ]);
        assert.equal(innerWidth, clientWidth, `layout viewport (${clientWidth}px) drifted from the visual viewport (${innerWidth}px) at ${width}px wide — something is overflowing horizontally`);
      } finally {
        await context.close();
      }
    });

    test(`drawer, composer, settings and terminal stay on-screen at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(base);
        await page.waitForSelector('.card, .column');

        // Card drawer
        await page.locator('.card').first().click();
        await page.waitForSelector('#drawer:not(.hidden)');
        await settleAnimations(page);
        await assertInViewport(page, '#drawer', 'card drawer');
        await assertInViewport(page, '#drawerClose', 'drawer close button');
        await page.click('#drawerClose');
        await page.locator('#drawer').waitFor({ state: 'hidden' });

        // Composer modal (+ New cards)
        await page.click('#newCardsBtn');
        await page.waitForSelector('#composerBackdrop:not(.hidden)');
        await settleAnimations(page);
        await assertInViewport(page, '#composerBackdrop .modal', 'composer modal');
        await assertInViewport(page, '#cmpCancel', 'composer cancel button');
        await page.click('#cmpCancel');
        await page.locator('#composerBackdrop').waitFor({ state: 'hidden' });

        // Settings modal
        await page.click('#settingsBtn');
        await page.waitForSelector('#settingsBackdrop:not(.hidden)');
        await settleAnimations(page);
        await assertInViewport(page, '#settingsBackdrop .modal', 'settings modal');
        await assertInViewport(page, '#settingsCancelBtn', 'settings cancel button');
        await page.click('#settingsCancelBtn');
        await page.locator('#settingsBackdrop').waitFor({ state: 'hidden' });

        // Terminal panel
        await page.click('#termToggle');
        await page.waitForSelector('#termPanel:not(.hidden)');
        await settleAnimations(page);
        await assertInViewport(page, '#termPanel', 'terminal panel');
        await assertInViewport(page, '#termClose', 'terminal close button');
      } finally {
        await context.close();
      }
    });

    test(`header fits with every alert chip visible at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(base);
        await page.waitForSelector('.app-header');
        await page.evaluate(() => {
          ['attnChip', 'errChip', 'cooldownChip', 'netChip', 'cliAuthChip', 'sseChip'].forEach((id) => {
            document.getElementById(id).classList.remove('hidden');
          });
        });
        const [innerWidth, clientWidth] = await page.evaluate(() => [
          window.innerWidth,
          document.documentElement.clientWidth,
        ]);
        assert.equal(innerWidth, clientWidth, `header with every chip visible widened the layout viewport at ${width}px wide`);
      } finally {
        await context.close();
      }
    });

    test(`buttons, links and text inputs meet the 44x44 CSS px touch target at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(base);
        await page.waitForSelector('#board .column');
        const failures = await page.evaluate((MIN) => {
          const bad = [];
          const els = document.querySelectorAll('button, a, input:not([type=checkbox]):not([type=radio])');
          for (const el of els) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue; // not rendered
            // include ::after overlays some controls use to grow their hit strip
            const after = getComputedStyle(el, '::after');
            let w = rect.width, h = rect.height;
            if (after && after.content && after.content !== 'none') {
              const aw = parseFloat(after.width) || 0;
              const ah = parseFloat(after.height) || 0;
              w = Math.max(w, aw);
              h = Math.max(h, ah);
            }
            if (w < MIN || h < MIN) {
              bad.push(`${el.tagName}#${el.id || '(no id)'}.${[...el.classList].join('.')} = ${w.toFixed(1)}x${h.toFixed(1)}`);
            }
          }
          return bad;
        }, MIN_HIT);
        assert.deepEqual(failures, [], `elements under the ${MIN_HIT}x${MIN_HIT}px touch target at ${width}px:\n${failures.join('\n')}`);
      } finally {
        await context.close();
      }
    });

    test(`inputs, textareas and selects compute to 16px font-size at ${width}px`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: HEIGHT },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await page.goto(base);
        await page.waitForSelector('#board .column');
        // Open the composer + settings so their fields are in the DOM and visible too.
        await page.click('#newCardsBtn');
        await page.waitForSelector('#composerBackdrop:not(.hidden)');
        const failures = await page.evaluate(() => {
          const bad = [];
          const els = document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select');
          for (const el of els) {
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const size = parseFloat(style.fontSize);
            if (size < 16) bad.push(`${el.tagName}#${el.id || '(no id)'} = ${size}px`);
          }
          return bad;
        });
        assert.deepEqual(failures, [], `fields under 16px font-size (triggers iOS zoom-on-focus) at ${width}px:\n${failures.join('\n')}`);
      } finally {
        await context.close();
      }
    });
  }
});
