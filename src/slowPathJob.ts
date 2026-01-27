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

export async function runSlowPathOnce(): Promise<void> {
  const db = await getDb();
  const tweetsCol = db.collection<TweetDoc>('tweets');
  const analysesCol = db.collection('analyses');

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

  const allBreakingArrays: any[][] = [];
  const analyzedTweetIds = new Set<string>();

  for (const batch of batches) {
    const batchTweets = batch.map((t) => t as NormalizedTweet);

    batch.forEach((t) => {
      if (t.tweetId) analyzedTweetIds.add(t.tweetId);
    });

    const rawResponse = await analyzeTweetsWithGrok(batchTweets);
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

  if (alerts.length > 0) {
    const alertsCol = db.collection<AlertRow>('alerts');
    await alertsCol.insertMany(alerts, { ordered: false });

    if (config.telegramAlertChatId) {
      for (const a of alerts) {
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
          `📊 ${a.Reason}`,
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

