'use strict';

// Minimal assertion harness. Counts every assertion so the reported totals in
// the readme are real numbers rather than a guess at how many checks ran.

const state = { asserts: 0, tests: 0, failures: [] };

function assert(cond, message) {
  state.asserts += 1;
  if (!cond) throw new Error('assertion failed: ' + (message || ''));
}

function assertEqual(actual, expected, message) {
  state.asserts += 1;
  if (actual !== expected) {
    throw new Error('assertion failed: ' + (message || '') + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')');
  }
}

function assertThrows(fn, name, message) {
  state.asserts += 1;
  try {
    fn();
  } catch (err) {
    if (name && err.name !== name) throw new Error('assertion failed: ' + (message || '') + ' (expected ' + name + ', got ' + err.name + ': ' + err.message + ')');
    return err;
  }
  throw new Error('assertion failed: expected a throw. ' + (message || ''));
}

function test(name, fn) {
  state.tests += 1;
  try {
    fn();
  } catch (err) {
    state.failures.push({ name: name, error: err.message });
  }
}

function report(label) {
  return { label: label, tests: state.tests, asserts: state.asserts, failures: state.failures.slice() };
}

function reset() { state.asserts = 0; state.tests = 0; state.failures = []; }

module.exports = { assert, assertEqual, assertThrows, test, report, reset, state };
