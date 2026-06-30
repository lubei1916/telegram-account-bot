require('dotenv').config();

const path = require('path');
const { isAddress, getAddress } = require('ethers');
const pino = require('pino');
const CurlTelegramBot = require('./curlTelegramBot');
const Store = require('./store');
const BalanceMonitor = require('./monitor');
const { assetName, formatAssetBalance, normalizeAsset } = require('./format');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const storagePath = path.resolve(process.env.STORAGE_PATH || './data/watchers.json');
const adminUserIds = parseAdminUserIds(process.env.ADMIN_USER_IDS);
const sessions = new Map();

const store = new Store(storagePath);
store.load();

const bot = new CurlTelegramBot(token, logger, {
  offsetPath: path.join(path.dirname(storagePath), 'telegram-offset.json')
});
const monitor = new BalanceMonitor({
  store,
  bot,
  ethWsUrl: process.env.ETH_WS_URL || '',
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || '',
  tronFullHost: process.env.TRON_FULL_HOST || 'https://api.trongrid.io',
  tronApiKey: process.env.TRON_API_KEY || '',
  tronPollMs: Number(process.env.TRON_POLL_MS || 3000),
  usdtErc20Contract: process.env.USDT_ERC20_CONTRACT || '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  usdtTrc20Contract: process.env.USDT_TRC20_CONTRACT || 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj',
  logger
});

bot.use(async (ctx, next) => {
  if (adminUserIds.size > 0 && !adminUserIds.has(String(ctx.from?.id))) {
    await ctx.reply('你沒有權限使用這個 bot。');
    return;
  }

  return next();
});

bot.start(async (ctx) => {
  await ctx.reply('請先選擇地址類型。', mainMenu());
});

bot.help(async (ctx) => {
  await ctx.reply(helpText(), mainMenu());
});

bot.command('menu', async (ctx) => {
  sessions.delete(String(ctx.chat.id));
  await ctx.reply('請選擇操作：', mainMenu());
});

bot.command('add', async (ctx) => {
  try {
    const { asset, address, label } = parseAddressCommand(ctx.message.text);
    const balance = await monitor.getBalance(asset, address);
    const { created } = store.add({
      chatId: ctx.chat.id,
      asset,
      address,
      label,
      lastBalance: balance
    });

    await ctx.reply([
      created ? '已新增監控地址。' : '地址已存在，已更新備註與目前餘額。',
      `資產：${assetName(asset)}`,
      `地址：${address}`,
      label ? `備註：${label}` : null,
      `目前餘額：${formatAssetBalance(asset, balance)}`
    ].filter(Boolean).join('\n'));
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, 'add command failed');
    await ctx.reply(`新增失敗：${errorMessage(error)}\n\n你也可以直接點下方菜單新增。`, mainMenu());
  }
});

bot.command('addall', async (ctx) => {
  try {
    const { tronAddress, ethAddress, label } = parseAllCommand(ctx.message.text);
    const targets = [
      { asset: 'trx', address: tronAddress },
      { asset: 'usdt-trc20', address: tronAddress },
      { asset: 'eth', address: ethAddress },
      { asset: 'usdt-erc20', address: ethAddress }
    ];

    const results = [];
    for (const target of targets) {
      const balance = await monitor.getBalance(target.asset, target.address);
      const { created } = store.add({
        chatId: ctx.chat.id,
        asset: target.asset,
        address: target.address,
        label,
        lastBalance: balance
      });

      results.push(`${created ? '已新增' : '已更新'} ${assetName(target.asset)}：${formatAssetBalance(target.asset, balance)}`);
    }

    await ctx.reply([
      '已同時啟用四個幣種通知。',
      `TRON 地址：${tronAddress}`,
      `ETH 地址：${ethAddress}`,
      label ? `備註：${label}` : null,
      '',
      ...results
    ].filter((line) => line !== null).join('\n'));
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, 'addall command failed');
    await ctx.reply(`批量新增失敗：${errorMessage(error)}\n\n你也可以直接點下方菜單新增。`, mainMenu());
  }
});

bot.command('remove', async (ctx) => {
  try {
    const { asset, address } = parseAddressCommand(ctx.message.text);
    const removed = store.remove(ctx.chat.id, asset, address);
    await ctx.reply(removed ? '已移除監控地址。' : '找不到這個監控地址。');
  } catch (error) {
    await ctx.reply(`移除失敗：${errorMessage(error)}\n\n用法：/remove usdt-trc20 T地址`);
  }
});

