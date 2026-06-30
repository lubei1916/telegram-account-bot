const { Contract, Interface, WebSocketProvider } = require('ethers');
const TronWebPackage = require('tronweb');
const { assetName, formatDelta, formatAssetBalance } = require('./format');

const TronWeb = TronWebPackage.TronWeb || TronWebPackage.default || TronWebPackage;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];
const ERC20_IFACE = new Interface(ERC20_ABI);
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const ETH_RPC_TIMEOUT_MS = 20_000;
const ETH_RECONNECT_MS = 5_000;

class BalanceMonitor {
  constructor({
    store,
    bot,
    ethWsUrl,
    etherscanApiKey,
    etherscanApiBase,
    tronFullHost,
    tronscanApiBase,
    tronApiKey,
    tronPollMs,
    usdtErc20Contract,
    usdtTrc20Contract,
    usdcErc20Contract,
    logger
  }) {
    this.store = store;
    this.bot = bot;
    this.ethWsUrl = ethWsUrl;
    this.etherscanApiKey = etherscanApiKey;
    this.etherscanApiBase = String(etherscanApiBase || 'https://api.etherscan.io/api').replace(/\/$/, '');
    this.tronFullHost = tronFullHost.replace(/\/$/, '');
    this.tronscanApiBase = String(tronscanApiBase || 'https://apilist.tronscanapi.com/api').replace(/\/$/, '');
    this.tronApiKey = tronApiKey;
    this.tronPollMs = this.tronApiKey ? tronPollMs : Math.max(Number(tronPollMs) || 3000, 10000);
    this.usdtErc20Contract = usdtErc20Contract;
    this.usdtTrc20Contract = usdtTrc20Contract;
    this.usdcErc20Contract = usdcErc20Contract;
    this.logger = logger;
    this.ethProvider = null;
    this.tronWeb = null;
    this.tronTimer = null;
    this.startedAt = new Date();
    this.lastEthBlock = null;
    this.checkingEth = false;
    this.checkingTrx = false;
    this.tronAccountCache = new Map();
    this.tronFetchQueue = Promise.resolve();
    this.lastTronFetchAt = 0;
    this.ethReconnectTimer = null;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    if (this.ethWsUrl) {
      await this.startEth();
    } else {
      this.logger.warn('ETH_WS_URL is not configured; Ethereum monitoring is disabled');
    }

    this.startTron();
  }

  async stop() {
    this.stopped = true;
    if (this.ethReconnectTimer) {
      clearTimeout(this.ethReconnectTimer);
      this.ethReconnectTimer = null;
    }

    if (this.ethProvider) {
      await this.ethProvider.destroy();
      this.ethProvider = null;
    }

    if (this.tronTimer) {
      clearInterval(this.tronTimer);
    }
  }

  clearRuntimeCache() {
    this.tronAccountCache.clear();
    this.logger.info('Runtime cache cleared');
  }

  async startEth() {
    if (this.ethProvider) {
      await this.ethProvider.destroy().catch((error) => {
        this.logger.warn({ error: error.message }, 'Failed to destroy old Ethereum provider');
      });
      this.ethProvider = null;
    }

    this.ethProvider = new WebSocketProvider(this.ethWsUrl);
    this.ethProvider.on('block', async (blockNumber) => {
      this.lastEthBlock = blockNumber;
      await this.checkEth(blockNumber).catch((error) => {
        this.logger.error({ error: error.message, blockNumber }, 'Ethereum block check failed');
      });
    });
    this.ethProvider.websocket.on('close', () => {
      this.logger.error('Ethereum WebSocket closed; scheduling reconnect');
      this.scheduleEthReconnect();
    });
    this.ethProvider.websocket.on('error', (error) => {
      this.logger.error({ error }, 'Ethereum WebSocket error');
    });
    this.logger.info('Ethereum monitor started');
  }

  scheduleEthReconnect() {
    if (this.stopped || !this.ethWsUrl || this.ethReconnectTimer) return;

    this.ethReconnectTimer = setTimeout(async () => {
      this.ethReconnectTimer = null;
      if (this.stopped) return;

      try {
        await this.startEth();
        this.logger.info('Ethereum WebSocket reconnected');
      } catch (error) {
        this.logger.error({ error: error.message }, 'Ethereum WebSocket reconnect failed');
        this.scheduleEthReconnect();
      }
    }, ETH_RECONNECT_MS);
  }

