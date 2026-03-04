require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const {
  createOrder,
  getAvailablePrices,
  getStatus,
  getActiveActivations,
  getBalance,
} = require('./heroClient');

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables');
}

const bot = new Telegraf(botToken);
const menuCallbackOpenPanel = 'menu_buy_wa_ph';
const menuCallbackNoop = 'menu_noop';
const menuCallbackQtyDec = 'menu_qty_dec';
const menuCallbackQtyInc = 'menu_qty_inc';
const menuCallbackRefresh = 'menu_refresh';
const menuCallbackBuyRandom = 'menu_buy_random';
const menuCallbackBuyQty5 = 'menu_buy_qty_5';
const menuCallbackBuyQty10 = 'menu_buy_qty_10';
const menuCallbackBuyQty20 = 'menu_buy_qty_20';
const menuService = process.env.MENU_SERVICE || 'wa';
const menuServiceFallbacks = (process.env.MENU_SERVICE_FALLBACKS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const allowedMenuServices = new Set(
  (process.env.ALLOWED_MENU_SERVICES || 'wa')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
);
const menuCountry = process.env.MENU_COUNTRY_PHILIPPINES || '4';
const menuCountryLabel = process.env.MENU_COUNTRY_LABEL || 'Philippines +63';
const menuMinQty = 1;
const menuMaxQty = 20;
const buyMinPrice = 0.16;
const buyMaxPrice = 0.18;
const otpPollIntervalMs = Number(process.env.OTP_POLL_INTERVAL_MS || 5000);
const enableCopyButtons = String(process.env.ENABLE_COPY_BUTTONS || '0') === '1';
const menuStateByChat = new Map();
const activationStoreByChat = new Map();
const activeBatchByChat = new Map();
const apiKeyByChat = new Map();
const apiKeysFile = path.join(process.cwd(), 'chat_api_keys.json');
const restockWatchChats = new Set();
const restockWatchFile = path.join(process.cwd(), 'restock_watchers.json');
let lastRestockAvailable = null;
let lastRestockCheckAt = null;
let lastRestockRows = 0;
let lastRestockError = null;
const lastRestockStateByChat = new Map();
let otpPollTimer = null;
let otpPollInProgress = false;
let otpPollQueued = false;

function loadApiKeys() {
  try {
    if (!fs.existsSync(apiKeysFile)) {
      return;
    }

    const raw = fs.readFileSync(apiKeysFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }

    for (const [chatId, apiKey] of Object.entries(parsed)) {
      if (apiKey && typeof apiKey === 'string') {
        apiKeyByChat.set(String(chatId), apiKey);
      }
    }
  } catch (error) {
    console.error('Failed to load API keys:', error.message);
  }
}

function saveApiKeys() {
  try {
    const data = Object.fromEntries(apiKeyByChat.entries());
    fs.writeFileSync(apiKeysFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('Failed to save API keys:', error.message);
  }
}

function getApiKeyForChat(chatId) {
  const key = apiKeyByChat.get(String(chatId)) || process.env.HERO_API_KEY || null;
  return key;
}

async function requireApiKey(ctx) {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return null;
  }

  const key = getApiKeyForChat(chatId);
  if (key) {
    return key;
  }

  await ctx.reply('API key belum di-set. Kirim: /setkey <api_key>');
  return null;
}

function loadRestockWatchers() {
  try {
    if (!fs.existsSync(restockWatchFile)) {
      return;
    }

    const raw = fs.readFileSync(restockWatchFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return;
    }

    for (const chatId of parsed) {
      if (typeof chatId === 'number' || typeof chatId === 'string') {
        restockWatchChats.add(chatId);
      }
    }
  } catch (error) {
    console.error('Failed to load restock watchers:', error.message);
  }
}

function saveRestockWatchers() {
  try {
    const data = JSON.stringify([...restockWatchChats], null, 2);
    fs.writeFileSync(restockWatchFile, data, 'utf8');
  } catch (error) {
    console.error('Failed to save restock watchers:', error.message);
  }
}

function getMainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: 'Buy WhatsApp Philippines', callback_data: menuCallbackOpenPanel }]],
    },
  };
}

function getCommandKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['/buy', '/reset', '/restockon'],
        ['/listbuy', '/otpall'],
        ['/setkey', '/ceksaldo'],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

function getChatId(ctx) {
  return ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id;
}

function formatCost(cost) {
  return `$${Number(cost).toFixed(4)}`;
}

function costToToken(cost) {
  return Number(cost).toFixed(4).replace('.', 'd');
}