bot.command('removeall', async (ctx) => {
  try {
    const { tronAddress, ethAddress } = parseAllCommand(ctx.message.text);
    const targets = [
      { asset: 'trx', address: tronAddress },
      { asset: 'usdt-trc20', address: tronAddress },
      { asset: 'eth', address: ethAddress },
      { asset: 'usdt-erc20', address: ethAddress }
    ];

    const removed = targets.reduce((count, target) => {
      return count + store.remove(ctx.chat.id, target.asset, target.address);
    }, 0);

    await ctx.reply(removed ? `已移除 ${removed} 個監控項。` : '找不到這些監控地址。');
  } catch (error) {
    await ctx.reply(`批量移除失敗：${errorMessage(error)}\n\n用法：/removeall T地址 0x地址`);
  }
});

bot.command('list', async (ctx) => {
  await sendList(ctx);
});

bot.command('balance', async (ctx) => {
  try {
    if (!hasCommandArgs(ctx.message.text)) {
      await ctx.reply('請先選擇地址類型，再選擇要查詢的餘額。', mainMenu());
      return;
    }

    const { asset, address } = parseAddressCommand(ctx.message.text);
    const balance = await monitor.getBalance(asset, address);
    await ctx.reply([
      `資產：${assetName(asset)}`,
      `地址：${address}`,
      `餘額：${formatAssetBalance(asset, balance)}`
    ].join('\n'));
  } catch (error) {
    await ctx.reply(`查詢失敗：${errorMessage(error)}\n\n用法：/balance usdt-trc20 T地址`);
  }
});

bot.command('tx', async (ctx) => {
  try {
    if (!hasCommandArgs(ctx.message.text)) {
      await ctx.reply('請先選擇地址類型，再選擇要查詢的交易紀錄。', mainMenu());
      return;
    }

    const { asset, address } = parseAddressCommand(ctx.message.text);
    const transactions = await monitor.getTransactions(asset, address, 5);
    await ctx.reply(formatTransactions(asset, address, transactions), { disable_web_page_preview: true, ...mainMenu() });
  } catch (error) {
    await ctx.reply(`查詢交易紀錄失敗：${errorMessage(error)}\n\n用法：/tx usdt-trc20 T地址`, mainMenu());
  }
});

bot.command('status', async (ctx) => {
  await sendStatus(ctx);
});

bot.onText(async (ctx) => {
  const text = String(ctx.message.text || '').trim();
  const chatId = String(ctx.chat.id);

  if (text === '取消') {
    sessions.delete(chatId);
    await ctx.reply('已取消目前操作。', mainMenu());
    return;
  }

  if (text === '主菜單') {
    sessions.delete(chatId);
    await ctx.reply('請先選擇地址類型。', mainMenu());
    return;
  }

  if (text === 'TRON 地址') {
    sessions.set(chatId, { mode: 'categoryAddress', chain: 'tron' });
    await ctx.reply('請直接貼上 T 開頭的 TRON 地址。', categoryAddressKeyboard('tron'));
    return;
  }

  if (text === 'ETH 地址') {
    sessions.set(chatId, { mode: 'categoryAddress', chain: 'eth' });
    await ctx.reply('請直接貼上 0x 開頭的 ETH 地址。', categoryAddressKeyboard('eth'));
    return;
  }

  const session = sessions.get(chatId);
  if (session) {
    await handleSession(ctx, session, text);
    return;
  }

  if (text === '新增四幣種') {
    sessions.set(chatId, { mode: 'all', step: 'tronAddress' });
    await ctx.reply('請發送 TRON 地址，也就是 T 開頭的地址。', cancelKeyboard());
    return;
  }

  const classifiedAction = classifiedActionFromText(text);
  if (classifiedAction) {
    sessions.set(chatId, {
      mode: classifiedAction.mode,
      step: classifiedAction.mode === 'single' ? 'address' : 'address',
      asset: classifiedAction.asset
    });
    const addressType = classifiedAction.asset === 'trx' || classifiedAction.asset === 'usdt-trc20'
      ? 'T 開頭 TRON 地址'
      : '0x 開頭 ETH 地址';
    await ctx.reply(`${classifiedAction.prompt}\n\n請直接貼上 ${addressType}。`, backKeyboard(classifiedAction.asset));
    return;
  }

  if (text === '監控列表') {
    await sendList(ctx);
    return;
  }

  if (text === '狀態') {
    await sendStatus(ctx);
    return;
  }

  await ctx.reply('請先從下方菜單選擇操作。', mainMenu());
});

