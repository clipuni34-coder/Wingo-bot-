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

const SIZE_LABELS = { SMALL: 'Small', BIG: 'Big' };
const EXCLUDED_SIG_KEYS = ['signature', 'track', 'xosoBettingData'];

function numberToSize(number) {
  return number >= 5 ? 'BIG' : 'SMALL';
}

function numberToColor(number) {
  number = Number(number);
  if (number === 0 || number === 5) return 'violet';
  if ([1, 3, 7, 9].includes(number)) return 'green';
  return 'red';
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
  return new Date(timeStr.replace(/-/g, '/')).getTime();
}

function modeToTypeId(mode) {
  return FB999_TYPE_MAP[mode] || 1;
}

async function fetchFb999WingoData(mode = '1m', fetchFn) {
  const typeID = modeToTypeId(mode);

  const issueData = await fb999ApiCall('GetGameIssue', { typeID }, fetchFn);
  const historyData = await fb999ApiCall('GetNoaverageEmerdList', { typeID }, fetchFn);

  const serviceTime = parseFb999Time(issueData.serviceTime || issueData.startTime);
  const endTime = parseFb999Time(issueData.endTime);
  const left = Math.max(0, Math.floor((endTime - serviceTime) / 1000));

  const history = (historyData.list || []).map(h => {
    const num = Number(h.number);
    return {
      period: h.issueNumber,
      number: num,
      size: numberToSize(num) === 'BIG' ? 'BIG' : 'SMALL',
      sizeLabel: numberToSize(num) === 'BIG' ? 'Big' : 'Small',
      color: h.colour || numberToColor(num)
    };
  });

  return {
    periodMode: mode,
    current: issueData.issueNumber,
    next: issueData.issueNumber,
    left: left,
    prediction: 'SMALL',
    confidence: 0,
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
  return {
    periodMode: data.periodMode || mode,
    current: data.current,
    next: data.next,
    left: Number(data.left || 0),
    prediction: data.prediction || 'SMALL',
    confidence: Number(data.confidence || 0),
    number: data.number,
    source: data.source || 'api',
    startTime: data.startTime,
    issueType: data.issueType,
    history: (data.history || []).map(h => ({
      period: h.period,
      number: Number(h.number),
      size: h.size || sizeLabel(Number(h.number)),
      color: h.color || numberToColor(Number(h.number))
    }))
  };
}

module.exports = {
  fetchWingoData,
  fetchFb999WingoData,
  normalizeData: normalizeWingosapiData,
  numberToSize,
  numberToColor,
  sizeLabel,
  SIZE_LABELS,
  MODES,
  FB999_API_BASE,
  FB999_ORIGIN,
  FB999_TYPE_MAP,
  modeToTypeId,
  generateSignature,
  fb999ApiCall
};