function serviceToToken(serviceCode) {
  return String(serviceCode || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function pickWeightedByStock(rows) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (total <= 0) {
    return null;
  }

  let random = Math.random() * total;
  for (const row of rows) {
    random -= row.count;
    if (random <= 0) {
      return row;
    }
  }

  return rows[rows.length - 1] || null;
}

function ensureMenuState(chatId) {
  if (!menuStateByChat.has(chatId)) {
    menuStateByChat.set(chatId, {
      qty: 1,
      hiddenCostTokens: new Set(),
    });
  }

  return menuStateByChat.get(chatId);
}

function upsertActivations(chatId, orders, price, batchId = null) {
  if (!activationStoreByChat.has(chatId)) {
    activationStoreByChat.set(chatId, new Map());
  }

  const byActivationId = activationStoreByChat.get(chatId);
  for (const order of orders) {
    byActivationId.set(String(order.activationId), {
      activationId: String(order.activationId),
      phoneNumber: order.phoneNumber,
      price,
      batchId,
      lastStatus: 'ACCESS_NUMBER',
      lastCode: null,
      lastNotifiedCode: null,
      closed: false,
      createdAt: Date.now(),
    });
  }
}

function getStoredActivations(chatId) {
  if (!activationStoreByChat.has(chatId)) {
    return [];
  }

  return [...activationStoreByChat.get(chatId).values()].sort((a, b) => b.createdAt - a.createdAt);
}

function isMessageNotModifiedError(error) {
  const msg = String(error?.response?.data?.description || error?.message || '').toLowerCase();
  return msg.includes('message is not modified');
}

function buildPricePanelKeyboard(rows, state) {
  const totalStock = rows.reduce((sum, row) => sum + row.count, 0);
  const minCost = rows.length ? rows[0].cost : 0;
  const maxCost = rows.length ? rows[rows.length - 1].cost : 0;
  const inlineKeyboard = [
    [{ text: `${menuCountryLabel} | ${totalStock} pcs`, callback_data: menuCallbackNoop }],
    [
      { text: '-', callback_data: menuCallbackQtyDec },
      { text: `${state.qty} pcs`, callback_data: menuCallbackNoop },
      { text: '+', callback_data: menuCallbackQtyInc },
      { text: rows.length ? `${formatCost(minCost)} - ${formatCost(maxCost)}` : 'No stock', callback_data: menuCallbackNoop },
    ],
    [
      { text: 'Buy 5', callback_data: menuCallbackBuyQty5 },
      { text: 'Buy 10', callback_data: menuCallbackBuyQty10 },
      { text: 'Buy 20', callback_data: menuCallbackBuyQty20 },
    ],
  ];

  for (const row of rows.slice(0, 20)) {
    const serviceToken = serviceToToken(row.service || menuService);
    const token = costToToken(row.cost);
    inlineKeyboard.push([
      { text: formatCost(row.cost), callback_data: `buy_${serviceToken}_${token}` },
      { text: `${row.count} pcs`, callback_data: menuCallbackNoop },
      { text: 'DEL', callback_data: `rm_${token}` },
    ]);
  }

  inlineKeyboard.push([{ text: 'Refresh', callback_data: menuCallbackRefresh }]);

  return { reply_markup: { inline_keyboard: inlineKeyboard } };
}

function getEmptyPricePanelKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Buy 5', callback_data: menuCallbackBuyQty5 },
          { text: 'Buy 10', callback_data: menuCallbackBuyQty10 },
          { text: 'Buy 20', callback_data: menuCallbackBuyQty20 },
        ],
        [{ text: `Buy Random ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}`, callback_data: menuCallbackBuyRandom }],
        [{ text: 'Refresh', callback_data: menuCallbackRefresh }],
      ],
    },
  };
}

function getOrderSummaryKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Cek OTP Semua', callback_data: 'otp_all' }],
        [{ text: 'Back to Price List', callback_data: menuCallbackOpenPanel }],
        [{ text: 'Refresh List', callback_data: menuCallbackRefresh }],
      ],
    },
  };
}

function buildCopyableNumbersMessage(successOrders) {
  const numberLines = successOrders.map((item, idx) => `${idx + 1}. \`${item.phoneNumber}\``);
  return [
    'Nomor (mudah disalin):',
    ...numberLines,
  ].join('\n');
}

