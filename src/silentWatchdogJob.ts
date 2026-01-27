import { getDb } from './mongo';
import { sendTelegramMessage } from './telegramClient';
import { config } from './config';

interface WatchdogState {
  _id: string;
  lastAlertAt?: string;
}

const WATCHDOG_STATE_ID = 'silentWatchdogState';

export async function runSilentWatchdogOnce(): Promise<void> {
  const db = await getDb();
  const tweets = db.collection('tweets');
  const meta = db.collection<WatchdogState>('metadata');

  const latest = await tweets
    .find(
      {},
      {
        projection: { ingestedAt: 1, tweetId: 1, timestamp: 1 },
        sort: { ingestedAt: -1 },
        limit: 1,
      }
    )
    .next();

  const now = new Date();

  // Load last alert time to enforce cooldown
  const state = await meta.findOne({ _id: WATCHDOG_STATE_ID });
  const lastAlertAt = state?.lastAlertAt
    ? new Date(state.lastAlertAt)
    : undefined;
  const cooldownMs = config.watchdogAlertCooldownMinutes * 60 * 1000;

  const withinCooldown =
    lastAlertAt && now.getTime() - lastAlertAt.getTime() < cooldownMs;

  if (!latest) {
    console.log(
      '[watchdog] No tweets ingested yet; skipping silent-alert Telegram message'
    );
    return;
  }

  const lastIngested = new Date(
    latest.ingestedAt || latest.timestamp || now.toISOString()
  );
  const diffMs = now.getTime() - lastIngested.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);

  const silentHours = config.watchdogSilentHours;

  if (diffHours <= silentHours) {
    console.log(
      `[watchdog] OK: last tweet at ${lastIngested.toISOString()} (${diffHours.toFixed(
        2
      )}h ago)`
    );
    return;
  }

  if (!config.telegramWatchdogChatId) {
    console.warn(
      '[watchdog] TELEGRAM_WATCHDOG_CHAT_ID not set; skipping alert'
    );
    return;
  }

  if (withinCooldown) {
    console.log(
      '[watchdog] Skipping alert (cooldown active, silent but recently alerted)'
    );
    return;
  }

  const text =
    `🚨 ALERT: No tweets received in over ${silentHours} hours!\n\n` +
    `Last tweet timestamp: ${lastIngested.toISOString()}\n` +
    `Last tweetId: ${latest.tweetId ?? 'unknown'}\n\n` +
    'Rule might be stuck — check twitterapi.io dashboard.';

  await sendTelegramMessage({ chatId: config.telegramWatchdogChatId, text });

  await meta.updateOne(
    { _id: WATCHDOG_STATE_ID },
    { $set: { lastAlertAt: now.toISOString() } },
    { upsert: true }
  );
}

