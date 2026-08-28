'use strict';

// A small predicate-AST query engine over the store. It exists so that record
// visibility can be pushed down into the plan instead of being bolted on after
// the rows have already been read.

function compare(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  return String(a) < String(b) ? -1 : 1;
}

function evalPredicate(pred, row) {
  if (!pred) return true;
  switch (pred.op) {
    case 'and': return pred.args.every((p) => evalPredicate(p, row));
    case 'or': return pred.args.some((p) => evalPredicate(p, row));
    case 'not': return !evalPredicate(pred.arg, row);
    case 'eq': return row[pred.field] === pred.value;
    case 'ne': return row[pred.field] !== pred.value;
    case 'gt': return compare(row[pred.field], pred.value) > 0;
    case 'gte': return compare(row[pred.field], pred.value) >= 0;
    case 'lt': return compare(row[pred.field], pred.value) < 0;
    case 'lte': return compare(row[pred.field], pred.value) <= 0;
    case 'in': return pred.values.indexOf(row[pred.field]) !== -1;
    case 'contains': return String(row[pred.field] === undefined ? '' : row[pred.field]).indexOf(pred.value) !== -1;
    default: throw new Error('unsupported predicate operator: ' + pred.op);
  }
}

// Pull the equality predicates that sit in a top level AND so the planner can
// try to serve them from a hash index instead of scanning.
function equalityHints(pred) {
  if (!pred) return [];
  if (pred.op === 'eq') return [pred];
  if (pred.op === 'and') {
    let out = [];
    for (const p of pred.args) out = out.concat(equalityHints(p));
    return out;
  }
  return [];
}

class QueryEngine {
  constructor(store, budget) {
    this.store = store;
    this.budget = budget || null;
  }

  _charge(limit, amount) { if (this.budget) this.budget.charge(limit, amount); }

  // Returns { rows, scanned, usedIndex }
  select(spec) {
    const table = this.store.table(spec.from);
    this._charge('queries', 1);

    let candidates = null;
    let usedIndex = null;
    for (const hint of equalityHints(spec.where)) {
      const ids = table.idsWhereEq(hint.field, hint.value);
      if (ids !== null) {
        if (candidates === null || ids.length < candidates.length) {
          candidates = ids;
          usedIndex = hint.field;
        }
      }
    }

    const source = candidates === null
      ? table.all()
      : candidates.map((id) => table.get(id)).filter(Boolean);

    const scanned = source.length;
    this._charge('queryRows', scanned);

    let rows = [];
    for (const row of source) {
      if (evalPredicate(spec.where, row)) rows.push(row);
    }

    if (spec.visibility) {
      rows = rows.filter((r) => spec.visibility(r));
    }

    if (spec.orderBy) {
      const keys = Array.isArray(spec.orderBy) ? spec.orderBy : [spec.orderBy];
      rows = rows.slice().sort((a, b) => {
        for (const k of keys) {
          const field = typeof k === 'string' ? k : k.field;
          const dir = (typeof k === 'string' ? 'asc' : (k.dir || 'asc')) === 'desc' ? -1 : 1;
          const c = compare(a[field], b[field]);
          if (c !== 0) return c * dir;
        }
        return 0;
      });
    }

    if (typeof spec.limit === 'number') rows = rows.slice(0, spec.limit);

    if (spec.fields) {
      rows = rows.map((r) => {
        const o = {};
        for (const f of spec.fields) o[f] = r[f];
        return o;
      });
    }

    return { rows: rows, scanned: scanned, usedIndex: usedIndex };
  }

  // Hash join of a driving result set against a lookup table on a foreign key.
  join(leftRows, spec) {
    const right = this.store.table(spec.table);
    this._charge('queries', 1);
    this._charge('queryRows', right.size);
    const byKey = new Map();
    for (const row of right.all()) {
      const k = String(row[spec.rightField]);
      let bucket = byKey.get(k);
      if (!bucket) { bucket = []; byKey.set(k, bucket); }
      bucket.push(row);
    }
    const out = [];
    for (const l of leftRows) {
      const matches = byKey.get(String(l[spec.leftField])) || [];
      if (matches.length === 0 && spec.type === 'left') {
        out.push(Object.assign({}, l, { [spec.as]: null }));
      }
      for (const r of matches) out.push(Object.assign({}, l, { [spec.as]: r }));
    }
    return out;
  }

  aggregate(rows, spec) {
    const groups = new Map();
    for (const row of rows) {
      const key = (spec.groupBy || []).map((f) => String(row[f])).join('\u0001');
      let g = groups.get(key);
      if (!g) { g = []; groups.set(key, g); }
      g.push(row);
    }
    const out = [];
    for (const [key, members] of groups) {
      const rec = {};
      (spec.groupBy || []).forEach((f, i) => { rec[f] = key.split('\u0001')[i]; });
      for (const [alias, agg] of Object.entries(spec.select || {})) {
        const vals = members.map((m) => m[agg.field]).filter((v) => v !== undefined && v !== null);
        switch (agg.fn) {
          case 'count': rec[alias] = members.length; break;
          case 'sum': rec[alias] = vals.reduce((a, b) => a + b, 0); break;
          case 'avg': rec[alias] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
          case 'min': rec[alias] = vals.length ? vals.reduce((a, b) => (a < b ? a : b)) : null; break;
          case 'max': rec[alias] = vals.length ? vals.reduce((a, b) => (a > b ? a : b)) : null; break;
          default: throw new Error('unsupported aggregate: ' + agg.fn);
        }
      }
      out.push(rec);
    }
    return out;
  }
}

module.exports = { QueryEngine, evalPredicate, equalityHints, compare };
