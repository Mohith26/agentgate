'use strict';

const { buildOrg, buildRegistry } = require('../src/seed');
const { Runtime } = require('../src/runtime');
const { QueryEngine } = require('../src/query');
const { LimitBudget } = require('../src/limits');
const { Telemetry } = require('../src/telemetry');
const { sweep } = require('../test/test-oracle');

const now = Telemetry.defaultClock();

function timed(fn) {
  const t0 = now();
  const value = fn();
  return { ms: now() - t0, value: value };
}

function run() {
  const org = buildOrg();
  const ctx = { parentLookup: (obj, id) => { const t = org.store.tables.get(obj); return t ? t.get(id) : null; } };
  const out = {};

  out.dataset = {
    users: org.users.length,
    roles: org.sharing.roles.size,
    accounts: org.store.table('Account').size,
    contacts: org.store.table('Contact').size,
    opportunities: org.store.table('Opportunity').size,
    cases: org.store.table('Case').size,
    sharingRules: org.sharing.rules.length,
    manualShares: org.sharing.manualShares.length,
  };

  // Access decision throughput, optimized path against the naive reference.
  const objects = ['Account', 'Contact', 'Opportunity', 'Case'];
  const pairs = [];
  for (const object of objects) {
    for (const record of org.store.table(object).all()) {
      for (const user of org.users) pairs.push([user, object, record]);
    }
  }

  const fast = timed(() => { let n = 0; for (const [u, o, r] of pairs) { if (org.sharing.resolve(u, o, r, ctx) !== 'none') n += 1; } return n; });
  const slow = timed(() => { let n = 0; for (const [u, o, r] of pairs) { if (org.sharing.resolveNaive(u, o, r, ctx) !== 'none') n += 1; } return n; });

  out.accessDecisions = {
    pairs: pairs.length,
    optimized_ms: +fast.ms.toFixed(2),
    reference_ms: +slow.ms.toFixed(2),
    optimized_per_sec: Math.round(pairs.length / (fast.ms / 1000)),
    reference_per_sec: Math.round(pairs.length / (slow.ms / 1000)),
    speedup: +(slow.ms / fast.ms).toFixed(2),
    grantedByOptimized: fast.value,
    grantedByReference: slow.value,
  };

  // Query throughput with visibility pushed into the scan.
  const budget = new LimitBudget({ queryRows: 100000000, queries: 1000000 });
  const q = new QueryEngine(org.store, budget);
  const probe = org.users.filter((u) => !u.isAdmin);
  const filtered = timed(() => {
    let rows = 0;
    for (let i = 0; i < 200; i++) {
      const user = probe[i % probe.length];
      const res = q.select({ from: 'Opportunity', where: null, visibility: org.sharing.visibilityFilter(user, 'Opportunity', ctx) });
      rows += res.rows.length;
    }
    return rows;
  });
  out.filteredQueries = {
    queries: 200,
    rowsReturned: filtered.value,
    ms: +filtered.ms.toFixed(2),
    queries_per_sec: Math.round(200 / (filtered.ms / 1000)),
    rowsScanned: 200 * org.store.table('Opportunity').size,
  };

  // Plan throughput through the full gate.
  const rt = new Runtime({ store: org.store, sharing: org.sharing, registry: buildRegistry(), verifyRollback: false });
  const admin = org.users.find((u) => u.isAdmin);
  const opps = org.store.table('Opportunity').all();
  const plans = timed(() => {
    let ok = 0;
    for (let i = 0; i < 5000; i++) {
      const opp = opps[i % opps.length];
      const res = rt.run(admin, [{ action: 'crm.opportunity.adjustAmount', args: { id: opp.id, amount: (i % 900) * 1000 } }]);
      if (res.ok) ok += 1;
    }
    return ok;
  });
  out.planExecution = {
    plans: 5000,
    succeeded: plans.value,
    ms: +plans.ms.toFixed(2),
    plans_per_sec: Math.round(5000 / (plans.ms / 1000)),
    latency: rt.telemetry.snapshot().latency['action.crm.opportunity.adjustAmount'],
  };

  // Denials measured on the same runtime, so the gate is exercised both ways.
  const support = org.users.find((u) => u.id === 'u_support_0');
  let denied = 0;
  let allowed = 0;
  for (let i = 0; i < 1000; i++) {
    const opp = opps[i % opps.length];
    const res = rt.run(support, [{ action: 'crm.opportunity.adjustAmount', args: { id: opp.id, amount: 1 } }]);
    if (res.ok) allowed += 1; else denied += 1;
  }
  out.gate = { attempts: 1000, denied: denied, allowed: allowed };

  out.oracleSweep = (() => {
    const s = sweep(org);
    return { pairs: s.pairs, mismatches: s.mismatches.length, overPermissive: s.overPermissive, underPermissive: s.underPermissive, grantedEdit: s.grantedEdit, grantedRead: s.grantedRead, denied: s.denied };
  })();

  return out;
}

module.exports = { run: run };

if (require.main === module) {
  console.log(JSON.stringify(run(), null, 2));
}