async function loadVisiblePriceRows(state, apiKey) {
  const serviceCandidates = [menuService, ...menuServiceFallbacks];
  const mergedRows = [];

  for (const serviceCode of serviceCandidates) {
    if (!allowedMenuServices.has(String(serviceCode).toLowerCase())) {
      continue;
    }
    try {
      const rows = await getAvailablePrices({ service: serviceCode, country: menuCountry, apiKey });
      if (rows.length > 0) {
        mergedRows.push(...rows.map((row) => ({ ...row, service: serviceCode })));
      }
    } catch (error) {
      // Skip one failing service candidate and continue with others.
    }
  }

  const dedup = [];
  const seen = new Set();
  for (const row of mergedRows) {
    const key = `${row.service}|${row.cost}|${row.count}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    dedup.push(row);
  }

  const rows = dedup.filter((row) => row.cost >= buyMinPrice && row.cost <= buyMaxPrice);
  const sortedRows = [...rows].sort((a, b) => a.cost - b.cost).filter((row) => {
    const token = costToToken(row.cost);
    return !state.hiddenCostTokens.has(token);
  });

  return sortedRows;
}

async function pickRandomBuyPriceByStock(serviceCode, apiKey) {
  const rows = await getAvailablePrices({ service: serviceCode, country: menuCountry, apiKey });
  const eligibleRows = rows.filter((row) => row.cost >= buyMinPrice && row.cost <= buyMaxPrice && row.count > 0);

  if (eligibleRows.length) {
    return pickWeightedByStock(eligibleRows);
  }

  // Fallback when getPrices reports empty but getNumber can still succeed.
  const fallbackCost = Number((buyMinPrice + (Math.random() * (buyMaxPrice - buyMinPrice))).toFixed(4));
  return { cost: fallbackCost, count: 1 };
}

async function pickRandomBuyPriceByStockForCountry(serviceCode, country, apiKey) {
  const rows = await getAvailablePrices({ service: serviceCode, country, apiKey });
  const eligibleRows = rows.filter((row) => row.cost >= buyMinPrice && row.cost <= buyMaxPrice && row.count > 0);

  if (!eligibleRows.length) {
    return null;
  }

  return pickWeightedByStock(eligibleRows);
}

async function renderPricePanel(ctx, mode = 'reply') {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }
  const apiKey = getApiKeyForChat(chatId);
  if (!apiKey) {
    await ctx.reply('API key belum di-set. Kirim: /setkey <api_key>');
    return;
  }

  const state = ensureMenuState(chatId);
  const rows = await loadVisiblePriceRows(state, apiKey);

  if (rows.length === 0) {
    const emptyText = [
      'WhatsApp Philippines',
      `Qty: ${state.qty} pcs`,
      'Tidak ada harga yang tersedia (stok kosong / terfilter).',
    ].join('\n');

    const emptyKeyboard = getEmptyPricePanelKeyboard();

  if (mode === 'edit') {
    try {
      await ctx.editMessageText(emptyText, emptyKeyboard);
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
      return;
    }

    await ctx.reply(emptyText, emptyKeyboard);
    return;
  }

  const text = [
    'WhatsApp Philippines Price Menu',
    `Tap harga untuk order qty. Harga random ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}.`,
  ].join('\n');
  const keyboard = buildPricePanelKeyboard(rows, state);

  if (mode === 'edit') {
    try {
      await ctx.editMessageText(text, keyboard);
    } catch (error) {
      if (!isMessageNotModifiedError(error)) {
        throw error;
      }
    }
    return;
  }

  await ctx.reply(text, keyboard);
}

async function checkSingleOtp(chatId, activationId) {
  const apiKey = getApiKeyForChat(chatId);
  if (!apiKey) {
    throw new Error('API key belum di-set untuk chat ini.');
  }
  const result = await getStatus({ activationId, apiKey });

  if (!activationStoreByChat.has(chatId)) {
    return result;
  }

  const store = activationStoreByChat.get(chatId);
  const item = store.get(String(activationId));
  if (!item) {
    return result;
  }

  item.lastStatus = result.status;
  if (result.status === 'STATUS_OK') {
    item.lastCode = result.code;
  }
  store.set(String(activationId), item);

  return result;
}

function getOtpNotificationExtra(phoneNumber, otpCode) {
  if (!enableCopyButtons) {
    return {};
  }

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Copy Number', copy_text: { text: String(phoneNumber) } },
          { text: 'Copy OTP', copy_text: { text: String(otpCode) } },
        ],
      ],
    },
  };
}

async function notifyOtpIfNeeded(chatId, item, status) {
  if (status.status !== 'STATUS_OK' || !status.code) {
    return false;
  }

  if (item.lastNotifiedCode === status.code) {
    return false;
  }

  item.lastNotifiedCode = status.code;
  item.lastCode = status.code;
  item.lastStatus = status.status;

  const text = [
    `Activation: \`${item.activationId}\``,
    `Number: \`${item.phoneNumber}\``,
    `OTP: \`${status.code}\``,
  ].join('\n');

  await bot.telegram.sendMessage(
    chatId,
    text,
    {
      parse_mode: 'Markdown',
      ...getOtpNotificationExtra(item.phoneNumber, status.code),
    },
  );

  // Close after first OTP push to avoid notifications from old/used numbers.
  item.closed = true;

  return true;
}

