'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchWingoData, MODES } = require('./api');
const { analyzeHistory, sortChronologically, gradePrediction } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

const CACHE_TTL = 5000;
let dataCache = {};

// --- Per-mode prediction locking + ledger state ---
// locks: mode -> Map<issueNumber, lock>
// ledger: mode -> array (rolling, newest last, capped 100)
// graded: mode -> Set<issueNumber> already graded
const locksByMode = new Map();
const ledgerByMode = new Map();
const gradedByMode = new Map();
const LEDGER_MAX = 100;

function getLocks(mode) {
  if (!locksByMode.has(mode)) locksByMode.set(mode, new Map());
  return locksByMode.get(mode);
}
function getLedger(mode) {
  if (!ledgerByMode.has(mode)) ledgerByMode.set(mode, []);
  return ledgerByMode.get(mode);
}
function getGraded(mode) {
  if (!gradedByMode.has(mode)) gradedByMode.set(mode, new Set());
  return gradedByMode.get(mode);
}

function clearModeState(mode) {
  locksByMode.delete(mode);
  ledgerByMode.delete(mode);
  gradedByMode.delete(mode);
  delete dataCache[mode];
}
function clearAllState() {
  locksByMode.clear(); ledgerByMode.clear(); gradedByMode.clear(); dataCache = {};
}

// Grade any locked predictions whose settled digit is now in history.
// history may be newest-first; we index by period string.
function gradeLockedPredictions(mode, history) {
  const locks = getLocks(mode);
  const ledger = getLedger(mode);
  const graded = getGraded(mode);
  const byPeriod = new Map();
  for (const h of history || []) {
    const key = String(h.period != null ? h.period : h.issueNumber);
    byPeriod.set(key, h);
  }
  let newEntries = 0;
  for (const [issue, lock] of locks.entries()) {
    if (graded.has(issue)) continue;
    const settled = byPeriod.get(issue);
    if (!settled) continue;
    const actualNumber = Number(settled.number);
    const actualSize = settled.size ? String(settled.size).toUpperCase() : (actualNumber >= 5 ? 'BIG' : 'SMALL');
    const result = gradePrediction(lock.shouldBet ? lock.prediction : 'SKIP', actualSize);
    const entry = {
      period: issue,
      issueNumber: issue,
      mode: mode,
      predicted: lock.shouldBet ? lock.prediction : 'SKIP',
      lean: lock.lean,
      shouldBet: Boolean(lock.shouldBet),
      actualNumber: actualNumber,
      actualSize: actualSize,
      result: result, // WIN | LOSS | SKIPPED
      winRateAtLock: lock.winRatePct != null ? lock.winRatePct : null,
      lockedAt: lock.lockedAt,
      gradedAt: new Date().toISOString()
    };
    ledger.push(entry);
    graded.add(issue);
    newEntries++;
    if (ledger.length > LEDGER_MAX) ledger.splice(0, ledger.length - LEDGER_MAX);
  }
  return newEntries;
}

function ledgerStats(mode) {
  const ledger = getLedger(mode);
  let wins = 0, losses = 0, skipped = 0;
  for (const e of ledger) {
    if (e.result === 'WIN') wins++;
    else if (e.result === 'LOSS') losses++;
    else skipped++;
  }
  const graded = wins + losses;
  const winRate = graded ? wins / graded : null;
  return {
    wins, losses, skipped, graded,
    winRate: winRate != null ? Number(winRate.toFixed(4)) : null,
    winRatePct: winRate != null ? Number((winRate * 100).toFixed(1)) : null,
    record: `${wins}W-${losses}L`,
    total: ledger.length
  };
}

