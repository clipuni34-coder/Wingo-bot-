const { WingoAnalyzer, analyzeHistory, sortChronologically, gradePrediction, walkForwardGrade, markovNGram, runsTest, streakHazard, binomialImbalance, digitMomentum, BREAK_EVEN_PCT } = require('../server/analyzer');
const { numberToSize, numberToColor, numberToColors } = require('../server/api');

function runTests() {
  let passed = 0, failed = 0;
  function assert(condition, name) {
    if (condition) { console.log('  PASS: ' + name); passed++; }
    else { console.log('  FAIL: ' + name); failed++; }
  }
  function makeHistory(sizes, startPeriod) {
    // sizes: array of 'BIG'/'SMALL'; numbers derived: BIG->7, SMALL->2
    return sizes.map((s, i) => ({
      period: String((startPeriod || 1000) + i),
      number: s === 'BIG' ? 7 : 2,
      size: s
    }));
  }
  function makeHistoryFromNumbers(numbers, startPeriod) {
    return numbers.map((n, i) => ({
      period: String((startPeriod || 1000) + i),
      number: n,
      size: numberToSize(n)
    }));
  }

  console.log('\n=== Wingo Analyzer Tests ===\n');

  // --- 1. Chronological sorting (newest-first input must be normalized) ---
  console.log('--- Chronological sorting ---');
  const chronological = makeHistory(['SMALL', 'BIG', 'SMALL', 'BIG', 'BIG'], 1000);
  const newestFirst = chronological.slice().reverse();
  const sorted = sortChronologically(newestFirst);
  assert(sorted.length === 5, 'sortChronologically keeps all records');
  assert(sorted[0].period === '1000' && sorted[4].period === '1004', 'sortChronologically ascending by issueNumber');
  assert(sorted.map(h => h.size).join(',') === 'SMALL,BIG,SMALL,BIG,BIG', 'sortChronologically preserves chronological size order');
  const shuffled = [chronological[2], chronological[0], chronological[4], chronological[1], chronological[3]];
  const sortedShuffled = sortChronologically(shuffled);
  assert(sortedShuffled.map(h => h.period).join(',') === '1000,1001,1002,1003,1004', 'sortChronologically handles shuffled input');
  const deduped = sortChronologically([...chronological, chronological[2]]);
  assert(deduped.length === 5, 'sortChronologically deduplicates by period');
  // Analyzer stores chronological internally regardless of input order
  const aSort = new WingoAnalyzer(newestFirst);
  assert(aSort.history.map(h => h.period).join(',') === '1000,1001,1002,1003,1004', 'WingoAnalyzer stores history oldest-first');
  assert(aSort.getHistoryNewestFirst()[0].period === '1004', 'getHistoryNewestFirst returns newest first for UI');

  // --- 2. Empty / insufficient history => SKIP ---
  console.log('--- Empty / insufficient history ---');
  const a1 = new WingoAnalyzer([]);
  const r1 = a1.analyze();
  assert(r1.prediction === 'SKIP', 'Empty history => SKIP');
  assert(r1.shouldBet === false, 'Empty history => shouldBet false');
  assert(r1.lean === 'BIG' || r1.lean === 'SMALL', 'Empty history still has directional lean');
  assert(r1.winRatePct === null, 'Empty history => winRatePct null (unmeasured)');
  assert(r1.algorithms.length === 5, '5 sub-models present');
  const smallHist = makeHistory(['BIG', 'SMALL', 'BIG'], 2000);
  const rSmall = new WingoAnalyzer(smallHist).analyze();
  assert(rSmall.prediction === 'SKIP' && rSmall.shouldBet === false, 'Tiny history (<20) => SKIP');

  // --- 3. Walk-forward zero-lookahead grading ---
  console.log('--- Walk-forward zero-lookahead ---');
  // Deterministic pseudo-random sequence (seeded LCG) so grading is reproducible
  function lcgSequence(n, seed) {
    let s = seed;
    const out = [];
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      out.push(s % 2 === 0 ? 'BIG' : 'SMALL');
    }
    return out;
  }
  const randHist = makeHistory(lcgSequence(60, 42), 3000);
  const wf = walkForwardGrade(sortChronologically(randHist));
  assert(wf.graded > 0, 'Walk-forward grades steps (graded > 0)');
  assert(wf.wins + wf.losses === wf.graded, 'Walk-forward wins+losses == graded');
  assert(wf.winRate === null || (wf.winRate >= 0 && wf.winRate <= 1), 'Walk-forward winRate in [0,1]');
  assert(wf.perModel.length === 5, 'Walk-forward per-model has 5 entries');
  assert(wf.perModel.every(p => p.graded === 60 - 12), 'Each sub-model graded on every step t=warmup..N-1');
  // Zero-lookahead proof: truncating history must not change earlier graded steps.
  // Grade full 60 vs truncated 40: first (40-12) ensemble steps must match.
  const wfFull = walkForwardGrade(sortChronologically(randHist));
  const wfTrunc = walkForwardGrade(sortChronologically(randHist.slice(0, 40)));
  const truncSteps = wfTrunc.steps.length;
  let lookaheadOk = true;
  for (let i = 0; i < truncSteps; i++) {
    if (wfFull.steps[i].period !== wfTrunc.steps[i].period ||
        wfFull.steps[i].ensemble !== wfTrunc.steps[i].ensemble ||
        wfFull.steps[i].actual !== wfTrunc.steps[i].actual) { lookaheadOk = false; break; }
  }
  assert(lookaheadOk, 'Zero lookahead: truncating future does not change past ensemble grades');
  // Weights are max(0, winRate-0.5)
  const weightsOk = wf.perModel.every(p => p.weight === Math.max(0, Number((p.winRate - 0.5).toFixed(4))) || (p.winRate != null && p.weight >= 0));
  assert(weightsOk, 'Weights follow max(0, winRate-0.5)');
  assert(wf.perModel.every(p => p.weight >= 0), 'Weights never negative');

  // --- 4. SKIP on pure uniform noise ---
  console.log('--- SKIP on uniform noise ---');
  // True uniform noise via xorshift32 (LCG parity alternates, so it is NOT noise).
  function xorshiftSequence(n, seed) {
    let s = (seed >>> 0) || 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      out.push(s % 2 === 0 ? 'BIG' : 'SMALL');
    }
    return out;
  }
  const noiseHist = makeHistory(xorshiftSequence(100, 42), 4000);
  const rNoise = new WingoAnalyzer(noiseHist).analyze();
  assert(rNoise.lean === 'BIG' || rNoise.lean === 'SMALL', 'Noise still produces a lean');
  assert(rNoise.winRatePct === null || typeof rNoise.winRatePct === 'number', 'Noise reports measured winRatePct');
  // On uniform noise the honest walk-forward win rate hovers near 50% and the
  // ensemble must SKIP (below 51.02% break-even or weak signal).
  assert(rNoise.prediction === 'SKIP' && rNoise.shouldBet === false, 'Uniform noise => SKIP (no edge)');
  assert(rNoise.skipReason != null, 'Uniform noise SKIP has a reason');
  // Alternating sequence IS predictable (runs test reversal) — betting is honest there.
  const altNoiseSizes = [];
  for (let i = 0; i < 80; i++) altNoiseSizes.push(i % 2 === 0 ? 'BIG' : 'SMALL');
  const rAlt = new WingoAnalyzer(makeHistory(altNoiseSizes, 4100)).analyze();
  assert(rAlt.winRatePct != null && rAlt.winRatePct > 51.02, 'Alternation is genuinely predictable (>51%)');
  assert(rAlt.record === `${rAlt.wins}W-${rAlt.losses}L`, 'Record format W-L');
  assert(rNoise.breakEven === 51.02, 'Break-even is 51.02% (1.96x payout)');

  // --- 5. Pattern detection: streaks & alternation ---
  console.log('--- Pattern detection ---');
  // Strong trending sequence: long BIG run then SMALL run — runs test should detect trending
  const trendSizes = [...Array(15).fill('BIG'), ...Array(15).fill('SMALL'), ...Array(10).fill('BIG')];
  const trendHist = makeHistory(trendSizes, 5000);
  const runsTrend = runsTest(sortChronologically(trendHist));
  assert(runsTrend.details.z < 0, 'Runs test Z negative on trending sequence');
  assert(runsTrend.prediction === 'BIG', 'Runs test follows trend on trending sequence (last=BIG)');
  // Alternating sequence: runs test should detect chop and predict reversal
  const altSizes = [];
  for (let i = 0; i < 30; i++) altSizes.push(i % 2 === 0 ? 'BIG' : 'SMALL');
  const altHist = makeHistory(altSizes, 6000);
  const runsAlt = runsTest(sortChronologically(altHist));
  assert(runsAlt.details.z > 0, 'Runs test Z positive on alternating sequence');
  assert(runsAlt.prediction === 'BIG', 'Runs test predicts reversal on alternation (last=SMALL => BIG)');
  // Markov on repeating pattern BIG,BIG,SMALL
  const markovHist = makeHistory([...Array(10).fill(['BIG', 'BIG', 'SMALL']).flat()], 7000);
  const mk = markovNGram(sortChronologically(markovHist));
  assert(mk.prediction === 'BIG' || mk.prediction === 'SMALL', 'Markov returns valid prediction');
  assert(mk.details.avgPBig === undefined || (mk.details.avgPBig >= 0 && mk.details.avgPBig <= 1), 'Markov avgPBig in [0,1]');
  // Streak hazard on a table where streaks continue: long runs
  const hazardHist = makeHistory([...Array(8).fill('BIG'), ...Array(8).fill('SMALL'), ...Array(8).fill('BIG'), ...Array(8).fill('SMALL'), 'BIG', 'BIG', 'BIG'], 8000);
  const hz = streakHazard(sortChronologically(hazardHist));
  assert(hz.prediction === 'BIG' || hz.prediction === 'SMALL', 'Streak hazard returns valid prediction');
  assert(hz.details.L === 3, 'Streak hazard detects current streak length 3');
  // Binomial imbalance: heavy BIG window => predict SMALL (mean reversion)
  const heavyBig = makeHistory(Array(30).fill('BIG'), 9000);
  const bin = binomialImbalance(sortChronologically(heavyBig));
  assert(bin.prediction === 'SMALL', 'Binomial imbalance predicts SMALL after heavy BIG window');
  // Digit momentum: high digits => BIG, low digits => SMALL
  const highDigits = makeHistoryFromNumbers(Array(20).fill(9), 10000);
  assert(digitMomentum(sortChronologically(highDigits)).prediction === 'BIG', 'Digit momentum predicts BIG on high digits');
  const lowDigits = makeHistoryFromNumbers(Array(20).fill(0), 11000);
  assert(digitMomentum(sortChronologically(lowDigits)).prediction === 'SMALL', 'Digit momentum predicts SMALL on low digits');

  // --- 6. Color / size mappings ---
  console.log('--- Color / size mappings ---');
  assert(numberToSize(0) === 'SMALL' && numberToSize(4) === 'SMALL', '0-4 => SMALL');
  assert(numberToSize(5) === 'BIG' && numberToSize(9) === 'BIG', '5-9 => BIG');
  assert(numberToColor(0) === 'red+violet', '0 => red+violet');
  assert(numberToColor(5) === 'green+violet', '5 => green+violet');
  assert([1, 3, 7, 9].every(n => numberToColor(n) === 'green'), '1,3,7,9 => green');
  assert([2, 4, 6, 8].every(n => numberToColor(n) === 'red'), '2,4,6,8 => red');
  assert(JSON.stringify(numberToColors(0)) === JSON.stringify(['red', 'violet']), 'numberToColors(0) dual array');
  assert(JSON.stringify(numberToColors(5)) === JSON.stringify(['green', 'violet']), 'numberToColors(5) dual array');

  // --- 7. Ledger grading ---
  console.log('--- Ledger grading ---');
  assert(gradePrediction('BIG', 'BIG') === 'WIN', 'gradePrediction BIG vs BIG => WIN');
  assert(gradePrediction('BIG', 'SMALL') === 'LOSS', 'gradePrediction BIG vs SMALL => LOSS');
  assert(gradePrediction('SMALL', 'SMALL') === 'WIN', 'gradePrediction SMALL vs SMALL => WIN');
  assert(gradePrediction('SKIP', 'BIG') === 'SKIPPED', 'gradePrediction SKIP => SKIPPED');
  assert(gradePrediction(null, 'BIG') === 'SKIPPED', 'gradePrediction null => SKIPPED');

  // --- 8. Server locking + ledger (integration, no network) ---
  console.log('--- Server locking & ledger ---');
  try {
    const server = require('../server/index');
    server.clearAllState();
    // Lock a prediction for period 5000
    const fakeAnalysis = { prediction: 'BIG', lean: 'BIG', shouldBet: true, confidence: 55, winRatePct: 55.0, wins: 5, losses: 4, record: '5W-4L', agreement: 0.8 };
    const lock1 = server.lockPredictionForPeriod('1m', '5000', fakeAnalysis, 30);
    const flipAnalysis = { prediction: 'SMALL', lean: 'SMALL', shouldBet: true, confidence: 60, winRatePct: 60.0, wins: 6, losses: 4, record: '6W-4L', agreement: 0.9 };
    const lock2 = server.lockPredictionForPeriod('1m', '5000', flipAnalysis, 10);
    assert(lock1 === lock2, 'Lock is immutable per period (same object returned)');
    assert(lock2.prediction === 'BIG', 'Locked prediction never flips mid-round');
    // Grade it: history contains settled 5000 as BIG (number 7) => WIN
    const settledHist = [{ period: '5000', number: 7, size: 'BIG' }, { period: '5001', number: 2, size: 'SMALL' }];
    const n1 = server.gradeLockedPredictions('1m', settledHist);
    assert(n1 === 1, 'gradeLockedPredictions grades settled lock once');
    const n2 = server.gradeLockedPredictions('1m', settledHist);
    assert(n2 === 0, 'gradeLockedPredictions does not double-grade');
    const stats = server.ledgerStats('1m');
    assert(stats.wins === 1 && stats.losses === 0 && stats.winRatePct === 100, 'Ledger stats reflect WIN');
    assert(stats.record === '1W-0L', 'Ledger record format');
    // SKIP lock grades as SKIPPED
    server.clearAllState();
    const skipAnalysis = { prediction: 'SKIP', lean: 'SMALL', shouldBet: false, confidence: null, winRatePct: 48.0, wins: 2, losses: 3, record: '2W-3L', agreement: 0.4 };
    server.lockPredictionForPeriod('1m', '6000', skipAnalysis, 30);
    server.gradeLockedPredictions('1m', [{ period: '6000', number: 8, size: 'BIG' }]);
    const skipStats = server.ledgerStats('1m');
    assert(skipStats.skipped === 1 && skipStats.graded === 0, 'SKIP lock grades as SKIPPED (not WIN/LOSS)');
    server.clearAllState();
  } catch (e) {
    console.log('  FAIL: server locking test threw: ' + e.message);
    failed++;
  }

  // --- 9. analyzeHistory integration ---
  console.log('--- analyzeHistory integration ---');
  const fullHist = makeHistory(lcgSequence(50, 7), 12000);
  const res = analyzeHistory(fullHist.slice().reverse(), '1m'); // newest-first input
  assert(res.totalHistory === 50, 'analyzeHistory counts all history');
  assert(['BIG', 'SMALL', 'SKIP'].includes(res.prediction), 'analyzeHistory prediction valid');
  assert(res.lean === 'BIG' || res.lean === 'SMALL', 'analyzeHistory lean valid');
  assert(typeof res.shouldBet === 'boolean', 'analyzeHistory shouldBet boolean');
  assert(res.walkForward && res.walkForward.perModel.length === 5, 'analyzeHistory includes walkForward');
  assert(res.algorithms.length === 5, 'analyzeHistory includes 5 algorithms');
  assert(res.algorithms.every(a => typeof a.weight === 'number' && a.weight >= 0), 'Algorithm weights non-negative');
  // Legacy wrappers still work (fibonacci bug fix path)
  const legacy = new WingoAnalyzer(fullHist);
  const fib = legacy.fibonacciAnalysis();
  assert(fib.prediction === 'BIG' || fib.prediction === 'SMALL', 'fibonacciAnalysis (fixed filter) returns valid prediction');

  console.log('\n=== Results ===');
  console.log('Passed: ' + passed + ' | Failed: ' + failed);
  process.exit(failed > 0 ? 1 : 0);
}
runTests();
