'use strict';

// Actions are the only way the agent is allowed to touch data. Each one
// declares its parameter shape and the access level it needs on its target
// record, and supplies a compensating operation so a partially applied plan
// can be undone.

class ValidationError extends Error {
  constructor(message, field) { super(message); this.name = 'ValidationError'; this.field = field; }
}

class PermissionError extends Error {
  constructor(message, detail) { super(message); this.name = 'PermissionError'; this.detail = detail || {}; }
}

function validateParams(schema, args) {
  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined && args[name] !== null;
    if (!present) {
      if (spec.required) throw new ValidationError('missing required parameter: ' + name, name);
      if ('default' in spec) out[name] = spec.default;
      continue;
    }
    let value = args[name];
    if (spec.type === 'number') {
      if (typeof value !== 'number' || Number.isNaN(value)) throw new ValidationError(name + ' must be a number', name);
      if ('min' in spec && value < spec.min) throw new ValidationError(name + ' must be at least ' + spec.min, name);
      if ('max' in spec && value > spec.max) throw new ValidationError(name + ' must be at most ' + spec.max, name);
    } else if (spec.type === 'string') {
      if (typeof value !== 'string') throw new ValidationError(name + ' must be a string', name);
      if (spec.maxLength && value.length > spec.maxLength) throw new ValidationError(name + ' exceeds ' + spec.maxLength + ' characters', name);
      if (spec.enum && spec.enum.indexOf(value) === -1) throw new ValidationError(name + ' must be one of ' + spec.enum.join(', '), name);
    } else if (spec.type === 'boolean') {
      if (typeof value !== 'boolean') throw new ValidationError(name + ' must be a boolean', name);
    } else if (spec.type === 'id') {
      if (typeof value !== 'string' || value.length === 0) throw new ValidationError(name + ' must be a record id', name);
    } else {
      throw new Error('unknown parameter type: ' + spec.type);
    }
    out[name] = value;
  }
  for (const key of Object.keys(args)) {
    if (!(key in schema)) throw new ValidationError('unexpected parameter: ' + key, key);
  }
  return out;
}

class ActionRegistry {
  constructor() { this.actions = new Map(); }

  define(def) {
    if (!def.name) throw new Error('action needs a name');
    if (this.actions.has(def.name)) throw new Error('action already defined: ' + def.name);
    if (typeof def.execute !== 'function') throw new Error(def.name + ' needs an execute function');
    if (def.mutating !== false && typeof def.compensate !== 'function') {
      throw new Error(def.name + ' is mutating so it needs a compensate function');
    }
    this.actions.set(def.name, Object.assign({ params: {}, mutating: true }, def));
    return this;
  }

  get(name) {
    const a = this.actions.get(name);
    if (!a) throw new Error('unknown action: ' + name);
    return a;
  }

  list() { return Array.from(this.actions.keys()).sort(); }
}

module.exports = { ActionRegistry, validateParams, ValidationError, PermissionError };
