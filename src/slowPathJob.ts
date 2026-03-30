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

If a post is a routine update on any of these topics, breaking: []`;
}

function toUsTradingDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function buildDeterministicKeys(a: AlertRow): string[] {
  const text = `${a.MainText || ''} ${a.QuotedText || ''}`.toLowerCase();
  const isEquityCrashSignal =
    /(?:crash|correction|sell-?off|biggest daily|7-month low|records? biggest|wiping out|down\s*\d+(?:\.\d+)?%|drops?\s*\d+(?:\.\d+)?%)/i.test(
      text
    );
  if (!isEquityCrashSignal) return [];

  const day = toUsTradingDay(a.Timestamp || new Date().toISOString());
  if (!day) return [];

  const keys: string[] = [];
  if (/(?:s&p\s*500|sp500|spx|s and p 500)/i.test(text)) {
    keys.push(`equity_crash|sp500|${day}`);
  }
  if (/(?:nasdaq\s*100|nasdaq100|ndx|nasdaq)/i.test(text)) {
    keys.push(`equity_crash|nasdaq100|${day}`);
  }
  return keys;
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
  let liveContext = context;
  const withinRunAlerts: {
    MainText?: string;
    ImpactLine?: string;
    Reason?: string;
  }[] = [];

  const allBreakingArrays: any[][] = [];
  const analyzedTweetIds = new Set<string>();

  const idToPlatform = new Map<string, 'twitter' | 'truth-social'>();
  for (const t of limited) {
    idToPlatform.set(
      t.tweetId,
      t.sourcePlatform === 'truth-social' ? 'truth-social' : 'twitter'
    );
  }

  for (const batch of batches) {
    const batchTweets = batch.map((t) => t as NormalizedTweet);

    batch.forEach((t) => {
      if (t.tweetId) analyzedTweetIds.add(t.tweetId);
    });

    const rawResponse = await analyzeTweetsWithGrok(batchTweets, liveContext);
    const parsed = parseGrokResponse(rawResponse);
    allBreakingArrays.push(parsed.breaking);

    // Feed newly found alerts back into context so later batches avoid repeats.
    const batchAlerts = flattenBreakingItems([parsed.breaking]).map((a) => ({
      MainText: a.MainText,
      ImpactLine: a.ImpactLine,
    }));
    if (batchAlerts.length > 0) {
      withinRunAlerts.push(...batchAlerts);
      liveContext = buildContextBlock([...withinRunAlerts, ...recentAlerts]);
    }

    // Persist analysis for debug/inspection
    try {
      await analysesCol.insertOne({
        createdAt: new Date().toISOString(),
        tweetIds: batchTweets.map((t) => t.tweetId),
        sourcePlatforms: batchTweets.map(
          (t) => t.sourcePlatform || 'twitter'
        ),
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
  for (const a of alerts) {
    a.SourcePlatform = idToPlatform.get(a.TweetId) || 'twitter';
  }

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

  // Deterministic dedup for same-day major equity crash stories across accounts.
  if (deduped.length > 0) {
    for (const a of deduped) {
      a.DeterministicKeys = buildDeterministicKeys(a);
    }
    const candidateKeys = Array.from(
      new Set(deduped.flatMap((a) => a.DeterministicKeys || []))
    );
    if (candidateKeys.length > 0) {
      const existingByKey = await alertsCol
        .find({ DeterministicKeys: { $in: candidateKeys } })
        .project({ DeterministicKeys: 1 })
        .toArray() as { DeterministicKeys?: string[] }[];
      const seenKeys = new Set<string>(
        existingByKey.flatMap((e) => e.DeterministicKeys || [])
      );
      const kept: AlertRow[] = [];
      for (const a of deduped) {
        const keys = a.DeterministicKeys || [];
        if (keys.length > 0 && keys.some((k) => seenKeys.has(k))) {
          continue;
        }
        kept.push(a);
        for (const k of keys) seenKeys.add(k);
      }
      if (kept.length < deduped.length) {
        console.log(
          `[slow-path] Skipping ${deduped.length - kept.length} alerts by deterministic same-day equity dedupe`
        );
      }
      deduped = kept;
    }
  }

  if (deduped.length > 0) {
    await alertsCol.insertMany(deduped, { ordered: false });

    for (const a of deduped) {
      const chatId =
        a.SourcePlatform === 'truth-social'
          ? config.telegramTruthSocialChatId
          : config.telegramAlertChatId;

      if (!chatId) {
        console.warn(
          `[slow-path] No Telegram chat for platform ${a.SourcePlatform || 'twitter'}; skipping send`
        );
        continue;
      }

      const icon =
        a.Urgency === 'high'
          ? '🔴'
          : a.Urgency === 'medium'
          ? '🟡'
          : '🟢';

      const textLines: string[] = [];
      if (a.SourcePlatform === 'truth-social') {
        textLines.push('📣 <b>Truth Social</b>', '');
      }
      textLines.push(`${icon} ${a.MainText}`);

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
        chatId,
        text: message,
      });
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

