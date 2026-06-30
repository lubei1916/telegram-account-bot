const { formatEther, formatUnits } = require('ethers');

const ASSETS = {
  trx: {
    id: 'trx',
    chain: 'tron',
    name: 'TRX',
    symbol: 'TRX',
    decimals: 6
  },
  eth: {
    id: 'eth',
    chain: 'ethereum',
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18
  },
  'usdt-trc20': {
    id: 'usdt-trc20',
    chain: 'tron',
    name: 'USDT-TRC20',
    symbol: 'USDT',
    decimals: 6
  },
  'usdt-erc20': {
    id: 'usdt-erc20',
    chain: 'ethereum',
    name: 'USDT-ERC20',
    symbol: 'USDT',
    decimals: 6
  },
  'usdc-erc20': {
    id: 'usdc-erc20',
    chain: 'ethereum',
    name: 'USDC-ERC20',
    symbol: 'USDC',
    decimals: 6
  }
};

function formatAssetBalance(assetId, value) {
  const asset = ASSETS[assetId];
  if (!asset) throw new Error(`Unsupported asset: ${assetId}`);

  if (asset.decimals === 18) {
    return `${trimDecimals(formatEther(value), 8)} ETH`;
  }

  const formatted = formatUnits(value, asset.decimals);
  return `${trimDecimals(formatted, asset.decimals)} ${asset.symbol}`;
}

function formatDelta(assetId, before, after) {
  const delta = BigInt(after) - BigInt(before);
  const sign = delta > 0n ? '+' : '';
  return `${sign}${formatAssetBalance(assetId, delta)}`;
}

function trimDecimals(value, maxDecimals) {
  if (!value.includes('.')) return value;

  const [whole, fraction] = value.split('.');
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function normalizeAsset(asset) {
  const normalized = String(asset || '').trim().toLowerCase();
  if (normalized === 'eth' || normalized === 'ethereum') return 'eth';
  if (normalized === 'trx' || normalized === 'tron') return 'trx';
  if (normalized === 'usdt-trc20' || normalized === 'trc20' || normalized === 'tron-usdt') return 'usdt-trc20';
  if (normalized === 'usdt-erc20' || normalized === 'erc20' || normalized === 'eth-usdt') return 'usdt-erc20';
  if (normalized === 'usdc-erc20' || normalized === 'eth-usdc' || normalized === 'usdc') return 'usdc-erc20';
  return null;
}

function assetName(assetId) {
  return ASSETS[assetId]?.name || assetId;
}

module.exports = {
  ASSETS,
  assetName,
  formatDelta,
  formatAssetBalance,
  normalizeAsset
};
