'use strict';

const { test, assert, assertEqual } = require('./harness');
const { buildOrg, buildRegistry } = require('../src/seed');
const { Runtime } = require('../src/runtime');
const { Store } = require('../src/store');

function newRuntime(counts) {
  const org = buildOrg({ counts: counts || { accounts: 150, contacts: 200, opportunities: 250, cases: 120 } });
  const rt = new Runtime({ store: org.store, sharing: org.sharing, registry: buildRegistry() });
  return { org: org, rt: rt };
}

module.exports = function run(out) {
  test('an action on a record the user owns is allowed', () => {
    const { org, rt } = newRuntime();
    const opp = org.store.table('Opportunity').all()[0];
    const owner = org.users.find((u) => u.id === opp.ownerId);
    const res = rt.run(owner, [{ action: 'crm.opportunity.updateStage', args: { id: opp.id, stage: 'Proposal' } }]);
    assertEqual(res.ok, true, res.ok ? '' : JSON.stringify(res.error));
    assertEqual(org.store.table('Opportunity').get(opp.id).stage, 'Proposal');
  });

  test('an action on an invisible record is refused with a structured reason', () => {
    const { org, rt } = newRuntime();
    const support = org.users.find((u) => u.id === 'u_support_0');
    const opp = org.store.table('Opportunity').all().find((o) => !org.sharing.canRead(support, 'Opportunity', o, { parentLookup: rt.parentLookup() }));
    assert(!!opp, 'found an opportunity the support user cannot see');
    const before = org.store.table('Opportunity').get(opp.id).stage;
    const res = rt.run(support, [{ action: 'crm.opportunity.updateStage', args: { id: opp.id, stage: 'ClosedWon' } }]);
    assertEqual(res.ok, false);
    assertEqual(res.error.name, 'PermissionError');
    assertEqual(res.error.detail.reason, 'insufficient_access');
    assertEqual(org.store.table('Opportunity').get(opp.id).stage, before, 'the record was not touched');
  });

  test('read access is not enough for an action that needs edit', () => {
    const { org, rt } = newRuntime();
    const ctx = { parentLookup: rt.parentLookup() };
    const vpWest = org.users.find((u) => u.id === 'u_vp_west');
    const opp = org.store.table('Opportunity').all().find((o) => org.sharing.resolve(vpWest, 'Opportunity', o, ctx) === 'read');
    assert(!!opp, 'found a read only opportunity for the west vp');
    const res = rt.run(vpWest, [{ action: 'crm.opportunity.adjustAmount', args: { id: opp.id, amount: 1 } }]);
    assertEqual(res.ok, false);
    assertEqual(res.error.detail.granted, 'read');
    assertEqual(res.error.detail.needed, 'edit');
  });

  test('a missing record and a hidden record fail the same way', () => {
    const { org, rt } = newRuntime();
    const support = org.users.find((u) => u.id === 'u_support_0');
    const res = rt.run(support, [{ action: 'crm.opportunity.updateStage', args: { id: 'opp_does_not_exist', stage: 'Proposal' } }]);
    assertEqual(res.ok, false);
    assertEqual(res.error.name, 'PermissionError');
    assertEqual(res.error.detail.reason, 'not_found_or_hidden');
  });

  test('bad parameters are caught before anything executes', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opp = org.store.table('Opportunity').all()[0];
    const bad = [
      { args: { id: opp.id, stage: 'NotAStage' }, why: 'value outside the enum' },
      { args: { id: opp.id }, why: 'missing required parameter' },
      { args: { id: opp.id, stage: 'Proposal', extra: 1 }, why: 'unexpected parameter' },
    ];
    for (const c of bad) {
      const res = rt.run(admin, [{ action: 'crm.opportunity.updateStage', args: c.args }]);
      assertEqual(res.ok, false, c.why);
      assertEqual(res.error.name, 'ValidationError', c.why);
    }
    const res2 = rt.run(admin, [{ action: 'crm.opportunity.adjustAmount', args: { id: opp.id, amount: -5 } }]);
    assertEqual(res2.ok, false, 'a negative amount is out of range');
  });

  test('a plan that fails halfway leaves the store exactly as it found it', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opps = org.store.table('Opportunity').all().slice(0, 3);
    const acc = org.store.table('Account').all()[0];
    const before = Store.fingerprint(org.store.snapshot());
    const plan = [
      { action: 'crm.opportunity.updateStage', args: { id: opps[0].id, stage: 'Negotiation' } },
      { action: 'crm.opportunity.adjustAmount', args: { id: opps[1].id, amount: 4242 } },
      { action: 'crm.account.updateTier', args: { id: acc.id, tier: 'Enterprise' } },
      { action: 'test.alwaysFails', args: { reason: 'downstream service is unavailable' } },
    ];
    const res = rt.run(admin, plan);
    assertEqual(res.ok, false);
    assertEqual(res.error.name, 'InjectedFailure');
    assertEqual(res.compensated, 3, 'all three mutating steps were undone');
    assertEqual(res.rolledBackClean, true, 'fingerprints match');
    assertEqual(Store.fingerprint(org.store.snapshot()), before, 'store fingerprint is unchanged');
  });

  test('rollback holds no matter which step is the one that fails', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opps = org.store.table('Opportunity').all().slice(0, 5);
    let scenarios = 0;
    for (let failAt = 0; failAt <= 4; failAt++) {
      const before = Store.fingerprint(org.store.snapshot());
      const plan = [];
      for (let i = 0; i < 5; i++) {
        if (i === failAt) plan.push({ action: 'test.alwaysFails', args: { reason: 'fail at step ' + i } });
        else plan.push({ action: 'crm.opportunity.adjustAmount', args: { id: opps[i].id, amount: 1000 + i } });
      }
      const res = rt.run(admin, plan);
      assertEqual(res.ok, false, 'scenario ' + failAt);
      assertEqual(res.rolledBackClean, true, 'scenario ' + failAt + ' rolled back clean');
      assertEqual(Store.fingerprint(org.store.snapshot()), before, 'scenario ' + failAt + ' fingerprint restored');
      scenarios += 1;
    }
    if (out) out.rollbackScenarios = { scenarios: scenarios, cleanRollbacks: scenarios };
  });

  test('a replayed plan is served from the ledger and does not run twice', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opp = org.store.table('Opportunity').all()[0];
    const plan = [{ action: 'crm.opportunity.adjustAmount', args: { id: opp.id, amount: 777 } }];
    const first = rt.run(admin, plan, { idempotencyKey: 'req-1' });
    assertEqual(first.ok, true);
    assertEqual(first.replayed, false);
    const previous = first.steps[0].result.previousAmount;
    for (let i = 0; i < 200; i++) {
      const again = rt.run(admin, plan, { idempotencyKey: 'req-1' });
      assertEqual(again.replayed, true, 'retry ' + i + ' was served from the ledger');
      assertEqual(again.steps[0].result.previousAmount, previous, 'retry ' + i + ' returned the original result');
    }
    assertEqual(org.store.table('Opportunity').get(opp.id).amount, 777, 'the amount was only ever written once');
    assertEqual(rt.replays, 200);
    if (out) out.idempotency = { duplicateSubmissions: 200, reExecutions: 0, ledgerHits: rt.replays };
  });

  test('a different plan under the same key is treated as a new request', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opps = org.store.table('Opportunity').all().slice(0, 2);
    rt.run(admin, [{ action: 'crm.opportunity.adjustAmount', args: { id: opps[0].id, amount: 10 } }], { idempotencyKey: 'k' });
    const second = rt.run(admin, [{ action: 'crm.opportunity.adjustAmount', args: { id: opps[1].id, amount: 20 } }], { idempotencyKey: 'k' });
    assertEqual(second.replayed, false, 'the plan body is part of the key');
    assertEqual(org.store.table('Opportunity').get(opps[1].id).amount, 20);
  });

  test('a read only action returns only rows the caller can see', () => {
    const { org, rt } = newRuntime();
    const ctx = { parentLookup: rt.parentLookup() };
    for (const userId of ['u_rep_0a', 'u_vp_east', 'u_support_2', 'u_ceo']) {
      const user = org.users.find((u) => u.id === userId);
      const res = rt.run(user, [{ action: 'crm.pipeline.summarize', args: { limit: 2000 } }]);
      assertEqual(res.ok, true, userId + ': ' + (res.ok ? '' : JSON.stringify(res.error)));
      const expected = org.store.table('Opportunity').all().filter((o) => org.sharing.canRead(user, 'Opportunity', o, ctx)).length;
      assertEqual(res.steps[0].result.visible, expected, 'visible count for ' + userId);
    }
  });

  test('every action emits a span with a duration and a status', () => {
    const { org, rt } = newRuntime();
    const admin = org.users.find((u) => u.isAdmin);
    const opp = org.store.table('Opportunity').all()[0];
    rt.run(admin, [{ action: 'crm.opportunity.updateStage', args: { id: opp.id, stage: 'Proposal' } }]);
    rt.run(admin, [{ action: 'test.alwaysFails', args: {} }]);
    const snap = rt.telemetry.snapshot();
    assert(snap.spans >= 4, 'plan and action spans were both recorded');
    assertEqual(snap.counters['action.ok'], 1);
    assertEqual(snap.counters['action.failed'], 1);
    // Two spans see the same throw: the action span and the plan span that wraps it.
    assertEqual(snap.errors.InjectedFailure, 2, 'the failure was classified by error name on both spans');
    assert(snap.latency['action.crm.opportunity.updateStage'].count === 1, 'per action latency was recorded');
  });
};
