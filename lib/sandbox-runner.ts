// Repo-aware task execution in a Vercel Sandbox microVM, fire-and-poll style:
// start() provisions the sandbox, clones the repo, and launches a detached
// runner script (Claude Code CLI → commit → push → PR), then returns
// immediately. poll() reconnects by sandbox name and reads the result file,
// so tasks can run up to 45 minutes — far past the API function window.
import { Sandbox } from '@vercel/sandbox';

export type RepoRunResult = {
  text: string;
  branch: string | null;
  prUrl: string | null;
  error?: string;
};

const CLI_MODEL: Record<string, string> = {
  default: 'opus', fable: 'fable', opus: 'opus', sonnet: 'sonnet', haiku: 'haiku',
};

// Sandbox minutes are the app's #1 operating cost — every repo card holds a
// microVM for up to this long. Configurable via env, clamped 5..45, default 20.
export const SANDBOX_MINUTES = Math.min(45, Math.max(5, parseInt(process.env.SANDBOX_MAX_MINUTES || '20', 10) || 20));
const SANDBOX_TIMEOUT_MS = SANDBOX_MINUTES * 60 * 1000;

function parseRepo(repoUrl: string): { owner: string; repo: string } {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (!m) throw new Error('Repo URL must be a github.com repository, e.g. https://github.com/owner/repo');
  return { owner: m[1], repo: m[2] };
}

async function gh(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kungfu-kanban',
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${body.message || ''}`.trim());
  return body;
}

// Runs inside the sandbox via node. Reads config from env, writes
// /tmp/kk/result.json when finished (success or failure).
const RUNNER_SCRIPT = `
const { execSync } = require('child_process');
const fs = require('fs');

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: '/tmp/repo', ...opts });