async function sendList(ctx) {
  const watchers = store.list(ctx.chat.id);
  if (watchers.length === 0) {
    await ctx.reply('目前沒有監控地址。', mainMenu());
    return;
  }

  const lines = watchers.map((watcher, index) => {
    const asset = watcher.asset || watcher.chain;
    const label = watcher.label ? ` (${watcher.label})` : '';
    return [
      `${index + 1}. ${assetName(asset)}${label}`,
      watcher.address,
      `上次餘額：${formatAssetBalance(asset, watcher.lastBalance)}`
    ].join('\n');
  });

  await ctx.reply(lines.join('\n\n'), { disable_web_page_preview: true, ...mainMenu() });
}

async function sendStatus(ctx) {
  const status = monitor.status();
  await ctx.reply([
    '機器人狀態',
    `啟動時間：${status.startedAt.toISOString()}`,
    `監控數量：${status.watchers}`,
    `ETH 監控：${status.ethEnabled ? '已啟用' : '未啟用'}`,
    `最新 ETH 區塊：${status.lastEthBlock || '無'}`,
    `TRON 輪詢間隔：${status.tronPollMs} ms`,
    `ETH 歷史交易：${status.etherscanHistoryEnabled ? '已啟用' : '需要 ETHERSCAN_API_KEY'}`,
    `USDT ERC20 合約：${status.usdtErc20Contract}`,
    `USDT TRC20 合約：${status.usdtTrc20Contract}`
  ].join('\n'), mainMenu());
}

bot.catch((error, ctx) => {
  logger.error({ error: errorMessage(error), update: ctx.update }, 'Telegram bot error');
});

async function main() {
  await monitor.start();
  await bot.launch();
  logger.info({ storagePath }, 'Telegram balance monitor bot started');
}

