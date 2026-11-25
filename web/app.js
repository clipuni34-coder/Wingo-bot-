(function () {
  'use strict';
  var currentMode = '1m';
  var countdownTimer = null;
  var autoRefreshInterval = null;
  // Locked prediction keyed by period — full refreshes never clobber it mid-round.
  var lockedPrediction = null; // {period, prediction, lean, shouldBet, winRatePct, record}
  var elements = {
    countdown: document.getElementById('countdown'),
    nextPeriod: document.getElementById('nextPeriod'),
    predictionText: document.getElementById('predictionText'),
    confidenceBadge: document.getElementById('confidenceBadge'),
    predictionResult: document.getElementById('predictionResult'),
    sourceBadge: document.getElementById('sourceBadge'),
    algorithmsList: document.getElementById('algorithmsList'),
    historyBody: document.getElementById('historyBody'),
    lastUpdate: document.getElementById('lastUpdate'),
    modeSelector: document.getElementById('modeSelector'),
    bettingLockedBadge: document.getElementById('bettingLockedBadge'),
    predictionCard: document.getElementById('predictionCard'),
    leanText: document.getElementById('leanText'),
    winRateValue: document.getElementById('winRateValue'),
    recordValue: document.getElementById('recordValue'),
    skipReason: document.getElementById('skipReason'),
    ledgerBody: document.getElementById('ledgerBody'),
    ledgerSummary: document.getElementById('ledgerSummary')
  };
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function formatPeriod(period) { return !period ? '--' : String(period); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Dual-color mapping: 0 red+violet, 5 green+violet, 1/3/7/9 green, 2/4/6/8 red
  function getBallColors(number) {
    number = Number(number);
    if (number === 0) return ['red', 'violet'];
    if (number === 5) return ['green', 'violet'];
    if ([1, 3, 7, 9].includes(number)) return ['green'];
    return ['red'];
  }
  function getBallColorClass(number) {
    var c = getBallColors(number);
    return c.length > 1 ? 'dual-' + c[0] + '-violet' : c[0];
  }
  function colorBadgeHtml(number) {
    var colors = getBallColors(number);
    if (colors.length > 1) {
      return '<span class="color-badge dual" title="' + colors.join('+') + '"><span class="color-half ' + colors[0] + '"></span><span class="color-half ' + colors[1] + '"></span></span>';
    }
    return '<span class="color-badge ' + colors[0] + '" title="' + colors[0] + '"></span>';
  }
  function startCountdown(seconds) {
    if (countdownTimer) clearInterval(countdownTimer);
    var remaining = Number(seconds) || 0;
    function updateDisplay() {
      var min = Math.floor(remaining / 60);
      var sec = remaining % 60;
      if (elements.countdown) {
        elements.countdown.textContent = (min > 0 ? pad(min) + ':' : '') + pad(sec) + 's';
      }
      var locked = remaining <= 5 && remaining > 0;
      if (elements.bettingLockedBadge) elements.bettingLockedBadge.classList.toggle('hidden', !locked);
      if (elements.countdown) elements.countdown.classList.toggle('locked', locked);
      if (elements.predictionCard) elements.predictionCard.classList.toggle('betting-locked', locked);
    }
    function tick() {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(countdownTimer); loadPrediction(); return; }
      updateDisplay();
    }
    updateDisplay();
    countdownTimer = setInterval(tick, 1000);
  }
  // Normalize any payload shape (/api/predict or /api/wingo) into locked fields.
  function extractLocked(data) {
    var analysis = data.analysis || {};
    var period = String(data.period || data.lockedPeriod || data.next || data.current || '');
    var prediction = data.prediction != null ? data.prediction : (analysis.prediction || 'SKIP');
    var lean = data.lean || analysis.lean || (prediction === 'SKIP' ? 'BIG' : prediction);
    var shouldBet = data.shouldBet != null ? Boolean(data.shouldBet) : Boolean(analysis.shouldBet);
    var winRatePct = data.winRatePct != null ? data.winRatePct : (analysis.winRatePct != null ? analysis.winRatePct : null);
    var record = data.record || analysis.record || '--';
    var skipReason = analysis.skipReason || null;
    return { period: period, prediction: prediction, lean: lean, shouldBet: shouldBet, winRatePct: winRatePct, record: record, skipReason: skipReason, analysis: analysis };
  }
  function renderPrediction(data) {
    if (!data) return;
    var incoming = extractLocked(data);
    // Lock on first sight of a period; never overwrite for the same period.
    if (!lockedPrediction || lockedPrediction.period !== incoming.period) {
      lockedPrediction = incoming;
    }
    var locked = lockedPrediction;
    if (elements.nextPeriod) elements.nextPeriod.textContent = formatPeriod(locked.period);
    if (elements.sourceBadge) {
      var isApi = data.source === 'api';
      elements.sourceBadge.textContent = isApi ? 'fb999.com Live' : 'Local';
    }
    if (elements.predictionResult && elements.predictionText && elements.confidenceBadge) {
      var isSkip = locked.prediction === 'SKIP' || !locked.shouldBet;
      var display = isSkip ? 'SKIP' : (locked.prediction === 'BIG' ? 'BIG' : 'SMALL');
      elements.predictionText.textContent = display;
      elements.confidenceBadge.textContent = locked.winRatePct != null ? locked.winRatePct + '%' : '--%';
      var cls = 'prediction-badge ';
      if (isSkip) cls += 'skip';
      else cls += (display === 'BIG' ? 'big' : 'small');
      elements.predictionResult.className = cls;
    }
    if (elements.leanText) {
      elements.leanText.textContent = locked.lean === 'BIG' ? 'Lean BIG' : 'Lean SMALL';
    }
    if (elements.winRateValue) {
      elements.winRateValue.textContent = locked.winRatePct != null ? locked.winRatePct + '%' : '--%';
    }
    if (elements.recordValue) {
      elements.recordValue.textContent = locked.record || '--';
    }
    if (elements.skipReason) {
      if (!locked.shouldBet && locked.skipReason) {
        elements.skipReason.textContent = 'SKIP (No Edge): ' + locked.skipReason;
        elements.skipReason.classList.remove('hidden');
      } else if (!locked.shouldBet) {
        elements.skipReason.textContent = 'SKIP (No Edge)';
        elements.skipReason.classList.remove('hidden');
      } else {
        elements.skipReason.classList.add('hidden');
      }
    }
  }
  function formatAlgoName(name) {
    var names = { markov: 'Markov N-Gram', runs: 'Runs Test', streakHazard: 'Streak Hazard', binomial: 'Binomial Imbalance', digitMomentum: 'Digit Momentum', streak: 'Streak Counter', frequency: 'Frequency', pattern: 'Pattern Match', alternation: 'Alternation', movingAverage: 'Moving Avg', fibonacci: 'Fibonacci', balance: 'Balance' };
    return names[name] || name;
  }
  function renderAlgorithms(algorithms) {
    if (!algorithms || !algorithms.length) {
      elements.algorithmsList.innerHTML = '<div class="algorithm-item"><span class="algorithm-name">No data</span></div>';
      return;
    }
    elements.algorithmsList.innerHTML = algorithms.map(function (algo) {
      var resultClass = algo.prediction === 'BIG' ? 'result-big' : 'result-small';
      var wr = algo.winRate != null ? '<span class="algorithm-winrate">' + algo.winRate + '%</span>' : '';
      var w = algo.weight != null ? '<span class="algorithm-weight">w:' + Number(algo.weight).toFixed(2) + '</span>' : '';
      return '<div class="algorithm-item"><span class="algorithm-name">' + escapeHtml(formatAlgoName(algo.name)) + '</span><span class="algorithm-result ' + resultClass + '">' + escapeHtml(algo.prediction) + '<span class="algorithm-confidence">(' + algo.confidence + '%)</span>' + wr + w + '</span></div>';
    }).join('');
  }
  function renderHistory(history) {
    if (!history || !history.length) {
      elements.historyBody.innerHTML = '<tr><td colspan="4" class="loading-row">No records</td></tr>';
      return;
    }
    // Display newest-first: sort descending by numeric period (do not blindly reverse)
    var sorted = history.slice().sort(function (a, b) {
      var na = parseInt(String(a.period), 10), nb = parseInt(String(b.period), 10);
      if (!isNaN(na) && !isNaN(nb)) return nb - na;
      return String(b.period).localeCompare(String(a.period));
    });
    elements.historyBody.innerHTML = sorted.slice(0, 30).map(function (h) {
      var ballColor = getBallColorClass(h.number);
      var size = h.size || (Number(h.number) >= 5 ? 'BIG' : 'SMALL');
      return '<tr><td>' + escapeHtml(formatPeriod(h.period)) + '</td><td class="number-cell"><span class="ball ' + ballColor + '">' + escapeHtml(h.number) + '</span></td><td class="' + (size === 'BIG' ? 'size-big' : 'size-small') + '">' + escapeHtml(size) + '</td><td>' + colorBadgeHtml(h.number) + '</td></tr>';
    }).join('');
  }
  function renderLedger(ledger, stats) {
    if (elements.ledgerSummary) {
      if (stats && stats.graded != null) {
        elements.ledgerSummary.textContent = stats.record + ' · ' + (stats.winRatePct != null ? stats.winRatePct + '%' : '--%') + ' win rate · ' + stats.skipped + ' skipped';
      } else {
        elements.ledgerSummary.textContent = '--';
      }
    }
    if (!elements.ledgerBody) return;
    if (!ledger || !ledger.length) {
      elements.ledgerBody.innerHTML = '<tr><td colspan="4" class="loading-row">No graded predictions yet</td></tr>';
      return;
    }
    elements.ledgerBody.innerHTML = ledger.slice(0, 20).map(function (e) {
      var resultClass = e.result === 'WIN' ? 'result-win' : (e.result === 'LOSS' ? 'result-loss' : 'result-skip');
      var actual = e.actualSize || '--';
      var actualNum = e.actualNumber != null ? ' (' + e.actualNumber + ')' : '';
      return '<tr><td>' + escapeHtml(formatPeriod(e.period)) + '</td><td>' + escapeHtml(e.predicted || 'SKIP') + '</td><td>' + escapeHtml(actual) + escapeHtml(actualNum) + '</td><td class="' + resultClass + '">' + escapeHtml(e.result || 'SKIPPED') + '</td></tr>';
    }).join('');
  }
  function renderError(message) {
    elements.algorithmsList.innerHTML = '<div class="status-error">' + escapeHtml(message) + '</div>';
    elements.historyBody.innerHTML = '<tr><td colspan="4" class="loading-row">No data available</td></tr>';
  }
  function loadPrediction() {
    var mode = currentMode;
    if (elements.countdown) elements.countdown.textContent = 'Loading';
    fetch('/api/predict?mode=' + encodeURIComponent(mode))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error || 'Unknown error');
        renderPrediction(data);
        if (data.analysis && data.analysis.algorithms) renderAlgorithms(data.analysis.algorithms);
        if (data.ledger) renderLedger(data.ledger, data.ledgerStats);
        if (elements.lastUpdate) elements.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        startCountdown(data.left);
      })
      .catch(function (error) {
        renderError(error.message || 'Connection failed');
        if (elements.countdown) elements.countdown.textContent = '--:--';
      });
  }
  function loadFullData() {
    var mode = currentMode;
    fetch('/api/wingo?mode=' + encodeURIComponent(mode))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.analysis && data.analysis.algorithms) renderAlgorithms(data.analysis.algorithms);
        // renderPrediction locks by period — safe to call on every refresh
        renderPrediction(data);
        if (data.history) renderHistory(data.history);
        if (data.ledger) renderLedger(data.ledger, data.ledgerStats);
        if (elements.lastUpdate) elements.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        startCountdown(data.left);
      })
      .catch(function (error) { renderError(error.message || 'Connection failed'); });
  }
  if (elements.modeSelector) {
    elements.modeSelector.addEventListener('change', function (e) {
      currentMode = e.target.value;
      lockedPrediction = null;
      loadPrediction();
      loadFullData();
    });
  }
  loadPrediction();
  loadFullData();
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(loadFullData, 30000);
})();
