'use strict';

// Record visibility. Five things can grant a user access to a row:
//   1. being an administrator
//   2. owning the row
//   3. the object's org wide default
//   4. sitting above the owner in the role hierarchy
//   5. a criteria based sharing rule or an explicit manual share
// A row that no rule touches stays invisible. The resolver below is the
// optimized path; resolveNaive is the deliberately slow reference used as a
// differential oracle in the tests.

const LEVELS = { none: 0, read: 1, edit: 2 };
const NAMES = ['none', 'read', 'edit'];

function maxLevel(a, b) { return LEVELS[a] >= LEVELS[b] ? a : b; }
function owdLevel(owd) {
  if (owd === 'readWrite') return 'edit';
  if (owd === 'read') return 'read';
  return 'none';
}

class SharingModel {
  constructor(config) {
    this.owd = config.owd || {};
    this.roles = new Map();            // roleId -> { id, parentId }
    this.users = new Map();            // userId -> { id, roleId, isAdmin }
    this.rules = [];                   // criteria based sharing rules
    this.manualShares = [];            // { object, recordId, userId, access }
    this.controlledByParent = config.controlledByParent || {};
    this._dirty = true;
  }

  addRole(id, parentId) { this.roles.set(id, { id: id, parentId: parentId === undefined ? null : parentId }); this._dirty = true; return this; }
  addUser(user) { this.users.set(user.id, user); this._dirty = true; return this; }
  addRule(rule) { this.rules.push(rule); this._dirty = true; return this; }
  addManualShare(share) { this.manualShares.push(share); this._dirty = true; return this; }

  ancestorsOf(roleId) {
    const out = [];
    let cur = this.roles.get(roleId);
    const seen = new Set();
    while (cur && cur.parentId !== null && cur.parentId !== undefined) {
      if (seen.has(cur.parentId)) throw new Error('role hierarchy contains a cycle at ' + cur.parentId);
      seen.add(cur.parentId);
      out.push(cur.parentId);
      cur = this.roles.get(cur.parentId);
    }
    return out;
  }

  descendantsOf(roleId) {
    const kids = new Map();
    for (const r of this.roles.values()) {
      if (r.parentId === null || r.parentId === undefined) continue;
      if (!kids.has(r.parentId)) kids.set(r.parentId, []);
      kids.get(r.parentId).push(r.id);
    }
    const out = new Set();
    const stack = (kids.get(roleId) || []).slice();
    while (stack.length) {
      const id = stack.pop();
      if (out.has(id)) continue;
      out.add(id);
      for (const c of (kids.get(id) || [])) stack.push(c);
    }
    return out;
  }

  compile() {
    this._ancestors = new Map();
    this._descendants = new Map();
    for (const roleId of this.roles.keys()) {
      this._ancestors.set(roleId, new Set(this.ancestorsOf(roleId)));
      this._descendants.set(roleId, this.descendantsOf(roleId));
    }

    // Expand each sharing rule into the concrete set of users it grants to.
    this._rulesByObject = new Map();
    for (const rule of this.rules) {
      const grantees = new Set();
      const roleIds = new Set([rule.grantToRoleId]);
      if (rule.includeSubordinates) {
        for (const d of (this._descendants.get(rule.grantToRoleId) || new Set())) roleIds.add(d);
      }
      for (const u of this.users.values()) if (roleIds.has(u.roleId)) grantees.add(u.id);
      const compiled = Object.assign({}, rule, { grantees: grantees });
      if (!this._rulesByObject.has(rule.object)) this._rulesByObject.set(rule.object, []);
      this._rulesByObject.get(rule.object).push(compiled);
    }

    this._shareIndex = new Map();
    for (const s of this.manualShares) {
      const key = s.object + '\u0001' + s.recordId + '\u0001' + s.userId;
      const prev = this._shareIndex.get(key);
      this._shareIndex.set(key, prev ? maxLevel(prev, s.access) : s.access);
    }

    this._criteriaCache = new Map();
    this._dirty = false;
    return this;
  }

