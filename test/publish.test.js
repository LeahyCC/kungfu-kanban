// Publishing a card's files as contracts. Everything that touches a worktree
// uses a REAL git repository and a real `git worktree` (locked, the way
// `claude --worktree` leaves them), because a stubbed git cannot show whether a
// path really resolves inside the checkout.
const DATA_DIR = require('./helpers/temp-data-dir');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const publish = require('../lib/publish');
const contracts = require('../lib/contracts');
const errlog = require('../lib/errlog');
const store = require('../lib/store');
const { finalize, buildPrompt } = require('../lib/runner');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-publish-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });

let repoCount = 0;
// A fresh repo plus a locked card worktree named for `id`. Returns the paths.
function makeRepo(id) {
  const repo = path.join(TMP, `repo${repoCount++}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const wt = path.join(repo, '.claude', 'worktrees', `kanban-${id.slice(0, 8)}`);
  git(repo, 'worktree', 'add', '-q', '-b', `feature/${id.slice(0, 8)}`, wt);
  git(repo, 'worktree', 'lock', wt);
  return { repo, wt };
}

function write(wt, rel, content) {
  const file = path.join(wt, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeTask(id, repo, extra = {}) {
  return { id, title: `Card ${id.slice(0, 8)}`, cwd: repo, worktree: true, status: 'review', error: null, publishes: [], ...extra };
}

describe('publish path rules', () => {
  test('parseEntry accepts a normal path and normalises separators and ./', () => {
    assert.deepEqual(publish.parseEntry('api-shape', 'docs\\api/shape.md'), { name: 'api-shape', path: 'docs/api/shape.md' });
    assert.deepEqual(publish.parseEntry('x', './a/./b.txt'), { name: 'x', path: 'a/b.txt' });
  });

  test('parseEntry rejects absolute paths, ".." segments, drive letters and empty paths', () => {
    for (const bad of ['/etc/passwd', '\\\\server\\share\\f', 'C:\\Users\\x', 'C:foo', 'a/../b', '..', '../x', 'a\\..\\b', '', '   ', '.', './']) {
      assert.throws(() => publish.parseEntry('x', bad), Error, `path ${JSON.stringify(bad)}`);
    }
  });

  test('parseEntry reuses the contract name rule', () => {
    for (const bad of ['Upper', 'a b', '', '-lead', 'a..b', 'con', 'trail.']) {
      assert.throws(() => publish.parseEntry(bad, 'f.txt'), /name/, `name ${JSON.stringify(bad)}`);
    }
  });

  test('normalize rejects non-arrays and bad entries; accepts an empty list', () => {
    assert.deepEqual(publish.normalize([]), []);
    assert.throws(() => publish.normalize('x'), /array/);
    assert.throws(() => publish.normalize([null]), /publishes entry/);
    assert.throws(() => publish.normalize([{ name: 'ok', path: '../x' }]), /\.\./);
  });
});

describe('publishTask against a real worktree', () => {
  test('publishes a file with taskId and ext, then records it on the card', async () => {
    const id = 'a1b2c3d4-0001';
    const { repo, wt } = makeRepo(id);
    write(wt, 'docs/shape.md', '# shape\n');
    const task = makeTask(id, repo, { publishes: [{ name: 'shape-doc', path: 'docs/shape.md' }] });

    const r = await publish.publishTask(task);
    assert.deepEqual(r.problems, []);
    assert.equal(r.published.length, 1);
    const got = contracts.get('shape-doc');
    assert.equal(got.content, '# shape\n');
    assert.equal(got.contract.taskId, id);
    assert.equal(got.contract.ext, 'md');
    assert.deepEqual(task.published, r.published);
    assert.deepEqual(Object.keys(task.published[0]).sort(), ['name', 'publishedAt', 'sha256', 'version']);
    assert.equal(task.published[0].sha256, got.contract.sha256);
  });

  test('publishing identical content again records nothing new; changed content is v2', async () => {
    const id = 'a1b2c3d4-0002';
    const { repo, wt } = makeRepo(id);
    write(wt, 'out.json', '{"a":1}');
    const task = makeTask(id, repo, { publishes: [{ name: 'same-sha', path: 'out.json' }] });

    await publish.publishTask(task);
    const again = await publish.publishTask(task);
    assert.deepEqual(again.published, []);
    assert.deepEqual(again.unchanged, [{ name: 'same-sha', version: 1 }]);
    assert.equal(task.published.length, 1);

    write(wt, 'out.json', '{"a":2}');
    await publish.publishTask(task);
    assert.equal(task.published.length, 2);
    assert.equal(task.published[1].version, 2);
  });

  test('a missing file is a transcript note and an error-tracker entry, and the other files still publish', async () => {
    const id = 'a1b2c3d4-0003';
    const { repo, wt } = makeRepo(id);
    write(wt, 'present.txt', 'here');
    const task = makeTask(id, repo, {
      publishes: [{ name: 'gone-file', path: 'nope/missing.md' }, { name: 'present-file', path: 'present.txt' }],
    });

    const r = await publish.publishTask(task);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /gone-file.*file not found/);
    assert.equal(contracts.get('present-file').content, 'here');
    const entry = errlog.list().find((e) => e.kind === 'publish' && e.taskId === id);
    assert.ok(entry, 'expected an error-tracker entry of kind publish');
    assert.match(entry.text, /gone-file/);
    assert.ok(store.readTranscript(id).some((e) => e.kind === 'error' && /publish: gone-file/.test(e.text)));
  });

  test('binary content and extensions contracts would reject degrade, never throw', async () => {
    const id = 'a1b2c3d4-0004';
    const { repo, wt } = makeRepo(id);
    fs.writeFileSync(path.join(wt, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    write(wt, 'weird.thisextensionistoolong', 'text');
    write(wt, 'noext', 'plain');
    const task = makeTask(id, repo, {
      publishes: [
        { name: 'bin-blob', path: 'blob.bin' },
        { name: 'long-ext', path: 'weird.thisextensionistoolong' },
        { name: 'no-ext', path: 'noext' },
      ],
    });
    const r = await publish.publishTask(task);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /bin-blob.*NUL/);
    assert.equal(contracts.get('long-ext').contract.ext, 'txt');
    assert.equal(contracts.get('no-ext').contract.ext, 'txt');
  });

  test('a directory is refused', async () => {
    const id = 'a1b2c3d4-0005';
    const { repo, wt } = makeRepo(id);
    write(wt, 'dir/file.txt', 'x');
    const task = makeTask(id, repo, { publishes: [{ name: 'a-dir', path: 'dir' }] });
    const r = await publish.publishTask(task);
    assert.match(r.problems[0], /not a regular file/);
  });

  test('no worktree: returns { error } and records a tracker entry instead of throwing', async () => {
    const id = 'a1b2c3d4-0006';
    const { repo } = makeRepo('ffffffff-other'); // a repo with some OTHER card's worktree
    const task = makeTask(id, repo, { publishes: [{ name: 'orphan', path: 'x.txt' }] });
    const r = await publish.publishTask(task);
    assert.match(r.error, /no worktree/);
    assert.ok(errlog.list().some((e) => e.kind === 'publish' && e.taskId === id));
  });

  test('symlink escape: a link inside the worktree pointing outside is refused', async (t) => {
    const id = 'a1b2c3d4-0007';
    const { repo, wt } = makeRepo(id);
    const secret = path.join(TMP, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    // Each link is tried on its own: Windows without developer mode refuses a
    // file symlink (EPERM) but still allows a directory junction.
    const entries = [];
    const tryLink = (name, rel, make) => {
      try {
        make();
        entries.push({ name, path: rel });
      } catch {}
    };
    tryLink('leak-file', 'link.txt', () => fs.symlinkSync(secret, path.join(wt, 'link.txt'), 'file'));
    tryLink('leak-dir', 'linkdir/secret.txt', () => fs.symlinkSync(TMP, path.join(wt, 'linkdir'), 'junction'));
    if (!entries.length) return t.skip('cannot create symlinks or junctions here');

    const task = makeTask(id, repo, { publishes: entries });
    const r = await publish.publishTask(task);
    assert.equal(r.published.length, 0);
    assert.equal(r.problems.length, entries.length);
    for (const p of r.problems) assert.match(p, /outside the worktree/);
    for (const e of entries) assert.throws(() => contracts.get(e.name), /no contract/);
  });

  test('a symlink that stays inside the worktree is fine', async (t) => {
    const id = 'a1b2c3d4-0008';
    const { repo, wt } = makeRepo(id);
    write(wt, 'real.txt', 'inside');
    try {
      fs.symlinkSync(path.join(wt, 'real.txt'), path.join(wt, 'alias.txt'), 'file');
    } catch (e) {
      return t.skip(`cannot create symlinks here: ${e.code}`);
    }
    const task = makeTask(id, repo, { publishes: [{ name: 'inside-link', path: 'alias.txt' }] });
    const r = await publish.publishTask(task);
    assert.deepEqual(r.problems, []);
    assert.equal(contracts.get('inside-link').content, 'inside');
  });
});

describe('Windows 8.3 names', () => {
  // Regression: the CI runner's temp dir is C:\Users\RUNNER~1\..., so a link
  // target built from it was stored in short form while git reported the root
  // long, and a link staying inside the worktree was refused as an escape. A
  // junction needs no privilege, so this runs here too.
  test('a link inside the worktree whose target is spelled with 8.3 names still publishes', async (t) => {
    if (process.platform !== 'win32') return t.skip('Windows only');
    const id = 'a1b2c3d4-0009';
    const { repo, wt } = makeRepo(id);
    write(wt, 'a-rather-long-directory-name/real-file-with-a-long-name.txt', 'inside');
    const longDir = path.join(wt, 'a-rather-long-directory-name');
    let short;
    try {
      short = execFileSync('powershell', ['-NoProfile', '-Command',
        `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${longDir}').ShortPath`], { encoding: 'utf8' }).trim();
    } catch (e) {
      return t.skip(`cannot read the 8.3 name: ${e.message}`);
    }
    if (short.toLowerCase() === longDir.toLowerCase()) return t.skip('8.3 names are disabled on this volume');
    fs.symlinkSync(short, path.join(wt, 'alias-dir'), 'junction');

    const task = makeTask(id, repo, {
      publishes: [{ name: 'short-name-link', path: 'alias-dir/real-file-with-a-long-name.txt' }],
    });
    const r = await publish.publishTask(task);
    assert.deepEqual(r.problems, []);
    assert.equal(contracts.get('short-name-link').content, 'inside');
  });
});

