'use strict';

// Per-transaction resource ceilings, in the spirit of a multi-tenant platform
// where one tenant's runaway request must not starve the others.

class LimitExceeded extends Error {
  constructor(limit, used, cap) {
    super('governor limit exceeded: ' + limit + ' (' + used + ' > ' + cap + ')');
    this.name = 'LimitExceeded';
    this.limit = limit;
    this.used = used;
    this.cap = cap;
  }
}

const DEFAULT_CAPS = {
  queryRows: 50000,
  queries: 100,
  dmlStatements: 150,
  dmlRows: 10000,
  actions: 50,
  depth: 8,
};

class LimitBudget {
  constructor(caps) {
    this.caps = Object.assign({}, DEFAULT_CAPS, caps || {});
    this.used = { queryRows: 0, queries: 0, dmlStatements: 0, dmlRows: 0, actions: 0, depth: 0 };
  }

  charge(limit, amount) {
    if (!(limit in this.used)) throw new Error('unknown limit: ' + limit);
    const next = this.used[limit] + amount;
    if (next > this.caps[limit]) throw new LimitExceeded(limit, next, this.caps[limit]);
    this.used[limit] = next;
    return next;
  }

  enter() {
    this.used.depth += 1;
    if (this.used.depth > this.caps.depth) {
      this.used.depth -= 1;
      throw new LimitExceeded('depth', this.used.depth + 1, this.caps.depth);
    }
  }

  exit() { this.used.depth = Math.max(0, this.used.depth - 1); }

  report() {
    const out = {};
    for (const k of Object.keys(this.used)) {
      out[k] = { used: this.used[k], cap: this.caps[k], pct: this.caps[k] ? +(100 * this.used[k] / this.caps[k]).toFixed(2) : 0 };
    }
    return out;
  }
}

module.exports = { LimitBudget, LimitExceeded, DEFAULT_CAPS };
