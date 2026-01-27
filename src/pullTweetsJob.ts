import { buildTimeWindow, updateCheckpoint } from './timeWindow';
import { searchLatest } from './twitterClient';
import { normalizeTweetsFromSearch } from './normalizeTweet';
import { deduplicateAndInsert } from './deduplicate';

export async function runPullTweetsOnce(): Promise<void> {
  const window = await buildTimeWindow();

  console.log(
    `[pull] Window: ${window.sinceStr} -> ${window.untilStr}`
  );

  const data = await searchLatest({
    sinceStr: window.sinceStr,
    untilStr: window.untilStr,
  });

  const normalized = normalizeTweetsFromSearch(data);
  console.log(`[pull] Found ${normalized.length} tweets from API`);

  const inserted = await deduplicateAndInsert(normalized);
  console.log(`[pull] Inserted ${inserted} new tweets into Mongo`);

  await updateCheckpoint(window.untilISO, inserted);
}