describe('finish-time publish (runner.finalize)', () => {
  test('a clean worktree card publishes at finish', async () => {
    const id = 'b1b2c3d4-0001';
    const { repo, wt } = makeRepo(id);
    write(wt, 'contract.md', 'finished');
    const task = makeTask(id, repo, { publishes: [{ name: 'finish-clean', path: 'contract.md' }] });
    store.state.tasks.unshift(task);

    await finalize(task);
    assert.equal(contracts.get('finish-clean').content, 'finished');
    assert.equal(task.published.length, 1);
    assert.equal(task.status, 'review'); // publishing never moves the card
  });

  test('a card that ended with an error publishes nothing', async () => {
    const id = 'b1b2c3d4-0002';
    const { repo, wt } = makeRepo(id);
    write(wt, 'contract.md', 'half done');
    const task = makeTask(id, repo, { error: 'Blocked on permission', publishes: [{ name: 'finish-errored', path: 'contract.md' }] });
    store.state.tasks.unshift(task);

    await finalize(task);
    assert.throws(() => contracts.get('finish-errored'), /no contract/);
    assert.equal(task.published, undefined);
  });

  test('a missing file does not fail the card or stop finalize', async () => {
    const id = 'b1b2c3d4-0003';
    const { repo } = makeRepo(id);
    const task = makeTask(id, repo, { publishes: [{ name: 'finish-missing', path: 'not-written.md' }] });
    store.state.tasks.unshift(task);

    await finalize(task);
    assert.equal(task.error, null);
    assert.ok(errlog.list().some((e) => e.kind === 'publish' && e.taskId === id));
  });

  test('a non-worktree card is skipped with a note', async () => {
    const id = 'b1b2c3d4-0004';
    const { repo, wt } = makeRepo(id);
    write(wt, 'contract.md', 'x');
    const task = makeTask(id, repo, { worktree: false, publishes: [{ name: 'finish-nowt', path: 'contract.md' }] });
    store.state.tasks.unshift(task);

    await finalize(task);
    assert.throws(() => contracts.get('finish-nowt'), /no contract/);
    assert.ok(store.readTranscript(id).some((e) => /only works on worktree cards/.test(e.text)));
  });
});