async function pollOtpUpdates() {
  const chatEntries = [...activationStoreByChat.entries()];

  for (const [chatId, store] of chatEntries) {
    const activeBatchId = activeBatchByChat.get(chatId);
    const items = [...store.values()];

    for (const item of items) {
      if (item.closed) {
        continue;
      }

      // Only auto-push OTP for the newest buy batch in each chat.
      if (activeBatchId && item.batchId && item.batchId !== activeBatchId) {
        continue;
      }

      try {
        const apiKey = getApiKeyForChat(chatId);
        if (!apiKey) {
          continue;
        }
        const status = await getStatus({ activationId: item.activationId, apiKey });
        item.lastStatus = status.status;
        if (status.status === 'STATUS_OK') {
          item.lastCode = status.code || item.lastCode;
        }

        await notifyOtpIfNeeded(chatId, item, status);
        store.set(String(item.activationId), item);
      } catch (error) {
        item.lastStatus = 'ERROR';
        store.set(String(item.activationId), item);
      }
    }
  }
}

async function checkRestockAlerts() {
  for (const chatId of restockWatchChats) {
    try {
      const apiKey = getApiKeyForChat(chatId);
      if (!apiKey) {
        continue;
      }

      const rows = await getAvailablePrices({ service: 'wa', country: menuCountry, apiKey });
      const eligibleRows = rows.filter((row) => row.cost >= buyMinPrice && row.cost <= buyMaxPrice);
      const available = eligibleRows.length > 0;
      const prev = lastRestockStateByChat.get(String(chatId));

      lastRestockCheckAt = Date.now();
      lastRestockRows = eligibleRows.length;
      lastRestockAvailable = available;
      lastRestockError = null;

      if (prev === undefined) {
        lastRestockStateByChat.set(String(chatId), available);
        continue;
      }

      if (!prev && available) {
        const cheapest = eligibleRows.sort((a, b) => a.cost - b.cost)[0];
        const msg = [
          'WA Restock Alert',
          `Country: ${menuCountryLabel}`,
          `Range: ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}`,
          `Cheapest: ${formatCost(cheapest.cost)} (stok ${cheapest.count})`,
        ].join('\n');
        await bot.telegram.sendMessage(chatId, msg);
      }

      lastRestockStateByChat.set(String(chatId), available);
    } catch (error) {
      lastRestockCheckAt = Date.now();
      lastRestockError = error.message;
    }
  }
}

async function notifyRestockBySuccessfulBuy(serviceCode, pickedPrices) {
  if (String(serviceCode).toLowerCase() !== 'wa' || !pickedPrices.length) {
    return;
  }
  if (!restockWatchChats.size) {
    return;
  }

  const minPicked = Math.min(...pickedPrices);
  const maxPicked = Math.max(...pickedPrices);
  lastRestockAvailable = true;
  lastRestockCheckAt = Date.now();
  lastRestockRows = Math.max(lastRestockRows, 1);
  lastRestockError = null;

  const msg = [
    'WA Restock Alert',
    `Terdeteksi dari buy sukses (${pickedPrices.length} pcs).`,
    `Harga terpakai: ${formatCost(minPicked)} - ${formatCost(maxPicked)}`,
  ].join('\n');

  for (const chatId of restockWatchChats) {
    try {
      await bot.telegram.sendMessage(chatId, msg);
    } catch (error) {
      // Ignore per-chat errors.
    }
  }
}

async function runOtpPollNow() {
  if (otpPollInProgress) {
    otpPollQueued = true;
    return;
  }

  otpPollInProgress = true;
  try {
    await pollOtpUpdates();
    await checkRestockAlerts();
  } catch (error) {
    console.error('OTP polling error:', error.message);
  } finally {
    otpPollInProgress = false;
  }

  if (otpPollQueued) {
    otpPollQueued = false;
    setTimeout(() => {
      runOtpPollNow().catch(() => {});
    }, 200);
  }
}

function startOtpPolling() {
  if (otpPollTimer) {
    return;
  }

  otpPollTimer = setInterval(() => {
    runOtpPollNow().catch(() => {});
  }, otpPollIntervalMs);
}

async function checkAllOtpForChat(chatId) {
  const items = getStoredActivations(chatId);
  const results = [];

  for (const item of items) {
    try {
      const status = await checkSingleOtp(chatId, item.activationId);
      results.push({
        activationId: item.activationId,
        phoneNumber: item.phoneNumber,
        status: status.status,
        code: status.code || null,
      });
    } catch (error) {
      results.push({
        activationId: item.activationId,
        phoneNumber: item.phoneNumber,
        status: 'ERROR',
        code: null,
        error: error.response?.data || error.message,
      });
    }
  }

  return results;
}