main().catch((error) => {
  logger.fatal({ error }, 'Fatal startup error');
  process.exit(1);
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  try {
    await bot.stop(signal);
  } catch (error) {
    if (error.message !== 'Bot is not running!') throw error;
  }
  await monitor.stop();
  process.exit(0);
}

async function beginSingleAdd(ctx, asset) {
  sessions.set(String(ctx.chat.id), { mode: 'single', step: 'address', asset });
  const addressType = asset === 'trx' || asset === 'usdt-trc20' ? 'T 開頭的 TRON 地址' : '0x 開頭的 ETH 地址';
  await ctx.reply(`請發送 ${assetName(asset)} 的地址。\n格式：${addressType}`, cancelKeyboard());
}

async function handleSession(ctx, session, text) {
  if (session.mode === 'categoryAddress') {
    await handleCategoryAddressSession(ctx, session, text);
    return;
  }

  if (session.mode === 'categoryReady') {
    await handleCategoryReadySession(ctx, session, text);
    return;
  }

  if (session.mode === 'categoryAddLabel') {
    await handleCategoryAddLabelSession(ctx, session, text);
    return;
  }

  if (session.mode === 'single') {
    await handleSingleSession(ctx, session, text);
    return;
  }

  if (session.mode === 'queryBalance' || session.mode === 'queryTx' || session.mode === 'deleteMonitor') {
    await handleDirectQuerySession(ctx, session, text);
    return;
  }

  await handleAllSession(ctx, session, text);
}

async function handleCategoryAddressSession(ctx, session, text) {
  const chatId = String(ctx.chat.id);

  try {
    const address = normalizeAddress(session.chain === 'tron' ? 'trx' : 'eth', text);
    sessions.set(chatId, {
      mode: 'categoryReady',
      chain: session.chain,
      address
    });

    await ctx.reply([
      session.chain === 'tron' ? '已收到 TRON 地址。' : '已收到 ETH 地址。',
      `地址：${address}`,
      '',
      '請選擇要執行的操作。'
    ].join('\n'), addressActionKeyboard(session.chain));
  } catch (error) {
    const hint = session.chain === 'tron' ? 'T 開頭的 TRON 地址' : '0x 開頭的 ETH 地址';
    await ctx.reply(`地址格式不正確：${errorMessage(error)}\n\n請重新貼上 ${hint}。`, categoryAddressKeyboard(session.chain));
  }
}

async function handleCategoryReadySession(ctx, session, text) {
  const action = addressActionFromText(session.chain, text);
  if (!action) {
    await ctx.reply('請從下方子菜單選擇操作。', addressActionKeyboard(session.chain));
    return;
  }

  if (action.kind === 'balance') {
    const balance = await monitor.getBalance(action.asset, session.address);
    await ctx.reply([
      '餘額查詢結果',
      `資產：${assetName(action.asset)}`,
      `地址：${session.address}`,
      `餘額：${formatAssetBalance(action.asset, balance)}`
    ].join('\n'), addressActionKeyboard(session.chain));
    return;
  }

  if (action.kind === 'tx') {
    const transactions = await monitor.getTransactions(action.asset, session.address, 5);
    await ctx.reply(formatTransactions(action.asset, session.address, transactions), {
      disable_web_page_preview: true,
      ...addressActionKeyboard(session.chain)
    });
    return;
  }

  if (action.kind === 'delete') {
    const removed = store.remove(ctx.chat.id, action.asset, session.address);
    await ctx.reply([
      removed ? '已刪除監控。' : '找不到這個監控項。',
      `資產：${assetName(action.asset)}`,
      `地址：${session.address}`
    ].join('\n'), addressActionKeyboard(session.chain));
    return;
  }

  const balance = await monitor.getBalance(action.asset, session.address);
  sessions.set(String(ctx.chat.id), {
    mode: 'categoryAddLabel',
    chain: session.chain,
    asset: action.asset,
    address: session.address,
    balance: String(balance)
  });
  await ctx.reply([
    `已讀取 ${assetName(action.asset)} 地址。`,
    `地址：${session.address}`,
    `目前餘額：${formatAssetBalance(action.asset, balance)}`,
    '',
    '請輸入備註，例如：多簽、熱錢包、交易所。'
  ].join('\n'), skipKeyboard());
}

async function handleCategoryAddLabelSession(ctx, session, text) {
  const label = text === '略過備註' ? '' : text;
  const { created } = store.add({
    chatId: ctx.chat.id,
    asset: session.asset,
    address: session.address,
    label,
    lastBalance: session.balance
  });

  sessions.set(String(ctx.chat.id), {
    mode: 'categoryReady',
    chain: session.chain,
    address: session.address
  });
  await ctx.reply([
    created ? '已新增監控。' : '地址已存在，已更新備註與目前餘額。',
    `資產：${assetName(session.asset)}`,
    `地址：${session.address}`,
    label ? `備註：${label}` : null,
    `目前餘額：${formatAssetBalance(session.asset, session.balance)}`
  ].filter(Boolean).join('\n'), addressActionKeyboard(session.chain));
}

async function handleDirectQuerySession(ctx, session, text) {
  const chatId = String(ctx.chat.id);

  try {
    const address = normalizeAddress(session.asset, text);
    if (session.mode === 'deleteMonitor') {
      const removed = store.remove(ctx.chat.id, session.asset, address);
      sessions.delete(chatId);
      await ctx.reply([
        removed ? '已刪除監控。' : '找不到這個監控項。',
        `資產：${assetName(session.asset)}`,
        `地址：${address}`
      ].join('\n'), mainMenu());
      return;
    }

    if (session.mode === 'queryBalance') {
      const balance = await monitor.getBalance(session.asset, address);
      sessions.delete(chatId);
      await ctx.reply([
        '餘額查詢結果',
        `資產：${assetName(session.asset)}`,
        `地址：${address}`,
        `餘額：${formatAssetBalance(session.asset, balance)}`
      ].join('\n'), mainMenu());
      return;
    }

    const transactions = await monitor.getTransactions(session.asset, address, 5);
    sessions.delete(chatId);
    await ctx.reply(formatTransactions(session.asset, address, transactions), { disable_web_page_preview: true, ...mainMenu() });
  } catch (error) {
    await ctx.reply(`查詢失敗：${errorMessage(error)}\n\n請重新發送地址，或返回上一層。`, backKeyboard(session.asset));
  }
}

async function handleSingleSession(ctx, session, text) {
  const chatId = String(ctx.chat.id);

  if (session.step === 'address') {
    try {
      const address = normalizeAddress(session.asset, text);
      const balance = await monitor.getBalance(session.asset, address);
      sessions.set(chatId, {
        ...session,
        step: 'label',
        address,
        balance: String(balance)
      });
      await ctx.reply([
        `已讀取 ${assetName(session.asset)} 地址。`,
        `地址：${address}`,
        `目前餘額：${formatAssetBalance(session.asset, balance)}`,
        '',
        '請輸入備註，例如：多簽、熱錢包、交易所。'
      ].join('\n'), skipKeyboard());
    } catch (error) {
      await ctx.reply(`地址或查詢失敗：${errorMessage(error)}\n\n請重新發送地址，或點「取消」。`, cancelKeyboard());
    }
    return;
  }

  const label = text === '略過備註' ? '' : text;
  const { created } = store.add({
    chatId,
    asset: session.asset,
    address: session.address,
    label,
    lastBalance: session.balance
  });

  sessions.delete(chatId);
  await ctx.reply([
    created ? '已新增監控。' : '地址已存在，已更新備註與目前餘額。',
    `資產：${assetName(session.asset)}`,
    `地址：${session.address}`,
    label ? `備註：${label}` : null,
    `目前餘額：${formatAssetBalance(session.asset, session.balance)}`
  ].filter(Boolean).join('\n'), mainMenu());
}

async function handleAllSession(ctx, session, text) {
  const chatId = String(ctx.chat.id);

  if (session.step === 'tronAddress') {
    try {
      const tronAddress = normalizeAddress('trx', text);
      sessions.set(chatId, { ...session, step: 'ethAddress', tronAddress });
      await ctx.reply('TRON 地址已收到。現在請發送 0x 開頭的 ETH 地址。', cancelKeyboard());
    } catch (error) {
      await ctx.reply(`TRON 地址格式不正確：${errorMessage(error)}\n\n請重新發送 T 開頭地址，或點「取消」。`, cancelKeyboard());
    }
    return;
  }

  if (session.step === 'ethAddress') {
    try {
      const ethAddress = normalizeAddress('eth', text);
      sessions.set(chatId, { ...session, step: 'label', ethAddress });
      await ctx.reply([
        'ETH 地址已收到。',
        '',
        '請輸入這組監控的備註，例如：多簽、主錢包、公司錢包。'
      ].join('\n'), skipKeyboard());
    } catch (error) {
      await ctx.reply(`ETH 地址格式不正確：${errorMessage(error)}\n\n請重新發送 0x 地址，或點「取消」。`, cancelKeyboard());
    }
    return;
  }

  const label = text === '略過備註' ? '' : text;
  const targets = [
    { asset: 'trx', address: session.tronAddress },
    { asset: 'usdt-trc20', address: session.tronAddress },
    { asset: 'eth', address: session.ethAddress },
    { asset: 'usdt-erc20', address: session.ethAddress }
  ];

  try {
    const results = [];
    for (const target of targets) {
      const balance = await monitor.getBalance(target.asset, target.address);
      const { created } = store.add({
        chatId,
        asset: target.asset,
        address: target.address,
        label,
        lastBalance: balance
      });
      results.push(`${created ? '已新增' : '已更新'} ${assetName(target.asset)}：${formatAssetBalance(target.asset, balance)}`);
    }

    sessions.delete(chatId);
    await ctx.reply([
      '已同時啟用四個幣種通知。',
      `TRON 地址：${session.tronAddress}`,
      `ETH 地址：${session.ethAddress}`,
      label ? `備註：${label}` : null,
      '',
      ...results
    ].filter(Boolean).join('\n'), mainMenu());
  } catch (error) {
    await ctx.reply(`新增四幣種失敗：${errorMessage(error)}\n\n請稍後再試，或點「取消」。`, cancelKeyboard());
  }
}

function parseAddressCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  const asset = normalizeAsset(parts[1]);
  if (!asset) throw new Error('資產必須是 trx、eth、usdt-trc20 或 usdt-erc20');

  const rawAddress = parts[2];
  if (!rawAddress) throw new Error('缺少地址');

  const address = normalizeAddress(asset, rawAddress);
  const label = parts.slice(3).join(' ');
  return { asset, address, label };
}

