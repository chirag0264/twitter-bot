import { getDb } from './mongo';
import { runBackfillOnce } from './backfillJob';

async function main() {
  await getDb(); // ensure connection

  const hoursEnv = process.env.BACKFILL_HOURS;
  const hours = hoursEnv ? Number(hoursEnv) : 12;

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `Invalid BACKFILL_HOURS value "${hoursEnv}". It must be a positive number.`
    );
  }

  await runBackfillOnce(hours);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill] Fatal error:', err);
  process.exit(1);
});