function formatOtpRow(row) {
  if (row.status === 'STATUS_OK' && row.code) {
    return `\`${row.phoneNumber}\` | \`${row.code}\``;
  }
  if (row.status === 'ERROR') {
    return `\`${row.phoneNumber}\` | ERROR`;
  }
  return `\`${row.phoneNumber}\` | ${row.status}`;
}

bot.start((ctx) => {
  ctx.reply([
    'BOT HERO SMS',
    '',
    'Perintah:',
    '/setkey <api_key>',
    '/buy',
    '/reset',
    '/restockon',
    '/listbuy',
    '/ceksaldo',
  ].join('\n'), getCommandKeyboard());
});

bot.help((ctx) => {
  ctx.reply([
    '/setkey <api_key>',
    '/buy',
    '/reset',
    '/restockon',
    '/listbuy',
    '/ceksaldo',
  ].join('\n'), getCommandKeyboard());
});

bot.command('setkey', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const text = ctx.message?.text || '';
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    await ctx.reply('Format: /setkey <api_key>');
    return;
  }

  const apiKey = parts[1].trim();
  if (!apiKey) {
    await ctx.reply('API key kosong.');
    return;
  }

  apiKeyByChat.set(String(chatId), apiKey);
  saveApiKeys();
  await ctx.reply('API key tersimpan untuk chat ini.');
});

bot.command('delkey', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }
  apiKeyByChat.delete(String(chatId));
  saveApiKeys();
  await ctx.reply('API key chat ini dihapus.');
});

bot.command('ceksaldo', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }
  const apiKey = await requireApiKey(ctx);
  if (!apiKey) {
    return;
  }

  try {
    const balance = await getBalance({ apiKey });
    await ctx.reply(`Saldo: ${balance}`);
  } catch (error) {
    await ctx.reply(`Gagal cek saldo: ${error.message}`);
  }
});

bot.command('buy', async (ctx) => {
  await runQuickBuy(ctx, 10);
});

