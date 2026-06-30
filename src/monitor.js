const { Contract, Interface, WebSocketProvider } = require('ethers');
const TronWebPackage = require('tronweb');
const { assetName, formatDelta, formatAssetBalance } = require('./format');

const TronWeb = TronWebPackage.TronWeb || TronWebPackage.default || TronWebPackage;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];
const ERC20_IFACE = new Interface(ERC20_ABI);

class BalanceMonitor {
  constructor({
    store,
    bot,
    ethWsUrl,
    etherscanApiKey,
    tronFullHost,
    tronApiKey,
    tronPollMs,
    usdtErc20Contract,
    usdtTrc20Contract,
    logger
  }) {
    this.store = store;
    this.bot = bot;
    this.ethWsUrl = ethWsUrl;
    this.etherscanApiKey = etherscanApiKey;
    this.tronFullHost = tronFullHost.replace(/\/$/, '');
    this.tronApiKey = tronApiKey;
    this.tronPollMs = tronPollMs;
    this.usdtErc20Contract = usdtErc20Contract;
    this.usdtTrc20Contract = usdtTrc20Contract;
    this.logger = logger;
    this.ethProvider = null;
    this.tronWeb = null;
    this.tronTimer = null;
    this.startedAt = new Date();
    this.lastEthBlock = null;
    this.checkingEth = false;
    this.checkingTrx = false;
  }

  async start() {
    if (this.ethWsUrl) {
      await this.startEth();
    } else {
      this.logger.warn('ETH_WS_URL is not configured; Ethereum monitoring is disabled');
    }

    this.startTron();
  }

  async stop() {
    if (this.ethProvider) {
      await this.ethProvider.destroy();
    }

    if (this.tronTimer) {
      clearInterval(this.tronTimer);
    }
  }

  async startEth() {
    this.ethProvider = new WebSocketProvider(this.ethWsUrl);
    this.ethProvider.on('block', async (blockNumber) => {
      this.lastEthBlock = blockNumber;
      await this.checkEth(blockNumber);
    });
    this.ethProvider.websocket.on('close', () => {
      this.logger.error('Ethereum WebSocket closed; restart the process or use a process manager');
    });
    this.ethProvider.websocket.on('error', (error) => {
      this.logger.error({ error }, 'Ethereum WebSocket error');
    });
    this.logger.info('Ethereum monitor started');
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
        ...this.store.listByAsset('usdt-erc20')
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
      const watchers = [
        ...this.store.listByAsset('trx'),
        ...this.store.listByAsset('usdt-trc20')
      ];
      await Promise.allSettled(watchers.map(async (watcher) => {
        const asset = watcher.asset || watcher.chain;
        const balance = await this.getBalance(asset, watcher.address);
        await this.handleBalance(asset, watcher, balance, 'poll');
      }));
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
      if (!this.ethProvider) throw new Error('ETH provider is not configured');
      return this.ethProvider.getBalance(address);
    }

    if (asset === 'usdt-erc20') {
      if (!this.ethProvider) throw new Error('ETH provider is not configured');
      const contract = new Contract(this.usdtErc20Contract, ERC20_ABI, this.ethProvider);
      return contract.balanceOf(address);
    }

    if (asset === 'trx') {
      return this.getTrxBalance(address);
    }

    if (asset === 'usdt-trc20') {
      return this.getTrc20Balance(address, this.usdtTrc20Contract);
    }

    throw new Error(`Unsupported asset: ${asset}`);
  }

  async getTrxBalance(address) {
    const url = `${this.tronFullHost}/v1/accounts/${encodeURIComponent(address)}`;
    const headers = {};
    if (this.tronApiKey) headers['TRON-PRO-API-KEY'] = this.tronApiKey;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`TRON API error ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const account = Array.isArray(json.data) ? json.data[0] : null;
    return BigInt(account?.balance || 0);
  }

  async getTrc20Balance(address, contractAddress) {
    const account = await this.getTronAccount(address);
    const tokens = Array.isArray(account?.trc20) ? account.trc20 : [];
    const token = tokens.find((item) => {
      return Object.keys(item)[0] === contractAddress;
    });

    if (!token) return 0n;

    return BigInt(token[contractAddress] || 0);
  }

  async getTransactions(asset, address, limit = 5) {
    if (asset === 'trx') return this.getTrxTransactions(address, limit);
    if (asset === 'usdt-trc20') return this.getTrc20Transactions(address, limit);
    if (asset === 'eth') return this.getEthTransactions(address, limit);
    if (asset === 'usdt-erc20') return this.getErc20Transactions(address, limit);
    throw new Error(`Unsupported asset: ${asset}`);
  }

  async getChangeTransactions(asset, address, blockNumber) {
    if (asset === 'trx') return this.getTrxTransactions(address, 3);
    if (asset === 'usdt-trc20') return this.getTrc20Transactions(address, 3);
    if (asset === 'eth' && blockNumber) return this.getEthBlockTransactions(address, blockNumber);
    if (asset === 'usdt-erc20' && blockNumber) return this.getErc20BlockTransactions(address, blockNumber);
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

  async getErc20Transactions(address, limit) {
    if (!this.etherscanApiKey) {
      throw new Error('ETH/USDT-ERC20 歷史交易查詢需要設定 ETHERSCAN_API_KEY');
    }

    const json = await this.etherscanFetch({
      module: 'account',
      action: 'tokentx',
      contractaddress: this.usdtErc20Contract,
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
    const block = await this.ethProvider.getBlock(blockNumber, true);
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

  async getErc20BlockTransactions(address, blockNumber) {
    const contract = new Contract(this.usdtErc20Contract, ERC20_ABI, this.ethProvider);
    const logs = await contract.queryFilter(contract.filters.Transfer(), blockNumber, blockNumber);
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

  async tronFetch(url) {
    const headers = {};
    if (this.tronApiKey) headers['TRON-PRO-API-KEY'] = this.tronApiKey;

    const response = await fetch(url, { headers });
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
    const response = await fetch(`https://api.etherscan.io/api?${search.toString()}`);
    if (!response.ok) {
      throw new Error(`Etherscan API error ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    if (json.status === '0' && json.message !== 'No transactions found') {
      throw new Error(`Etherscan API error: ${json.result || json.message}`);
    }

    return json;
  }

  async getTronAccount(address) {
    const url = `${this.tronFullHost}/v1/accounts/${encodeURIComponent(address)}`;
    const headers = {};
    if (this.tronApiKey) headers['TRON-PRO-API-KEY'] = this.tronApiKey;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`TRON API error ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    return Array.isArray(json.data) ? json.data[0] : null;
  }

  status() {
    return {
      startedAt: this.startedAt,
      ethEnabled: Boolean(this.ethProvider),
      lastEthBlock: this.lastEthBlock,
      tronPollMs: this.tronPollMs,
      usdtErc20Contract: this.usdtErc20Contract,
      usdtTrc20Contract: this.usdtTrc20Contract,
      etherscanHistoryEnabled: Boolean(this.etherscanApiKey),
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

module.exports = BalanceMonitor;
