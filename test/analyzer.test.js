const { WingoAnalyzer } = require('../server/analyzer');

function runTests() {
  let passed = 0, failed = 0;
  function assert(condition, name) {
    if (condition) { console.log('  PASS: ' + name); passed++; }
    else { console.log('  FAIL: ' + name); failed++; }
  }

  console.log('\n=== Wingo Analyzer Tests ===\n');

  // Empty history
  const a1 = new WingoAnalyzer([]);
  const r1 = a1.analyze();
  assert(r1.prediction === 'BIG', 'Default prediction');
  assert(r1.confidence >= 40, 'Confidence >= 40');

  // All BIG
  const bigHistory = Array.from({ length: 15 }, (_, i) => ({ period: '100'+i, number: 7, size: 'BIG' }));
  const a2 = new WingoAnalyzer(bigHistory);
  const r2 = a2.analyze();
  assert(r2.prediction === 'BIG' || r2.prediction === 'SMALL', 'Valid prediction');

  // Mixed
  const mixed = Array.from({ length: 10 }, (_, i) => ({
    period: '300'+i, number: i % 2 === 0 ? 2 : 7, size: i % 2 === 0 ? 'SMALL' : 'BIG'
  }));
  const a5 = new WingoAnalyzer(mixed);
  const r5 = a5.analyze();
  assert(r5.confidence >= 40 && r5.confidence <= 92, 'Confidence in range');
  assert(r5.algorithms.length === 7, '7 algorithms');

  console.log('\n=== Results ===');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}
runTests();