bot.action(menuCallbackNoop, async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(menuCallbackOpenPanel, async (ctx) => {
  await ctx.answerCbQuery();

  try {
    await renderPricePanel(ctx, 'edit');
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (status) {
      await ctx.reply(`Gagal ambil harga (HTTP ${status}):\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      return;
    }

    await ctx.reply(`Gagal ambil harga: ${error.message}`);
  }
});

bot.action(menuCallbackQtyDec, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const state = ensureMenuState(chatId);
  state.qty = Math.max(menuMinQty, state.qty - 1);

  try {
    await renderPricePanel(ctx, 'edit');
  } catch (error) {
    await ctx.reply(`Gagal update qty: ${error.message}`);
  }
});

bot.action(menuCallbackQtyInc, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const state = ensureMenuState(chatId);
  state.qty = Math.min(menuMaxQty, state.qty + 1);

  try {
    await renderPricePanel(ctx, 'edit');
  } catch (error) {
    await ctx.reply(`Gagal update qty: ${error.message}`);
  }
});

bot.action(menuCallbackRefresh, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  if (chatId) {
    const state = ensureMenuState(chatId);
    state.hiddenCostTokens.clear();
  }

  try {
    await renderPricePanel(ctx, 'edit');
  } catch (error) {
    await ctx.reply(`Gagal refresh harga: ${error.message}`);
  }
});

bot.action('otp_all', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const items = getStoredActivations(chatId);
  if (!items.length) {
    await ctx.reply('Belum ada order tersimpan. Lakukan buy dulu.');
    return;
  }

  await ctx.reply(`Cek OTP untuk ${items.length} nomor...`);
  const results = await checkAllOtpForChat(chatId);

  const lines = results.slice(0, 40).map(formatOtpRow);

  await ctx.reply([
    'Hasil OTP:',
    ...lines,
    '',
    'Pakai /otp <nomor_urut> untuk cek satu nomor.',
  ].join('\n'), { parse_mode: 'Markdown' });
});

bot.action(/^rm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Removed from list');
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const token = ctx.match[1];
  const state = ensureMenuState(chatId);
  state.hiddenCostTokens.add(token);

  try {
    await renderPricePanel(ctx, 'edit');
  } catch (error) {
    await ctx.reply(`Gagal update list: ${error.message}`);
  }
});

async function runBulkBuyFromMenu(ctx, serviceCode) {
  try {
    const chatId = getChatId(ctx);
    if (!chatId) {
      return;
    }
    const apiKey = await requireApiKey(ctx);
    if (!apiKey) {
      return;
    }

    const state = ensureMenuState(chatId);
    const targetQty = state.qty;
    const batchId = `${Date.now()}`;
    activeBatchByChat.set(chatId, batchId);
    const successOrders = [];
    const pickedPrices = [];
    let lastFailure = null;

    await ctx.reply(
      `Memproses order ${targetQty} pcs (random range ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)})...`,
    );

    for (let i = 0; i < targetQty; i += 1) {
      try {
        const pickedRow = await pickRandomBuyPriceByStock(serviceCode || menuService, apiKey);
        if (!pickedRow) {
          lastFailure = `Tidak ada stok dalam range ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}`;
          break;
        }

        const currentMaxPrice = pickedRow.cost;
        const result = await createOrder({
          service: serviceCode || menuService,
          country: menuCountry,
          maxPrice: currentMaxPrice,
          apiKey,
        });
        if (result.status === 'ACCESS_NUMBER') {
          successOrders.push(result);
          pickedPrices.push(currentMaxPrice);
        } else {
          lastFailure = result.raw || result.status;
          break;
        }
      } catch (error) {
        lastFailure = error.response?.data || error.message;
        break;
      }
    }

    if (!successOrders.length) {
      await ctx.reply(`Order gagal. Detail: ${typeof lastFailure === 'string' ? lastFailure : JSON.stringify(lastFailure)}`);
      return;
    }

    const avgPrice = pickedPrices.length
      ? pickedPrices.reduce((sum, price) => sum + price, 0) / pickedPrices.length
      : 0;
    upsertActivations(chatId, successOrders, avgPrice, batchId);
    runOtpPollNow().catch(() => {});
    notifyRestockBySuccessfulBuy(serviceCode || menuService, pickedPrices).catch(() => {});

    const total = pickedPrices.reduce((sum, price) => sum + price, 0);
    const lines = successOrders.slice(0, 20).map(
      (item, idx) => `${idx + 1}. id ${item.activationId} | max ${formatCost(pickedPrices[idx] || 0)}`,
    );

    await ctx.reply(
      [
        'WA PH +63',
        `Range random: ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}`,
        `Berhasil: ${successOrders.length}/${targetQty} pcs`,
        `Total max: ${formatCost(total)}`,
        '',
        ...lines,
        '',
        'Auto OTP aktif (tanpa klik menu):',
        '- bot akan kirim nomor + OTP saat masuk',
        '',
        'Manual check juga tersedia:',
        '- /otpall',
        '- /otp <nomor_urut>',
        ...(lastFailure ? ['', `Sisa gagal: ${typeof lastFailure === 'string' ? lastFailure : JSON.stringify(lastFailure)}`] : []),
      ].join('\n'),
      getOrderSummaryKeyboard(),
    );

    await ctx.reply(
      buildCopyableNumbersMessage(successOrders),
      { parse_mode: 'Markdown' },
    );
  } catch (error) {
    await ctx.reply(`Buy gagal: ${error.message}`);
  }
}

bot.action(menuCallbackBuyRandom, async (ctx) => {
  await ctx.answerCbQuery('Processing buy...');
  await runBulkBuyFromMenu(ctx, menuService);
});

async function runQuickBuy(ctx, qty) {
  await ctx.answerCbQuery(`Processing buy ${qty}...`);
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const state = ensureMenuState(chatId);
  state.qty = Math.max(menuMinQty, Math.min(menuMaxQty, qty));
  await runBulkBuyFromMenu(ctx, menuService);
}

bot.action(menuCallbackBuyQty5, async (ctx) => {
  await runQuickBuy(ctx, 5);
});

bot.action(menuCallbackBuyQty10, async (ctx) => {
  await runQuickBuy(ctx, 10);
});

bot.action(menuCallbackBuyQty20, async (ctx) => {
  await runQuickBuy(ctx, 20);
});

bot.action(/^buy_([^_]+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Processing buy...');

  const serviceCode = ctx.match[1];
  if (!allowedMenuServices.has(String(serviceCode).toLowerCase())) {
    await ctx.reply(`Service ${serviceCode} tidak diizinkan untuk menu ini.`);
    return;
  }

  await runBulkBuyFromMenu(ctx, serviceCode);
});

bot.command('otpall', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const items = getStoredActivations(chatId);
  if (!items.length) {
    await ctx.reply('Belum ada order tersimpan. Lakukan buy dulu.');
    return;
  }

  await ctx.reply(`Cek OTP untuk ${items.length} nomor...`);
  const results = await checkAllOtpForChat(chatId);

  const lines = results.slice(0, 40).map(formatOtpRow);

  await ctx.reply(['Hasil OTP:', ...lines].join('\n'), { parse_mode: 'Markdown' });
});

bot.command('otp', async (ctx) => {
  const message = ctx.message?.text || '';
  const parts = message.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    await ctx.reply('Format: /otp <nomor_urut>');
    return;
  }

  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const items = getStoredActivations(chatId);
  if (!items.length) {
    await ctx.reply('Belum ada order tersimpan. Lakukan buy dulu.');
    return;
  }

  const orderIndex = Number(parts[1]);
  if (!Number.isInteger(orderIndex) || orderIndex < 1 || orderIndex > items.length) {
    await ctx.reply(`Nomor urut tidak valid. Pakai angka 1 sampai ${items.length}.`);
    return;
  }

  const selected = items[orderIndex - 1];
  const activationId = selected.activationId;

  try {
    const result = await checkSingleOtp(chatId, activationId);
    if (result.status === 'STATUS_OK') {
      await ctx.reply(`\`${selected.phoneNumber}\` | \`${result.code}\``, { parse_mode: 'Markdown' });
      return;
    }

    await ctx.reply(`\`${selected.phoneNumber}\` | ${result.status}`, { parse_mode: 'Markdown' });
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (status) {
      await ctx.reply(`Cek OTP gagal (HTTP ${status}):\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      return;
    }

    await ctx.reply(`Cek OTP gagal: ${error.message}`);
  }
});

bot.command('listbuy', async (ctx) => {
  try {
    const apiKey = await requireApiKey(ctx);
    if (!apiKey) {
      return;
    }
    const rows = await getActiveActivations({ start: 0, limit: 100, apiKey });
    const waRows = rows.filter((row) => row.serviceCode.toLowerCase() === 'wa');

    if (!waRows.length) {
      await ctx.reply('Belum ada nomor WhatsApp aktif di akun ini.');
      return;
    }

    waRows.sort((a, b) => String(b.activationTime || '').localeCompare(String(a.activationTime || '')));

    const lines = waRows.slice(0, 100).map(
      (item, idx) => `${idx + 1}. \`${item.phoneNumber}\` | id: ${item.activationId} | ${formatCost(item.cost)}`,
    );

    await ctx.reply(
      [
        `Daftar nomor WA aktif akun: ${waRows.length}`,
        ...lines,
        ...(waRows.length > 100 ? ['...', `Ditampilkan 100 dari ${waRows.length}`] : []),
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    if (status) {
      await ctx.reply(`Gagal ambil list buy (HTTP ${status}):\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      return;
    }
    const code = String(error.code || '');
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
      await ctx.reply(`Gagal ambil list buy: ${code}. Coba ulang lagi beberapa detik.`);
      return;
    }
    await ctx.reply(`Gagal ambil list buy: ${error.message}`);
  }
});

bot.command('checkwa', async (ctx) => {
  const country = menuCountry;

  try {
    const apiKey = await requireApiKey(ctx);
    if (!apiKey) {
      return;
    }
    const rows = await getAvailablePrices({ service: 'wa', country, apiKey });
    const top = rows.sort((a, b) => a.cost - b.cost).slice(0, 10);

    if (!top.length) {
      await ctx.reply(
        [
          'WA check (API live):',
          `country: ${country}`,
          'prices: kosong (count=0)',
          'Catatan: getPrices kadang tidak sinkron dengan hasil order real-time.',
          `Menu tetap bisa coba "Buy Random ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}".`,
        ].join('\n'),
      );
      return;
    }

    const lines = top.map((row) => `${formatCost(row.cost)} | stok ${row.count}`);
    await ctx.reply(
      [
        'WA check (API live):',
        `country: ${country}`,
        ...lines,
      ].join('\n'),
    );
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    if (status) {
      await ctx.reply(`WA check gagal (HTTP ${status}):\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      return;
    }
    await ctx.reply(`WA check gagal: ${error.message}`);
  }
});

bot.command('restockon', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  const apiKey = await requireApiKey(ctx);
  if (!apiKey) {
    return;
  }

  restockWatchChats.add(chatId);
  saveRestockWatchers();

  try {
    const rows = await getAvailablePrices({ service: 'wa', country: menuCountry, apiKey });
    const eligibleRows = rows.filter((row) => row.cost >= buyMinPrice && row.cost <= buyMaxPrice);
    if (!eligibleRows.length) {
      await ctx.reply(`Alert restock aktif. Nanti saya kabari saat WA ready di range ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}.`);
      return;
    }

    const cheapest = eligibleRows.sort((a, b) => a.cost - b.cost)[0];
    await ctx.reply(
      [
        'Alert restock aktif.',
        `Saat ini sudah ada stok: ${formatCost(cheapest.cost)} (stok ${cheapest.count})`,
      ].join('\n'),
    );
  } catch (error) {
    await ctx.reply(`Alert restock aktif, tapi cek awal gagal: ${error.message}`);
  }
});

