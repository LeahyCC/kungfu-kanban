// Points lib/store at a throwaway data dir for one test file. Require this
// BEFORE any ../lib module: store reads KFK_DATA_DIR once, at load time, and
// almost every lib module loads store. Without it a test reads the checkout's
// real data/ (a board with prFooter: false failed prflow's footer tests) and
// can write or even delete it (errlog and importer tests used to unlink the
// live board's data/errors.json on every run from the main checkout).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kfk-test-data-'));
process.env.KFK_DATA_DIR = DATA_DIR;

after(async () => {
  // errlog.save() debounces its write 150ms; let an in-flight one land
  // before the dir goes, or it throws ENOENT from a timer after the suite.
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

module.exports = DATA_DIR;
