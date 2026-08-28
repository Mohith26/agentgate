'use strict';

const { test, assert, assertEqual, assertThrows } = require('./harness');
const { buildOrg } = require('../src/seed');
const { QueryEngine, evalPredicate } = require('../src/query');
const { LimitBudget } = require('../src/limits');

module.exports = function run(out) {
  const org = buildOrg({ counts: { accounts: 300, contacts: 400, opportunities: 600, cases: 200 } });
  const { store, sharing, users } = org;
  const ctx = { parentLookup: (obj, id) => { const t = store.tables.get(obj); return t ? t.get(id) : null; } };
  const q = new QueryEngine(store, new LimitBudget({ queryRows: 10000000, queries: 10000 }));

  test('an equality predicate on an indexed field avoids a full scan', () => {
    const res = q.select({ from: 'Opportunity', where: { op: 'eq', field: 'stage', value: 'Proposal' } });
    assertEqual(res.usedIndex, 'stage', 'planner picked the stage index');
    assert(res.scanned < store.table('Opportunity').size, 'scanned fewer rows than the table holds');
    assert(res.rows.every((r) => r.stage === 'Proposal'), 'every row matches');
  });

  test('the planner picks the most selective available index', () => {
    const res = q.select({
      from: 'Opportunity',
      where: { op: 'and', args: [
        { op: 'eq', field: 'region', value: 'EAST' },
        { op: 'eq', field: 'stage', value: 'Negotiation' },
      ] },
    });
    assert(res.usedIndex === 'stage' || res.usedIndex === 'region', 'used one of the two indexes');
    const scanA = store.table('Opportunity').idsWhereEq('region', 'EAST').length;
    const scanB = store.table('Opportunity').idsWhereEq('stage', 'Negotiation').length;
    assertEqual(res.scanned, Math.min(scanA, scanB), 'scanned the smaller candidate set');
  });

  test('an unindexed predicate still returns the same rows as a manual filter', () => {
    const pred = { op: 'gte', field: 'amount', value: 500000 };
    const res = q.select({ from: 'Opportunity', where: pred });
    const expected = store.table('Opportunity').all().filter((r) => evalPredicate(pred, r));
    assertEqual(res.rows.length, expected.length, 'row counts agree');
  });

  test('boolean composition behaves like plain javascript', () => {
    const pred = { op: 'or', args: [
      { op: 'and', args: [{ op: 'eq', field: 'region', value: 'WEST' }, { op: 'gt', field: 'amount', value: 900000 }] },
      { op: 'in', field: 'stage', values: ['ClosedWon'] },
    ] };
    const res = q.select({ from: 'Opportunity', where: pred });
    const expected = store.table('Opportunity').all().filter((r) => (r.region === 'WEST' && r.amount > 900000) || r.stage === 'ClosedWon');
    assertEqual(res.rows.length, expected.length);
  });

  test('ordering and limiting are applied after filtering', () => {
    const res = q.select({ from: 'Opportunity', where: null, orderBy: [{ field: 'amount', dir: 'desc' }], limit: 10 });
    assertEqual(res.rows.length, 10);
    for (let i = 1; i < res.rows.length; i++) assert(res.rows[i - 1].amount >= res.rows[i].amount, 'descending by amount');
  });

  test('a visibility filter never returns a row the resolver would deny', () => {
    const user = users.find((u) => u.id === 'u_rep_0a');
    const res = q.select({ from: 'Opportunity', where: null, visibility: sharing.visibilityFilter(user, 'Opportunity', ctx) });
    for (const row of res.rows) {
      assert(sharing.canRead(user, 'Opportunity', row, ctx), 'returned row is readable: ' + row.id);
    }
    const all = store.table('Opportunity').all().filter((r) => sharing.canRead(user, 'Opportunity', r, ctx));
    assertEqual(res.rows.length, all.length, 'no readable row was dropped');
    if (out) out.visibilityPushdown = { user: user.id, total: store.table('Opportunity').size, visible: res.rows.length };
  });

  test('a hash join attaches the parent row to each child', () => {
    const contacts = q.select({ from: 'Contact', where: null, limit: 50 }).rows;
    const joined = q.join(contacts, { table: 'Account', leftField: 'accountId', rightField: 'id', as: 'account', type: 'inner' });
    assertEqual(joined.length, contacts.length, 'every contact matched exactly one account');
    for (const row of joined) assertEqual(row.account.id, row.accountId, 'join key lines up');
  });

  test('grouped aggregates agree with a hand rolled reduction', () => {
    const rows = q.select({ from: 'Opportunity', where: null }).rows;
    const agg = q.aggregate(rows, { groupBy: ['stage'], select: { n: { fn: 'count' }, total: { fn: 'sum', field: 'amount' }, biggest: { fn: 'max', field: 'amount' } } });
    const manual = new Map();
    for (const r of rows) {
      const cur = manual.get(r.stage) || { n: 0, total: 0, biggest: -1 };
      cur.n += 1; cur.total += r.amount; cur.biggest = Math.max(cur.biggest, r.amount);
      manual.set(r.stage, cur);
    }
    assertEqual(agg.length, manual.size, 'same number of groups');
    for (const g of agg) {
      const m = manual.get(g.stage);
      assertEqual(g.n, m.n, 'count for ' + g.stage);
      assertEqual(g.total, m.total, 'sum for ' + g.stage);
      assertEqual(g.biggest, m.biggest, 'max for ' + g.stage);
    }
  });

  test('an unsupported operator is rejected rather than silently ignored', () => {
    assertThrows(() => q.select({ from: 'Opportunity', where: { op: 'regex', field: 'name', value: 'x' } }), 'Error', 'unknown operator');
  });
};
