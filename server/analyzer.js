'use strict';

const { numberToSize, SIZE_LABELS } = require('./api');

// FB999 Big/Small payout 1.96x => break-even win rate = 1/1.96 = 51.02%
const BREAK_EVEN = 1 / 1.96; // 0.510204...
const BREAK_EVEN_PCT = 51.02;
const WARMUP = 12; // minimum history before walk-forward grading starts
const MIN_HISTORY_FOR_BET = 20; // below this we always SKIP (not enough evidence)
const AGREEMENT_THRESHOLD = 0.6; // weighted agreement needed to bet
const SCORE_THRESHOLD = 0.08; // minimum |weighted score| to bet

function opposite(size) {
  return size === 'BIG' ? 'SMALL' : 'BIG';
}

function parsePeriodNum(period) {
  const n = parseInt(String(period), 10);
  return isNaN(n) ? null : n;
}

// Normalize any-order history (newest-first from fb999api, oldest-first, shuffled)
// into strictly chronological order (issueNumber ascending), deduplicated.
function sortChronologically(history) {
  const seen = new Set();
  const out = [];
  for (const h of history || []) {
    if (!h) continue;
    const period = h.period != null ? String(h.period) : (h.issueNumber != null ? String(h.issueNumber) : '');
    if (!period) continue;
    if (seen.has(period)) continue;
    seen.add(period);
    const number = Number(h.number);
    const size = h.size ? String(h.size).toUpperCase() : numberToSize(number);
    out.push({
      period: period,
      issueNumber: period,
      number: number,
      size: size === 'BIG' ? 'BIG' : 'SMALL',
      color: h.color || ''
    });
  }
  out.sort((a, b) => {
    const na = parsePeriodNum(a.period);
    const nb = parsePeriodNum(b.period);
    if (na != null && nb != null) return na - nb;
    return String(a.period).localeCompare(String(b.period));
  });
  return out;
}

function gradePrediction(predicted, actualSize) {
  if (!predicted || predicted === 'SKIP') return 'SKIPPED';
  if (!actualSize) return 'SKIPPED';
  return predicted === actualSize ? 'WIN' : 'LOSS';
}

// ---------------------------------------------------------------------------
// Sub-model 1: Markov N-Gram Transition (k=1,2,3) with Laplace smoothing
// ---------------------------------------------------------------------------
function markovNGram(history) {
  const sizes = history.map(h => h.size);
  if (sizes.length < 4) return { name: 'markov', prediction: sizes[sizes.length - 1] || 'BIG', score: 0, details: { reason: 'insufficient' } };
  const ks = [1, 2, 3];
  const probs = [];
  const perK = [];
  for (const k of ks) {
    if (sizes.length <= k) continue;
    // Build transition counts: context -> {BIG, SMALL}
    const counts = new Map();
    for (let i = k; i < sizes.length; i++) {
      const ctx = sizes.slice(i - k, i).join(',');
      if (!counts.has(ctx)) counts.set(ctx, { BIG: 0, SMALL: 0 });
      counts.get(ctx)[sizes[i]]++;
    }
    const currentCtx = sizes.slice(-k).join(',');
    const c = counts.get(currentCtx);
    if (!c) { perK.push({ k, seen: 0 }); continue; }
    // Laplace smoothing alpha=1
    const pBig = (c.BIG + 1) / (c.BIG + c.SMALL + 2);
    probs.push(pBig);
    perK.push({ k, seen: c.BIG + c.SMALL, pBig: Number(pBig.toFixed(3)) });
  }
  if (!probs.length) {
    return { name: 'markov', prediction: sizes[sizes.length - 1], score: 0, details: { perK, reason: 'context-unseen' } };
  }
  const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
  const prediction = avg >= 0.5 ? 'BIG' : 'SMALL';
  const score = (avg - 0.5) * 2; // [-1,1]
  return { name: 'markov', prediction, score, details: { perK, avgPBig: Number(avg.toFixed(3)) } };
}

