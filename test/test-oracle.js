'use strict';

// Differential test. The optimized resolver is compared against the naive
// reference across every user and every record in the org. Any disagreement,
// in either direction, is a bug worth failing the build over.

const { test, assert, assertEqual } = require('./harness');
const { buildOrg } = require('../src/seed');
const { LEVELS } = require('../src/sharing');

function sweep(org) {
  const { store, sharing, users } = org;
  const ctx = { parentLookup: (obj, id) => { const t = store.tables.get(obj); return t ? t.get(id) : null; } };
  const objects = ['Account', 'Contact', 'Opportunity', 'Case'];
  const stats = { pairs: 0, mismatches: [], overPermissive: 0, underPermissive: 0, grantedRead: 0, grantedEdit: 0, denied: 0 };

  for (const object of objects) {
    for (const record of store.table(object).all()) {
      for (const user of users) {
        const fast = sharing.resolve(user, object, record, ctx);
        const slow = sharing.resolveNaive(user, object, record, ctx);
        stats.pairs += 1;
        if (fast !== slow) {
          if (LEVELS[fast] > LEVELS[slow]) stats.overPermissive += 1; else stats.underPermissive += 1;
          if (stats.mismatches.length < 10) stats.mismatches.push({ object: object, record: record.id, user: user.id, fast: fast, slow: slow });
        }
        if (fast === 'edit') stats.grantedEdit += 1;
        else if (fast === 'read') stats.grantedRead += 1;
        else stats.denied += 1;
      }
    }
  }
  return stats;
}

module.exports = function run(out) {
  const org = buildOrg();
  const stats = sweep(org);

  test('the optimized resolver matches the reference on every user and record pair', () => {
    assertEqual(stats.mismatches.length, 0, 'mismatches: ' + JSON.stringify(stats.mismatches));
    assertEqual(stats.overPermissive, 0, 'over permissive decisions');
    assertEqual(stats.underPermissive, 0, 'under permissive decisions');
    assert(stats.pairs > 100000, 'sweep covered a meaningful number of pairs, got ' + stats.pairs);
  });

  test('the sweep exercises all three outcomes', () => {
    assert(stats.grantedEdit > 0, 'some pairs resolve to edit');
    assert(stats.grantedRead > 0, 'some pairs resolve to read');
    assert(stats.denied > 0, 'some pairs resolve to none');
  });

  if (out) out.oracleSweep = stats;
  return stats;
};
module.exports.sweep = sweep;
