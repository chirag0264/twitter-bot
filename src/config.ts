import dotenv from 'dotenv';

dotenv.config();

type EnvKey =
  | 'MONGO_URI'
  | 'MONGO_DB_NAME'
  | 'TWITTERAPI_IO_API_KEY'
  | 'GROK_API_KEY'
  | 'TELEGRAM_BOT_TOKEN'
  | 'CRON_INTERVAL_MINUTES'
  | 'SLOW_PATH_INTERVAL_MINUTES';

function requireEnv(key: EnvKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
}

function parseAccountList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const config = {
  mongoUri: requireEnv('MONGO_URI'),
  mongoDbName: requireEnv('MONGO_DB_NAME'),
  twitterApiKey: process.env.TWITTERAPI_IO_API_KEY ?? '',
  grokApiKey: process.env.GROK_API_KEY ?? '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  // Business-configurable values
  priorityAccounts: parseAccountList(process.env.PRIORITY_ACCOUNTS),
  normalAccounts: parseAccountList(process.env.NORMAL_ACCOUNTS),
  telegramWatchdogChatId: process.env.TELEGRAM_WATCHDOG_CHAT_ID ?? '',
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID ?? '',
  watchdogSilentHours: Number(process.env.WATCHDOG_SILENT_HOURS ?? '2'),
  cronIntervalMinutes: Number(process.env.CRON_INTERVAL_MINUTES ?? '3'),
  slowPathIntervalMinutes: Number(process.env.SLOW_PATH_INTERVAL_MINUTES ?? '2'),
  watchdogAlertCooldownMinutes: Number(
    process.env.WATCHDOG_ALERT_COOLDOWN_MINUTES ?? '60'
  ),
};

