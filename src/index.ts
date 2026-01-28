import { getDb } from './mongo';
import { runPullTweetsOnce } from './pullTweetsJob';
import { runSilentWatchdogOnce } from './silentWatchdogJob';
import { runSlowPathOnce } from './slowPathJob';
import cron from 'node-cron';
import { config } from './config';

async function main() {
  const db = await getDb();
  const collections = await db.collections();

  console.log(
    `[twitter-bot] Connected to MongoDB database "${db.databaseName}". Existing collections: ${collections
      .map((c: { collectionName: any; }) => c.collectionName)
      .join(', ') || '(none)'}`
  );

  // Run immediately once on startup
  await runPullTweetsOnce();
  await runSilentWatchdogOnce();
  await runSlowPathOnce();

  // Schedule fast path (pull tweets) + watchdog on CRON_INTERVAL_MINUTES
  const fastPathMinutes = Math.max(1, Math.floor(config.cronIntervalMinutes || 3));
  const fastPathExpr = `*/${fastPathMinutes} * * * *`;

  console.log(
    `[scheduler] Fast path (pull tweets + watchdog): every ${fastPathMinutes} minute(s) - "${fastPathExpr}"`
  );

  cron.schedule(fastPathExpr, async () => {
    try {
      console.log('[scheduler] Fast path tick: running pull tweets + watchdog');
      await runPullTweetsOnce();
      await runSilentWatchdogOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in fast path:', err);
    }
  });

  // Schedule slow path (process tweets) more frequently - every 1-2 minutes
  // This ensures tweets get analyzed quickly after ingestion
  const slowPathMinutes = Math.max(1, Math.floor(config.slowPathIntervalMinutes || 2));
  const slowPathExpr = `*/${slowPathMinutes} * * * *`;

  console.log(
    `[scheduler] Slow path (analyze tweets): every ${slowPathMinutes} minute(s) - "${slowPathExpr}"`
  );

  cron.schedule(slowPathExpr, async () => {
    try {
      console.log('[scheduler] Slow path tick: running tweet analysis');
      await runSlowPathOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in slow path:', err);
    }
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`[twitter-bot] Received ${signal}, shutting down gracefully...`);
    // Give cron jobs a moment to finish if they're running
    await new Promise((resolve) => setTimeout(resolve, 2000));
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('[twitter-bot] ✅ Started successfully. Press Ctrl+C to stop.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[twitter-bot] Fatal error:', err);
  process.exit(1);
});