function hasCommandArgs(text) {
  return String(text || '').trim().split(/\s+/).length > 1;
}

function parseAllCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  const tronAddress = normalizeAddress('trx', parts[1]);
  const ethAddress = normalizeAddress('eth', parts[2]);
  const label = parts.slice(3).join(' ');
  return { tronAddress, ethAddress, label };
}

function normalizeAddress(asset, address) {
  if (!address) throw new Error('缺少地址');

  if (asset === 'eth' || asset === 'usdt-erc20') {
    if (!isAddress(address)) throw new Error('ETH 地址格式不正確');
    return getAddress(address);
  }

  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error('TRX 地址格式不正確，請使用 T 開頭的 TRON base58 地址');
  }

  return address;
}

function parseAdminUserIds(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: 'TRON 地址' }, { text: 'ETH 地址' }],
        [{ text: '新增四幣種' }],
        [{ text: '監控列表' }, { text: '狀態' }]
      ],
      resize_keyboard: true
    }
  };
}

function categoryAddressKeyboard(chain) {
  const menuText = chain === 'tron' ? 'TRON 地址' : 'ETH 地址';
  return {
    reply_markup: {
      keyboard: [[{ text: menuText }, { text: '主菜單' }], [{ text: '取消' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function addressActionKeyboard(chain) {
  if (chain === 'tron') {
    return tronMenu();
  }

  return ethMenu();
}

function tronMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: 'TRX 新增監控' }, { text: 'USDT-TRC20 新增監控' }],
        [{ text: 'TRX 刪除監控' }, { text: 'USDT-TRC20 刪除監控' }],
        [{ text: 'TRX 查餘額' }, { text: 'USDT-TRC20 查餘額' }],
        [{ text: 'TRX 查交易' }, { text: 'USDT-TRC20 查交易' }],
        [{ text: '主菜單' }]
      ],
      resize_keyboard: true
    }
  };
}

