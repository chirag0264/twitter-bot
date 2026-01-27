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

  // Then schedule based on CRON_INTERVAL_MINUTES (default: 3 minutes)
  const minutes = Math.max(1, Math.floor(config.cronIntervalMinutes || 3));
  const expr = `*/${minutes} * * * *`;

  console.log(
    `[scheduler] Starting cron with interval ${minutes} minute(s): "${expr}"`
  );

  cron.schedule(expr, async () => {
    try {
      console.log('[scheduler] Tick: running pull + slow path + watchdog');
      await runPullTweetsOnce();
      await runSilentWatchdogOnce();
      await runSlowPathOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in scheduled run:', err);
    }
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[twitter-bot] Fatal error:', err);
  process.exit(1);
});

