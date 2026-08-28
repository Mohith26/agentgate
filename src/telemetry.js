'use strict';

// Spans, counters and a latency histogram. The runtime records one span per
// action so a failed plan can be read back step by step afterwards.

class Histogram {
  constructor() { this.values = []; }
  record(v) { this.values.push(v); }
  percentile(p) {
    if (this.values.length === 0) return 0;
    const sorted = this.values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }
  get count() { return this.values.length; }
  get mean() { return this.values.length ? this.values.reduce((a, b) => a + b, 0) / this.values.length : 0; }
  summary() {
    return {
      count: this.count,
      mean_ms: +this.mean.toFixed(4),
      p50_ms: +this.percentile(50).toFixed(4),
      p95_ms: +this.percentile(95).toFixed(4),
      p99_ms: +this.percentile(99).toFixed(4),
      max_ms: +(this.values.length ? Math.max.apply(null, this.values) : 0).toFixed(4),
    };
  }
}

class Telemetry {
  constructor(clock) {
    this.clock = clock || Telemetry.defaultClock();
    this.spans = [];
    this.counters = new Map();
    this.errors = new Map();
    this.latency = new Map();
  }

  count(name, n) { this.counters.set(name, (this.counters.get(name) || 0) + (n === undefined ? 1 : n)); }
  countError(kind) { this.errors.set(kind, (this.errors.get(kind) || 0) + 1); }

  startSpan(name, attrs) {
    const span = { name: name, attrs: attrs || {}, start: this.clock(), end: null, status: 'unset', error: null };
    this.spans.push(span);
    const self = this;
    return {
      span: span,
      end(status, error) {
        span.end = self.clock();
        span.durationMs = span.end - span.start;
        span.status = status || 'ok';
        if (error) {
          span.error = { name: error.name, message: error.message };
          self.countError(error.name || 'Error');
        }
        let h = self.latency.get(name);
        if (!h) { h = new Histogram(); self.latency.set(name, h); }
        h.record(span.durationMs);
        return span;
      },
    };
  }

  snapshot() {
    const latency = {};
    for (const [k, h] of this.latency) latency[k] = h.summary();
    return {
      spans: this.spans.length,
      counters: Object.fromEntries(this.counters),
      errors: Object.fromEntries(this.errors),
      latency: latency,
    };
  }

  reset() { this.spans = []; this.counters.clear(); this.errors.clear(); this.latency.clear(); }

  static defaultClock() {
    if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
      return () => Number(process.hrtime.bigint()) / 1e6;
    }
    if (typeof performance !== 'undefined' && performance.now) return () => performance.now();
    return () => Date.now();
  }
}

module.exports = { Telemetry, Histogram };
