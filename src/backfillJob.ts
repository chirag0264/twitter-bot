import { searchLatest } from './twitterClient';
import { normalizeTweetsFromSearch } from './normalizeTweet';
import { deduplicateAndInsert } from './deduplicate';
import { runSlowPathOnce } from './slowPathJob';

function formatUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )}_${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(
    d.getUTCSeconds()
  )}_UTC`;
}

export async function runBackfillOnce(hours: number): Promise<void> {
  const now = new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const sinceStr = formatUtc(since);
  const untilStr = formatUtc(now);

  console.log(
    `[backfill] Window: ${sinceStr} -> ${untilStr} (${hours}h back)`
  );

  const data = await searchLatest({
    sinceStr,
    untilStr,
  });

  const normalized = normalizeTweetsFromSearch(data);
  console.log(
    `[backfill] Found ${normalized.length} tweets from API in backfill window`
  );

  const normalizedTweetIds = normalized.map((t) => t.tweetId);
  if (normalizedTweetIds.includes('2016145532821918064')) {
    console.log(`[backfill] ✅ Target tweet 2016145532821918064 found in normalized results`);
  } else {
    console.log(`[backfill] ❌ Target tweet 2016145532821918064 NOT in normalized results`);
  }

  const inserted = await deduplicateAndInsert(normalized);
  console.log(`[backfill] Inserted ${inserted} new tweets into Mongo`);

  // Run slow path once to process any new unprocessed tweets
  await runSlowPathOnce();
}