(async () => {
  const out = { text: '', branch: null, prUrl: null };
  try {
    const model = process.env.KK_MODEL || 'opus';
    const effort = process.env.KK_EFFORT || '';
    let raw = '';
    let failed = false;
    try {
      raw = sh(
        'claude -p "$(cat /tmp/kk/prompt.txt)" --output-format json --permission-mode bypassPermissions --model ' +
          model + (effort ? ' --effort ' + effort : ''),
        { env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/root/.npm-global/bin' } }
      );
    } catch (e) {
      raw = (e.stdout || '') + '\\n' + (e.stderr || '');
      failed = true; // non-zero exit from the CLI
    }
    // Success only if the CLI exited zero AND the JSON envelope parses with a
    // genuine result and no error flag. Anything else is a failure.
    let parsed = null;
    try { parsed = JSON.parse(raw.trim().split('\\n').pop()); } catch {}
    if (!failed && parsed && parsed.is_error !== true && typeof parsed.result === 'string' && parsed.result) {
      out.text = parsed.result;
    } else {
      const detail = (parsed && (parsed.result || parsed.error)) || raw.trim();
      throw new Error('Claude Code run failed: ' + String(detail).slice(0, 1500));
    }

    if (sh('git status --porcelain').trim()) {
      const branch = process.env.KK_BRANCH;
      fs.writeFileSync('/tmp/kk/commitmsg.txt', process.env.KK_TITLE + ' (kungfu-kanban task)');
      sh('git config user.email "bot@kungfu-kanban.dev" && git config user.name "Kungfu Kanban"');
      sh('git checkout -b ' + branch + ' && git add -A');
      sh('git commit -F /tmp/kk/commitmsg.txt');
      const diffstat = sh('git show --stat --format="" HEAD').trim();
      sh('git push origin ' + branch);
      out.branch = branch;
      out.text += '\\n\\n---\\n' + diffstat;

      const prRes = await fetch('https://api.github.com/repos/' + process.env.KK_REPO + '/pulls', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kungfu-kanban',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: process.env.KK_TITLE,
          head: branch,
          base: process.env.KK_BASE,
          body: 'Automated by Kungfu Kanban.\\n\\n**Agent summary:**\\n' + out.text.slice(0, 2000),
        }),
      });
      const pr = await prRes.json();
      if (prRes.ok) out.prUrl = pr.html_url || null;
      else out.text += '\\n\\n(PR creation failed: ' + (pr.message || prRes.status) + ')';
    } else {
      out.text += '\\n\\n(no file changes were made)';
    }
  } catch (e) {
    // Redact any embedded credential before persisting the error.
    out.error = String(e.message || e)
      .replace(/x-access-token:[^@\\s]+@/gi, 'x-access-token:***@')
      .slice(0, 2000);
  }
  fs.writeFileSync('/tmp/kk/result.json', JSON.stringify(out));
})();
`;

export async function startRepoTask(opts: {
  anthropicKey: string;
  githubToken: string;
  repoUrl: string;
  baseBranch: string;
  model: string;
  effort: string;
  prompt: string;
  taskId: string;
  title: string;
  retries: number;
}): Promise<{ sandboxName: string }> {
  const { owner, repo } = parseRepo(opts.repoUrl);
  const repoInfo = await gh(`/repos/${owner}/${repo}`, opts.githubToken);
  const base = opts.baseBranch || repoInfo.default_branch || 'main';
  if (!/^[\w./-]+$/.test(base)) throw new Error('Invalid base branch name');
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort) ? opts.effort : '';
  // Unique per RUN, not per task: include a wide slice of the uuid plus the
  // retry counter so retries get fresh branches/sandboxes and the shared
  // Vercel sandbox namespace can't collide across tenants.
  const uid = opts.taskId.replace(/-/g, '');
  const runIdx = opts.retries || 0;
  const sandboxName = `kk-${uid.slice(0, 20)}-${runIdx}`;
  const branch = `kungfu/${opts.taskId.slice(0, 8)}-${runIdx}`;

  const sandbox = await Sandbox.create({
    name: sandboxName,
    runtime: 'node24',
    timeout: SANDBOX_TIMEOUT_MS,
  } as Parameters<typeof Sandbox.create>[0]);

  const run = async (script: string) => {
    const r = await sandbox.runCommand('sh', ['-lc', script]);
    if (r.exitCode !== 0) {
      const err = await r.stderr();
      const out = await r.stdout();
      await sandbox.stop().catch(() => {});
      throw new Error(`sandbox setup failed (${r.exitCode}): ${(err || out).slice(-600)}`);
    }
  };

  const authUrl = `https://x-access-token:${opts.githubToken}@github.com/${owner}/${repo}.git`;
  await run(`mkdir -p /tmp/kk && git clone --depth 20 --branch ${JSON.stringify(base)} ${JSON.stringify(authUrl)} /tmp/repo 2>&1`);
  await run('npm install -g @anthropic-ai/claude-code 2>&1 | tail -1');
  await run(`echo ${JSON.stringify(Buffer.from(opts.prompt, 'utf8').toString('base64'))} | base64 -d > /tmp/kk/prompt.txt`);
  await run(`echo ${JSON.stringify(Buffer.from(RUNNER_SCRIPT, 'utf8').toString('base64'))} | base64 -d > /tmp/kk/run.cjs`);

  await sandbox.runCommand({
    cmd: 'node',
    args: ['/tmp/kk/run.cjs'],
    detached: true,
    env: {
      ANTHROPIC_API_KEY: opts.anthropicKey,
      GITHUB_TOKEN: opts.githubToken,
      KK_REPO: `${owner}/${repo}`,
      KK_BASE: base,
      KK_BRANCH: branch,
      KK_MODEL: CLI_MODEL[opts.model] ?? 'opus',
      KK_EFFORT: effort,
      KK_TITLE: opts.title.slice(0, 120),
    },
  });

  return { sandboxName };
}

// Returns null while still running; a RepoRunResult once finished (sandbox is
// stopped as a side effect). Throws if the sandbox is gone (expired/errored).
export async function pollRepoTask(sandboxName: string): Promise<RepoRunResult | null> {
  const sandbox = await Sandbox.get({ name: sandboxName } as Parameters<typeof Sandbox.get>[0]);
  const r = await sandbox.runCommand('sh', ['-lc', 'cat /tmp/kk/result.json 2>/dev/null']);
  const out = await r.stdout();
  if (r.exitCode !== 0 || !out.trim()) return null;
  const result = JSON.parse(out) as RepoRunResult;
  await sandbox.stop().catch(() => {});
  return result;
}
