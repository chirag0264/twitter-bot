# Twitter Breaking News Bot

Node.js/TypeScript backend for monitoring Twitter accounts and detecting breaking crypto/macro news using Grok LLM.

## Features

- **Fast Path**: Pulls tweets from Twitter API with pagination support
- **Slow Path**: Analyzes tweets with Grok LLM to detect breaking news
- **Watchdog**: Monitors for silent periods and sends alerts
- **MongoDB**: All data stored in MongoDB (tweets, alerts, analyses)
- **Telegram**: Sends breaking news alerts to Telegram

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file in the project root:

```bash
# Required
MONGO_URI="mongodb+srv://user:pass@host/db?options"
MONGO_DB_NAME="twitterbot"
TWITTERAPI_IO_API_KEY="your_twitterapi_io_key"
GROK_API_KEY="your_grok_api_key"
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"

# Optional (with defaults)
PRIORITY_ACCOUNTS="deitaone"  # Comma-separated list
NORMAL_ACCOUNTS=""            # Comma-separated list
TELEGRAM_WATCHDOG_CHAT_ID="1285567245"
TELEGRAM_ALERT_CHAT_ID="-1003449247259"
WATCHDOG_SILENT_HOURS="2"
WATCHDOG_ALERT_COOLDOWN_MINUTES="60"
CRON_INTERVAL_MINUTES="3"           # Fast path interval
SLOW_PATH_INTERVAL_MINUTES="2"      # Slow path interval
GROK_TEMPERATURE="0"                # Grok temperature (0-1)
GROK_TOP_P="1"                      # Grok top_p (0-1)
```

### 3. Build

```bash
npm run build
```

### 4. Run

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

**One-time backfill:**
```bash
BACKFILL_HOURS=24 npm run backfill
```

**Manual slow path:**
```bash
npm run slow-path
```

## Production Deployment

### Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start the app
pm2 start dist/index.js --name twitter-bot

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

### Using systemd

Create `/etc/systemd/system/twitter-bot.service`:

```ini
[Unit]
Description=Twitter Breaking News Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/path/to/backend-twitter-bot
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable twitter-bot
sudo systemctl start twitter-bot
sudo systemctl status twitter-bot
```

## Architecture

- **Fast Path** (every 3 min by default): Pulls new tweets from Twitter API
- **Slow Path** (every 2 min by default): Analyzes unprocessed tweets with Grok
- **Watchdog**: Checks for silent periods and sends alerts

## MongoDB Collections

- `tweets`: All ingested tweets (with `processed` flag)
- `alerts`: Breaking news alerts sent to Telegram
- `analyses`: Full Grok analysis results for debugging
- `metadata`: Checkpoints and watchdog state

## Monitoring

Check logs:
```bash
# PM2
pm2 logs twitter-bot

# systemd
sudo journalctl -u twitter-bot -f
```

## Troubleshooting

- **429 Rate Limit**: Twitter API free tier allows 1 request per 5 seconds. Pagination automatically waits 6 seconds between pages.
- **Missing tweets**: Check timezone - tweets are queried in UTC.
- **No breaking alerts**: Check `analyses` collection to see what Grok returned.
