'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./harness');

const suites = [
  ['sharing', require('./test-sharing')],
  ['oracle', require('./test-oracle')],
  ['query', require('./test-query')],
  ['limits', require('./test-limits')],
  ['runtime', require('./test-runtime')],
];

function main() {
  harness.reset();
  const evidence = {};
  const perSuite = [];
  let lastTests = 0;
  let lastAsserts = 0;

  for (const [name, fn] of suites) {
    fn(evidence);
    const s = harness.state;
    perSuite.push({ suite: name, tests: s.tests - lastTests, asserts: s.asserts - lastAsserts });
    lastTests = s.tests;
    lastAsserts = s.asserts;
  }

  const rep = harness.report('all');
  const bench = require('../bench/bench').run();

  const results = {
    generatedAt: new Date().toISOString(),
    tests: { total: rep.tests, asserts: rep.asserts, failures: rep.failures },
    perSuite: perSuite,
    evidence: evidence,
    bench: bench,
  };

  const dir = path.join(__dirname, '..', 'results');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));

  for (const f of rep.failures) console.log('FAIL ' + f.name + ': ' + f.error);
  console.log(rep.failures.length === 0 ? 'PASS' : 'FAIL');
  console.log(rep.tests + ' tests, ' + rep.asserts + ' assertions, ' + rep.failures.length + ' failures');
  return rep.failures.length === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main: main };