bot.command('restockoff', async (ctx) => {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  restockWatchChats.delete(chatId);
  saveRestockWatchers();
  await ctx.reply('Alert restock dimatikan untuk chat ini.');
});

bot.command('restockstatus', async (ctx) => {
  const chatId = getChatId(ctx);
  const active = chatId ? restockWatchChats.has(chatId) : false;
  const lastCheck = lastRestockCheckAt ? new Date(lastRestockCheckAt).toISOString() : 'never';
  await ctx.reply(
    [
      'Restock Status',
      `active: ${active ? 'yes' : 'no'}`,
      `watchers: ${restockWatchChats.size}`,
      `last_check: ${lastCheck}`,
      `last_available: ${lastRestockAvailable === null ? 'unknown' : String(lastRestockAvailable)}`,
      `last_rows_in_range: ${lastRestockRows}`,
      `last_error: ${lastRestockError || '-'}`,
    ].join('\n'),
  );
});

async function handleResetWatch(ctx) {
  const chatId = getChatId(ctx);
  if (!chatId) {
    return;
  }

  activationStoreByChat.delete(chatId);
  activeBatchByChat.delete(chatId);
  restockWatchChats.delete(chatId);
  saveRestockWatchers();
  await ctx.reply('Reset selesai: semua order/watch OTP dibersihkan dan alert restock dimatikan.');
}