// ---------------------------------------------------------------------------
// Sub-model 2: Wald-Wolfowitz Runs Test Z-Score
// Few runs (Z<<0) => trending => continue streak. Many runs (Z>>0) => chop => reverse.
// ---------------------------------------------------------------------------
function runsTest(history) {
  const sizes = history.map(h => h.size);
  const n = sizes.length;
  if (n < 8) return { name: 'runs', prediction: sizes[n - 1] || 'BIG', score: 0, details: { reason: 'insufficient' } };
  const n1 = sizes.filter(s => s === 'BIG').length;
  const n2 = n - n1;
  if (n1 === 0 || n2 === 0) {
    // Monochrome: maximally trending
    return { name: 'runs', prediction: sizes[n - 1], score: sizes[n - 1] === 'BIG' ? 0.6 : -0.6, details: { n1, n2, runs: 1, z: null, note: 'monochrome' } };
  }
  let runs = 1;
  for (let i = 1; i < n; i++) if (sizes[i] !== sizes[i - 1]) runs++;
  const mu = 1 + (2 * n1 * n2) / n;
  const varNum = 2 * n1 * n2 * (2 * n1 * n2 - n);
  const varDen = n * n * (n - 1);
  const variance = varDen > 0 ? varNum / varDen : 0;
  const sd = Math.sqrt(Math.max(variance, 1e-9));
  const z = (runs - mu) / sd;
  const last = sizes[n - 1];
  let prediction, score;
  if (z < -1.0) {
    // Significantly fewer runs than random => trending/streaky => follow last
    prediction = last;
    score = last === 'BIG' ? Math.min(0.8, 0.3 + Math.abs(z) * 0.15) : -Math.min(0.8, 0.3 + Math.abs(z) * 0.15);
  } else if (z > 1.0) {
    // Significantly more runs => alternating/chop => fade last
    prediction = opposite(last);
    score = prediction === 'BIG' ? Math.min(0.8, 0.3 + Math.abs(z) * 0.15) : -Math.min(0.8, 0.3 + Math.abs(z) * 0.15);
  } else {
    // Consistent with random noise => weak lean to last, small score
    prediction = last;
    score = last === 'BIG' ? 0.1 : -0.1;
  }
  return { name: 'runs', prediction, score, details: { n1, n2, runs, expectedRuns: Number(mu.toFixed(2)), z: Number(z.toFixed(2)) } };
}

// ---------------------------------------------------------------------------
// Sub-model 3: Empirical Streak Hazard / Survival Rate
// Measures how often streaks of length L actually continue on this table.
// ---------------------------------------------------------------------------
function streakHazard(history) {
  const sizes = history.map(h => h.size);
  const n = sizes.length;
  if (n < 6) return { name: 'streakHazard', prediction: sizes[n - 1] || 'BIG', score: 0, details: { reason: 'insufficient' } };
  // Current streak
  const last = sizes[n - 1];
  let L = 1;
  for (let i = n - 2; i >= 0; i--) {
    if (sizes[i] === last) L++; else break;
  }
  // Identify completed streak segments (exclude the ongoing last segment)
  const segments = [];
  let curType = sizes[0], curLen = 1;
  for (let i = 1; i < n; i++) {
    if (sizes[i] === curType) curLen++;
    else { segments.push({ type: curType, len: curLen }); curType = sizes[i]; curLen = 1; }
  }
  // curType/curLen is the ongoing streak — do not count it as completed
  const completed = segments;
  // Hazard: among completed streaks with len >= L, fraction that continued beyond L
  const eligible = completed.filter(s => s.len >= L);
  const continued = eligible.filter(s => s.len > L).length;
  if (eligible.length < 3) {
    // Not enough empirical evidence — fall back to mild fade only for long streaks,
    // otherwise follow. This avoids blindly fading every 3-streak.
    if (L >= 5) return { name: 'streakHazard', prediction: opposite(last), score: opposite(last) === 'BIG' ? 0.2 : -0.2, details: { L, eligible: eligible.length, continued, fallback: 'long-streak-fade' } };
    return { name: 'streakHazard', prediction: last, score: last === 'BIG' ? 0.1 : -0.1, details: { L, eligible: eligible.length, continued, fallback: 'follow' } };
  }
  const continuationRate = continued / eligible.length;
  let prediction, score;
  if (continuationRate > 0.55) {
    prediction = last; // streaks tend to continue on this table
    score = (continuationRate - 0.5) * 2 * 0.8;
    if (last === 'SMALL') score = -Math.abs(score);
  } else if (continuationRate < 0.45) {
    prediction = opposite(last); // streaks tend to reverse
    score = (0.5 - continuationRate) * 2 * 0.8;
    if (prediction === 'SMALL') score = -Math.abs(score);
  } else {
    prediction = last;
    score = last === 'BIG' ? 0.05 : -0.05;
  }
  return { name: 'streakHazard', prediction, score, details: { L, streakType: last, eligible: eligible.length, continued, continuationRate: Number(continuationRate.toFixed(3)) } };
}

