'use strict';

// A tiny in-memory relational store. Tables hold plain row objects keyed by a
// string primary key, plus optional secondary hash indexes so the query engine
// can avoid full scans on equality predicates.

class Table {
  constructor(name, opts) {
    opts = opts || {};
    this.name = name;
    this.pk = opts.pk || 'id';
    this.rows = new Map();
    this.indexes = new Map();
    this.onChange = opts.onChange || null;
    (opts.indexes || []).forEach((f) => this.indexes.set(f, new Map()));
  }

  _notify(op, row) {
    if (this.onChange) this.onChange(this.name, op, row);
  }

  _indexAdd(row) {
    for (const [field, idx] of this.indexes) {
      const key = String(row[field]);
      let bucket = idx.get(key);
      if (!bucket) { bucket = new Set(); idx.set(key, bucket); }
      bucket.add(row[this.pk]);
    }
  }

  _indexRemove(row) {
    for (const [field, idx] of this.indexes) {
      const bucket = idx.get(String(row[field]));
      if (bucket) {
        bucket.delete(row[this.pk]);
        if (bucket.size === 0) idx.delete(String(row[field]));
      }
    }
  }

  insert(row) {
    const id = row[this.pk];
    if (id === undefined || id === null) throw new Error(this.name + ': row is missing primary key ' + this.pk);
    if (this.rows.has(id)) throw new Error(this.name + ': duplicate primary key ' + id);
    const copy = Object.assign({}, row);
    this.rows.set(id, copy);
    this._indexAdd(copy);
    this._notify('insert', copy);
    return copy;
  }

  get(id) { return this.rows.get(id) || null; }

  update(id, patch) {
    const cur = this.rows.get(id);
    if (!cur) throw new Error(this.name + ': no row with key ' + id);
    this._indexRemove(cur);
    const next = Object.assign({}, cur, patch);
    next[this.pk] = id;
    this.rows.set(id, next);
    this._indexAdd(next);
    this._notify('update', next);
    return next;
  }

  remove(id) {
    const cur = this.rows.get(id);
    if (!cur) return false;
    this._indexRemove(cur);
    this.rows.delete(id);
    this._notify('remove', cur);
    return true;
  }

  idsWhereEq(field, value) {
    const idx = this.indexes.get(field);
    if (!idx) return null;
    const bucket = idx.get(String(value));
    return bucket ? Array.from(bucket) : [];
  }

  all() { return Array.from(this.rows.values()); }
  get size() { return this.rows.size; }
}

class Store {
  constructor() { this.tables = new Map(); this.listeners = []; }

  // Anything that caches a decision about a row needs to hear when the row
  // changes underneath it.
  onChange(fn) { this.listeners.push(fn); return this; }

  define(name, opts) {
    if (this.tables.has(name)) throw new Error('table already defined: ' + name);
    const self = this;
    const t = new Table(name, Object.assign({}, opts, {
      onChange: (table, op, row) => { for (const fn of self.listeners) fn(table, op, row); },
    }));
    this.tables.set(name, t);
    return t;
  }

  table(name) {
    const t = this.tables.get(name);
    if (!t) throw new Error('unknown table: ' + name);
    return t;
  }

  // Deep-ish snapshot used by the runtime to prove that a rolled back plan
  // leaves the store byte-identical to how it started.
  snapshot() {
    const out = {};
    for (const [name, t] of this.tables) {
      out[name] = t.all().map((r) => Object.assign({}, r));
    }
    return out;
  }

  static fingerprint(snap) {
    const names = Object.keys(snap).sort();
    const parts = [];
    for (const n of names) {
      const rows = snap[n].slice().sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
      for (const r of rows) {
        const keys = Object.keys(r).sort();
        parts.push(n + ':' + keys.map((k) => k + '=' + String(r[k])).join(','));
      }
    }
    // FNV-1a over the flattened text, enough to detect any state divergence.
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
}

module.exports = { Store, Table };
