(function () {
  'use strict';
  var currentMode = '1m';
  var countdownTimer = null;
  var autoRefreshInterval = null;
  var lockedPrediction = null;
  var lockExpires = 0;
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
    modeSelector: document.getElementById('modeSelector')
  };
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function formatPeriod(period) { return !period ? '--' : String(period); }
  function getBallColorClass(number) {
    number = Number(number);
    if (number === 0 || number === 5) return 'violet';
    if ([1, 3, 7, 9].includes(number)) return 'green';
    return 'red';
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
    }
    function tick() {
      remaining -= 1;
      if (remaining <= 0) { clearInterval(countdownTimer); loadPrediction(); return; }
      updateDisplay();
    }
    updateDisplay();
    countdownTimer = setInterval(tick, 1000);
  }
  function renderPrediction(data) {
    if (!data) return;
    if (elements.nextPeriod) elements.nextPeriod.textContent = formatPeriod(data.period);
    if (elements.sourceBadge) {
      var isApi = data.source === 'api';
      elements.sourceBadge.textContent = isApi ? 'fb999.com Live' : 'Local';
    }
    if (elements.predictionResult && elements.predictionText && elements.confidenceBadge) {
      var now = Date.now();
      var newLeft = Number(data.left) || 0;

      if (newLeft > 25) {
        lockedPrediction = data.prediction || 'SMALL';
        lockExpires = now + newLeft * 1000;
      }
      var prediction = (lockedPrediction && now < lockExpires) ? lockedPrediction : (data.prediction || 'SMALL');
      var confidence = data.confidence || 0;
      elements.predictionText.textContent = prediction === 'BIG' ? 'BIG' : 'SMALL';
      elements.confidenceBadge.textContent = confidence + '%';
      elements.predictionResult.className = 'prediction-badge ' + (prediction === 'BIG' ? 'big' : 'small');
    }
  }
  function formatAlgoName(name) {
    var names = { streak: 'Streak Counter', frequency: 'Frequency', pattern: 'Pattern Match', alternation: 'Alternation', movingAverage: 'Moving Avg', fibonacci: 'Fibonacci', balance: 'Balance' };
    return names[name] || name;
  }
  function renderAlgorithms(algorithms) {
    if (!algorithms || !algorithms.length) {
      elements.algorithmsList.innerHTML = '<div class="algorithm-item"><span class="algorithm-name">No data</span></div>';
      return;
    }
    elements.algorithmsList.innerHTML = algorithms.map(function (algo) {
      var resultClass = algo.prediction === 'BIG' ? 'result-big' : 'result-small';
      return '<div class="algorithm-item"><span class="algorithm-name">' + formatAlgoName(algo.name) + '</span><span class="algorithm-result ' + resultClass + '">' + algo.prediction + '<span class="algorithm-confidence">(' + algo.confidence + '%)</span></span></div>';
    }).join('');
  }
  function renderHistory(history) {
    if (!history || !history.length) {
      elements.historyBody.innerHTML = '<tr><td colspan="4" class="loading-row">No records</td></tr>';
      return;
    }
    elements.historyBody.innerHTML = history.slice().reverse().map(function (h) {
      var ballColor = getBallColorClass(h.number);
      var size = h.size || (Number(h.number) >= 5 ? 'BIG' : 'SMALL');
      return '<tr><td>' + formatPeriod(h.period) + '</td><td class="number-cell"><span class="ball ' + ballColor + '">' + h.number + '</span></td><td class="' + (size === 'BIG' ? 'size-big' : 'size-small') + '">' + size + '</td><td>-</td></tr>';
    }).join('');
  }
  function renderError(message) {
    elements.algorithmsList.innerHTML = '<div class="status-error">' + message + '</div>';
    elements.historyBody.innerHTML = '<tr><td colspan="4" class="loading-row">No data available</td></tr>';
  }
  function loadPrediction() {
    var mode = currentMode;
    elements.countdown.textContent = 'Loading';
    fetch('/api/predict?mode=' + encodeURIComponent(mode))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.success) throw new Error(data.error || 'Unknown error');
        renderPrediction(data);
        if (data.analysis && data.analysis.algorithms) renderAlgorithms(data.analysis.algorithms);
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
        renderPrediction(data);
        if (data.history) renderHistory(data.history);
        if (elements.lastUpdate) elements.lastUpdate.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        startCountdown(data.left);
      })
      .catch(function (error) { renderError(error.message || 'Connection failed'); });
  }
  if (elements.modeSelector) {
      elements.modeSelector.addEventListener('change', function (e) {
        currentMode = e.target.value;
        lockedPrediction = null;
        lockExpires = 0;
        loadPrediction();
    });
  }
  loadPrediction();
  loadFullData();
  if (autoRefreshInterval) clearInterval(autoRefreshInterval);
  autoRefreshInterval = setInterval(loadFullData, 30000);
})();