// ---------------------------------------------------------------------------
// Sub-model 4: Multi-Window Binomial Imbalance Z-Score (12, 25, 50)
// Excess BIG in recent windows => mean-reversion predicts SMALL (and vice versa).
// ---------------------------------------------------------------------------
function binomialImbalance(history) {
  const sizes = history.map(h => h.size);
  const windows = [12, 25, 50];
  const zs = [];
  const perWindow = [];
  for (const w of windows) {
    if (sizes.length < Math.max(6, Math.floor(w / 2))) continue;
    const slice = sizes.slice(-Math.min(w, sizes.length));
    const m = slice.length;
    const big = slice.filter(s => s === 'BIG').length;
    const expected = m * 0.5;
    const sd = Math.sqrt(m * 0.25);
    const z = sd > 0 ? (big - expected) / sd : 0;
    zs.push(z);
    perWindow.push({ window: w, n: m, big, z: Number(z.toFixed(2)) });
  }
  if (!zs.length) return { name: 'binomial', prediction: sizes[sizes.length - 1] || 'BIG', score: 0, details: { reason: 'insufficient' } };
  const avgZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  // Mean reversion: positive Z (too many BIG) => predict SMALL
  const prediction = avgZ >= 0 ? 'SMALL' : 'BIG';
  const magnitude = Math.min(0.8, Math.abs(avgZ) * 0.25);
  const score = prediction === 'BIG' ? magnitude : -magnitude;
  // If |avgZ| tiny, score near zero (no edge)
  const finalScore = Math.abs(avgZ) < 0.3 ? score * 0.3 : score;
  return { name: 'binomial', prediction, score: finalScore, details: { perWindow, avgZ: Number(avgZ.toFixed(2)) } };
}

// ---------------------------------------------------------------------------
// Sub-model 5: Digit Center-of-Gravity / Momentum (exact digits vs 4.5)
// ---------------------------------------------------------------------------
function digitMomentum(history) {
  const numbers = history.map(h => Number(h.number)).filter(n => !isNaN(n));
  if (numbers.length < 6) return { name: 'digitMomentum', prediction: history[history.length - 1]?.size || 'BIG', score: 0, details: { reason: 'insufficient' } };
  const recentWindow = Math.min(20, numbers.length);
  const recent = numbers.slice(-recentWindow);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const overallMean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
  // Momentum: recent mean above 4.5 => digits drifting BIG => predict BIG continuation.
  // Also blend recent-vs-overall drift.
  const centerDev = (recentMean - 4.5) / 4.5; // [-1,1]-ish
  const drift = overallMean !== 0 ? (recentMean - overallMean) / 4.5 : 0;
  const combined = centerDev * 0.7 + drift * 0.3;
  const prediction = combined >= 0 ? 'BIG' : 'SMALL';
  const score = Math.max(-0.8, Math.min(0.8, combined * 1.2));
  return { name: 'digitMomentum', prediction, score, details: { recentMean: Number(recentMean.toFixed(2)), overallMean: Number(overallMean.toFixed(2)), centerDev: Number(centerDev.toFixed(3)), drift: Number(drift.toFixed(3)) } };
}

const SUBMODELS = [
  { key: 'markov', label: 'Markov N-Gram (k=1,2,3)', fn: markovNGram },
  { key: 'runs', label: 'Runs Test (Wald–Wolfowitz)', fn: runsTest },
  { key: 'streakHazard', label: 'Streak Hazard', fn: streakHazard },
  { key: 'binomial', label: 'Binomial Imbalance (12/25/50)', fn: binomialImbalance },
  { key: 'digitMomentum', label: 'Digit Momentum (vs 4.5)', fn: digitMomentum }
];

function runSubmodels(history) {
  return SUBMODELS.map(m => {
    const r = m.fn(history);
    return {
      name: m.key,
      label: m.label,
      prediction: r.prediction,
      score: Number(r.score.toFixed(4)),
      details: r.details || {}
    };
  });
}

