const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

class CurlTelegramBot {
  constructor(token, logger, options = {}) {
    this.token = token;
    this.logger = logger;
    this.commands = new Map();
    this.textHandlers = [];
    this.middlewares = [];
    this.errorHandler = null;
    this.running = false;
    this.offsetPath = options.offsetPath || '';
    this.offset = this.loadOffset();
    this.updateTimeoutMs = Number(options.updateTimeoutMs || 45_000);
    this.watchdogMs = Number(options.watchdogMs || 120_000);
    this.watchdogTimer = null;
    this.lastPollProgressAt = Date.now();
    this.telegram = {
      sendMessage: (chatId, text, options = {}) => {
        const payload = {
          chat_id: chatId,
          text,
          disable_web_page_preview: Boolean(options.disable_web_page_preview)
        };

        if (options.reply_markup) payload.reply_markup = options.reply_markup;
        return this.callApi('sendMessage', payload, 20);
      },
      setMyCommands: (commands) => {
        return this.callApi('setMyCommands', { commands }, 15);
      }
    };
  }

  use(fn) {
    this.middlewares.push(fn);
  }

  start(fn) {
    this.command('start', fn);
  }

  help(fn) {
    this.command('help', fn);
  }

  command(name, fn) {
    this.commands.set(name, fn);
  }

  onText(fn) {
    this.textHandlers.push(fn);
  }

  catch(fn) {
    this.errorHandler = fn;
  }

  async launch() {
    const me = await this.callApi('getMe', {}, 15);
    await this.syncOffset();
    this.running = true;
    this.startWatchdog();
    this.logger.info({ username: me.result.username }, 'Telegram curl polling started');
    this.pollLoop();
  }

  async stop() {
    this.running = false;
    this.stopWatchdog();
  }

  async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.callApi('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message']
        }, 35);
        this.markPollProgress('getUpdates completed');

        for (const update of updates.result || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.saveOffset();
          try {
            await withTimeout(
              this.handleUpdate(update),
              this.updateTimeoutMs,
              `Telegram update ${update.update_id} handling timed out after ${this.updateTimeoutMs} ms`
            );
            this.markPollProgress('update handled');
          } catch (error) {
            this.logger.error({ error: error.message, updateId: update.update_id }, 'Telegram update handling failed');
          }
        }
      } catch (error) {
        this.logger.error({ error: error.message }, 'Telegram polling failed');
        this.markPollProgress('polling error handled');
        await sleep(3000);
      }
    }
  }

  startWatchdog() {
    if (!Number.isFinite(this.watchdogMs) || this.watchdogMs <= 0) {
      this.logger.warn({ watchdogMs: this.watchdogMs }, 'Telegram polling watchdog is disabled');
      return;
    }

    this.stopWatchdog();
    this.lastPollProgressAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      const staleMs = Date.now() - this.lastPollProgressAt;
      if (!this.running || staleMs <= this.watchdogMs) return;

      this.logger.fatal({ staleMs, watchdogMs: this.watchdogMs }, 'Telegram polling watchdog timed out; exiting for platform restart');
      process.exit(1);
    }, Math.max(10_000, Math.floor(this.watchdogMs / 3)));
    this.watchdogTimer.unref?.();
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  markPollProgress(reason) {
    this.lastPollProgressAt = Date.now();
    this.logger.debug({ reason }, 'Telegram polling progress');
  }

  async handleUpdate(update) {
    const message = update.message;
    if (!message?.text) return;

    const commandName = parseCommandName(message.text);
    const ctx = {
      update,
      message,
      chat: message.chat,
      from: message.from,
      telegram: this.telegram,
      reply: (text, options = {}) => this.telegram.sendMessage(message.chat.id, text, options)
    };

    try {
      if (!commandName) {
        await this.runMiddlewares(ctx, async () => {
          for (const handler of this.textHandlers) await handler(ctx);
        });
        return;
      }

      const handler = this.commands.get(commandName);
      if (!handler) return;

      await this.runMiddlewares(ctx, () => handler(ctx));
    } catch (error) {
      if (this.errorHandler) {
        await this.errorHandler(error, ctx);
      } else {
        throw error;
      }
    }
  }

  async runMiddlewares(ctx, finalHandler) {
    let index = -1;
    const dispatch = async (nextIndex) => {
      if (nextIndex <= index) throw new Error('next() called multiple times');
      index = nextIndex;
      const fn = this.middlewares[nextIndex] || finalHandler;
      if (!fn) return;
      await fn(ctx, () => dispatch(nextIndex + 1));
    };

    await dispatch(0);
  }

  async callApi(method, payload, timeoutSeconds) {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const args = [
      '-sS',
      '--fail-with-body',
      '--connect-timeout',
      '10',
      '--max-time',
      String(timeoutSeconds),
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '--data',
      JSON.stringify(payload),
      url
    ];

    const stdout = await execCurl(args, timeoutSeconds * 1000 + 2000);
    const json = JSON.parse(stdout);
    if (!json.ok) throw new Error(`Telegram API ${method} failed: ${JSON.stringify(json)}`);
    return json;
  }

  async syncOffset() {
    if (this.offset > 0) return;

    const updates = await this.callApi('getUpdates', {
      offset: -1,
      timeout: 0,
      allowed_updates: ['message']
    }, 15);
    const latest = updates.result?.[0]?.update_id;
    if (typeof latest === 'number') {
      this.offset = latest + 1;
      await this.callApi('getUpdates', {
        offset: this.offset,
        timeout: 0,
        allowed_updates: ['message']
      }, 15);
      this.saveOffset();
    }
  }

  loadOffset() {
    if (!this.offsetPath) return 0;

    try {
      if (!fs.existsSync(this.offsetPath)) return 0;
      const raw = fs.readFileSync(this.offsetPath, 'utf8');
      const json = raw.trim() ? JSON.parse(raw) : {};
      return Number(json.offset || 0);
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Failed to load Telegram offset');
      return 0;
    }
  }

  saveOffset() {
    if (!this.offsetPath) return;

    try {
      fs.mkdirSync(path.dirname(this.offsetPath), { recursive: true });
      const tmpPath = `${this.offsetPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ offset: this.offset }, null, 2));
      fs.renameSync(tmpPath, this.offsetPath);
    } catch (error) {
      this.logger.warn({ error: error.message }, 'Failed to save Telegram offset');
    }
  }
}

function parseCommandName(text) {
  const match = String(text).trim().match(/^\/([A-Za-z0-9_]+)(?:@\S+)?(?:\s|$)/);
  return match ? match[1].toLowerCase() : null;
}

function execCurl(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve(stdout);
    });
  });
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

module.exports = CurlTelegramBot;
