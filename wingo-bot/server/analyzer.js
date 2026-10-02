'use strict';

const { numberToSize, SIZE_LABELS } = require('./api');

class WingoAnalyzer {
  constructor(history = []) {
    this.history = history.map(h => ({
      period: h.period,
      number: Number(h.number),
      size: h.size ? String(h.size).toUpperCase() : numberToSize(Number(h.number)),
      color: h.color || ''
    }));
  }

  getSizes() {
    return this.history.map(h => h.size);
  }

  getNumbers() {
    return this.history.map(h => h.number);
  }

  analyze() {
    const algorithms = [
      { name: 'streak', weight: 0.20, result: this.streakAnalysis() },
      { name: 'frequency', weight: 0.15, result: this.frequencyAnalysis() },
      { name: 'pattern', weight: 0.20, result: this.patternAnalysis() },
      { name: 'alternation', weight: 0.10, result: this.alternationAnalysis() },
      { name: 'movingAverage', weight: 0.15, result: this.movingAverageAnalysis() },
      { name: 'fibonacci', weight: 0.10, result: this.fibonacciAnalysis() },
      { name: 'balance', weight: 0.10, result: this.balanceAnalysis() }
    ];

    let bigScore = 0;
    let smallScore = 0;
    let totalWeight = 0;

    for (const algo of algorithms) {
      const result = algo.result;
      if (result.prediction === 'BIG') {
        bigScore += algo.weight * (result.confidence / 100);
      } else {
        smallScore += algo.weight * (result.confidence / 100);
      }
      totalWeight += algo.weight;
    }

    const prediction = bigScore >= smallScore ? 'BIG' : 'SMALL';
    const margin = Math.abs(bigScore - smallScore) / totalWeight;
    const confidence = Math.min(92, Math.max(40, Math.round(50 + margin * 60)));

    const algorithmDetails = algorithms.map(a => ({
      name: a.name,
      prediction: a.result.prediction,
      confidence: a.result.confidence,
      weight: a.weight,
      details: a.result.details
    }));

    return {
      prediction: prediction,
      confidence: confidence,
      sizeLabel: SIZE_LABELS[prediction],
      algorithms: algorithmDetails,
      bigScore: Math.round(bigScore * 100),
      smallScore: Math.round(smallScore * 100),
      totalHistory: this.history.length
    };
  }

  streakAnalysis() {
    const sizes = this.getSizes();
    if (sizes.length < 3) return { prediction: 'BIG', confidence: 50, details: { streak: 0 } };

    let currentStreak = 1;
    let streakType = sizes[sizes.length - 1];

    for (let i = sizes.length - 2; i >= 0; i--) {
      if (sizes[i] === streakType) {
        currentStreak++;
      } else {
        break;
      }
    }

    let prediction = streakType;
    let confidence = 50;

    if (currentStreak >= 4) {
      prediction = streakType === 'BIG' ? 'SMALL' : 'BIG';
      confidence = 65;
    } else if (currentStreak >= 3) {
      prediction = streakType === 'BIG' ? 'SMALL' : 'BIG';
      confidence = 58;
    } else {
      confidence = 52;
    }

    return {
      prediction,
      confidence,
      details: { currentStreak, streakType, reversed: prediction !== streakType }
    };
  }

  frequencyAnalysis() {
    const sizes = this.getSizes();
    if (sizes.length < 5) return { prediction: 'BIG', confidence: 50, details: {} };

    const bigCount = sizes.filter(s => s === 'BIG').length;
    const smallCount = sizes.filter(s => s === 'SMALL').length;
    const totalCount = sizes.length;
    const bigRatio = bigCount / totalCount;

    let prediction, confidence;

    if (bigRatio > 0.6) {
      prediction = 'SMALL';
      confidence = Math.round(55 + (bigRatio - 0.6) * 80);
    } else if (bigRatio < 0.4) {
      prediction = 'BIG';
      confidence = Math.round(55 + (0.4 - bigRatio) * 80);
    } else {
      prediction = bigRatio >= 0.5 ? 'BIG' : 'SMALL';
      confidence = Math.round(52 + Math.abs(bigRatio - 0.5) * 80);
    }

    confidence = Math.min(85, Math.max(50, confidence));

    return {
      prediction,
      confidence,
      details: { bigCount, smallCount, bigRatio: Number((bigRatio * 100).toFixed(1)) }
    };
  }

  patternAnalysis() {
    const sizes = this.getSizes();
    if (sizes.length < 6) return { prediction: 'BIG', confidence: 50, details: {} };

    const windowSize = Math.min(10, sizes.length);
    const recent = sizes.slice(-windowSize);
    const recentStr = recent.join('');

    let bestMatch = 0;
    let bestLookback = 0;

    for (let lookback = windowSize + 1; lookback <= sizes.length; lookback++) {
      const window = sizes.slice(-lookback, -lookback + windowSize);
      if (window.length < windowSize) continue;
      const windowStr = window.join('');
      if (windowStr === recentStr) {
        bestMatch = windowSize;
        bestLookback = lookback;
        break;
      }
    }

    let prediction, confidence;

    if (bestMatch > 0) {
      const nextIndex = sizes.length - bestLookback + windowSize;
      prediction = nextIndex < sizes.length ? sizes[nextIndex] : this.predictFromTrend(recent);
      confidence = 70;
    } else {
      prediction = this.predictFromTrend(recent);
      confidence = 55;
    }

    confidence = Math.min(75, Math.max(50, confidence));

    return {
      prediction,
      confidence,
      details: { patternMatched: bestMatch > 0, lookback: bestLookback, windowSize }
    };
  }

