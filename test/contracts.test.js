const DATA_DIR = require('./helpers/temp-data-dir');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const contracts = require('../lib/contracts');
const store = require('../lib/store');

const CONTRACTS_DIR = path.join(DATA_DIR, 'contracts');
const rejects400 = (fn) => assert.throws(fn, (e) => e instanceof contracts.ContractError && e.status === 400);

describe('lib/contracts', () => {
  test('first publish is version 1 and writes content plus index', () => {
    const { contract, created } = contracts.publish({ name: 'api-shape', content: 'hello\n', taskId: 'abc' });
    assert.equal(created, true);
    assert.equal(contract.version, 1);
    assert.equal(contract.name, 'api-shape');
    assert.equal(contract.ext, 'txt');
    assert.equal(contract.taskId, 'abc');
    assert.equal(contract.bytes, 6);
    assert.match(contract.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!Number.isNaN(Date.parse(contract.publishedAt)));
    assert.equal(fs.readFileSync(path.join(CONTRACTS_DIR, 'api-shape', '1.txt'), 'utf8'), 'hello\n');
    const index = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, 'index.json'), 'utf8'));
    assert.deepEqual(index['api-shape'].versions, [contract]);
  });

  test('changed content increments the version by one, each keeps its own file', () => {
    contracts.publish({ name: 'inc', content: 'one', ext: 'md' });
    const v2 = contracts.publish({ name: 'inc', content: 'two', ext: 'json' }).contract;
    const v3 = contracts.publish({ name: 'inc', content: 'three' }).contract;
    assert.deepEqual([v2.version, v3.version], [2, 3]);
    assert.equal(contracts.get('inc', 1).content, 'one');
    assert.equal(contracts.get('inc', '2').contract.ext, 'json');
    assert.equal(contracts.get('inc').content, 'three');
    assert.equal(contracts.get('inc').contract.version, 3);
  });

  test('same sha as the latest version is a no-op returning the existing version', () => {
    const first = contracts.publish({ name: 'same', content: 'x', taskId: 'first' });
    const again = contracts.publish({ name: 'same', content: 'x', taskId: 'second' });
    assert.equal(again.created, false);
    assert.deepEqual(again.contract, first.contract);
    assert.equal(contracts.get('same').contract.version, 1);
    assert.deepEqual(fs.readdirSync(path.join(CONTRACTS_DIR, 'same')), ['1.txt']);
  });

  test('republishing an OLDER body is a new version (only the latest sha is compared)', () => {
    contracts.publish({ name: 'flip', content: 'a' });
    contracts.publish({ name: 'flip', content: 'b' });
    const back = contracts.publish({ name: 'flip', content: 'a' });
    assert.equal(back.created, true);
    assert.equal(back.contract.version, 3);
  });

  test('CRLF and multi-byte content round-trip byte for byte', () => {
    const body = 'line1\r\nline2\r\n\u00e9\u4e2d\ud83d\ude00\r\n';
    const { contract } = contracts.publish({ name: 'crlf', content: body });
    assert.equal(contract.bytes, Buffer.byteLength(body));
    assert.equal(contracts.get('crlf').content, body);
  });

  test('taskId defaults to null', () => {
    assert.equal(contracts.publish({ name: 'no-task', content: 'x' }).contract.taskId, null);
  });

  test('list returns the latest metadata per name, sorted, without content', () => {
    contracts.publish({ name: 'zz-list', content: 'v1' });
    contracts.publish({ name: 'zz-list', content: 'v2' });
    contracts.publish({ name: 'aa-list', content: 'only' });
    const rows = contracts.list();
    const names = rows.map((r) => r.name);
    assert.deepEqual(names, [...names].sort());
    assert.equal(rows.find((r) => r.name === 'zz-list').version, 2);
    assert.ok(rows.every((r) => !('content' in r)));
  });

  test('index and content survive a module reload', () => {
    contracts.publish({ name: 'persist', content: 'kept' });
    for (const id of Object.keys(require.cache)) {
      if (/lib[\\/](contracts|store)\.js$/.test(id)) delete require.cache[id];
    }
    const fresh = require('../lib/contracts');
    assert.notEqual(fresh, contracts);
    assert.equal(fresh.get('persist').content, 'kept');
    assert.equal(fresh.publish({ name: 'persist', content: 'kept' }).created, false);
    assert.equal(fresh.publish({ name: 'persist', content: 'next' }).contract.version, 2);
  });

  test('names that collide with Object.prototype members behave like any other name', () => {
    assert.throws(() => contracts.get('constructor'), { status: 404 });
    assert.equal(contracts.publish({ name: 'constructor', content: 'x' }).contract.version, 1);
    assert.equal(contracts.get('constructor').content, 'x');
  });

  test('unknown name and unknown version are 404', () => {
    assert.throws(() => contracts.get('nope'), (e) => e.status === 404);
    assert.throws(() => contracts.get('inc', 99), (e) => e.status === 404);
  });

  describe('validation', () => {
    test('rejects bad names, including path traversal', () => {
      const badNames = [
        '', undefined, null, 42, {}, 'Upper', 'has space', '-lead', '.lead', '_lead', 'a/b', 'a\\b',
        '../x', '..', 'a..b', 'a/../b', '/abs', 'C:\\x', 'x'.repeat(65), 'tab\t', 'nul\0', 'trail.', 'con', 'nul',
        'com1', 'lpt9', 'con.txt', 'aux.v1', '%2e%2e',
      ];
      for (const name of badNames) {
        rejects400(() => contracts.publish({ name, content: 'x' }));
        rejects400(() => contracts.get(name));
      }
      assert.equal(contracts.publish({ name: 'x'.repeat(64), content: 'x' }).created, true);
      assert.equal(contracts.publish({ name: 'a.b_c-d', content: 'x' }).created, true);
    });

    test('rejects bad ext', () => {
      for (const ext of ['', '.txt', 'TXT', 'a/b', '../x', 'x'.repeat(11), 'tx t', 7, {}]) {
        rejects400(() => contracts.publish({ name: 'ext-bad', content: 'x', ext }));
      }
      assert.equal(contracts.publish({ name: 'ext-ok', content: 'x', ext: 'x'.repeat(10) }).created, true);
    });

    test('rejects NUL bytes and non-string content', () => {
      rejects400(() => contracts.publish({ name: 'bin', content: 'a\0b' }));
      for (const content of [undefined, null, 5, {}, ['x'], Buffer.from('x')]) {
        rejects400(() => contracts.publish({ name: 'bin', content }));
      }
    });

    test('enforces the 1 MB limit in bytes, not characters', () => {
      assert.equal(contracts.publish({ name: 'big', content: 'a'.repeat(contracts.MAX_BYTES) }).created, true);
      rejects400(() => contracts.publish({ name: 'big2', content: 'a'.repeat(contracts.MAX_BYTES + 1) }));
      // 524289 two-byte characters is under the limit as a string length but over it in bytes.
      rejects400(() => contracts.publish({ name: 'big2', content: '\u00e9'.repeat(contracts.MAX_BYTES / 2 + 1) }));
    });

    test('rejects a bad taskId and a bad version', () => {
      for (const taskId of ['', 7, {}, 'x'.repeat(101)]) {
        rejects400(() => contracts.publish({ name: 'tid', content: 'x', taskId }));
      }
      for (const v of ['0', '-1', '1.5', 'abc', '1e2', '01', '../1', '']) {
        rejects400(() => contracts.get('inc', v));
      }
    });

    test('a rejected publish leaves nothing behind', () => {
      assert.throws(() => contracts.publish({ name: 'ghost', content: 'a\0' }));
      assert.equal(fs.existsSync(path.join(CONTRACTS_DIR, 'ghost')), false);
      assert.ok(!contracts.list().some((r) => r.name === 'ghost'));
    });
  });

  test('a corrupt index is an error, not an empty store', () => {
    const indexFile = path.join(CONTRACTS_DIR, 'index.json');
    const good = fs.readFileSync(indexFile, 'utf8');
    fs.writeFileSync(indexFile, '{not json');
    try {
      assert.throws(() => contracts.publish({ name: 'after-corrupt', content: 'x' }), SyntaxError);
      assert.equal(fs.readFileSync(indexFile, 'utf8'), '{not json', 'not overwritten');
    } finally {
      fs.writeFileSync(indexFile, good);
    }
  });

  test('a hand-edited index cannot steer the content path', () => {
    const indexFile = path.join(CONTRACTS_DIR, 'index.json');
    const good = fs.readFileSync(indexFile, 'utf8');
    const index = JSON.parse(good);
    index.evil = { versions: [{ name: 'evil', version: 1, ext: '../../../tasks', sha256: 'x', bytes: 1 }] };
    fs.writeFileSync(indexFile, JSON.stringify(index));
    try {
      rejects400(() => contracts.get('evil'));
    } finally {
      fs.writeFileSync(indexFile, good);
    }
  });
});

describe('store.writeFileAtomic', () => {
  test('writes strings and Buffers, leaves no tmp file, overwrites in place', () => {
    const file = path.join(DATA_DIR, 'plain.txt');
    store.writeFileAtomic(file, 'one');
    store.writeFileAtomic(file, Buffer.from('two'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp')), []);
  });

  test('retries the rename while the file is held, like writeJsonAtomic', () => {
    const file = path.join(DATA_DIR, 'held.txt');
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      if (++calls <= 2) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
      return realRename(from, to);
    };
    try {
      store.writeFileAtomic(file, 'finally');
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(calls, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), 'finally');
  });
});