  _ensure() { if (this._dirty) this.compile(); }

  // resolve(user, object, record, ctx) -> 'none' | 'read' | 'edit'
  // ctx.parentLookup(object, id) supplies the parent row for objects whose
  // visibility is controlled by their master record.
  resolve(user, object, record, ctx) {
    this._ensure();
    if (!record) return 'none';
    if (user.isAdmin) return 'edit';

    const parentCfg = this.controlledByParent[object];
    if (parentCfg) {
      const parent = ctx && ctx.parentLookup ? ctx.parentLookup(parentCfg.object, record[parentCfg.field]) : null;
      // A detail row is exactly as visible as its master, never more.
      return this.resolve(user, parentCfg.object, parent, ctx);
    }

    if (record.ownerId === user.id) return 'edit';

    let level = owdLevel(this.owd[object] || 'private');
    if (level === 'edit') return 'edit';

    const owner = this.users.get(record.ownerId);
    if (owner && owner.roleId && user.roleId) {
      const ownerAncestors = this._ancestors.get(owner.roleId);
      if (ownerAncestors && ownerAncestors.has(user.roleId)) return 'edit';
    }

    const shareKey = object + '\u0001' + record.id + '\u0001' + user.id;
    const manual = this._shareIndex.get(shareKey);
    if (manual) {
      level = maxLevel(level, manual);
      if (level === 'edit') return 'edit';
    }

    for (const rule of (this._rulesByObject.get(object) || [])) {
      if (!rule.grantees.has(user.id)) continue;
      const cacheKey = rule.id + '\u0001' + record.id;
      let matched = this._criteriaCache.get(cacheKey);
      if (matched === undefined) {
        matched = !!rule.criteria(record);
        this._criteriaCache.set(cacheKey, matched);
      }
      if (matched) {
        level = maxLevel(level, rule.access);
        if (level === 'edit') return 'edit';
      }
    }

    return level;
  }

  // Reference implementation. Same semantics, no precomputation, no caching.
  resolveNaive(user, object, record, ctx) {
    if (!record) return 'none';
    if (user.isAdmin) return 'edit';

    const parentCfg = this.controlledByParent[object];
    if (parentCfg) {
      const parent = ctx && ctx.parentLookup ? ctx.parentLookup(parentCfg.object, record[parentCfg.field]) : null;
      return this.resolveNaive(user, parentCfg.object, parent, ctx);
    }

    if (record.ownerId === user.id) return 'edit';

    let level = owdLevel(this.owd[object] || 'private');

    const owner = this.users.get(record.ownerId);
    if (owner && owner.roleId && user.roleId) {
      if (this.ancestorsOf(owner.roleId).indexOf(user.roleId) !== -1) level = maxLevel(level, 'edit');
    }

    for (const s of this.manualShares) {
      if (s.object === object && s.recordId === record.id && s.userId === user.id) {
        level = maxLevel(level, s.access);
      }
    }

    for (const rule of this.rules) {
      if (rule.object !== object) continue;
      const roleIds = [rule.grantToRoleId];
      if (rule.includeSubordinates) for (const d of this.descendantsOf(rule.grantToRoleId)) roleIds.push(d);
      if (roleIds.indexOf(user.roleId) === -1) continue;
      if (rule.criteria(record)) level = maxLevel(level, rule.access);
    }

    return level;
  }

  canRead(user, object, record, ctx) { return LEVELS[this.resolve(user, object, record, ctx)] >= LEVELS.read; }
  canEdit(user, object, record, ctx) { return LEVELS[this.resolve(user, object, record, ctx)] >= LEVELS.edit; }

  // A predicate the query engine can apply while it walks candidate rows, so
  // invisible rows never reach the caller in the first place.
  visibilityFilter(user, object, ctx) {
    this._ensure();
    return (record) => this.canRead(user, object, record, ctx);
  }
}

module.exports = { SharingModel, LEVELS, NAMES, maxLevel, owdLevel };
