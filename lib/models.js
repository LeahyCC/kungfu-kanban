// Model fallback ladder. When a run fails because a specific model is capped
// or unavailable (as opposed to the whole subscription cooling down), that
// model is blocked for a while and launches substitute the next model down.
// Cards keep their configured model — when the block expires, runs climb back.
const { state, save } = require('./store');

const LADDER = ['fable', 'opus', 'sonnet', 'haiku'];

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
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
    save();
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
  if (/overloaded_error|status.?529|\b529\b/i.test(err)) return true;
  return false;
}

// Block a model; overload errors get a short block, caps a longer one.
function block(model, err) {
  if (!model || model === 'default' || !LADDER.includes(model)) return;
  const minutes = /overloaded|529/i.test(err || '') ? 10 : 30;
  const b = blocks();
  b[model] = Date.now() + minutes * 60_000;
  save();
  broadcast({ type: 'modelblocks', blocks: b });
}

// The model a launch should actually use right now.
function effective(model) {
  if (!model || model === 'default') return model;
  const b = blocks();
  let cur = model;
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
  const failed = LADDER.includes(task.modelUsed) ? task.modelUsed
    : LADDER.includes(task.model) ? task.model : null;
  if (!failed) return null;
  block(failed, err);
  const next = effective(task.model && task.model !== 'default' ? task.model : failed);
  return next !== failed ? next : null;
}

module.exports = { setBroadcaster, detect, block, blocks, effective, fallbackFor, LADDER };
