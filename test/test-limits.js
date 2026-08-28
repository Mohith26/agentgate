'use strict';

const { test, assert, assertEqual, assertThrows } = require('./harness');
const { LimitBudget, LimitExceeded } = require('../src/limits');
const { QueryEngine } = require('../src/query');
const { buildOrg, buildRegistry } = require('../src/seed');
const { Runtime } = require('../src/runtime');

module.exports = function run(out) {
  test('a budget charges up to the cap and then refuses', () => {
    const b = new LimitBudget({ queryRows: 10 });
    b.charge('queryRows', 7);
    assertEqual(b.used.queryRows, 7);
    assertThrows(() => b.charge('queryRows', 5), 'LimitExceeded', 'row cap');
    assertEqual(b.used.queryRows, 7, 'a refused charge does not move the counter');
  });

  test('a refused charge names the limit, the usage and the cap', () => {
    const b = new LimitBudget({ queries: 2 });
    b.charge('queries', 2);
    const err = assertThrows(() => b.charge('queries', 1), 'LimitExceeded');
    assertEqual(err.limit, 'queries');
    assertEqual(err.cap, 2);
    assertEqual(err.used, 3);
  });

  test('a query that scans past the row cap is stopped by the engine', () => {
    const org = buildOrg({ counts: { accounts: 400, contacts: 100, opportunities: 400, cases: 50 } });
    const budget = new LimitBudget({ queryRows: 100 });
    const q = new QueryEngine(org.store, budget);
    assertThrows(() => q.select({ from: 'Opportunity', where: null }), 'LimitExceeded', 'full scan exceeds the cap');
  });

  test('the same query fits comfortably when it can use an index', () => {
    const org = buildOrg({ counts: { accounts: 400, contacts: 100, opportunities: 400, cases: 50 } });
    const budget = new LimitBudget({ queryRows: 400 });
    const q = new QueryEngine(org.store, budget);
    const res = q.select({ from: 'Opportunity', where: { op: 'eq', field: 'stage', value: 'Proposal' } });
    assert(res.scanned <= 400, 'index kept the scan inside the budget');
  });

  test('a plan that runs too many actions is cut off mid flight and unwound', () => {
    const org = buildOrg({ counts: { accounts: 60, contacts: 60, opportunities: 80, cases: 40 } });
    const rt = new Runtime({ store: org.store, sharing: org.sharing, registry: buildRegistry(), caps: { actions: 3 } });
    const admin = org.users.find((u) => u.isAdmin);
    const opps = org.store.table('Opportunity').all().slice(0, 6);
    const plan = opps.map((o) => ({ action: 'crm.opportunity.updateStage', args: { id: o.id, stage: 'Proposal' } }));
    const res = rt.run(admin, plan);
    assertEqual(res.ok, false, 'plan was refused');
    assertEqual(res.error.name, 'LimitExceeded');
    assertEqual(res.failedAt, 3, 'three actions ran before the cap bit');
    assert(res.rolledBackClean, 'the store came back to its starting fingerprint');
    if (out) out.limitCutoff = { cap: 3, ranBeforeCutoff: res.failedAt, rolledBackClean: res.rolledBackClean };
  });

  test('a successful plan reports how much of each budget it used', () => {
    const org = buildOrg({ counts: { accounts: 60, contacts: 60, opportunities: 80, cases: 40 } });
    const rt = new Runtime({ store: org.store, sharing: org.sharing, registry: buildRegistry() });
    const admin = org.users.find((u) => u.isAdmin);
    const opp = org.store.table('Opportunity').all()[0];
    const res = rt.run(admin, [{ action: 'crm.opportunity.updateStage', args: { id: opp.id, stage: 'Negotiation' } }]);
    assertEqual(res.ok, true);
    assertEqual(res.limits.actions.used, 1);
    assertEqual(res.limits.dmlStatements.used, 1);
    assert(res.limits.actions.pct > 0, 'usage is reported as a percentage of the cap');
  });
};