describe('prompt line', () => {
  test('a worktree card with publishes is told which files it writes', () => {
    const prompt = buildPrompt({
      prompt: 'do it', worktree: true,
      publishes: [{ name: 'api-shape', path: 'docs/a.md' }, { name: 'codes', path: 'docs/c.json' }],
    });
    assert.match(prompt, /`docs\/a\.md` \(contract `api-shape`\), `docs\/c\.json` \(contract `codes`\)/);
    assert.match(prompt, /publishes each as its named contract/);
  });

  test('cards without publishes (or without a worktree) get no such line', () => {
    assert.doesNotMatch(buildPrompt({ prompt: 'do it', worktree: true, publishes: [] }), /contract/);
    assert.doesNotMatch(buildPrompt({ prompt: 'do it', worktree: false, publishes: [{ name: 'a', path: 'b' }] }), /contract/);
    assert.doesNotMatch(buildPrompt({ prompt: 'do it', worktree: true }), /contract/);
  });
});

// --- the HTTP surface, against the real server.js ---------------------------

const ROOT = path.join(__dirname, '..');
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const TOKEN = 'kfk-publish-test-token';

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
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      if (/EADDRINUSE/.test(stderr)) return resolve({ ok: false });
      reject(new Error(`test server exited (code ${code}):\n${stderr.slice(-1000)}`));
    });
    (async () => {
      const deadline = Date.now() + 15_000;
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
        resolve({ ok: false });
      }
    })();
  });
}

