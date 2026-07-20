const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// lib/skill.js resolves its install destination from os.homedir() (which
// respects $HOME on POSIX) and its port from process.env.PORT, both read at
// module-load time. Running it in a child process with a scratch HOME lets
// us exercise install()/status() for real without ever touching the
// developer's actual ~/.claude/skills.
const SKILL_PATH = path.join(__dirname, '..', 'lib', 'skill.js');

function runInScratchHome(extraScript, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-skill-test-'));
  const script = `
    const skill = require(${JSON.stringify(SKILL_PATH)});
    ${extraScript}
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env, HOME: home },
      encoding: 'utf8',
    });
    return { home, out: JSON.parse(out.trim()) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('skill.status(): reports not-installed against a fresh HOME', () => {
  const { out } = runInScratchHome(`console.log(JSON.stringify(skill.status()));`);
  assert.ok(out.length >= 2);
  for (const s of out) {
    assert.equal(s.installed, false);
    assert.equal(s.current, false);
  }
});

test('skill.install()/status(): install baked absolute board path and the configured port into the generated file', () => {
  const { out } = runInScratchHome(
    `
    skill.install();
    const fs = require('fs');
    const dest = require('path').join(process.env.HOME, '.claude', 'skills', 'kungfu-todo', 'SKILL.md');
    console.log(JSON.stringify({ content: fs.readFileSync(dest, 'utf8') }));
    `,
    { PORT: '9931' }
  );
  const boardRoot = path.join(__dirname, '..');
  assert.ok(out.content.includes(boardRoot), 'installed file should bake in the absolute board path');
  assert.ok(out.content.includes('localhost:9931'), 'installed file should bake in the configured port');
});

test('skill.install() defaults the port to 4747 when PORT is unset', () => {
  const { out } = runInScratchHome(
    `
    skill.install();
    const fs = require('fs');
    const dest = require('path').join(process.env.HOME, '.claude', 'skills', 'kungfu-todo', 'SKILL.md');
    console.log(JSON.stringify({ content: fs.readFileSync(dest, 'utf8') }));
    `,
    { PORT: '' }
  );
  assert.ok(out.content.includes('localhost:4747'));
});

test('skill.status(): installed+current right after install, then installed+stale after the file is hand-edited', () => {
  const { out } = runInScratchHome(`
    const fs = require('fs');
    const path = require('path');
    const before = skill.status();
    skill.install();
    const afterInstall = skill.status();
    const dest = path.join(process.env.HOME, '.claude', 'skills', 'kungfu-todo', 'SKILL.md');
    fs.appendFileSync(dest, '\\n<!-- stale marker -->\\n');
    const afterEdit = skill.status();
    console.log(JSON.stringify({ before, afterInstall, afterEdit }));
  `);

  const kungfuBefore = out.before.find((s) => s.name === 'kungfu-todo');
  assert.equal(kungfuBefore.installed, false);

  const kungfuAfterInstall = out.afterInstall.find((s) => s.name === 'kungfu-todo');
  assert.equal(kungfuAfterInstall.installed, true);
  assert.equal(kungfuAfterInstall.current, true);

  const kungfuAfterEdit = out.afterEdit.find((s) => s.name === 'kungfu-todo');
  assert.equal(kungfuAfterEdit.installed, true);
  assert.equal(kungfuAfterEdit.current, false);

  // ponytail is a verbatim vendored file — same current/stale story applies.
  const ponytailAfterInstall = out.afterInstall.find((s) => s.name === 'ponytail');
  assert.equal(ponytailAfterInstall.installed, true);
  assert.equal(ponytailAfterInstall.current, true);
});
