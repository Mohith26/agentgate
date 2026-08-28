'use strict';

const { Store } = require('./store');
const { SharingModel } = require('./sharing');
const { ActionRegistry } = require('./actions');

// Deterministic PRNG so every run of the tests and the benchmark sees the
// exact same synthetic org. No real customer data is used anywhere.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['EAST', 'WEST'];
const INDUSTRIES = ['Technology', 'Manufacturing', 'Healthcare', 'Retail', 'Energy'];
const TIERS = ['SMB', 'MidMarket', 'Enterprise'];
const STAGES = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'ClosedWon', 'ClosedLost'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

function buildOrg(opts) {
  opts = opts || {};
  const counts = Object.assign({ accounts: 500, contacts: 1500, opportunities: 1200, cases: 800 }, opts.counts || {});
  const rnd = mulberry32(opts.seed === undefined ? 20270601 : opts.seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const store = new Store();
  store.define('Account', { indexes: ['ownerId', 'region', 'tier'] });
  store.define('Contact', { indexes: ['accountId', 'ownerId'] });
  store.define('Opportunity', { indexes: ['ownerId', 'accountId', 'stage', 'region'] });
  store.define('Case', { indexes: ['accountId', 'priority'] });

  const sharing = new SharingModel({
    owd: { Account: 'private', Opportunity: 'private' },
    controlledByParent: {
      Contact: { object: 'Account', field: 'accountId' },
      Case: { object: 'Account', field: 'accountId' },
    },
  });

  // Role hierarchy: one sales tree plus a support tree that is deliberately
  // disconnected, so hierarchy access alone can never reach support users.
  sharing.addRole('ceo', null);
  sharing.addRole('vp_east', 'ceo');
  sharing.addRole('vp_west', 'ceo');
  const dirRoles = [];
  for (const vp of ['vp_east', 'vp_west']) {
    for (let d = 1; d <= 2; d++) {
      const id = vp.replace('vp_', 'dir_') + '_' + d;
      sharing.addRole(id, vp);
      dirRoles.push(id);
    }
  }
  const repRoles = [];
  for (const dir of dirRoles) {
    for (let r = 1; r <= 2; r++) {
      const id = dir.replace('dir_', 'rep_') + '_' + r;
      sharing.addRole(id, dir);
      repRoles.push(id);
    }
  }
  sharing.addRole('support', null);
  sharing.addRole('support_agent', 'support');

  const users = [];
  const addUser = (id, roleId, isAdmin) => {
    const u = { id: id, roleId: roleId, isAdmin: !!isAdmin };
    sharing.addUser(u);
    users.push(u);
    return u;
  };
  addUser('u_admin', 'ceo', true);
  addUser('u_ceo', 'ceo', false);
  addUser('u_vp_east', 'vp_east', false);
  addUser('u_vp_west', 'vp_west', false);
  dirRoles.forEach((r, i) => addUser('u_dir_' + i, r, false));
  repRoles.forEach((r, i) => {
    addUser('u_rep_' + i + 'a', r, false);
    addUser('u_rep_' + i + 'b', r, false);
  });
  for (let i = 0; i < 6; i++) addUser('u_support_' + i, 'support_agent', false);

  const owners = users.filter((u) => u.roleId.indexOf('rep_') === 0 || u.roleId.indexOf('dir_') === 0);

  const accounts = [];
  for (let i = 0; i < counts.accounts; i++) {
    const region = pick(REGIONS);
    const candidates = owners.filter((o) => o.roleId.indexOf(region === 'EAST' ? 'east' : 'west') !== -1);
    const owner = candidates.length ? candidates[Math.floor(rnd() * candidates.length)] : pick(owners);
    accounts.push(store.table('Account').insert({
      id: 'acc_' + i,
      name: 'Account ' + i,
      ownerId: owner.id,
      region: region,
      industry: pick(INDUSTRIES),
      tier: pick(TIERS),
      arr: Math.round(rnd() * 4000000),
    }));
  }

  for (let i = 0; i < counts.contacts; i++) {
    const acc = accounts[Math.floor(rnd() * accounts.length)];
    store.table('Contact').insert({
      id: 'con_' + i,
      name: 'Contact ' + i,
      accountId: acc.id,
      ownerId: acc.ownerId,
      email: 'contact' + i + '@example.invalid',
      title: 'Title ' + (i % 17),
    });
  }

  for (let i = 0; i < counts.opportunities; i++) {
    const acc = accounts[Math.floor(rnd() * accounts.length)];
    const owner = rnd() < 0.7 ? acc.ownerId : pick(owners).id;
    store.table('Opportunity').insert({
      id: 'opp_' + i,
      name: 'Opportunity ' + i,
      accountId: acc.id,
      ownerId: owner,
      region: acc.region,
      stage: pick(STAGES),
      amount: Math.round(rnd() * 1000000),
      probability: Math.round(rnd() * 100),
    });
  }

  for (let i = 0; i < counts.cases; i++) {
    const acc = accounts[Math.floor(rnd() * accounts.length)];
    store.table('Case').insert({
      id: 'case_' + i,
      subject: 'Case ' + i,
      accountId: acc.id,
      priority: pick(PRIORITIES),
      status: rnd() < 0.4 ? 'Closed' : 'Open',
      escalated: false,
    });
  }

  // Criteria based sharing rules.
  sharing.addRule({
    id: 'rule_tech_accounts',
    object: 'Account',
    criteria: (r) => r.industry === 'Technology',
    grantToRoleId: 'support',
    includeSubordinates: true,
    access: 'read',
  });
  sharing.addRule({
    id: 'rule_enterprise_accounts',
    object: 'Account',
    criteria: (r) => r.tier === 'Enterprise',
    grantToRoleId: 'support_agent',
    includeSubordinates: false,
    access: 'edit',
  });
  sharing.addRule({
    id: 'rule_cross_region_big_deals',
    object: 'Opportunity',
    criteria: (r) => r.amount >= 750000 && r.region === 'EAST',
    grantToRoleId: 'vp_west',
    includeSubordinates: true,
    access: 'read',
  });
  sharing.addRule({
    id: 'rule_negotiation_visibility',
    object: 'Opportunity',
    criteria: (r) => r.stage === 'Negotiation',
    grantToRoleId: 'dir_west_1',
    includeSubordinates: true,
    access: 'read',
  });

  // A handful of explicit one off shares.
  const opps = store.table('Opportunity').all();
  for (let i = 0; i < 40; i++) {
    const opp = opps[Math.floor(rnd() * opps.length)];
    const user = users[Math.floor(rnd() * users.length)];
    sharing.addManualShare({ object: 'Opportunity', recordId: opp.id, userId: user.id, access: rnd() < 0.5 ? 'read' : 'edit' });
  }
  const accs = store.table('Account').all();
  for (let i = 0; i < 25; i++) {
    const acc = accs[Math.floor(rnd() * accs.length)];
    const user = users[Math.floor(rnd() * users.length)];
    sharing.addManualShare({ object: 'Account', recordId: acc.id, userId: user.id, access: 'read' });
  }

  sharing.bindTo(store);
  sharing.compile();
  return { store: store, sharing: sharing, users: users, counts: counts };
}

function buildRegistry() {
  const registry = new ActionRegistry();

  registry.define({
    name: 'crm.opportunity.updateStage',
    params: { id: { type: 'id', required: true }, stage: { type: 'string', required: true, enum: STAGES } },
    requires: { object: 'Opportunity', level: 'edit', idParam: 'id' },
    execute: ({ store, args, target }) => {
      const prev = target.record.stage;
      store.table('Opportunity').update(args.id, { stage: args.stage });
      return { previousStage: prev, rowsTouched: 1 };
    },
    compensate: ({ store, args, result }) => {
      store.table('Opportunity').update(args.id, { stage: result.previousStage });
    },
  });

  registry.define({
    name: 'crm.opportunity.adjustAmount',
    params: { id: { type: 'id', required: true }, amount: { type: 'number', required: true, min: 0, max: 100000000 } },
    requires: { object: 'Opportunity', level: 'edit', idParam: 'id' },
    execute: ({ store, args, target }) => {
      const prev = target.record.amount;
      store.table('Opportunity').update(args.id, { amount: args.amount });
      return { previousAmount: prev, rowsTouched: 1 };
    },
    compensate: ({ store, args, result }) => {
      store.table('Opportunity').update(args.id, { amount: result.previousAmount });
    },
  });

  registry.define({
    name: 'crm.account.updateTier',
    params: { id: { type: 'id', required: true }, tier: { type: 'string', required: true, enum: TIERS } },
    requires: { object: 'Account', level: 'edit', idParam: 'id' },
    execute: ({ store, args, target }) => {
      const prev = target.record.tier;
      store.table('Account').update(args.id, { tier: args.tier });
      return { previousTier: prev, rowsTouched: 1 };
    },
    compensate: ({ store, args, result }) => {
      store.table('Account').update(args.id, { tier: result.previousTier });
    },
  });

  registry.define({
    name: 'crm.case.escalate',
    params: { id: { type: 'id', required: true }, priority: { type: 'string', required: true, enum: PRIORITIES } },
    requires: { object: 'Case', level: 'edit', idParam: 'id' },
    execute: ({ store, args, target }) => {
      const prev = { priority: target.record.priority, escalated: target.record.escalated };
      store.table('Case').update(args.id, { priority: args.priority, escalated: true });
      return { previous: prev, rowsTouched: 1 };
    },
    compensate: ({ store, args, result }) => {
      store.table('Case').update(args.id, result.previous);
    },
  });

  registry.define({
    name: 'crm.contact.setTitle',
    params: { id: { type: 'id', required: true }, title: { type: 'string', required: true, maxLength: 80 } },
    requires: { object: 'Contact', level: 'edit', idParam: 'id' },
    execute: ({ store, args, target }) => {
      const prev = target.record.title;
      store.table('Contact').update(args.id, { title: args.title });
      return { previousTitle: prev, rowsTouched: 1 };
    },
    compensate: ({ store, args, result }) => {
      store.table('Contact').update(args.id, { title: result.previousTitle });
    },
  });

  // Read only. Everything it returns has already passed the visibility filter.
  registry.define({
    name: 'crm.pipeline.summarize',
    mutating: false,
    params: { stage: { type: 'string', required: false, enum: STAGES }, limit: { type: 'number', required: false, default: 200, min: 1, max: 2000 } },
    execute: ({ user, args, ctx }) => {
      const where = args.stage ? { op: 'eq', field: 'stage', value: args.stage } : null;
      const res = ctx.query.select({
        from: 'Opportunity',
        where: where,
        visibility: (r) => ctx.sharingModel.canRead(user, 'Opportunity', r, ctx),
        orderBy: [{ field: 'amount', dir: 'desc' }],
        limit: args.limit,
      });
      const total = res.rows.reduce((a, r) => a + r.amount, 0);
      return { visible: res.rows.length, scanned: res.scanned, usedIndex: res.usedIndex, totalAmount: total };
    },
  });

  // Deliberately fails. Used to prove that a partially applied plan unwinds.
  registry.define({
    name: 'test.alwaysFails',
    params: { reason: { type: 'string', required: false, default: 'injected failure' } },
    mutating: false,
    execute: ({ args }) => { const e = new Error(args.reason); e.name = 'InjectedFailure'; throw e; },
  });

  return registry;
}

module.exports = { buildOrg, buildRegistry, mulberry32, REGIONS, INDUSTRIES, TIERS, STAGES, PRIORITIES };