function addressActionFromText(chain, text) {
  const actions = chain === 'tron'
    ? {
        'TRX 新增監控': { kind: 'add', asset: 'trx' },
        'USDT-TRC20 新增監控': { kind: 'add', asset: 'usdt-trc20' },
        'TRX 刪除監控': { kind: 'delete', asset: 'trx' },
        'USDT-TRC20 刪除監控': { kind: 'delete', asset: 'usdt-trc20' },
        'TRX 查餘額': { kind: 'balance', asset: 'trx' },
        'USDT-TRC20 查餘額': { kind: 'balance', asset: 'usdt-trc20' },
        'TRX 查交易': { kind: 'tx', asset: 'trx' },
        'USDT-TRC20 查交易': { kind: 'tx', asset: 'usdt-trc20' }
      }
    : {
        'ETH 新增監控': { kind: 'add', asset: 'eth' },
        'USDT-ERC20 新增監控': { kind: 'add', asset: 'usdt-erc20' },
        'ETH 刪除監控': { kind: 'delete', asset: 'eth' },
        'USDT-ERC20 刪除監控': { kind: 'delete', asset: 'usdt-erc20' },
        'ETH 查餘額': { kind: 'balance', asset: 'eth' },
        'USDT-ERC20 查餘額': { kind: 'balance', asset: 'usdt-erc20' },
        'ETH 查交易': { kind: 'tx', asset: 'eth' },
        'USDT-ERC20 查交易': { kind: 'tx', asset: 'usdt-erc20' }
      };

  return actions[text];
}

function ethMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: 'ETH 新增監控' }, { text: 'USDT-ERC20 新增監控' }],
        [{ text: 'ETH 刪除監控' }, { text: 'USDT-ERC20 刪除監控' }],
        [{ text: 'ETH 查餘額' }, { text: 'USDT-ERC20 查餘額' }],
        [{ text: 'ETH 查交易' }, { text: 'USDT-ERC20 查交易' }],
        [{ text: '主菜單' }]
      ],
      resize_keyboard: true
    }
  };
}