  startTron() {
    this.initTronWeb();

    this.tronTimer = setInterval(() => {
      this.checkTron().catch((error) => {
        this.logger.error({ error }, 'TRON monitor tick failed');
      });
    }, this.tronPollMs);
    this.checkTron().catch((error) => {
      this.logger.error({ error }, 'Initial TRON monitor check failed');
    });
    this.logger.info({ tronPollMs: this.tronPollMs }, 'TRON monitor started');
  }

  initTronWeb() {
    if (this.tronWeb) return;

    const headers = {};
    if (this.tronApiKey) headers['TRON-PRO-API-KEY'] = this.tronApiKey;

    this.tronWeb = new TronWeb({
      fullHost: this.tronFullHost,
      headers
    });
  }

  async checkEth(blockNumber) {
    if (this.checkingEth) return;
    this.checkingEth = true;

    try {
      const watchers = [
        ...this.store.listByAsset('eth'),
        ...this.store.listByAsset('usdt-erc20'),
        ...this.store.listByAsset('usdc-erc20')
      ];
      await Promise.allSettled(watchers.map(async (watcher) => {
        const asset = watcher.asset || watcher.chain;
        const balance = await this.getBalance(asset, watcher.address);
        await this.handleBalance(asset, watcher, balance, blockNumber ? `block ${blockNumber}` : 'manual check', blockNumber);
      }));
    } finally {
      this.checkingEth = false;
    }
  }

  async checkTron() {
    if (this.checkingTrx) return;
    this.checkingTrx = true;

    try {
      this.tronAccountCache.clear();
      const watchers = [
        ...this.store.listByAsset('trx'),
        ...this.store.listByAsset('usdt-trc20')
      ];
      for (const watcher of watchers) {
        const asset = watcher.asset || watcher.chain;
        try {
          const balance = await this.getBalance(asset, watcher.address);
          await this.handleBalance(asset, watcher, balance, 'poll');
        } catch (error) {
          this.logger.warn({ error: error.message, asset, address: watcher.address }, 'TRON watcher check skipped');
        }
      }
    } finally {
      this.checkingTrx = false;
    }
  }

  async handleBalance(asset, watcher, balance, source, blockNumber = null) {
    const next = String(balance);
    const previous = String(watcher.lastBalance || '0');
    if (next === previous) return;

    this.store.updateBalance(watcher.id, next);

    const transactions = await this.getChangeTransactions(asset, watcher.address, blockNumber).catch((error) => {
      this.logger.warn({ error: error.message, asset, address: watcher.address }, 'Failed to fetch change transaction details');
      return [];
    });

    const label = watcher.label ? `\n備註：${watcher.label}` : '';
    const lines = [
      `動帳提醒：${assetName(asset)}`,
      `地址：${watcher.address}${label}`,
      `變動前：${formatAssetBalance(asset, previous)}`,
      `變動後：${formatAssetBalance(asset, next)}`,
      `變動額：${formatDelta(asset, previous, next)}`,
      `來源：${formatSource(source)}`
    ];

    if (transactions.length) {
      lines.push('', '交易詳情：');
      for (const tx of transactions.slice(0, 3)) {
        lines.push(formatTxLine(asset, tx));
      }
    }

    await this.bot.telegram.sendMessage(watcher.chatId, lines.join('\n'), { disable_web_page_preview: true });
  }

  async getBalance(asset, address) {
    if (asset === 'eth') {
      if (!this.ethProvider) return this.getEtherscanBalance(asset, address);
      return this.withEtherscanFallback(
        asset,
        address,
        () => withTimeout(this.ethProvider.getBalance(address), ETH_RPC_TIMEOUT_MS, 'ETH balance query timed out')
      );
    }

    if (asset === 'usdt-erc20' || asset === 'usdc-erc20') {
      if (!this.ethProvider) return this.getEtherscanBalance(asset, address);
      const contract = new Contract(this.getErc20Contract(asset), ERC20_ABI, this.ethProvider);
      return this.withEtherscanFallback(
        asset,
        address,
        () => withTimeout(contract.balanceOf(address), ETH_RPC_TIMEOUT_MS, `${assetName(asset)} balance query timed out`)
      );
    }

    if (asset === 'trx') {
      return this.withTronscanFallback(asset, address, () => this.getTrxBalance(address));
    }

    if (asset === 'usdt-trc20') {
      return this.withTronscanFallback(asset, address, () => this.getTrc20Balance(address, this.usdtTrc20Contract));
    }

    throw new Error(`Unsupported asset: ${asset}`);
  }