bot.command('resetwatch', handleResetWatch);
bot.command('reset', handleResetWatch);

bot.command('order', async (ctx) => {
  const message = ctx.message?.text || '';
  const parts = message.split(/\s+/).filter(Boolean);

  // WA-only:
  // new format: /order <country> [max_price]
  // backward compatibility: /order wa <country> [max_price]
  if (parts.length < 2) {
    ctx.reply('Format salah. Pakai: /order <country> [max_price]');
    return;
  }

  let country = parts[1];
  let maxPrice = parts[2];

  if (parts.length >= 3 && String(parts[1]).toLowerCase() === 'wa') {
    country = parts[2];
    maxPrice = parts[3];
  } else if (parts.length >= 3 && !/^\d+$/.test(parts[1])) {
    ctx.reply('Bot ini fokus WhatsApp saja. Pakai: /order <country> [max_price]');
    return;
  }

  const service = 'wa';
  // Hard lock price range for all buys.
  if (maxPrice && (Number(maxPrice) < buyMinPrice || Number(maxPrice) > buyMaxPrice)) {
    await ctx.reply(`Range harga dikunci: ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}.`);
    return;
  }

  await ctx.reply(
    `Memproses request number: service=${service}, country=${country}, range=${formatCost(buyMinPrice)}-${formatCost(buyMaxPrice)}`,
  );

  try {
    const apiKey = await requireApiKey(ctx);
    if (!apiKey) {
      return;
    }
    const pickedRow = await pickRandomBuyPriceByStockForCountry(service, country, apiKey);
    if (!pickedRow) {
      await ctx.reply(`Tidak ada stok dalam range ${formatCost(buyMinPrice)} - ${formatCost(buyMaxPrice)}.`);
      return;
    }

    const result = await createOrder({ service, country, maxPrice: pickedRow.cost, apiKey });

    if (result.status === 'ACCESS_NUMBER') {
      upsertActivations(getChatId(ctx), [result], Number(pickedRow.cost || 0));
      activeBatchByChat.set(getChatId(ctx), `${Date.now()}`);
      runOtpPollNow().catch(() => {});
      await ctx.reply(
        [
          'Request berhasil.',
          `activation_id: ${result.activationId}`,
          `number: \`${result.phoneNumber}\``,
          `max_price: ${formatCost(pickedRow.cost)}`,
          'Auto OTP aktif untuk nomor ini.',
          'Cek OTP: /otp <nomor_urut>',
        ].join('\n'),
        { parse_mode: 'Markdown' },
      );
      return;
    }

    await ctx.reply(`Request selesai dengan status: ${result.status}\nraw: ${result.raw}`);
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;

    if (status) {
      await ctx.reply(`Request gagal (HTTP ${status}):\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`);
      return;
    }

    await ctx.reply(`Request gagal: ${error.message}`);
  }
});

bot.launch().then(() => {
  loadApiKeys();
  loadRestockWatchers();
  startOtpPolling();
  console.log('Telegram bot running');
});

process.once('SIGINT', () => {
  if (otpPollTimer) {
    clearInterval(otpPollTimer);
  }
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  if (otpPollTimer) {
    clearInterval(otpPollTimer);
  }
  bot.stop('SIGTERM');
});