  alternationAnalysis() {
    const sizes = this.getSizes();
    if (sizes.length < 4) return { prediction: 'BIG', confidence: 50, details: {} };

    let alternations = 0;
    for (let i = 1; i < sizes.length; i++) {
      if (sizes[i] !== sizes[i - 1]) alternations++;
    }

    const ratio = alternations / (sizes.length - 1);
    let prediction, confidence;

    if (ratio > 0.7) {
      const last = sizes[sizes.length - 1];
      prediction = last === 'BIG' ? 'SMALL' : 'BIG';
      confidence = 65;
    } else {
      const last = sizes[sizes.length - 1];
      prediction = last;
      confidence = 53;
    }

    return {
      prediction,
      confidence: Math.min(70, Math.max(48, confidence)),
      details: { alternations, ratio: Number((ratio * 100).toFixed(1)) }
    };
  }

  movingAverageAnalysis() {
    const numbers = this.getNumbers();
    if (numbers.length < 8) return { prediction: 'BIG', confidence: 50, details: {} };

    const windowSize = Math.min(8, numbers.length);
    const recent = numbers.slice(-windowSize);
    const avg = recent.reduce((a, b) => a + b, 0) / windowSize;
    const allAvg = numbers.reduce((a, b) => a + b, 0) / numbers.length;

    let prediction, confidence;

    if (avg < allAvg) {
      prediction = 'BIG';
      confidence = Math.round(55 + ((allAvg - avg) / allAvg) * 20);
    } else if (avg > allAvg) {
      prediction = 'SMALL';
      confidence = Math.round(55 + ((avg - allAvg) / allAvg) * 20);
    } else {
      prediction = avg >= 4.5 ? 'BIG' : 'SMALL';
      confidence = 52;
    }

    return {
      prediction,
      confidence: Math.min(72, Math.max(48, confidence)),
      details: { recentAvg: Number(avg.toFixed(2)), overallAvg: Number(allAvg.toFixed(2)) }
    };
  }

  fibonacciAnalysis() {
    const sizes = this.getSizes();
    const fibLevels = [5, 8, 13, 21];
    let bigVotes = 0;
    let smallVotes = 0;
    const results = [];

    for (const level of fibLevels) {
      if (sizes.length < level) continue;
      const window = sizes.slice(-level);
      const bigCount = window.filter(s => s === 'BIG').length;
      const smallCount = window.filter(s => 'SMALL').length;

      if (bigCount > smallCount) {
        bigVotes++;
        results.push({ level, vote: 'BIG', bigCount, smallCount });
      } else {
        smallVotes++;
        results.push({ level, vote: 'SMALL', bigCount, smallCount });
      }
    }

    let prediction, confidence;
    if (bigVotes > smallVotes) {
      prediction = 'BIG';
      confidence = Math.round(55 + (bigVotes / fibLevels.length) * 15);
    } else if (smallVotes > bigVotes) {
      prediction = 'SMALL';
      confidence = Math.round(55 + (smallVotes / fibLevels.length) * 15);
    } else {
      prediction = sizes[sizes.length - 1];
      confidence = 50;
    }

    return {
      prediction,
      confidence: Math.min(70, Math.max(48, confidence)),
      details: { results, bigVotes, smallVotes }
    };
  }

  balanceAnalysis() {
    const sizes = this.getSizes();
    if (sizes.length < 10) return { prediction: 'BIG', confidence: 50, details: {} };

    const segmentSize = Math.floor(sizes.length / 3);
    const segments = [];
    for (let i = 0; i < 3; i++) {
      const start = i * segmentSize;
      const end = (i === 2) ? sizes.length : start + segmentSize;
      segments.push(sizes.slice(start, end));
    }

    const ratios = segments.map(seg => {
      const big = seg.filter(s => s === 'BIG').length;
      return big / seg.length;
    });

    const latestRatio = ratios[ratios.length - 1];
    let prediction, confidence;

    if (latestRatio > 0.6) {
      prediction = 'SMALL';
      confidence = 65;
    } else if (latestRatio < 0.4) {
      prediction = 'BIG';
      confidence = 65;
    } else {
      prediction = latestRatio >= 0.5 ? 'BIG' : 'SMALL';
      confidence = 55;
    }

    return {
      prediction,
      confidence: Math.min(70, Math.max(48, confidence)),
      details: { segmentRatios: ratios.map(r => Number((r * 100).toFixed(1))) }
    };
  }

  predictFromTrend(sizes) {
    if (sizes.length === 0) return 'BIG';
    const last3 = sizes.slice(-3);
    const bigCount = last3.filter(s => s === 'BIG').length;
    if (bigCount >= 2) return 'BIG';
    if (bigCount <= 1) return 'SMALL';
    return sizes[sizes.length - 1];
  }
}

function analyzeHistory(history, mode) {
  const analyzer = new WingoAnalyzer(history);
  return analyzer.analyze();
}

module.exports = { WingoAnalyzer, analyzeHistory };
