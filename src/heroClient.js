const axios = require('axios');

const baseURL = process.env.HERO_BASE_URL || 'https://hero-sms.com';
const defaultApiKey = process.env.HERO_API_KEY;
const requestPath = process.env.HERO_REQUEST_PATH || '/stubs/handler_api.php';
const actionGetNumber = process.env.HERO_ACTION_GET_NUMBER || 'getNumber';
const actionGetPrices = process.env.HERO_ACTION_GET_PRICES || 'getPrices';
const actionGetStatus = process.env.HERO_ACTION_GET_STATUS || 'getStatus';
const actionGetActiveActivations = process.env.HERO_ACTION_GET_ACTIVE_ACTIVATIONS || 'getActiveActivations';

const http = axios.create({
  baseURL,
  timeout: Number(process.env.HERO_TIMEOUT_MS || 15000),
});

function resolveApiKey(apiKey) {
  const value = apiKey || defaultApiKey;
  if (!value) {
    throw new Error('Missing API key. Set with /setkey <api_key> or HERO_API_KEY.');
  }
  return value;
}

function isTransientNetworkError(error) {
  const code = String(error?.code || '').toUpperCase();
  return [
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
  ].includes(code);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSmsActivateResponse(raw) {
  if (typeof raw !== 'string') {
    return { raw };
  }

  const text = raw.trim();
  const parts = text.split(':');

  if (parts[0] === 'ACCESS_NUMBER' && parts.length >= 3) {
    return {
      status: 'ACCESS_NUMBER',
      activationId: parts[1],
      phoneNumber: parts.slice(2).join(':'),
      raw: text,
    };
  }

  return { status: parts[0], raw: text };
}

function parseGetStatusResponse(raw) {
  if (typeof raw !== 'string') {
    return { status: 'UNKNOWN', raw };
  }

  const text = raw.trim();
  const parts = text.split(':');

  if (parts[0] === 'STATUS_OK' && parts.length >= 2) {
    return {
      status: 'STATUS_OK',
      code: parts.slice(1).join(':'),
      raw: text,
    };
  }

  return {
    status: parts[0] || 'UNKNOWN',
    raw: text,
  };
}

async function createOrder({ service, country, maxPrice, apiKey }) {
  const params = {
    api_key: resolveApiKey(apiKey),
    action: actionGetNumber,
    service,
    country,
  };

  if (maxPrice !== undefined) {
    params.maxPrice = Number(maxPrice);
  }

  const response = await http.get(requestPath, { params, responseType: 'text' });

  return parseSmsActivateResponse(response.data);
}

function flattenPriceRows(raw) {
  const rows = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return rows;
  }

  for (const [countryKey, services] of Object.entries(raw)) {
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      continue;
    }

    // Shape A (when service query is passed):
    // { "4": { "cost": 0.238, "count": 2496, ... } }
    if (Object.prototype.hasOwnProperty.call(services, 'cost')
      && Object.prototype.hasOwnProperty.call(services, 'count')) {
      rows.push({
        country: String(countryKey),
        service: '',
        cost: Number(services.cost),
        count: Number(services.count),
      });
      continue;
    }

    // Shape B (when service query is not passed):
    // { "4": { "wa": { "cost": 0.238, "count": 2496 } } }
    for (const [serviceKey, priceInfo] of Object.entries(services)) {
      if (!priceInfo || typeof priceInfo !== 'object' || Array.isArray(priceInfo)) {
        continue;
      }

      rows.push({
        country: String(countryKey),
        service: String(serviceKey),
        cost: Number(priceInfo.cost),
        count: Number(priceInfo.count),
      });
    }
  }

  return rows.filter((item) => Number.isFinite(item.cost) && Number.isFinite(item.count));
}

async function getAvailablePrices({ service, country, apiKey }) {
  const params = {
    api_key: resolveApiKey(apiKey),
    action: actionGetPrices,
  };

  if (service) {
    params.service = service;
  }

  if (country) {
    params.country = country;
  }

  const response = await http.get(requestPath, { params });
  const rows = flattenPriceRows(response.data);

  return rows.filter((row) => row.count > 0);
}

async function getStatus({ activationId, apiKey }) {
  const params = {
    api_key: resolveApiKey(apiKey),
    action: actionGetStatus,
    id: activationId,
  };

  const response = await http.get(requestPath, { params, responseType: 'text' });
  return parseGetStatusResponse(response.data);
}

function normalizeActiveActivationRows(raw) {
  if (!raw || typeof raw !== 'object') {
    return [];
  }

  if (Array.isArray(raw.data)) {
    return raw.data;
  }

  if (Array.isArray(raw.activeActivations?.rows)) {
    return raw.activeActivations.rows;
  }

  if (Array.isArray(raw.activeActivations)) {
    return raw.activeActivations;
  }

  return [];
}

async function getActiveActivations({ start = 0, limit = 100, apiKey } = {}) {
  const params = {
    api_key: resolveApiKey(apiKey),
    action: actionGetActiveActivations,
    start,
    limit,
  };

  const maxAttempts = 3;
  let lastError = null;
  let rows = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await http.get(requestPath, { params });
      rows = normalizeActiveActivationRows(response.data);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(attempt * 400);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return rows.map((row) => ({
    activationId: String(row.activationId || row.id || ''),
    serviceCode: String(row.serviceCode || row.service || ''),
    phoneNumber: String(row.phoneNumber || row.phone || ''),
    activationStatus: String(row.activationStatus || row.status || ''),
    activationTime: row.activationTime || row.createDate || null,
    cost: Number(row.activationCost ?? row.cost ?? 0),
    countryCode: String(row.countryCode || row.country || ''),
  })).filter((row) => row.activationId && row.phoneNumber);
}

async function getBalance({ apiKey } = {}) {
  const params = {
    api_key: resolveApiKey(apiKey),
    action: 'getBalance',
  };
  const response = await http.get(requestPath, { params, responseType: 'text' });
  return String(response.data || '').trim();
}

module.exports = {
  createOrder,
  getAvailablePrices,
  getStatus,
  getActiveActivations,
  getBalance,
};