async function bootServer(env) {
  for (let i = 0; i < 5; i++) {
    const r = await tryBoot(env);
    if (r.ok) return r;
  }
  throw new Error('could not boot test server');
}

describe('publish API', () => {
  let child, base, dataDir;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const call = (method, p, body) =>
    fetch(`${base}${p}`, { method, headers: { ...JSON_HEADERS, ...auth }, body: body === undefined ? undefined : JSON.stringify(body) });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-publish-srv-'));
    fs.writeFileSync(path.join(dataDir, 'auth-token'), TOKEN);
    ({ child, base } = await bootServer({ KFK_DATA_DIR: dataDir }));
  });

  after(async () => {
    await new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('POST and PATCH validate publishes and store the normalised list', async () => {
    const bad = await call('POST', '/api/tasks', { title: 't', publishes: [{ name: 'ok', path: '../escape' }] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /\.\./);

    const res = await call('POST', '/api/tasks', { title: 't', publishes: [{ name: 'shape', path: 'docs\\a.md' }] });
    assert.equal(res.status, 200);
    const task = await res.json();
    assert.deepEqual(task.publishes, [{ name: 'shape', path: 'docs/a.md' }]);

    const patchBad = await call('PATCH', `/api/tasks/${task.id}`, { publishes: [{ name: 'Bad Name', path: 'a' }] });
    assert.equal(patchBad.status, 400);
    const patchOk = await call('PATCH', `/api/tasks/${task.id}`, { publishes: [{ name: 'other', path: 'b.txt' }] });
    assert.equal(patchOk.status, 200);
    assert.deepEqual((await patchOk.json()).publishes, [{ name: 'other', path: 'b.txt' }]);
  });

  test('POST /api/tasks/:id/publish publishes from a real worktree and records it on the card', async () => {
    // The worktree name comes from the card id, so create the card first.
    const created = await call('POST', '/api/tasks', { title: 'publisher' });
    const task = await created.json();
    const { repo, wt } = makeRepo(task.id);
    write(wt, 'out/spec.md', 'v1 content');
    const patch = await call('PATCH', `/api/tasks/${task.id}`, {
      cwd: repo, worktree: true, status: 'review', publishes: [{ name: 'route-spec', path: 'out/spec.md' }],
    });
    assert.equal(patch.status, 200);

    const res = await call('POST', `/api/tasks/${task.id}/publish`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.problems, []);
    assert.equal(body.published.length, 1);
    assert.equal(body.published[0].name, 'route-spec');
    assert.equal(body.published[0].version, 1);

    const card = await (await call('GET', `/api/tasks/${task.id}`)).json();
    assert.deepEqual(card.published, body.published);
    const served = await (await call('GET', '/api/contracts/route-spec')).json();
    assert.equal(served.content, 'v1 content');
    assert.equal(served.contract.taskId, task.id);

    // Same file again: nothing new on the card.
    const again = await (await call('POST', `/api/tasks/${task.id}/publish`)).json();
    assert.deepEqual(again.published, []);
    assert.deepEqual(again.unchanged, [{ name: 'route-spec', version: 1 }]);
    assert.equal((await (await call('GET', `/api/tasks/${task.id}`)).json()).published.length, 1);
  });

  test('refusals: unknown card 404, wrong status 409, no publishes 400, missing worktree 404', async () => {
    assert.equal((await call('POST', '/api/tasks/nope/publish')).status, 404);

    const created = await (await call('POST', '/api/tasks', { title: 'backlog card', worktree: true, publishes: [{ name: 'p', path: 'a' }] })).json();
    assert.equal((await call('POST', `/api/tasks/${created.id}/publish`)).status, 409);

    await call('PATCH', `/api/tasks/${created.id}`, { status: 'review', publishes: [] });
    assert.equal((await call('POST', `/api/tasks/${created.id}/publish`)).status, 400);

    const { repo } = makeRepo('eeeeeeee-none');
    await call('PATCH', `/api/tasks/${created.id}`, { cwd: repo, publishes: [{ name: 'p', path: 'a' }] });
    const res = await call('POST', `/api/tasks/${created.id}/publish`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no worktree/);
  });
});
