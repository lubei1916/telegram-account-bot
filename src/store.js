const fs = require('fs');
const path = require('path');

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { watchers: [] };
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8');
    this.data = raw.trim() ? JSON.parse(raw) : { watchers: [] };
    if (!Array.isArray(this.data.watchers)) this.data.watchers = [];
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }

  list(chatId) {
    return this.data.watchers.filter((watcher) => String(watcher.chatId) === String(chatId));
  }

  listAll() {
    return [...this.data.watchers];
  }

  listByAsset(asset) {
    return this.data.watchers.filter((watcher) => normalizeAsset(watcher) === asset);
  }

  find(chatId, asset, address) {
    const normalized = normalizeAddress(asset, address);
    return this.data.watchers.find((watcher) => {
      return String(watcher.chatId) === String(chatId)
        && normalizeAsset(watcher) === asset
        && normalizeAddress(asset, watcher.address) === normalized;
    });
  }

  add({ chatId, asset, address, label, lastBalance }) {
    const existing = this.find(chatId, asset, address);
    if (existing) {
      existing.asset = asset;
      delete existing.chain;
      existing.label = label || existing.label;
      existing.lastBalance = String(lastBalance);
      existing.updatedAt = new Date().toISOString();
      this.save();
      return { watcher: existing, created: false };
    }

    const watcher = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      chatId: String(chatId),
      asset,
      address,
      label: label || '',
      lastBalance: String(lastBalance),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.data.watchers.push(watcher);
    this.save();
    return { watcher, created: true };
  }

  remove(chatId, asset, address) {
    const before = this.data.watchers.length;
    const normalized = normalizeAddress(asset, address);

    this.data.watchers = this.data.watchers.filter((watcher) => {
      return !(String(watcher.chatId) === String(chatId)
        && normalizeAsset(watcher) === asset
        && normalizeAddress(asset, watcher.address) === normalized);
    });

    const removed = before - this.data.watchers.length;
    if (removed > 0) this.save();
    return removed;
  }

  removeById(chatId, watcherId) {
    const before = this.data.watchers.length;

    this.data.watchers = this.data.watchers.filter((watcher) => {
      return !(String(watcher.chatId) === String(chatId) && watcher.id === watcherId);
    });

    const removed = before - this.data.watchers.length;
    if (removed > 0) this.save();
    return removed;
  }

  updateBalance(watcherId, balance) {
    const watcher = this.data.watchers.find((item) => item.id === watcherId);
    if (!watcher) return null;

    watcher.lastBalance = String(balance);
    watcher.updatedAt = new Date().toISOString();
    this.save();
    return watcher;
  }
}

function normalizeAsset(watcher) {
  return watcher.asset || watcher.chain;
}

function normalizeAddress(asset, address) {
  if (asset === 'eth' || asset === 'usdt-erc20') return String(address).toLowerCase();
  return String(address);
}

module.exports = Store;
