'use strict';

const crypto = require('crypto');

const FB999_API_BASE = 'https://fb999api.com/api/webapi';
const FB999_ORIGIN = 'https://fb999.com';

const FB999_TYPE_MAP = {
  '30s': 30,
  '1m': 1,
  '3m': 2,
  '5m': 3,
  '10m': 4
};

const MODES = ['30s', '1m', '3m', '5m', '10m'];

const SIZE_LABELS = { SMALL: 'Small', BIG: 'Big', SKIP: 'Skip (No Edge)' };
const EXCLUDED_SIG_KEYS = ['signature', 'track', 'xosoBettingData'];

// --- Rolling history cache (per mode, deduplicated by issueNumber) ---
const HISTORY_CACHE_MAX = 200;
const historyCacheByMode = new Map(); // mode -> Map<issueNumberString, record>

function getHistoryCache(mode) {
  if (!historyCacheByMode.has(mode)) historyCacheByMode.set(mode, new Map());
  return historyCacheByMode.get(mode);
}

function clearHistoryCache(mode) {
  if (mode) historyCacheByMode.delete(mode);
  else historyCacheByMode.clear();
}

function issueKey(record) {
  const raw = record.issueNumber != null ? record.issueNumber : record.period;
  return String(raw);
}

function mergeHistoryCache(mode, records) {
  const cache = getHistoryCache(mode);
  for (const r of records || []) {
    if (!r) continue;
    const key = issueKey(r);
    if (!key || key === 'undefined' || key === 'null') continue;
    cache.set(key, r);
  }
  // Cap to most recent HISTORY_CACHE_MAX by numeric issueNumber
  if (cache.size > HISTORY_CACHE_MAX) {
    const keys = Array.from(cache.keys()).sort((a, b) => {
      const na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const toDelete = keys.slice(0, cache.size - HISTORY_CACHE_MAX);
    for (const k of toDelete) cache.delete(k);
  }
  return Array.from(cache.values());
}

function getCachedHistory(mode) {
  const cache = historyCacheByMode.get(mode);
  if (!cache) return [];
  return Array.from(cache.values());
}

function numberToSize(number) {
  return Number(number) >= 5 ? 'BIG' : 'SMALL';
}

// Dual-color mapping:
//  0 -> red+violet, 5 -> green+violet, 1,3,7,9 -> green, 2,4,6,8 -> red
function numberToColors(number) {
  number = Number(number);
  if (number === 0) return ['red', 'violet'];
  if (number === 5) return ['green', 'violet'];
  if ([1, 3, 7, 9].includes(number)) return 'green';
  return 'red';
}

function numberToColor(number) {
  const colors = numberToColors(number);
  return Array.isArray(colors) ? colors.join('+') : colors;
}

function sizeLabel(number) {
  const size = numberToSize(number);
  return SIZE_LABELS[size] || size;
}

function generateUuid() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const t = Math.random() * 16 | 0;
    const n = c === 'x' ? t : (t & 3 | 8);
    return n.toString(16);
  });
}

function vueDeepClone(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (data && typeof data === 'object') {
    return JSON.parse(JSON.stringify(data));
  }
  return {};
}

function generateSignature(data) {
  const cloned = vueDeepClone(data);
  delete cloned.signature;
  delete cloned.timestamp;
  cloned.language = 'en';
  cloned.random = generateUuid();

  const sorted = {};
  Object.keys(cloned).sort().forEach(key => {
    const value = cloned[key];
    if (value !== null && value !== '' && !EXCLUDED_SIG_KEYS.includes(key)) {
      sorted[key] = value === 0 ? 0 : value;
    }
  });

  const jsonStr = JSON.stringify(sorted);
  const signature = crypto.createHash('md5').update(jsonStr).digest('hex').toUpperCase().slice(0, 32);

  cloned.signature = signature;
  cloned.timestamp = Math.floor(Date.now() / 1000);

  return cloned;
}

async function fb999ApiCall(endpoint, data, fetchFn) {
  const signedData = generateSignature(data || {});
  const url = `${FB999_API_BASE}/${endpoint}`;

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      'Origin': FB999_ORIGIN,
      'Referer': `${FB999_ORIGIN}/`,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: JSON.stringify(signedData)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.code !== 0) {
    throw new Error(`API error: ${json.msg || 'Unknown error'}`);
  }

  return json.data;
}

function parseFb999Time(timeStr) {
  if (!timeStr) return Date.now();
  return new Date(String(timeStr).replace(/-/g, '/')).getTime();
}

function modeToTypeId(mode) {
  return FB999_TYPE_MAP[mode] || 1;
}

function normalizeHistoryRecord(h) {
  const num = Number(h.number);
  const size = numberToSize(num);
  return {
    period: h.issueNumber != null ? String(h.issueNumber) : String(h.period),
    issueNumber: h.issueNumber != null ? String(h.issueNumber) : String(h.period),
    number: num,
    size: size,
    sizeLabel: SIZE_LABELS[size],
    color: numberToColor(num),
    colors: numberToColors(num)
  };
}

