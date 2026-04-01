import { getDb } from './mongo';
import { runPullTweetsOnce } from './pullTweetsJob';
import { runTruthSocialIngestWithFallback } from './civicTrackerIngestJob';
import { runSilentWatchdogOnce } from './silentWatchdogJob';
import { runSlowPathOnce } from './slowPathJob';
import { runArchiveEnrichOnce } from './archiveEnrichJob';
import { runTruthSocialAnalysisOnce } from './truthSocialAnalysisJob';
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
  try {
    await runTruthSocialIngestWithFallback();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[twitter-bot] Truth Social ingest on startup:', err);
  }
  await runArchiveEnrichOnce();
  await runSilentWatchdogOnce();
  await runSlowPathOnce();
  await runTruthSocialAnalysisOnce();

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

  const truthMinutes = Math.max(
    1,
    Math.floor(config.truthSocialPollMinutes || 3)
  );
  const truthExpr = `*/${truthMinutes} * * * *`;
  console.log(
    `[scheduler] Truth Social ingest (CivicTracker primary / RSS fallback): every ${truthMinutes} minute(s) - "${truthExpr}"`
  );

  cron.schedule(truthExpr, async () => {
    try {
      await runTruthSocialIngestWithFallback();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in Truth Social ingest:', err);
    }
  });

  // Archive enrichment: runs slightly more often than ingest so media posts get
  // descriptions before the analysis job picks them up.
  const enrichMinutes = Math.max(1, Math.min(truthMinutes, 3));
  const enrichExpr = `*/${enrichMinutes} * * * *`;
  console.log(
    `[scheduler] Archive enrichment: every ${enrichMinutes} minute(s) - "${enrichExpr}"`
  );

  cron.schedule(enrichExpr, async () => {
    try {
      await runArchiveEnrichOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in archive enrich:', err);
    }
  });

  // Truth Social analysis: separate from Twitter slow-path
  const tsAnalysisMinutes = Math.max(1, Math.floor(config.slowPathIntervalMinutes || 2));
  const tsAnalysisExpr = `*/${tsAnalysisMinutes} * * * *`;
  console.log(
    `[scheduler] Truth Social analysis: every ${tsAnalysisMinutes} minute(s) - "${tsAnalysisExpr}"`
  );

  cron.schedule(tsAnalysisExpr, async () => {
    try {
      await runTruthSocialAnalysisOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] Error in Truth Social analysis:', err);
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

