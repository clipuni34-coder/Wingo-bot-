'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { fetchWingoData, MODES } = require('./api');
const { analyzeHistory } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

const CACHE_TTL = 5000;
let dataCache = {};

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

app.get('/api/modes', (req, res) => {
  res.json({ modes: MODES });
});

app.get('/api/wingo', async (req, res) => {
  try {
    const mode = req.query.mode || '1m';
    const data = await getCachedData(mode);
    const analysis = analyzeHistory(data.history || [], mode);
    const result = { ...data, analysis: analysis, receivedAt: new Date().toISOString() };
    res.json(result);
  } catch (error) {
    console.error('Wingo API error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to fetch Wingo data', message: error.message });
  }
});

app.get('/api/predict', async (req, res) => {
  try {
    const mode = req.query.mode || '1m';
    const data = await getCachedData(mode);
    const analysis = analyzeHistory(data.history || [], mode);
    res.json({
      success: true,
      period: data.next || data.current,
      mode: data.periodMode,
      left: data.left,
      prediction: analysis.prediction,
      predictionLabel: analysis.sizeLabel,
      confidence: analysis.confidence,
      analysis: analysis,
      source: data.source,
      receivedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Prediction error:', error.message);
    res.status(502).json({ success: false, error: 'Failed to generate prediction', message: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log('Wingo Bot server running on http://' + HOST + ':' + PORT);
  console.log('Endpoints: /api/modes, /api/wingo, /api/predict, /health');
});

module.exports = app;
