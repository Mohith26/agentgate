'use strict';

const { LimitBudget, LimitExceeded } = require('./limits');
const { QueryEngine } = require('./query');
const { Telemetry } = require('./telemetry');
const { validateParams, ValidationError, PermissionError } = require('./actions');

// The runtime executes an ordered plan of actions on behalf of one user.
// Everything a plan is allowed to do goes through here: parameters are
// validated, the target record is checked against the sharing model, resource
// use is charged against a budget, and a failed step unwinds the steps that
// already ran.

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function planHash(plan) {
  const s = stableStringify(plan);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

class Runtime {
  constructor(opts) {
    this.store = opts.store;
    this.sharing = opts.sharing;
    this.registry = opts.registry;
    this.telemetry = opts.telemetry || new Telemetry(opts.clock);
    this.caps = opts.caps || {};
    this.ledger = new Map();       // idempotency key -> recorded result
    this.replays = 0;
  }

  parentLookup() {
    const store = this.store;
    return (object, id) => {
      const t = store.tables.get(object);
      return t ? t.get(id) : null;
    };
  }

  _resolveTarget(action, args) {
    if (!action.requires) return null;
    const idField = action.requires.idParam || 'id';
    const recordId = args[idField];
    if (recordId === undefined) return null;
    const table = this.store.tables.get(action.requires.object);
    const record = table ? table.get(recordId) : null;
    return { object: action.requires.object, recordId: recordId, record: record };
  }

  _authorize(user, action, args, ctx) {
    const target = this._resolveTarget(action, args);
    if (!target) return null;
    if (!target.record) {
      // Do not leak the difference between "not there" and "not yours".
      throw new PermissionError('record not accessible: ' + target.object + '/' + target.recordId, {
        object: target.object, recordId: target.recordId, reason: 'not_found_or_hidden',
      });
    }
    const level = this.sharing.resolve(user, target.object, target.record, ctx);
    const needed = action.requires.level || 'read';
    const order = { none: 0, read: 1, edit: 2 };
    if (order[level] < order[needed]) {
      throw new PermissionError(
        'user ' + user.id + ' has ' + level + ' on ' + target.object + '/' + target.recordId + ' but ' + action.name + ' needs ' + needed,
        { object: target.object, recordId: target.recordId, granted: level, needed: needed, reason: 'insufficient_access' }
      );
    }
    return target;
  }

  // plan: [{ action, args }]
  run(user, plan, opts) {
    opts = opts || {};
    const key = opts.idempotencyKey ? opts.idempotencyKey + ':' + planHash(plan) : null;
    if (key && this.ledger.has(key)) {
      this.replays += 1;
      this.telemetry.count('plan.replayed');
      return Object.assign({}, this.ledger.get(key), { replayed: true });
    }

    const budget = new LimitBudget(this.caps);
    const query = new QueryEngine(this.store, budget);
    const ctx = { parentLookup: this.parentLookup(), query: query, budget: budget, user: user, sharingModel: this.sharing };
    const before = this.store.snapshot();
    const beforeFp = require('./store').Store.fingerprint(before);

    const planSpan = this.telemetry.startSpan('plan', { user: user.id, steps: plan.length });
    const completed = [];
    const stepResults = [];

    try {
      for (let i = 0; i < plan.length; i++) {
        const step = plan[i];
        const action = this.registry.get(step.action);
        const span = this.telemetry.startSpan('action.' + action.name, { user: user.id, step: i });
        try {
          budget.charge('actions', 1);
          budget.enter();
          const args = validateParams(action.params, step.args || {});
          const target = this._authorize(user, action, args, ctx);
          if (action.mutating) budget.charge('dmlStatements', 1);
          const result = action.execute({ store: this.store, user: user, args: args, target: target, ctx: ctx });
          if (action.mutating) budget.charge('dmlRows', (result && result.rowsTouched) || 1);
          budget.exit();
          completed.push({ action: action, args: args, target: target, result: result });
          stepResults.push({ action: action.name, ok: true, result: result });
          this.telemetry.count('action.ok');
          span.end('ok');
        } catch (err) {
          budget.exit();
          span.end('error', err);
          this.telemetry.count('action.failed');
          throw err;
        }
      }

      const out = {
        ok: true,
        user: user.id,
        steps: stepResults,
        limits: budget.report(),
        replayed: false,
        fingerprint: require('./store').Store.fingerprint(this.store.snapshot()),
      };
      planSpan.end('ok');
      this.telemetry.count('plan.ok');
      if (key) this.ledger.set(key, out);
      return out;
    } catch (err) {
      const undone = this._compensate(completed, user, ctx);
      const afterFp = require('./store').Store.fingerprint(this.store.snapshot());
      planSpan.end('error', err);
      this.telemetry.count('plan.failed');
      const out = {
        ok: false,
        user: user.id,
        failedAt: completed.length,
        error: { name: err.name, message: err.message, detail: err.detail || null },
        compensated: undone,
        rolledBackClean: afterFp === beforeFp,
        fingerprintBefore: beforeFp,
        fingerprintAfter: afterFp,
        steps: stepResults,
        limits: budget.report(),
        replayed: false,
      };
      if (key) this.ledger.set(key, out);
      return out;
    }
  }

  _compensate(completed, user, ctx) {
    let undone = 0;
    for (let i = completed.length - 1; i >= 0; i--) {
      const c = completed[i];
      if (!c.action.mutating) continue;
      const span = this.telemetry.startSpan('compensate.' + c.action.name, { user: user.id });
      try {
        c.action.compensate({ store: this.store, user: user, args: c.args, target: c.target, result: c.result, ctx: ctx });
        undone += 1;
        this.telemetry.count('compensate.ok');
        span.end('ok');
      } catch (err) {
        this.telemetry.count('compensate.failed');
        span.end('error', err);
      }
    }
    return undone;
  }
}

module.exports = { Runtime, planHash, stableStringify };
