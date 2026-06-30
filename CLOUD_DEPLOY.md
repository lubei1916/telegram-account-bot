# Cloud Deployment

這個 bot 是長駐背景程序，部署時請選 Background Worker、Worker、Service 或 VPS，不要選靜態網站。

## 必填環境變數

```env
TELEGRAM_BOT_TOKEN=你的 Telegram bot token
ETH_WS_URL=wss://你的以太坊 WebSocket RPC
ETHERSCAN_API_KEY=你的 Etherscan API Key，用於查 ETH/ERC20 歷史交易
TRON_FULL_HOST=https://api.trongrid.io
TRON_API_KEY=你的 TronGrid API Key
USDT_ERC20_CONTRACT=0xdAC17F958D2ee523a2206206994597C13D831ec7
USDT_TRC20_CONTRACT=TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj
TRON_POLL_MS=3000
STORAGE_PATH=/app/data/watchers.json
LOG_LEVEL=info
```

`ADMIN_USER_IDS` 建議上線後設定，只允許你的 Telegram user ID 操作 bot。

## Railway

1. 把這個專案推到 GitHub。
2. Railway 建立 New Project，選 Deploy from GitHub repo。
3. Railway 會偵測 Dockerfile 並部署。
4. 到 Variables 填入上面的環境變數。
5. 如果要保存監控列表，建立 Volume 並掛到 `/app/data`。

## Render

1. 把這個專案推到 GitHub。
2. Render 建立 Background Worker。
3. Environment 選 Docker。
4. 填入上面的環境變數。
5. 如果要保存監控列表，使用 Persistent Disk 掛到 `/app/data`。

## VPS / Oracle Cloud / AWS Lightsail

在伺服器上：

```bash
git clone 你的repo
cd telegram-chain-balance-bot
cp .env.example .env
nano .env
docker build -t chain-balance-bot .
docker run -d --restart unless-stopped --name chain-balance-bot --env-file .env -v "$PWD/data:/app/data" chain-balance-bot
```

查看 log：

```bash
docker logs -f chain-balance-bot
```

停止：

```bash
docker stop chain-balance-bot
```
