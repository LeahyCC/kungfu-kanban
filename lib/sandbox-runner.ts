// Repo-aware task execution: clone the repo into a Vercel Sandbox microVM,
// run the Claude Code CLI there on the user's own Anthropic API key, push the
// changes as a branch, and open a PR with the user's GitHub token.
import { Sandbox } from '@vercel/sandbox';

export type RepoRunResult = {
  text: string;
  branch: string | null;
  prUrl: string | null;
  diffstat: string | null;
  model: string;
};

const CLI_MODEL: Record<string, string> = {
  default: 'opus',
  fable: 'fable',
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

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

export async function runRepoTask(opts: {
  anthropicKey: string;
  githubToken: string;
  repoUrl: string;
  baseBranch: string;
  model: string;
  effort: string;
  prompt: string;
  taskId: string;
  title: string;
}): Promise<RepoRunResult> {
  const { owner, repo } = parseRepo(opts.repoUrl);

  // Validate token + resolve default branch before paying for a sandbox
  const repoInfo = await gh(`/repos/${owner}/${repo}`, opts.githubToken);
  const base = opts.baseBranch || repoInfo.default_branch || 'main';
  const branch = `kungfu/${opts.taskId.slice(0, 8)}`;
  const model = CLI_MODEL[opts.model] ?? 'opus';

  const sandbox = await Sandbox.create({ runtime: 'node24', timeout: 280_000 });
  try {
    const sh = async (script: string, okCodes: number[] = [0]) => {
      const r = await sandbox.runCommand('sh', ['-lc', script]);
      const out = await r.stdout();
      const err = await r.stderr();
      if (!okCodes.includes(r.exitCode)) {
        throw new Error(`sandbox step failed (${r.exitCode}): ${(err || out).slice(-600)}`);
      }
      return out;
    };

    const authUrl = `https://x-access-token:${opts.githubToken}@github.com/${owner}/${repo}.git`;
    await sh(`git clone --depth 20 --branch ${JSON.stringify(base)} ${JSON.stringify(authUrl)} /tmp/repo 2>&1`);
    await sh('npm install -g @anthropic-ai/claude-code 2>&1 | tail -1');

    // Prompt via base64 to survive quoting; key via env assignment (ephemeral single-tenant VM)
    const promptB64 = Buffer.from(opts.prompt, 'utf8').toString('base64');
    await sh(`echo ${JSON.stringify(promptB64)} | base64 -d > /tmp/prompt.txt`);
    const runOut = await sh(
      `cd /tmp/repo && ANTHROPIC_API_KEY=${JSON.stringify(opts.anthropicKey)} ` +
        `claude -p "$(cat /tmp/prompt.txt)" --output-format json ` +
        `--permission-mode bypassPermissions --model ${model}` +
        (opts.effort && opts.effort !== 'default' ? ` --effort ${opts.effort}` : '') +
        ` 2>/tmp/claude.err || cat /tmp/claude.err`
    );

    let resultText = runOut.trim();
    try {
      const parsed = JSON.parse(runOut.trim().split('\n').pop() || '{}');
      if (parsed.result) resultText = parsed.result;
    } catch {
      // non-JSON output — keep raw
    }

    // Commit + push if the agent changed anything
    const status = await sh('cd /tmp/repo && git status --porcelain');
    let prUrl: string | null = null;
    let diffstat: string | null = null;
    if (status.trim()) {
      await sh(
        `cd /tmp/repo && git config user.email "bot@kungfu-kanban.dev" && git config user.name "Kungfu Kanban" && ` +
          `git checkout -b ${JSON.stringify(branch)} && git add -A && ` +
          `git commit -m ${JSON.stringify(`${opts.title} (kungfu-kanban task)`)} 2>&1`
      );
      diffstat = (await sh('cd /tmp/repo && git show --stat --format="" HEAD')).trim();
      await sh(`cd /tmp/repo && git push origin ${JSON.stringify(branch)} 2>&1`);
      const pr = await gh(`/repos/${owner}/${repo}/pulls`, opts.githubToken, {
        method: 'POST',
        body: JSON.stringify({
          title: opts.title,
          head: branch,
          base,
          body: `Automated by Kungfu Kanban.\n\n**Task prompt:**\n${opts.prompt.slice(0, 1500)}\n\n**Agent summary:**\n${resultText.slice(0, 2000)}`,
        }),
      });
      prUrl = pr.html_url || null;
    }

    return {
      text: status.trim() ? `${resultText}\n\n---\n${diffstat || ''}` : `${resultText}\n\n(no file changes were made)`,
      branch: status.trim() ? branch : null,
      prUrl,
      diffstat,
      model,
    };
  } finally {
    await sandbox.stop();
  }
}