function backKeyboard(asset) {
  const menu = asset === 'trx' || asset === 'usdt-trc20' ? 'TRON 地址' : 'ETH 地址';
  return {
    reply_markup: {
      keyboard: [[{ text: menu }, { text: '主菜單' }], [{ text: '取消' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function cancelKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: '取消' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function skipKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: '略過備註' }, { text: '取消' }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  };
}

function errorMessage(error) {
  if (!error) return '未知錯誤';
  if (error.message) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifiedActionFromText(text) {
  return {
    'TRX 新增監控': { mode: 'single', asset: 'trx', prompt: '新增 TRX 監控' },
    'USDT-TRC20 新增監控': { mode: 'single', asset: 'usdt-trc20', prompt: '新增 USDT-TRC20 監控' },
    'ETH 新增監控': { mode: 'single', asset: 'eth', prompt: '新增 ETH 監控' },
    'USDT-ERC20 新增監控': { mode: 'single', asset: 'usdt-erc20', prompt: '新增 USDT-ERC20 監控' },
    'TRX 刪除監控': { mode: 'deleteMonitor', asset: 'trx', prompt: '刪除 TRX 監控' },
    'USDT-TRC20 刪除監控': { mode: 'deleteMonitor', asset: 'usdt-trc20', prompt: '刪除 USDT-TRC20 監控' },
    'ETH 刪除監控': { mode: 'deleteMonitor', asset: 'eth', prompt: '刪除 ETH 監控' },
    'USDT-ERC20 刪除監控': { mode: 'deleteMonitor', asset: 'usdt-erc20', prompt: '刪除 USDT-ERC20 監控' },
    'TRX 查餘額': { mode: 'queryBalance', asset: 'trx', prompt: '查詢 TRX 餘額' },
    'USDT-TRC20 查餘額': { mode: 'queryBalance', asset: 'usdt-trc20', prompt: '查詢 USDT-TRC20 餘額' },
    'ETH 查餘額': { mode: 'queryBalance', asset: 'eth', prompt: '查詢 ETH 餘額' },
    'USDT-ERC20 查餘額': { mode: 'queryBalance', asset: 'usdt-erc20', prompt: '查詢 USDT-ERC20 餘額' },
    'TRX 查交易': { mode: 'queryTx', asset: 'trx', prompt: '查詢 TRX 交易紀錄' },
    'USDT-TRC20 查交易': { mode: 'queryTx', asset: 'usdt-trc20', prompt: '查詢 USDT-TRC20 交易紀錄' },
    'ETH 查交易': { mode: 'queryTx', asset: 'eth', prompt: '查詢 ETH 交易紀錄' },
    'USDT-ERC20 查交易': { mode: 'queryTx', asset: 'usdt-erc20', prompt: '查詢 USDT-ERC20 交易紀錄' }
  }[text];
}

function formatTransactions(asset, address, transactions) {
  if (!transactions.length) {
    return [
      `最近交易紀錄：${assetName(asset)}`,
      `地址：${address}`,
      '',
      '沒有查到最近交易。'
    ].join('\n');
  }

  const lines = transactions.map((tx, index) => {
    return [
      `${index + 1}. ${formatDirection(tx.direction)} ${tx.amount ? formatAssetBalance(asset, tx.amount) : ''}`.trim(),
      tx.counterparty ? `對手方：${tx.counterparty}` : null,
      tx.hash ? `交易哈希：${tx.hash}` : null,
      tx.time ? `時間：${new Date(tx.time).toISOString()}` : null,
      tx.status ? `狀態：${formatStatus(tx.status)}` : null
    ].filter(Boolean).join('\n');
  });

  return [
    `最近交易紀錄：${assetName(asset)}`,
    `地址：${address}`,
    '',
    ...lines
  ].join('\n\n');
}

function formatDirection(direction) {
  if (direction === 'in') return '轉入';
  if (direction === 'out') return '轉出';
  return '未知方向';
}

function formatStatus(status) {
  const text = String(status || '');
  if (text === 'success') return '成功';
  if (text === 'failed') return '失敗';
  if (text === 'confirmed') return '已確認';
  if (text === 'pending block confirmation') return '區塊內待確認';
  return text;
}

function helpText() {
  return [
    'ET 監控機器人',
    '',
    '推薦用法：直接點下方分類菜單。',
    'TRON 地址：TRX / USDT-TRC20 新增、查餘額、查交易。',
    'ETH 地址：ETH / USDT-ERC20 新增、查餘額、查交易。',
    '新增流程：選分類 -> 選功能 -> 貼地址 -> 輸入備註。',
    '',
    '進階指令：',
    '/addall T地址 0x地址 備註',
    '/add trx T地址 備註',
    '/add eth 0x地址 備註',
    '/add usdt-trc20 T地址 備註',
    '/add usdt-erc20 0x地址 備註',
    '/removeall T地址 0x地址',
    '/remove trx T地址',
    '/remove eth 0x地址',
    '/remove usdt-trc20 T地址',
    '/remove usdt-erc20 0x地址',
    '/list',
    '/balance trx T地址',
    '/balance eth 0x地址',
    '/balance usdt-trc20 T地址',
    '/balance usdt-erc20 0x地址',
    '/tx trx T地址',
    '/tx usdt-trc20 T地址',
    '/tx eth 0x地址',
    '/tx usdt-erc20 0x地址',
    '/status'
  ].join('\n');
}
