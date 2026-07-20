// Discovers installed skills and agents from the user's Claude Code setup.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

function parseFrontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function scanSkillDir(dir, source) {
  const skills = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const fm = parseFrontmatter(skillFile);
    skills.push({
      name: fm.name || e.name,
      description: (fm.description || '').slice(0, 300),
      source,
    });
  }
  return skills;
}

function discoverSkills() {
  const skills = [];

  // Personal skills: ~/.claude/skills/*/SKILL.md
  skills.push(...scanSkillDir(path.join(CLAUDE_DIR, 'skills'), 'user'));

  // Plugin skills: resolve enabled plugins from installed_plugins.json
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8')
    );
    for (const [key, installs] of Object.entries(manifest.plugins || {})) {
      const pluginName = key.split('@')[0];
      for (const inst of installs) {
        if (!inst.installPath) continue;
        for (const sub of ['skills', 'workflow-skills']) {
          for (const s of scanSkillDir(path.join(inst.installPath, sub), `plugin:${pluginName}`)) {
            skills.push({ ...s, name: `${pluginName}:${s.name}` });
          }
        }
      }
    }
  } catch {
    // no plugins manifest — fine
  }

  // De-dupe by name (multiple cached versions of the same plugin)
  const seen = new Set();
  return skills.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function discoverAgents() {
  const agents = [];
  const dir = path.join(CLAUDE_DIR, 'agents');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return agents;
  }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const fm = parseFrontmatter(path.join(dir, f));
    agents.push({
      name: fm.name || f.replace(/\.md$/, ''),
      description: (fm.description || '').slice(0, 300),
      model: fm.model || null,
    });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

// Git repos one level under reposDir — the card modal's cwd picker.
function discoverRepos(reposDir) {
  const repos = [];
  let entries;
  try {
    entries = fs.readdirSync(reposDir, { withFileTypes: true });
  } catch {
    return repos;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    const full = path.join(reposDir, e.name);
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    if (fs.existsSync(path.join(full, '.git'))) repos.push({ name: e.name, path: full });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

module.exports = { discoverSkills, discoverAgents, discoverRepos };
