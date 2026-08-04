// Central pub/sub for SSE broadcasts, so modules can broadcast without a
// require cycle back to server.js. server.js subscribes the SSE writer once.
const path = require('path');

let sink = () => {};

function subscribe(fn) {
  sink = fn;
}

function broadcast(msg) {
  sink(msg);
}

// This app's own node_modules — cards run with cwd inside whatever project
// they're working on, not this repo, so a plain `require('playwright')` from
// a card's script would fail to resolve it even though it's a real
// dependency here. Node's module resolution consults NODE_PATH as a
// fallback, so appending our node_modules lets any card verify UI work with
// a real headless browser regardless of which project it's in.
const OWN_NODE_MODULES = path.join(__dirname, '..', 'node_modules');

// Force subscription auth: never let an API key in the environment win.
function subEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  env.NODE_PATH = env.NODE_PATH ? `${OWN_NODE_MODULES}${path.delimiter}${env.NODE_PATH}` : OWN_NODE_MODULES;
  return env;
}

module.exports = { broadcast, subscribe, subEnv };