// Fetch deeper history: pageSize 50, pageNo 1 + pageNo 2 (best-effort),
// merged into rolling cache (up to 200 unique periods per mode).
async function fetchHistoryDeep(typeID, mode, fetchFn) {
  const seen = new Map();
  const addList = (list) => {
    for (const h of list || []) {
      const key = String(h.issueNumber != null ? h.issueNumber : h.period);
      if (!seen.has(key)) seen.set(key, h);
    }
  };

  // Page 1 (required)
  const page1 = await fb999ApiCall('GetNoaverageEmerdList', { typeID, pageSize: 50, pageNo: 1 }, fetchFn);
  addList(page1 && page1.list);

  // Page 2 (best-effort multi-page to deepen window)
  try {
    const page2 = await fb999ApiCall('GetNoaverageEmerdList', { typeID, pageSize: 50, pageNo: 2 }, fetchFn);
    addList(page2 && page2.list);
  } catch (_) {
    // ignore — page 1 + rolling cache is sufficient
  }

  const fresh = Array.from(seen.values());
  // Merge into rolling cache and return merged (deduplicated) set
  const merged = mergeHistoryCache(mode, fresh);
  // If cache merge returned more than fresh, return merged; else fresh
  return merged.length ? merged : fresh;
}

async function fetchFb999WingoData(mode = '1m', fetchFn) {
  const typeID = modeToTypeId(mode);

  const issueData = await fb999ApiCall('GetGameIssue', { typeID }, fetchFn);
  const rawHistory = await fetchHistoryDeep(typeID, mode, fetchFn);

  const serviceTime = parseFb999Time(issueData.serviceTime || issueData.startTime);
  const endTime = parseFb999Time(issueData.endTime);
  const left = Math.max(0, Math.floor((endTime - serviceTime) / 1000));

  // rawHistory may be newest-first from API; keep newest-first for UI display.
  // Analyzer normalizes to chronological internally.
  const history = (rawHistory || []).map(normalizeHistoryRecord);

  // Sort newest-first by numeric issueNumber for UI (descending)
  history.sort((a, b) => {
    const na = parseInt(a.period, 10), nb = parseInt(b.period, 10);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return String(b.period).localeCompare(String(a.period));
  });

  return {
    periodMode: mode,
    current: issueData.issueNumber,
    next: issueData.issueNumber,
    left: left,
    // No hardcoded prediction — index.js wires analysis.prediction here.
    // Kept as null so a full refresh can never clobber a locked prediction
    // with a fake 'SMALL'/0.
    prediction: null,
    confidence: null,
    shouldBet: false,
    lean: null,
    number: history[0]?.number || null,
    source: 'api',
    startTime: issueData.startTime,
    endTime: issueData.endTime,
    serviceTime: issueData.serviceTime,
    intervalM: issueData.intervalM,
    issueType: typeID,
    history: history
  };
}

async function fetchWingoData(mode = '1m', fetchFn) {
  try {
    return await fetchFb999WingoData(mode, fetchFn);
  } catch (fbError) {
    try {
      const params = new URLSearchParams({
        action: 'wg_prediction',
        nonce: '4e535c4bee',
        mode: mode
      });
      const url = `https://wingo.games/wp-admin/admin-ajax.php?${params.toString()}`;
      const response = await fetchFn(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://wingo.games/wingo-result/'
        }
      });
      const json = await response.json();
      if (json.success && json.data) {
        return normalizeWingosapiData(json.data, mode);
      }
      throw new Error('Wingo.games API fallback failed');
    } catch (e) {
      throw new Error(`Failed to fetch Wingo data: ${fbError.message}`);
    }
  }
}

function normalizeWingosapiData(data, mode) {
  const history = (data.history || []).map(h => {
    const num = Number(h.number);
    const size = h.size && ['BIG', 'SMALL'].includes(String(h.size).toUpperCase())
      ? String(h.size).toUpperCase()
      : numberToSize(num);
    return {
      period: h.period != null ? String(h.period) : (h.issueNumber != null ? String(h.issueNumber) : ''),
      issueNumber: h.issueNumber != null ? String(h.issueNumber) : (h.period != null ? String(h.period) : ''),
      number: num,
      size: size,
      sizeLabel: SIZE_LABELS[size],
      color: numberToColor(num),
      colors: numberToColors(num)
    };
  });
  history.sort((a, b) => {
    const na = parseInt(a.period, 10), nb = parseInt(b.period, 10);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return String(b.period).localeCompare(String(a.period));
  });
  return {
    periodMode: data.periodMode || mode,
    current: data.current,
    next: data.next,
    left: Number(data.left || 0),
    prediction: data.prediction || null,
    confidence: data.confidence != null ? Number(data.confidence) : null,
    shouldBet: Boolean(data.shouldBet),
    lean: data.lean || null,
    number: data.number,
    source: data.source || 'api',
    startTime: data.startTime,
    issueType: data.issueType,
    history: history
  };
}

module.exports = {
  fetchWingoData,
  fetchFb999WingoData,
  normalizeData: normalizeWingosapiData,
  normalizeHistoryRecord,
  numberToSize,
  numberToColor,
  numberToColors,
  sizeLabel,
  SIZE_LABELS,
  MODES,
  FB999_API_BASE,
  FB999_ORIGIN,
  FB999_TYPE_MAP,
  modeToTypeId,
  generateSignature,
  fb999ApiCall,
  // rolling cache helpers (exported for tests / server locking)
  mergeHistoryCache,
  getCachedHistory,
  clearHistoryCache,
  HISTORY_CACHE_MAX
};