  async getTrxBalance(address) {
    const account = await this.getTronAccount(address);
    return BigInt(account?.balance || 0);
  }

  async getTrc20Balance(address, contractAddress) {
    this.initTronWeb();

    const ownerAddress = this.tronWeb.address.toHex(address);
    const contractHex = this.tronWeb.address.toHex(contractAddress);
    const parameter = encodeTronAddressParameter(ownerAddress);
    const json = await this.tronFetch(`${this.tronFullHost}/wallet/triggerconstantcontract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner_address: ownerAddress,
        contract_address: contractHex,
        function_selector: 'balanceOf(address)',
        parameter,
        visible: false
      })
    });

    if (json.result && json.result.result === false) {
      throw new Error(`TRC20 balance query failed: ${json.result.message || 'unknown error'}`);
    }

    const balanceHex = json.constant_result?.[0];
    if (!balanceHex) return 0n;

    return BigInt(`0x${balanceHex}`);
  }

  async withTronscanFallback(asset, address, primaryQuery) {
    try {
      const balance = BigInt(await primaryQuery());
      if (balance !== 0n) return balance;

      const fallback = await this.getTronscanBalance(asset, address).catch((error) => {
        this.logger.warn({ error: error.message, asset, address }, 'Tronscan fallback balance query failed');
        return null;
      });
      if (fallback !== null && fallback !== 0n) {
        this.logger.warn({ asset, address }, 'Primary TRON balance was zero; using Tronscan fallback balance');
        return fallback;
      }

      return balance;
    } catch (error) {
      const fallback = await this.getTronscanBalance(asset, address).catch((fallbackError) => {
        this.logger.warn({ error: fallbackError.message, asset, address }, 'Tronscan fallback balance query failed');
        return null;
      });
      if (fallback !== null) {
        this.logger.warn({ error: error.message, asset, address }, 'Primary TRON balance query failed; using Tronscan fallback balance');
        return fallback;
      }

      throw error;
    }
  }

  async getTronscanBalance(asset, address) {
    if (!this.tronscanApiBase) throw new Error('TRONSCAN_API_BASE is not configured');

    if (asset === 'trx') {
      const search = new URLSearchParams({ address });
      const json = await this.tronscanFetch(`/account?${search.toString()}`);
      return BigInt(json.balance || json.account?.balance || 0);
    }

    if (asset === 'usdt-trc20') {
      const search = new URLSearchParams({ address, start: '0', limit: '50' });
      const json = await this.tronscanFetch(`/account/tokens?${search.toString()}`);
      const tokens = [
        ...(Array.isArray(json.data) ? json.data : []),
        ...(Array.isArray(json.tokens) ? json.tokens : [])
      ];
      const token = tokens.find((item) => isTronscanTokenMatch(item, this.usdtTrc20Contract, 'USDT'));
      if (!token) return 0n;

      return parseTronscanTokenBalance(token);
    }

    throw new Error(`Unsupported Tronscan asset: ${asset}`);
  }

  async withEtherscanFallback(asset, address, primaryQuery) {
    try {
      const balance = BigInt(await primaryQuery());
      if (balance !== 0n || !this.etherscanApiKey) return balance;

      const fallback = await this.getEtherscanBalance(asset, address).catch((error) => {
        this.logger.warn({ error: error.message, asset, address }, 'Etherscan fallback balance query failed');
        return null;
      });
      if (fallback !== null && fallback !== 0n) {
        this.logger.warn({ asset, address }, 'Primary Ethereum balance was zero; using Etherscan fallback balance');
        return fallback;
      }

      return balance;
    } catch (error) {
      const fallback = await this.getEtherscanBalance(asset, address).catch((fallbackError) => {
        this.logger.warn({ error: fallbackError.message, asset, address }, 'Etherscan fallback balance query failed');
        return null;
      });
      if (fallback !== null) {
        this.logger.warn({ error: error.message, asset, address }, 'Primary Ethereum balance query failed; using Etherscan fallback balance');
        return fallback;
      }

      throw error;
    }
  }

  async getEtherscanBalance(asset, address) {
    if (!this.etherscanApiKey) throw new Error('ETHERSCAN_API_KEY is not configured');

    if (asset === 'eth') {
      const json = await this.etherscanFetch({
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest'
      });
      return BigInt(json.result || 0);
    }

    if (asset === 'usdt-erc20' || asset === 'usdc-erc20') {
      const json = await this.etherscanFetch({
        module: 'account',
        action: 'tokenbalance',
        contractaddress: this.getErc20Contract(asset),
        address,
        tag: 'latest'
      });
      return BigInt(json.result || 0);
    }

    throw new Error(`Unsupported Etherscan asset: ${asset}`);
  }

  async getTransactions(asset, address, limit = 5) {
    if (asset === 'trx') return this.getTrxTransactions(address, limit);
    if (asset === 'usdt-trc20') return this.getTrc20Transactions(address, limit);
    if (asset === 'eth') return this.getEthTransactions(address, limit);
    if (asset === 'usdt-erc20') return this.getErc20Transactions(address, limit);
    if (asset === 'usdc-erc20') return this.getErc20Transactions(address, limit, 'usdc-erc20');
    throw new Error(`Unsupported asset: ${asset}`);
  }

  async getChangeTransactions(asset, address, blockNumber) {
    if (asset === 'trx') return this.getTrxTransactions(address, 3);
    if (asset === 'usdt-trc20') return this.getTrc20Transactions(address, 3);
    if (asset === 'eth' && blockNumber) return this.getEthBlockTransactions(address, blockNumber);
    if (asset === 'usdt-erc20' && blockNumber) return this.getErc20BlockTransactions(address, blockNumber);
    if (asset === 'usdc-erc20' && blockNumber) return this.getErc20BlockTransactions(address, blockNumber, 'usdc-erc20');
    return this.getTransactions(asset, address, 3);
  }

  async getTrxTransactions(address, limit) {
    this.initTronWeb();
    const url = `${this.tronFullHost}/v1/accounts/${encodeURIComponent(address)}/transactions?only_confirmed=true&limit=${limit}`;
    const json = await this.tronFetch(url);
    return (json.data || []).map((tx) => {
      const value = tx.raw_data?.contract?.[0]?.parameter?.value || {};
      const from = value.owner_address ? this.tronWeb.address.fromHex(value.owner_address) : '';
      const to = value.to_address ? this.tronWeb.address.fromHex(value.to_address) : '';
      return {
        hash: tx.txID,
        direction: sameAddress(address, to) ? 'in' : 'out',
        amount: String(value.amount || 0),
        counterparty: sameAddress(address, to) ? from : to,
        time: tx.block_timestamp,
        status: tx.ret?.[0]?.contractRet || 'confirmed'
      };
    });
  }

  async getTrc20Transactions(address, limit) {
    const search = new URLSearchParams({
      only_confirmed: 'true',
      limit: String(limit),
      contract_address: this.usdtTrc20Contract
    });
    const url = `${this.tronFullHost}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${search.toString()}`;
    const json = await this.tronFetch(url);
    return (json.data || []).map((tx) => {
      const from = tx.from || '';
      const to = tx.to || '';
      return {
        hash: tx.transaction_id,
        direction: sameAddress(address, to) ? 'in' : 'out',
        amount: String(tx.value || 0),
        counterparty: sameAddress(address, to) ? from : to,
        time: tx.block_timestamp,
        status: 'confirmed'
      };
    });
  }

  async getEthTransactions(address, limit) {
    if (!this.etherscanApiKey) {
      throw new Error('ETH/USDT-ERC20 歷史交易查詢需要設定 ETHERSCAN_API_KEY');
    }

    const json = await this.etherscanFetch({
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: String(limit),
      sort: 'desc'
    });

    return (json.result || []).map((tx) => ({
      hash: tx.hash,
      direction: sameAddress(address, tx.to) ? 'in' : 'out',
      amount: String(tx.value || 0),
      counterparty: sameAddress(address, tx.to) ? tx.from : tx.to,
      time: Number(tx.timeStamp) * 1000,
      status: tx.isError === '0' ? 'success' : 'failed'
    }));
  }

  async getErc20Transactions(address, limit, asset = 'usdt-erc20') {
    if (!this.etherscanApiKey) {
      throw new Error('ETH/ERC20 歷史交易查詢需要設定 ETHERSCAN_API_KEY');
    }

    const json = await this.etherscanFetch({
      module: 'account',
      action: 'tokentx',
      contractaddress: this.getErc20Contract(asset),
      address,
      page: '1',
      offset: String(limit),
      sort: 'desc'
    });

    return (json.result || []).map((tx) => ({
      hash: tx.hash,
      direction: sameAddress(address, tx.to) ? 'in' : 'out',
      amount: String(tx.value || 0),
      counterparty: sameAddress(address, tx.to) ? tx.from : tx.to,
      time: Number(tx.timeStamp) * 1000,
      status: 'success'
    }));
  }

  async getEthBlockTransactions(address, blockNumber) {
    const block = await withTimeout(
      this.ethProvider.getBlock(blockNumber, true),
      ETH_RPC_TIMEOUT_MS,
      'ETH block transaction query timed out'
    );
    const transactions = block?.prefetchedTransactions || [];
    return transactions
      .filter((tx) => sameAddress(address, tx.from) || sameAddress(address, tx.to))
      .map((tx) => ({
        hash: tx.hash,
        direction: sameAddress(address, tx.to) ? 'in' : 'out',
        amount: String(tx.value || 0),
        counterparty: sameAddress(address, tx.to) ? tx.from : tx.to,
        time: Number(block.timestamp) * 1000,
        status: 'pending block confirmation'
      }));
  }

  async getErc20BlockTransactions(address, blockNumber, asset = 'usdt-erc20') {
    const contract = new Contract(this.getErc20Contract(asset), ERC20_ABI, this.ethProvider);
    const logs = await withTimeout(
      contract.queryFilter(contract.filters.Transfer(), blockNumber, blockNumber),
      ETH_RPC_TIMEOUT_MS,
      `${assetName(asset)} block log query timed out`
    );
    const normalized = address.toLowerCase();

    return logs
      .map((log) => {
        const parsed = ERC20_IFACE.parseLog(log);
        return {
          hash: log.transactionHash,
          from: parsed.args.from,
          to: parsed.args.to,
          amount: String(parsed.args.value)
        };
      })
      .filter((tx) => tx.from.toLowerCase() === normalized || tx.to.toLowerCase() === normalized)
      .map((tx) => ({
        hash: tx.hash,
        direction: tx.to.toLowerCase() === normalized ? 'in' : 'out',
        amount: tx.amount,
        counterparty: tx.to.toLowerCase() === normalized ? tx.from : tx.to,
        time: null,
        status: 'confirmed'
      }));
  }

  async tronFetch(url, options = {}) {
    return this.enqueueTronFetch(() => this.doTronFetch(url, options));
  }

  getErc20Contract(asset) {
    if (asset === 'usdt-erc20') return this.usdtErc20Contract;
    if (asset === 'usdc-erc20') return this.usdcErc20Contract;
    throw new Error(`Unsupported ERC20 asset: ${asset}`);
  }

  async enqueueTronFetch(task) {
    const run = this.tronFetchQueue.then(async () => {
      const minGapMs = this.tronApiKey ? 250 : 2500;
      const waitMs = Math.max(0, minGapMs - (Date.now() - this.lastTronFetchAt));
      if (waitMs > 0) await sleep(waitMs);

      try {
        return await task();
      } catch (error) {
        if (isRateLimitError(error)) {
          await sleep(this.tronApiKey ? 1000 : 4500);
          return task();
        }

        throw error;
      } finally {
        this.lastTronFetchAt = Date.now();
      }
    });

    this.tronFetchQueue = run.catch(() => {});
    return run;
  }

  async doTronFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (this.tronApiKey) headers['TRON-PRO-API-KEY'] = this.tronApiKey;

    const response = await fetchWithTimeout(url, { ...options, headers }, DEFAULT_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`TRON API error ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async etherscanFetch(params) {
    const search = new URLSearchParams({
      ...params,
      apikey: this.etherscanApiKey
    });
    const response = await fetchWithTimeout(`${this.etherscanApiBase}?${search.toString()}`, {}, DEFAULT_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Etherscan API error ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    if (json.status === '0' && json.message !== 'No transactions found') {
      throw new Error(`Etherscan API error: ${json.result || json.message}`);
    }

    return json;
  }

  async tronscanFetch(path) {
    const response = await fetchWithTimeout(`${this.tronscanApiBase}${path}`, {}, DEFAULT_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Tronscan API error ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async getTronAccount(address) {
    const cacheKey = String(address);
    const cached = this.tronAccountCache.get(cacheKey);
    if (cached && Date.now() - cached.time < Math.max(this.tronPollMs, 5000)) {
      return cached.account;
    }

    const url = `${this.tronFullHost}/v1/accounts/${encodeURIComponent(address)}`;
    const json = await this.tronFetch(url);
    const account = Array.isArray(json.data) ? json.data[0] : null;
    this.tronAccountCache.set(cacheKey, { time: Date.now(), account });
    return account;
  }

  status() {
    return {
      startedAt: this.startedAt,
      ethEnabled: Boolean(this.ethProvider),
      lastEthBlock: this.lastEthBlock,
      tronPollMs: this.tronPollMs,
      usdtErc20Contract: this.usdtErc20Contract,
      usdtTrc20Contract: this.usdtTrc20Contract,
      usdcErc20Contract: this.usdcErc20Contract,
      etherscanEnabled: Boolean(this.etherscanApiKey),
      tronscanEnabled: Boolean(this.tronscanApiBase),
      watchers: this.store.listAll().length
    };
  }
}

function sameAddress(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function formatTxLine(asset, tx) {
  return [
    `- ${formatDirection(tx.direction)} ${tx.amount ? formatAssetBalance(asset, tx.amount) : ''}`.trim(),
    tx.counterparty ? `  對手方：${tx.counterparty}` : null,
    tx.hash ? `  交易哈希：${tx.hash}` : null,
    tx.time ? `  時間：${new Date(tx.time).toISOString()}` : null,
    tx.status ? `  狀態：${formatStatus(tx.status)}` : null
  ].filter(Boolean).join('\n');
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

function formatSource(source) {
  const text = String(source || '');
  if (text === 'poll') return '輪詢';
  if (text === 'manual check') return '手動檢查';
  if (text.startsWith('block ')) return `區塊 ${text.slice(6)}`;
  return text;
}

function isRateLimitError(error) {
  return /TRON API error 429|request rate exceeded/i.test(String(error?.message || error));
}

function isTronscanTokenMatch(token, contractAddress, symbol) {
  const tokenAddress = token.tokenId || token.token_id || token.contract_address || token.tokenAddress || token.address;
  if (tokenAddress && sameAddress(tokenAddress, contractAddress)) return true;

  const tokenSymbol = token.tokenAbbr || token.tokenSymbol || token.symbol || token.name;
  return String(tokenSymbol || '').toUpperCase() === String(symbol || '').toUpperCase();
}

function parseTronscanTokenBalance(token) {
  const raw = token.balance ?? token.amount ?? token.quantity ?? token.tokenValue;
  if (raw === null || raw === undefined || raw === '') return 0n;

  const text = String(raw);
  if (/^\d+$/.test(text)) return BigInt(text);

  const decimals = Number(token.tokenDecimal ?? token.decimals ?? token.precision ?? 6);
  return decimalToRawUnits(text, Number.isFinite(decimals) ? decimals : 6);
}

function decimalToRawUnits(value, decimals) {
  const text = String(value || '0').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return 0n;

  const [whole, fraction = ''] = text.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(`${whole}${paddedFraction}` || '0');
}

function encodeTronAddressParameter(hexAddress) {
  const withoutPrefix = String(hexAddress || '').replace(/^0x/i, '').replace(/^41/i, '');
  if (!/^[0-9a-fA-F]{40}$/.test(withoutPrefix)) {
    throw new Error('Invalid TRON address for contract call');
  }

  return withoutPrefix.padStart(64, '0');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = BalanceMonitor;