// Walk-forward grading with zero lookahead.
// For each t in [warmup, N-1]: sub-models see only history[0..t-1], graded vs history[t].
// Ensemble at each t uses weights from graded steps < t only (expanding window).
function walkForwardGrade(history) {
  const N = history.length;
  const perModel = SUBMODELS.map(m => ({ name: m.key, label: m.label, wins: 0, losses: 0, graded: 0, winRate: null, weight: 0 }));
  let ensWins = 0, ensLosses = 0, ensSkipped = 0;
  const steps = [];

  if (N <= WARMUP) {
    return { wins: 0, losses: 0, skipped: 0, graded: 0, winRate: null, winRatePct: null, perModel, steps, warmup: WARMUP, breakEven: BREAK_EVEN_PCT };
  }

  // Track per-model cumulative wins/losses for expanding weights
  const cum = SUBMODELS.map(() => ({ wins: 0, losses: 0 }));

  for (let t = WARMUP; t < N; t++) {
    const slice = history.slice(0, t); // strictly past — zero lookahead
    const actual = history[t].size;
    const preds = runSubmodels(slice);

    // Grade each sub-model
    preds.forEach((p, i) => {
      perModel[i].graded++;
      if (p.prediction === actual) { perModel[i].wins++; cum[i].wins++; }
      else { perModel[i].losses++; cum[i].losses++; }
    });

    // Expanding weights from prior graded steps only (exclude current t)
    // cum currently includes current t for per-model totals, so compute weights
    // from cum BEFORE this step would be ideal; approximate by using cum
    // minus current outcome. Simpler & still honest: weights from steps < t
    // are derived from a snapshot taken before grading this step.
    // (We recompute below using snapshot logic — see note.)
    steps.push({ t, period: history[t].period, actual, preds: preds.map(p => ({ name: p.name, prediction: p.prediction })) });
  }

  // Second pass for ensemble grading with proper expanding weights:
  // Re-run replay keeping a pre-step snapshot for weights.
  ensWins = 0; ensLosses = 0; ensSkipped = 0;
  const cum2 = SUBMODELS.map(() => ({ wins: 0, losses: 0 }));
  const ensembleSteps = [];
  for (let t = WARMUP; t < N; t++) {
    const slice = history.slice(0, t);
    const actual = history[t].size;
    const preds = runSubmodels(slice);
    // Weights from graded steps < t (cum2 snapshot before this step)
    const weights = cum2.map(c => {
      const g = c.wins + c.losses;
      if (g === 0) return 0;
      const wr = c.wins / g;
      return Math.max(0, wr - 0.5);
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    let ensPred = null;
    if (totalW > 0) {
      let wScore = 0;
      preds.forEach((p, i) => { wScore += weights[i] * p.score; });
      wScore = wScore / totalW;
      ensPred = wScore >= 0 ? 'BIG' : 'SMALL';
      if (ensPred === actual) ensWins++; else ensLosses++;
    } else {
      ensSkipped++;
    }
    // Now update cum2 with this step's sub-model outcomes
    preds.forEach((p, i) => {
      if (p.prediction === actual) cum2[i].wins++; else cum2[i].losses++;
    });
    ensembleSteps.push({ period: history[t].period, actual, ensemble: ensPred });
  }

  // Finalize per-model win rates + dynamic weights
  perModel.forEach((pm, i) => {
    pm.winRate = pm.graded ? Number((pm.wins / pm.graded).toFixed(4)) : null;
    pm.weight = pm.winRate != null ? Number(Math.max(0, pm.winRate - 0.5).toFixed(4)) : 0;
  });

  const graded = ensWins + ensLosses;
  const winRate = graded ? Number((ensWins / graded).toFixed(4)) : null;

  return {
    wins: ensWins,
    losses: ensLosses,
    skipped: ensSkipped,
    graded,
    winRate,
    winRatePct: winRate != null ? Number((winRate * 100).toFixed(1)) : null,
    perModel,
    steps: ensembleSteps,
    warmup: WARMUP,
    breakEven: BREAK_EVEN_PCT
  };
}

class WingoAnalyzer {
  constructor(history = []) {
    // Normalize + sort chronologically (oldest-first) regardless of input order.
    this.history = sortChronologically(history);
  }

  getSizes() { return this.history.map(h => h.size); }
  getNumbers() { return this.history.map(h => h.number); }

  // Newest-first view for UI display
  getHistoryNewestFirst() { return this.history.slice().reverse(); }

  analyze() {
    const N = this.history.length;
    const wf = walkForwardGrade(this.history);
    const current = runSubmodels(this.history);

    // Dynamic weights from walk-forward empirical win rates
    const weights = wf.perModel.map(pm => pm.weight);
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let weightedScore = 0;
    let bigWeight = 0, smallWeight = 0;
    if (totalWeight > 0) {
      current.forEach((c, i) => {
        weightedScore += weights[i] * c.score;
        if (c.prediction === 'BIG') bigWeight += weights[i]; else smallWeight += weights[i];
      });
      weightedScore = weightedScore / totalWeight;
    }

    const lastSize = N ? this.history[N - 1].size : 'BIG';
    const lean = totalWeight > 0 ? (weightedScore >= 0 ? 'BIG' : 'SMALL') : lastSize;

    // Agreement: fraction of total weight agreeing with lean
    const agreeWeight = lean === 'BIG' ? bigWeight : smallWeight;
    const agreement = totalWeight > 0 ? agreeWeight / totalWeight : 0;

    const ensWinRate = wf.winRate; // measured, out-of-sample
    const ensWinRatePct = wf.winRatePct;

    // SKIP logic: weak agreement, below break-even, no weight, or too little history
    let shouldBet = true;
    let skipReason = null;
    if (N < MIN_HISTORY_FOR_BET) { shouldBet = false; skipReason = 'insufficient-history'; }
    else if (totalWeight <= 0) { shouldBet = false; skipReason = 'no-model-above-coinflip'; }
    else if (ensWinRate == null) { shouldBet = false; skipReason = 'no-walkforward-data'; }
    else if (ensWinRate < BREAK_EVEN) { shouldBet = false; skipReason = 'below-breakeven'; }
    else if (agreement < AGREEMENT_THRESHOLD) { shouldBet = false; skipReason = 'weak-agreement'; }
    else if (Math.abs(weightedScore) < SCORE_THRESHOLD) { shouldBet = false; skipReason = 'weak-signal'; }

    const prediction = shouldBet ? lean : 'SKIP';

    // Confidence for backward compat = measured win rate (not synthetic).
    // Null when unmeasured; UI shows winRatePct instead.
    const confidence = ensWinRatePct != null ? Math.round(ensWinRatePct) : null;

    const algorithms = current.map((c, i) => {
      const pm = wf.perModel[i];
      const conf = Math.round(50 + Math.abs(c.score) * 40);
      return {
        name: c.name,
        label: c.label,
        prediction: c.prediction,
        confidence: Math.max(50, Math.min(90, conf)),
        score: c.score,
        weight: weights[i],
        winRate: pm.winRate != null ? Number((pm.winRate * 100).toFixed(1)) : null,
        wins: pm.wins,
        losses: pm.losses,
        details: c.details
      };
    });

    const bigScore = Math.round((lean === 'BIG' ? (0.5 + weightedScore / 2) : (0.5 - weightedScore / 2)) * 100);
    const smallScore = 100 - bigScore;

    return {
      prediction: prediction,
      lean: lean,
      leanLabel: lean === 'BIG' ? 'Lean BIG' : 'Lean SMALL',
      shouldBet: shouldBet,
      skipReason: skipReason,
      confidence: confidence,
      winRate: ensWinRate,
      winRatePct: ensWinRatePct,
      wins: wf.wins,
      losses: wf.losses,
      skipped: wf.skipped,
      graded: wf.graded,
      record: `${wf.wins}W-${wf.losses}L`,
      breakEven: BREAK_EVEN_PCT,
      sizeLabel: shouldBet ? (SIZE_LABELS[lean] || lean) : SIZE_LABELS.SKIP,
      algorithms: algorithms,
      bigScore: bigScore,
      smallScore: smallScore,
      agreement: Number(agreement.toFixed(3)),
      weightedScore: Number(weightedScore.toFixed(4)),
      totalWeight: Number(totalWeight.toFixed(4)),
      walkForward: wf,
      totalHistory: N
    };
  }

  // Keep legacy method names as thin wrappers for any external callers/tests
  streakAnalysis() { return this._wrap(streakHazard(this.history)); }
  frequencyAnalysis() { return this._wrap(binomialImbalance(this.history)); }
  patternAnalysis() { return this._wrap(markovNGram(this.history)); }
  alternationAnalysis() { return this._wrap(runsTest(this.history)); }
  movingAverageAnalysis() { return this._wrap(digitMomentum(this.history)); }
  fibonacciAnalysis() { return this._wrap(binomialImbalance(this.history)); }
  balanceAnalysis() { return this._wrap(binomialImbalance(this.history)); }
  _wrap(r) {
    return { prediction: r.prediction, confidence: Math.round(50 + Math.abs(r.score || 0) * 40), details: r.details || {} };
  }
  predictFromTrend(sizes) {
    if (!sizes || !sizes.length) return 'BIG';
    const last3 = sizes.slice(-3);
    const bigCount = last3.filter(s => s === 'BIG').length;
    return bigCount >= 2 ? 'BIG' : 'SMALL';
  }
}

function analyzeHistory(history, mode) {
  const analyzer = new WingoAnalyzer(history);
  return analyzer.analyze();
}

module.exports = {
  WingoAnalyzer,
  analyzeHistory,
  sortChronologically,
  gradePrediction,
  walkForwardGrade,
  runSubmodels,
  markovNGram,
  runsTest,
  streakHazard,
  binomialImbalance,
  digitMomentum,
  BREAK_EVEN,
  BREAK_EVEN_PCT,
  WARMUP,
  MIN_HISTORY_FOR_BET,
  SUBMODELS
};
