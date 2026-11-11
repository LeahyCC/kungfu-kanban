const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// lib/skill.js resolves its install destination from os.homedir() and its
// port from process.env.PORT, both read at module-load time. Running it in a
// child process with a scratch home lets us exercise install()/status() for
// real without ever touching the developer's actual ~/.claude/skills.
// os.homedir() reads $HOME on POSIX but %USERPROFILE% on Windows, so both
// must point at the scratch dir: faking HOME alone let every Windows run
// install into the real profile.
const SKILL_PATH = path.join(__dirname, '..', 'lib', 'skill.js');

function runInScratchHome(extraScript, env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-skill-test-'));
  const script = `
    const skill = require(${JSON.stringify(SKILL_PATH)});
    ${extraScript}
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
    });
    return { home, out: JSON.parse(out.trim()) };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('skill.status(): reports not-installed against a fresh HOME', () => {
  const { home, out } = runInScratchHome(`console.log(JSON.stringify(skill.status()));`);
  assert.ok(out.length >= 2);
  for (const s of out) {
    assert.ok(s.path.startsWith(home), `${s.name} must resolve inside the scratch home, not the real one: ${s.path}`);
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

test('skill.install(): generated skill makes the session the lead, with the real endpoints', () => {
  const { out } = runInScratchHome(
    `
    skill.install();
    const fs = require('fs');
    const dest = require('path').join(process.env.HOME, '.claude', 'skills', 'kungfu-todo', 'SKILL.md');
    console.log(JSON.stringify({ content: fs.readFileSync(dest, 'utf8') }));
    `,
    { PORT: '9931' }
  );
  const c = out.content;
  assert.ok(c.includes('## Running the batch'), 'owning the run is the default section, not a conditional one');
  assert.ok(c.includes('**You are the lead.**'), 'the session is told it owns the cards');
  assert.ok(c.includes('http://localhost:9931/api/manager/config'));
  assert.ok(c.includes('http://localhost:9931/api/settings'));
  assert.ok(c.includes('"prWatchAutoFixCi": false'));
  // The merge rule is the one line that keeps a session from shipping code on
  // its own judgement. It must not quietly drop out of a future rewrite.
  assert.ok(/only prose/.test(c), 'prose-only PRs are the ones it may merge itself');
  assert.ok(/wait for the user to\s+say go/.test(c), 'code changes wait for a go-ahead');
  // `repo` is an alias of `cwd` in a card's header block, so a prompt line
  // starting "Repo:" either redirects the card or fails the import. Eleven
  // cards hit the second case on one board before the skill said so.
  assert.ok(/`Repository:`, never `Repo:`/.test(c), 'the Repo: trap is spelled out');
  // Reading the token file put it in the transcript, and a Read(**/auth-token)
  // deny rule blocked every API call the skill told the session to make.
  assert.ok(!/cat [^\n]*auth-token/.test(c), 'no command reads the token file');
  assert.ok(c.includes('$KFK_TOKEN'), 'a gated board takes the token from the environment');
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
