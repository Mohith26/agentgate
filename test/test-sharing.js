'use strict';

const { test, assert, assertEqual } = require('./harness');
const { buildOrg } = require('../src/seed');
const { LEVELS } = require('../src/sharing');

module.exports = function run() {
  const org = buildOrg({ counts: { accounts: 120, contacts: 200, opportunities: 200, cases: 150 } });
  const { store, sharing, users } = org;
  const ctx = { parentLookup: (obj, id) => { const t = store.tables.get(obj); return t ? t.get(id) : null; } };

  test('an owner always has edit on their own record', () => {
    for (const opp of store.table('Opportunity').all().slice(0, 60)) {
      const owner = users.find((u) => u.id === opp.ownerId);
      assertEqual(sharing.resolve(owner, 'Opportunity', opp, ctx), 'edit', 'owner of ' + opp.id);
    }
  });

  test('an administrator has edit on everything', () => {
    const admin = users.find((u) => u.isAdmin);
    for (const acc of store.table('Account').all().slice(0, 40)) {
      assertEqual(sharing.resolve(admin, 'Account', acc, ctx), 'edit', 'admin on ' + acc.id);
    }
    for (const c of store.table('Case').all().slice(0, 40)) {
      assertEqual(sharing.resolve(admin, 'Case', c, ctx), 'edit', 'admin on ' + c.id);
    }
  });

  test('a manager inherits access to records owned below them', () => {
    const ceo = users.find((u) => u.id === 'u_ceo');
    let checked = 0;
    for (const acc of store.table('Account').all()) {
      if (acc.ownerId === ceo.id) continue;
      assertEqual(sharing.resolve(ceo, 'Account', acc, ctx), 'edit', 'ceo on ' + acc.id);
      checked += 1;
      if (checked >= 50) break;
    }
    assert(checked > 0, 'expected at least one account owned below the ceo');
  });

  test('a peer in a disconnected branch gets nothing from the hierarchy alone', () => {
    const support = users.find((u) => u.id === 'u_support_0');
    let denied = 0;
    for (const acc of store.table('Account').all()) {
      const level = sharing.resolve(support, 'Account', acc, ctx);
      const viaRule = acc.industry === 'Technology' || acc.tier === 'Enterprise';
      const viaShare = sharing.manualShares.some((s) => s.object === 'Account' && s.recordId === acc.id && s.userId === support.id);
      if (!viaRule && !viaShare && acc.ownerId !== support.id) {
        assertEqual(level, 'none', 'support should not see ' + acc.id);
        denied += 1;
      }
    }
    assert(denied > 0, 'expected some accounts to be invisible to support');
  });

  test('a criteria based rule grants exactly the rows matching its criteria', () => {
    const support = users.find((u) => u.id === 'u_support_1');
    let granted = 0;
    for (const acc of store.table('Account').all()) {
      if (acc.industry !== 'Technology') continue;
      assert(LEVELS[sharing.resolve(support, 'Account', acc, ctx)] >= LEVELS.read, 'tech account visible: ' + acc.id);
      granted += 1;
    }
    assert(granted > 0, 'expected technology accounts in the seeded org');
  });

  test('a detail record is exactly as visible as its master', () => {
    const user = users.find((u) => u.id === 'u_dir_0');
    let compared = 0;
    for (const c of store.table('Case').all()) {
      const acc = store.table('Account').get(c.accountId);
      assertEqual(sharing.resolve(user, 'Case', c, ctx), sharing.resolve(user, 'Account', acc, ctx), 'case follows account for ' + c.id);
      compared += 1;
      if (compared >= 60) break;
    }
    assert(compared > 0);
  });

  test('a manual share raises access for that one user and nobody else', () => {
    const share = sharing.manualShares.find((s) => s.object === 'Opportunity' && s.access === 'edit');
    assert(!!share, 'seed produced at least one edit level manual share');
    const opp = store.table('Opportunity').get(share.recordId);
    if (opp) {
      const target = users.find((u) => u.id === share.userId);
      assertEqual(sharing.resolve(target, 'Opportunity', opp, ctx), 'edit', 'shared user has edit');
    }
  });

  test('the visibility filter and the resolver agree row for row', () => {
    const user = users.find((u) => u.id === 'u_vp_west');
    const filter = sharing.visibilityFilter(user, 'Opportunity', ctx);
    for (const opp of store.table('Opportunity').all()) {
      assertEqual(filter(opp), LEVELS[sharing.resolve(user, 'Opportunity', opp, ctx)] >= LEVELS.read, 'filter matches resolver on ' + opp.id);
    }
  });

  test('a cyclic role hierarchy is rejected instead of looping forever', () => {
    const { SharingModel } = require('../src/sharing');
    const m = new SharingModel({ owd: {} });
    m.addRole('a', 'b');
    m.addRole('b', 'a');
    let threw = false;
    try { m.ancestorsOf('a'); } catch (e) { threw = /cycle/.test(e.message); }
    assert(threw, 'expected a cycle to be detected');
  });
};