// Lock (or reuse) the prediction for the current issueNumber. Immutable per period.
function lockPredictionForPeriod(mode, issueNumber, analysis, left) {
  const locks = getLocks(mode);
  const key = String(issueNumber);
  if (locks.has(key)) return locks.get(key);
  const lock = {
    period: key,
    issueNumber: key,
    mode: mode,
    prediction: analysis.prediction, // BIG | SMALL | SKIP
    lean: analysis.lean,
    shouldBet: Boolean(analysis.shouldBet),
    confidence: analysis.confidence,
    winRatePct: analysis.winRatePct != null ? analysis.winRatePct : null,
    wins: analysis.wins,
    losses: analysis.losses,
    record: analysis.record,
    agreement: analysis.agreement,
    leftAtLock: left != null ? Number(left) : null,
    lockedAt: new Date().toISOString()
  };
  locks.set(key, lock);
  // Prune old locks (keep last 50 periods)
  if (locks.size > 50) {
    const keys = Array.from(locks.keys());
    for (let i = 0; i < locks.size - 50; i++) locks.delete(keys[i]);
  }
  return lock;
}

async function getCachedData(mode) {
  const cacheKey = mode;
  const now = Date.now();
  const cached = dataCache[cacheKey];
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  const data = await fetchWingoData(mode, fetch);
  dataCache[cacheKey] = { data, timestamp: now };
  return data;
}

// --- Demo fallback (only when live fb999api is unreachable, e.g. sandbox preview) ---
// Generates deterministic synthetic history so the UI/preview shows working
// predictions. Clearly labelled source:'demo'. Production with internet uses live data.
const DEMO_INTERVALS = { '30s': 30, '1m': 60, '3m': 180, '5m': 300, '10m': 600 };
function demoDigitForPeriod(periodNum) {
  // Deterministic hash -> digit 0-9, stable across requests
  let s = (periodNum * 2654435761) >>> 0;
  s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
  return s % 10;
}
function buildDemoData(mode) {
  const interval = DEMO_INTERVALS[mode] || 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const periodIndex = Math.floor(nowSec / interval);
  const currentPeriod = 900000 + periodIndex;
  const left = interval - (nowSec % interval);
  const history = [];
  for (let i = 80; i >= 1; i--) {
    const p = currentPeriod - i;
    const num = demoDigitForPeriod(p);
    const size = num >= 5 ? 'BIG' : 'SMALL';
    history.push({
      period: String(p),
      issueNumber: String(p),
      number: num,
      size: size,
      sizeLabel: size === 'BIG' ? 'Big' : 'Small',
      color: num === 0 ? 'red+violet' : num === 5 ? 'green+violet' : ([1, 3, 7, 9].includes(num) ? 'green' : 'red'),
      colors: num === 0 ? ['red', 'violet'] : num === 5 ? ['green', 'violet'] : ([1, 3, 7, 9].includes(num) ? ['green'] : ['red'])
    });
  }
  // history already newest-first (descending period)
  return {
    periodMode: mode,
    current: String(currentPeriod),
    next: String(currentPeriod),
    left: left,
    prediction: null,
    confidence: null,
    shouldBet: false,
    lean: null,
    number: history[0] ? history[0].number : null,
    source: 'demo',
    issueType: 1,
    history: history
  };
}

// Build the full response payload with locked prediction wired to top level.
async function buildWingoPayload(mode) {
  let data;
  try {
    data = await getCachedData(mode);
  } catch (e) {
    // Live API unreachable (e.g. sandbox preview) — serve demo so UI is functional.
    // In production with internet this path is never taken.
    data = buildDemoData(mode);
  }
  const rawHistory = data.history || [];
  // Analyzer sorts chronologically internally; UI history stays newest-first.
  const analysis = analyzeHistory(rawHistory, mode);
  const issueNumber = String(data.next || data.current || '');
  const left = Number(data.left || 0);
  const bettingLocked = left <= 5 && left > 0;

  // Grade settled locks first, then lock current period (if new)
  gradeLockedPredictions(mode, rawHistory);
  const lock = issueNumber ? lockPredictionForPeriod(mode, issueNumber, analysis, left) : null;

  // Locked values win — never flip mid-round, never clobber with hardcoded defaults
  const lockedPrediction = lock ? lock.prediction : analysis.prediction;
  const lockedLean = lock ? lock.lean : analysis.lean;
  const lockedShouldBet = lock ? Boolean(lock.shouldBet) : Boolean(analysis.shouldBet);
  const lockedConfidence = lock ? lock.confidence : analysis.confidence;
  const lockedWinRatePct = lock && lock.winRatePct != null ? lock.winRatePct : analysis.winRatePct;

  // History newest-first for UI
  const historyNewestFirst = rawHistory.slice().sort((a, b) => {
    const na = parseInt(String(a.period), 10), nb = parseInt(String(b.period), 10);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return String(b.period).localeCompare(String(a.period));
  });

  const ledger = getLedger(mode).slice().reverse(); // newest first
  const stats = ledgerStats(mode);

  return {
    ...data,
    history: historyNewestFirst,
    // Top-level wired to locked analysis (fixes /api/wingo clobber bug)
    prediction: lockedPrediction,
    lean: lockedLean,
    leanLabel: lockedLean === 'BIG' ? 'Lean BIG' : 'Lean SMALL',
    shouldBet: lockedShouldBet,
    confidence: lockedConfidence,
    winRate: analysis.winRate,
    winRatePct: lockedWinRatePct,
    wins: analysis.wins,
    losses: analysis.losses,
    record: analysis.record,
    bettingLocked: bettingLocked,
    lockedPeriod: issueNumber,
    lockedPrediction: lock,
    analysis: analysis,
    ledger: ledger,
    ledgerStats: stats,
    receivedAt: new Date().toISOString()
  };
}

