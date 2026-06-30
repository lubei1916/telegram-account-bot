# Telegram ETH/TRX Balance Monitor Bot

一個可以監控 TRX、ETH、USDT-TRC20、USDT-ERC20 地址餘額變動的 Telegram 機器人。

- ETH：使用 WebSocket provider 訂閱新區塊，每個新區塊檢查監控地址餘額。
- ERC20：跟 ETH 一樣在每個以太坊新區塊檢查 `balanceOf`。
- TRX/TRC20：使用 TronGrid/API 快速輪詢帳戶餘額，預設每 3 秒一次。
- 支援多個 Telegram chat 各自新增監控地址。
- 監控資料會保存到本地 JSON 檔，重啟後不會丟失。

## 安裝

```bash
pnpm install
cp .env.example .env
```

編輯 `.env`：

```env
TELEGRAM_BOT_TOKEN=你的 Telegram Bot Token
ETH_WS_URL=wss://你的以太坊 WebSocket RPC
ETHERSCAN_API_KEY=你的 Etherscan API Key，用於查 ETH/ERC20 歷史交易
TRON_FULL_HOST=https://api.trongrid.io
TRON_API_KEY=你的 TronGrid API Key，可留空但容易被限流
USDT_ERC20_CONTRACT=0xdAC17F958D2ee523a2206206994597C13D831ec7
USDT_TRC20_CONTRACT=TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj
TRON_POLL_MS=3000
```

啟動：

```bash
pnpm start
```

如果你習慣 `npm`，也可以用 `npm install && npm start`。

## Telegram 指令

```text
/start
/help
/addall T地址 0x地址 備註
/add trx T地址 備註
/add eth 0x地址 備註
/add usdt-trc20 T地址 備註
/add usdt-erc20 0x地址 備註
/removeall T地址 0x地址
/remove trx T地址
/remove eth 0x地址
/remove usdt-trc20 T地址
/remove usdt-erc20 0x地址
/list
/balance trx T地址
/balance eth 0x地址
/balance usdt-trc20 T地址
/balance usdt-erc20 0x地址
/tx trx T地址
/tx usdt-trc20 T地址
/tx eth 0x地址
/tx usdt-erc20 0x地址
/status
```

例子：

```text
/addall TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj 0x742d35Cc6634C0532925a3b844Bc454e4438f44e main wallets
/add trx TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj tron account
/add usdt-trc20 TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj tron usdt
/add eth 0x742d35Cc6634C0532925a3b844Bc454e4438f44e eth wallet
/add usdt-erc20 0x742d35Cc6634C0532925a3b844Bc454e4438f44e eth usdt
```

如果你要同時收到四個幣種通知，最簡單就是用：

```text
/addall 你的T地址 你的0x地址 備註
```

它會一次加入 `TRX`、`USDT-TRC20`、`ETH`、`USDT-ERC20` 四個監控項。

菜單按鈕也支援：

- 查餘額
- 查交易紀錄
- 動帳通知附最近交易詳情

注意：TRX/USDT-TRC20 交易紀錄直接走 TronGrid。ETH/USDT-ERC20 歷史交易紀錄需要 `ETHERSCAN_API_KEY`，否則只能在新區塊動帳通知時附上本次區塊內找到的交易詳情。

## 實時性說明

ETH/ERC20 的通知速度取決於以太坊出塊與你的 WebSocket RPC 延遲。TRX/TRC20 主網常見公開 API 不提供像 ETH JSON-RPC WebSocket 那樣的帳戶餘額推送，所以本 bot 用短間隔輪詢模擬近實時監控。你可以把 `TRON_POLL_MS` 調低，例如 `1000`，但太低可能觸發 API 限流。

如果你的重點是 TRX/USDT-TRC20，建議配置 `TRON_API_KEY`，並把 `TRON_POLL_MS` 設在 `1000` 到 `3000` 之間。監控地址很多時請適當加大間隔，或使用私有 TRON full node。

## 部署建議

生產環境建議用 `pm2` 或 Docker 長駐：

```bash
npm install -g pm2
pm2 start src/index.js --name chain-balance-bot
pm2 save
```

或使用 Docker：

```bash
docker build -t chain-balance-bot .
docker run -d --name chain-balance-bot --env-file .env -v "$PWD/data:/app/data" chain-balance-bot
```
