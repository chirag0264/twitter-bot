import { getDb } from './mongo';
import { NormalizedTweet } from './normalizeTweet';
import { analyzeTweetsWithGrok } from './grokClient';
import { parseGrokResponse } from './parseGrokResponse';
import { flattenBreakingItems, AlertRow } from './flattenBreaking';
import { sendTelegramMessage } from './telegramClient';
import { config } from './config';

type TweetDoc = NormalizedTweet & {
  processedAt?: string;
};

function isPriorityTag(tag?: string): boolean {
  const lower = (tag || '').toLowerCase();
  return lower.includes('priority');
}

function buildContextBlock(
  alerts: { MainText?: string; ImpactLine?: string; Reason?: string }[]
): string {
  if (alerts.length === 0) return '';
  const lines = alerts.map(
    (a) =>
      `- "${(a.MainText || '').slice(0, 120)}${(a.MainText || '').length > 120 ? '...' : ''}" | ${a.ImpactLine || a.Reason || ''}`
  );
  return `## ALREADY SENT — PRICED IN (last 3 days, newest first)
Treat these topics as established/priced-in. Only flag a NEW MATERIAL DEVELOPMENT.
${lines.join('\n')}

If a tweet is a routine update on any of these topics, breaking: []`;
}

export async function runSlowPathOnce(): Promise<void> {
  const db = await getDb();
  const tweetsCol = db.collection<TweetDoc>('tweets');
  const analysesCol = db.collection('analyses');
  const alertsCol = db.collection<AlertRow>('alerts');

  const allItems = await tweetsCol
    .find({ processed: false })
    .sort({ ruleTag: 1, ingestedAt: -1 })
    .limit(50)
    .toArray();

  if (allItems.length === 0) {
    console.log('Slow Path: No unprocessed tweets found');
    return;
  }

  console.log(`Slow Path: Found ${allItems.length} unprocessed tweets`);

  const MIN_TWEETS_PRIORITY = 1;
  const MIN_TWEETS_REGULAR = 3;
  const MAX_TWEETS = 10;
  const BATCH_SIZE = 5;

  const sortedItems = allItems.sort((a, b) => {
    const aTag = (a.ruleTag || '').toLowerCase();
    const bTag = (b.ruleTag || '').toLowerCase();

    const aPriority = isPriorityTag(aTag);
    const bPriority = isPriorityTag(bTag);

    if (aPriority && !bPriority) return -1;
    if (!aPriority && bPriority) return 1;

    const aTime = new Date(a.ingestedAt || a.timestamp || 0).getTime();
    const bTime = new Date(b.ingestedAt || b.timestamp || 0).getTime();
    return bTime - aTime;
  });

  const priorityTweets = sortedItems.filter((item) =>
    isPriorityTag(item.ruleTag)
  );
  const regularTweets = sortedItems.filter(
    (item) => !isPriorityTag(item.ruleTag)
  );

  console.log(
    `Priority tweets: ${priorityTweets.length}, Regular tweets: ${regularTweets.length}`
  );

  if (priorityTweets.length >= MIN_TWEETS_PRIORITY) {
    console.log(
      `Priority threshold met (${priorityTweets.length}/${MIN_TWEETS_PRIORITY})`
    );
  } else if (regularTweets.length >= MIN_TWEETS_REGULAR) {
    console.log(
      `Regular threshold met (${regularTweets.length}/${MIN_TWEETS_REGULAR})`
    );
  } else {
    console.log(
      `Waiting: Priority ${priorityTweets.length}/${MIN_TWEETS_PRIORITY}, Regular ${regularTweets.length}/${MIN_TWEETS_REGULAR}`
    );
    return;
  }

  const tweetsToProcess = Math.min(sortedItems.length, MAX_TWEETS);
  const limited = sortedItems.slice(0, tweetsToProcess);

  console.log(
    `Processing ${tweetsToProcess} tweets (max: ${MAX_TWEETS})`
  );

  if (sortedItems.length > MAX_TWEETS) {
    console.log(
      `${sortedItems.length - MAX_TWEETS} tweets remaining for next run`
    );
  }

  // Build batches
  const batches: TweetDoc[][] = [];
  for (let i = 0; i < limited.length; i += BATCH_SIZE) {
    batches.push(limited.slice(i, i + BATCH_SIZE));
  }

  console.log(`Created ${batches.length} batch(es)`);

  const threeDaysAgo = new Date(
    Date.now() - 3 * 24 * 60 * 60 * 1000
  ).toISOString();
  const recentAlerts = await alertsCol
    .find({ Timestamp: { $gte: threeDaysAgo } })
    .sort({ Timestamp: -1 })
    .limit(30)
    .project({ MainText: 1, ImpactLine: 1, Reason: 1 })
    .toArray() as { MainText?: string; ImpactLine?: string; Reason?: string }[];
  const context = buildContextBlock(recentAlerts);

  const allBreakingArrays: any[][] = [];
  const analyzedTweetIds = new Set<string>();

  for (const batch of batches) {
    const batchTweets = batch.map((t) => t as NormalizedTweet);

    batch.forEach((t) => {
      if (t.tweetId) analyzedTweetIds.add(t.tweetId);
    });

    const rawResponse = await analyzeTweetsWithGrok(batchTweets, context);
    const parsed = parseGrokResponse(rawResponse);
    allBreakingArrays.push(parsed.breaking);

    // Persist analysis for debug/inspection
    try {
      await analysesCol.insertOne({
        createdAt: new Date().toISOString(),
        tweetIds: batchTweets.map((t) => t.tweetId),
        results: parsed.results,
        breaking: parsed.breaking,
        raw: rawResponse,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[slow-path] Failed to insert analysis document:',
        (err as Error).message
      );
    }
  }

  const alerts: AlertRow[] = flattenBreakingItems(allBreakingArrays);

  // Cross-run dedup: only insert and send alerts not already in DB
  let deduped = alerts;
  if (alerts.length > 0) {
    const newAlertTweetIds = alerts.map((a) => a.TweetId);
    const existing = await alertsCol
      .find({ TweetId: { $in: newAlertTweetIds } })
      .project({ TweetId: 1 })
      .toArray();
    const existingIds = new Set(existing.map((e) => e.TweetId));
    deduped = alerts.filter((a) => !existingIds.has(a.TweetId));
    if (deduped.length < alerts.length) {
      console.log(
        `[slow-path] Skipping ${alerts.length - deduped.length} alerts already sent (cross-run dedup)`
      );
    }
  }

  if (deduped.length > 0) {
    await alertsCol.insertMany(deduped, { ordered: false });

    if (config.telegramAlertChatId) {
      for (const a of deduped) {
        const icon =
          a.Urgency === 'high'
            ? '🔴'
            : a.Urgency === 'medium'
            ? '🟡'
            : '🟢';

        const textLines = [
          `${icon} ${a.MainText}`,
        ];

        if (a.HasQuote && a.QuotedText) {
          textLines.push(
            '',
            `📎 <b>Quoting @${a.QuotedAuthor}:</b>`,
            a.QuotedText
          );
        }

        textLines.push(
          '',
          `👤 @${a.Username}`,
          '',
          `🔗 ${a.Link}`
        );

        if (a.QuotedLink) {
          textLines.push(`📎 ${a.QuotedLink}`);
        }

        const message = textLines.join('\n');

        await sendTelegramMessage({
          chatId: config.telegramAlertChatId,
          text: message,
        });
      }
    } else {
      console.warn(
        '[slow-path] TELEGRAM_ALERT_CHAT_ID not set; skipping breaking alerts to Telegram'
      );
    }
  } else {
    console.log('No breaking alerts to send');
  }

  if (analyzedTweetIds.size > 0) {
    await tweetsCol.updateMany(
      { tweetId: { $in: Array.from(analyzedTweetIds) } },
      { $set: { processed: true, processedAt: new Date().toISOString() } }
    );
    console.log(
      `Marked ${analyzedTweetIds.size} tweets as processed in Mongo`
    );
  }
}

