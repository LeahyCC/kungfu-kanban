// Model fallback ladder. When a run fails because a specific model is capped
// or unavailable (as opposed to the whole subscription cooling down), that
// model is blocked for a while and launches substitute the next model down.
// Cards keep their configured model — when the block expires, runs climb back.
const { state, saveSettings } = require('./store');
const { broadcast } = require('./bus');

const LADDER = ['fable', 'opus', 'sonnet', 'haiku'];

// A full model id ("claude-sonnet-4-5", "claude-3-5-haiku-20241022", the CLI's
// own `--model` short aliases) names its ladder rung as a case-insensitive
// substring. Returns null for an id that names no rung at all (outside the
// ladder, or "default") — block()/effective() then have nothing to act on.
function rungOf(model) {
  if (!model || model === 'default') return null;
  const m = String(model).toLowerCase();
  return LADDER.find((r) => m.includes(r)) || null;
}

function blocks() {
  const b = state.settings.modelBlocks || {};
  let changed = false;
  for (const [m, until] of Object.entries(b)) {
    if (until <= Date.now()) {
      delete b[m];
      changed = true;
    }
  }
  state.settings.modelBlocks = b;
  if (changed) {
    saveSettings();
    broadcast({ type: 'modelblocks', blocks: b });
  }
  return b;
}

// Model-SPECIFIC failure (named model + limit, or model unavailable/overloaded).
// Generic "usage limit reached" belongs to the cooldown, not here.
function detect(err) {
  if (!err) return false;
  if (/(fable|opus|sonnet|haiku)[^\n]{0,80}(limit|unavailable|not available|capacity)/i.test(err)) return true;
  if (/model[^\n]{0,40}(unavailable|not available|not supported|no access)/i.test(err)) return true;
  // The CLI's "unknown/inaccessible model id" wording: "There's an issue with
  // the selected model (cc/claude-sonnet-5). It may not exist or you may not
  // have access to it." — distinct from the generic phrasing above (no
  // "unavailable"/"not supported"), so it needs its own match.
  if (/(model[^\n]{0,120}may not exist|no such model|invalid model)/i.test(err)) return true;
  if (/overloaded_error|status.?529|\b529\b/i.test(err)) return true;
  return false;
}

// Block a model; overload errors get a short block, caps a longer one. Takes
// any model reference (short alias or a full id like "claude-sonnet-4-5") and
// resolves it to the ladder rung it belongs to.
function block(model, err) {
  const rung = rungOf(model);
  if (!rung) return;
  const minutes = /overloaded|529/i.test(err || '') ? 10 : 30;
  const b = blocks();
  b[rung] = Date.now() + minutes * 60_000;
  saveSettings();
  broadcast({ type: 'modelblocks', blocks: b });
}

// The model a launch should actually use right now. A full model id keeps its
// exact value (it pins a specific snapshot) unless ITS rung is actually
// blocked, in which case launches step down the ladder from there — same as
// a short alias.
function effective(model) {
  if (!model || model === 'default') return model;
  const b = blocks();
  const rung = rungOf(model);
  if (!rung || !b[rung]) return model;
  let cur = rung;
  let i = LADDER.indexOf(cur);
  while (i >= 0 && b[cur] && i < LADDER.length - 1) {
    i += 1;
    cur = LADDER[i];
  }
  return cur;
}

// Handle a model-specific failure for a task. Returns the model to retry on,
// or null when there's nowhere lower to go (caller should treat as cooldown).
function fallbackFor(task, err) {
  const failed = rungOf(task.modelUsed) || rungOf(task.model);
  if (!failed) return null;
  block(failed, err);
  const next = effective(task.model && task.model !== 'default' ? task.model : failed);
  return next !== failed ? next : null;
}

module.exports = { detect, block, blocks, effective, fallbackFor, rungOf, LADDER };
