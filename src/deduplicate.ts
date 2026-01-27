import { getDb } from './mongo';
import { NormalizedTweet } from './normalizeTweet';

export async function deduplicateAndInsert(
  tweets: NormalizedTweet[]
): Promise<number> {
  if (tweets.length === 0) return 0;

  const db = await getDb();
  const collection = db.collection<NormalizedTweet>('tweets');

  const localSeen = new Set<string>();
  const toInsert: NormalizedTweet[] = [];

  for (const t of tweets) {
    const tweetId = t.tweetId?.trim();
    if (!tweetId) continue;
    if (localSeen.has(tweetId)) continue;
    localSeen.add(tweetId);
    toInsert.push(t);
  }

  if (toInsert.length === 0) return 0;

  try {
    await collection.createIndex({ tweetId: 1 }, { unique: true });
  } catch {
    // ignore index race
  }

  let inserted = 0;

  if (toInsert.length > 0) {
    try {
      const res = await collection.insertMany(toInsert, {
        ordered: false,
      });
      inserted = res.insertedCount ?? Object.keys(res.insertedIds).length;
    } catch (err: any) {
      // Ignore duplicate key errors and count successful inserts
      if (err?.writeErrors?.length) {
        inserted =
          toInsert.length -
          err.writeErrors.filter(
            (e: any) =>
              e.code === 11000 || e.code === 11001 || e.code === 12582
          ).length;
      }
    }
  }

  return inserted;
}