app.get('/api/modes', (req, res) => {
  res.json({ modes: MODES });
});

app.get('/api/wingo', async (req, res) => {
  try {
    const mode = req.query.mode || '1m';
    if (!MODES.includes(mode)) return res.status(400).json({ success: false, error: 'Invalid mode' });
    const result = await buildWingoPayload(mode);
    res.json(result);
  } catch (error) {
    console.error('Wingo API error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to fetch Wingo data', message: error.message });
  }
});

app.get('/api/predict', async (req, res) => {
  try {
    const mode = req.query.mode || '1m';
    if (!MODES.includes(mode)) return res.status(400).json({ success: false, error: 'Invalid mode' });
    const payload = await buildWingoPayload(mode);
    res.json({
      success: true,
      period: payload.lockedPeriod,
      mode: payload.periodMode,
      left: payload.left,
      bettingLocked: payload.bettingLocked,
      prediction: payload.prediction,
      lean: payload.lean,
      leanLabel: payload.leanLabel,
      shouldBet: payload.shouldBet,
      predictionLabel: payload.analysis.sizeLabel,
      confidence: payload.confidence,
      winRate: payload.winRate,
      winRatePct: payload.winRatePct,
      wins: payload.wins,
      losses: payload.losses,
      record: payload.record,
      lockedPrediction: payload.lockedPrediction,
      analysis: payload.analysis,
      ledger: payload.ledger,
      ledgerStats: payload.ledgerStats,
      source: payload.source,
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Prediction error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to generate prediction', message: error.message });
  }
});

app.get('/api/ledger', async (req, res) => {
  try {
    const mode = req.query.mode || '1m';
    if (!MODES.includes(mode)) return res.status(400).json({ success: false, error: 'Invalid mode' });
    // Ensure grading is up to date if we have cached data
    const cached = dataCache[mode];
    if (cached && cached.data && cached.data.history) gradeLockedPredictions(mode, cached.data.history);
    res.json({
      success: true,
      mode,
      ledger: getLedger(mode).slice().reverse(),
      stats: ledgerStats(mode),
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('Wingo Bot server running on http://' + HOST + ':' + PORT);
    console.log('Endpoints: /api/modes, /api/wingo, /api/predict, /api/ledger, /health');
  });
}

module.exports = app;
module.exports.buildWingoPayload = buildWingoPayload;
module.exports.gradeLockedPredictions = gradeLockedPredictions;
module.exports.lockPredictionForPeriod = lockPredictionForPeriod;
module.exports.ledgerStats = ledgerStats;
module.exports.getLedger = getLedger;
module.exports.getLocks = getLocks;
module.exports.clearModeState = clearModeState;
module.exports.clearAllState = clearAllState;
module.exports._setDataCache = (mode, data) => { dataCache[mode] = { data, timestamp: Date.now() }; };
