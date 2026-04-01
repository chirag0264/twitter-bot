/**
 * Truth Social Analysis Job
 *
 * The dedicated slow-path for Truth Social posts — completely separate from
 * slowPathJob.ts (which handles Twitter only).
 *
 * Flow:
 *   1. Fetch unprocessed Truth Social posts where enriched !== false
 *      (enriched: true  → text-only post, ready immediately)
 *      (enriched: undefined → legacy RSS post, treated as ready)
 *   2. Send to grokTruthSocialClient (commentary + breaking schema)
 *   3. Commentary: classification !== 'noise' && market_relevance >= 15
 *      → 🟡 Trump Commentary → TELEGRAM_TRUTH_SOCIAL_CHAT_ID
 *   4. Breaking: urgency high/medium → 📣 Truth Social alert → same channel
 *   5. Deduplicate across runs (TweetId + deterministic keys)
 *   6. Mark tweets processed
 */

import { getDb } from './mongo';
import { NormalizedTweet } from './normalizeTweet';
import { analyzeTruthSocialWithGrok } from './grokTruthSocialClient';
import { parseGrokResponse } from './parseGrokResponse';
import { flattenBreakingItems, AlertRow } from './flattenBreaking';
import { sendTelegramMessage } from './telegramClient';
import { config } from './config';

type TweetDoc = NormalizedTweet & { processedAt?: string };

type CommentaryRow = AlertRow & {
  AlertType: 'commentary';
  Summary: string;
  Classification: string;
  MarketRelevance: number;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildContextBlock(
  alerts: { MainText?: string; ImpactLine?: string; Reason?: string }[]
): string {
  if (alerts.length === 0) return '';
  const lines = alerts.map(
    (a) =>
      `- "${(a.MainText || '').slice(0, 120)}${(a.MainText || '').length > 120 ? '...' : ''}" | ${a.ImpactLine || (a as any).Reason || ''}`
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

function normalizeClassification(v: unknown): string {
  const s = String(v || '').trim().toLowerCase();
  return ['crypto_relevant', 'macro', 'commentary', 'noise'].includes(s) ? s : 'noise';
}

function normalizeMarketRelevance(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ─── Main export ─────────────────────────────────────────────────────────────

export async function runTruthSocialAnalysisOnce(): Promise<void> {
  const db = await getDb();
  const tweetsCol = db.collection<TweetDoc>('tweets');
  const analysesCol = db.collection('analyses');
  const alertsCol = db.collection<AlertRow | CommentaryRow>('alerts');

  // Only pick up CivicTracker Truth Social posts that are ready
  const allItems = await tweetsCol
    .find({
      processed: false,
      sourcePlatform: 'truth-social',
      source: 'civictracker-truth-social',
      enriched: { $ne: false },
    })
    .sort({ ingestedAt: -1 })
    .limit(50)
    .toArray();

  if (allItems.length === 0) {
    console.log('[ts-analysis] No unprocessed CivicTracker Truth Social posts');
    return;
  }

  console.log(
    `[ts-analysis] Found ${allItems.length} unprocessed CivicTracker Truth Social post(s)`
  );
  for (const item of allItems.slice(0, 10)) {
    console.log(
      `[ts-analysis] PICK ${item.tweetId} -> processed=false, enriched=${item.enriched === false ? 'false' : 'true/legacy'}; sending to Grok`
    );
  }

  const MAX_TWEETS = 10;
  const BATCH_SIZE = 5;

  const limited = allItems.slice(0, MAX_TWEETS);

  if (allItems.length > MAX_TWEETS) {
    console.log(`[ts-analysis] ${allItems.length - MAX_TWEETS} post(s) deferred to next run`);
  }

  const batches: TweetDoc[][] = [];
  for (let i = 0; i < limited.length; i += BATCH_SIZE) {
    batches.push(limited.slice(i, i + BATCH_SIZE));
  }

  // Build live context from recent Truth Social alerts (avoids repricing)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const recentAlerts = (await alertsCol
    .find({
      SourcePlatform: 'truth-social',
      Timestamp: { $gte: threeDaysAgo },
    })
    .sort({ Timestamp: -1 })
    .limit(30)
    .project({ MainText: 1, ImpactLine: 1 })
    .toArray()) as { MainText?: string; ImpactLine?: string }[];

  let liveContext = buildContextBlock(recentAlerts);
  const withinRunAlerts: { MainText?: string; ImpactLine?: string }[] = [];

  const allBreakingArrays: unknown[][] = [];
  const commentaryCandidates: CommentaryRow[] = [];
  const analyzedTweetIds = new Set<string>();

  for (const batch of batches) {
    const tweets = batch.map((t) => t as NormalizedTweet);
    batch.forEach((t) => t.tweetId && analyzedTweetIds.add(t.tweetId));

    console.log(
      `[ts-analysis] Grok batch: ${tweets.map((t) => t.tweetId).join(', ')}`
    );

    const rawResponse = await analyzeTruthSocialWithGrok(tweets, liveContext);
    const parsed = parseGrokResponse(rawResponse);

    allBreakingArrays.push(parsed.breaking);

    // Commentary candidates
    parsed.results.forEach((result, idx) => {
      const tweet = tweets[idx];
      if (!tweet) return;

      const breaking = Array.isArray(result?.breaking) ? result.breaking : [];
      const classification = normalizeClassification(result?.classification);
      const marketRelevance = normalizeMarketRelevance(result?.market_relevance);
      const summary = String(result?.summary || '').trim();

      if (breaking.length === 0 && classification !== 'noise' && marketRelevance >= 15) {
        commentaryCandidates.push({
          Timestamp: new Date().toISOString(),
          TweetId: tweet.tweetId,
          MainText: tweet.mainText || '',
          QuotedText: tweet.quotedText || '',
          QuotedAuthor: tweet.quotedAuthor || '',
          ImpactLine: '',
          Urgency: 'low',
          Username: tweet.authorUsername || 'realDonaldTrump',
          Link: tweet.tweetUrl || '',
          QuotedLink: tweet.quotedUrl || '',
          HasQuote: Boolean(tweet.quotedText),
          SourcePlatform: 'truth-social',
          AlertType: 'commentary',
          Summary: summary || tweet.mainText || '',
          Classification: classification,
          MarketRelevance: marketRelevance,
          DeterministicKeys: [`truth_commentary|${classification}|${tweet.tweetId}`],
        });
      }
    });

    // Store analysis
    try {
      await analysesCol.insertOne({
        createdAt: new Date().toISOString(),
        tweetIds: tweets.map((t) => t.tweetId),
        sourcePlatform: 'truth-social',
        results: parsed.results.map((result, idx) => ({
          ...result,
          classification: normalizeClassification(result?.classification),
          market_relevance: normalizeMarketRelevance(result?.market_relevance),
          tweetId: tweets[idx]?.tweetId || '',
        })),
        breaking: parsed.breaking,
        raw: rawResponse,
      });
    } catch (err) {
      console.error('[ts-analysis] Failed to store analysis:', (err as Error).message);
    }

    // Update live context with newly found breaking items
    const batchAlerts = flattenBreakingItems([parsed.breaking as any[]]).map((a) => ({
      MainText: a.MainText,
      ImpactLine: a.ImpactLine,
    }));
    if (batchAlerts.length > 0) {
      withinRunAlerts.push(...batchAlerts);
      liveContext = buildContextBlock([...withinRunAlerts, ...recentAlerts]);
    }
  }

  // ── Breaking alerts ──────────────────────────────────────────────────────

  let breakingAlerts: AlertRow[] = flattenBreakingItems(allBreakingArrays as any[][]);
  breakingAlerts.forEach((a) => {
    a.SourcePlatform = 'truth-social';
    a.AlertType = 'breaking';
  });

  // Cross-run dedup by TweetId
  if (breakingAlerts.length > 0) {
    const ids = breakingAlerts.map((a) => a.TweetId);
    const existing = await alertsCol
      .find({ TweetId: { $in: ids } })
      .project({ TweetId: 1 })
      .toArray();
    const existingIds = new Set(existing.map((e) => e.TweetId));
    const before = breakingAlerts.length;
    breakingAlerts = breakingAlerts.filter((a) => !existingIds.has(a.TweetId));
    if (breakingAlerts.length < before) {
      console.log(
        `[ts-analysis] Skipped ${before - breakingAlerts.length} already-sent breaking alert(s)`
      );
    }
  }

  // Deterministic same-day equity crash dedup
  if (breakingAlerts.length > 0) {
    breakingAlerts.forEach((a) => {
      a.DeterministicKeys = buildDeterministicKeys(a);
    });
    const candidateKeys = Array.from(
      new Set(breakingAlerts.flatMap((a) => a.DeterministicKeys || []))
    );
    if (candidateKeys.length > 0) {
      const existingByKey = (await alertsCol
        .find({ DeterministicKeys: { $in: candidateKeys } })
        .project({ DeterministicKeys: 1 })
        .toArray()) as { DeterministicKeys?: string[] }[];
      const seenKeys = new Set<string>(
        existingByKey.flatMap((e) => e.DeterministicKeys || [])
      );
      const kept: AlertRow[] = [];
      for (const a of breakingAlerts) {
        const keys = a.DeterministicKeys || [];
        if (keys.length > 0 && keys.some((k) => seenKeys.has(k))) continue;
        kept.push(a);
        keys.forEach((k) => seenKeys.add(k));
      }
      if (kept.length < breakingAlerts.length) {
        console.log(
          `[ts-analysis] Skipped ${breakingAlerts.length - kept.length} breaking alert(s) by deterministic equity dedup`
        );
      }
      breakingAlerts = kept;
    }
  }

  // ── Commentary dedup ─────────────────────────────────────────────────────

  let dedupedCommentary = commentaryCandidates;
  if (commentaryCandidates.length > 0) {
    const ids = commentaryCandidates.map((a) => a.TweetId);
    const existing = (await alertsCol
      .find({ AlertType: 'commentary', TweetId: { $in: ids } })
      .project({ TweetId: 1, DeterministicKeys: 1 })
      .toArray()) as { TweetId?: string; DeterministicKeys?: string[] }[];
    const existingIds = new Set(existing.map((e) => String(e.TweetId || '')));
    const existingKeys = new Set(existing.flatMap((e) => e.DeterministicKeys || []));
    dedupedCommentary = commentaryCandidates.filter((a) => {
      if (existingIds.has(a.TweetId)) return false;
      return !(a.DeterministicKeys || []).some((k) => existingKeys.has(k));
    });
  }

  const outgoing = [...breakingAlerts, ...dedupedCommentary];

  // ── Persist + send ───────────────────────────────────────────────────────

  if (outgoing.length > 0) {
    await alertsCol.insertMany(outgoing, { ordered: false });

    const chatId = config.telegramTruthSocialChatId;

    for (const a of outgoing) {
      if (!chatId) {
        console.warn('[ts-analysis] TELEGRAM_TRUTH_SOCIAL_CHAT_ID not set — skipping send');
        break;
      }

      if (a.AlertType === 'commentary') {
        const row = a as CommentaryRow;
        const msg = [
          '🟡 <b>Trump Commentary</b>',
          '',
          row.Summary || row.MainText,
          '',
          `👤 @${row.Username}`,
          '',
          `🔗 ${row.Link}`,
        ].join('\n');

        await sendTelegramMessage({ chatId, text: msg });
        continue;
      }

      // Breaking alert
      const icon =
        a.Urgency === 'high' ? '🔴' : a.Urgency === 'medium' ? '🟠' : '🟢';

      const lines: string[] = [
        '📣 <b>Truth Social</b>',
        '',
        `${icon} ${a.MainText}`,
      ];

      if (a.HasQuote && a.QuotedText) {
        lines.push('', `📎 <b>Quoting @${a.QuotedAuthor}:</b>`, a.QuotedText);
      }

      lines.push('', `👤 @${a.Username}`, '', `🔗 ${a.Link}`);
      if (a.QuotedLink) lines.push(`📎 ${a.QuotedLink}`);

      await sendTelegramMessage({ chatId, text: lines.join('\n') });
    }
  } else {
    console.log('[ts-analysis] No alerts or commentary to send');
  }

  // ── Mark processed ───────────────────────────────────────────────────────

  if (analyzedTweetIds.size > 0) {
    await tweetsCol.updateMany(
      { tweetId: { $in: Array.from(analyzedTweetIds) } },
      { $set: { processed: true, processedAt: new Date().toISOString() } }
    );
    console.log(`[ts-analysis] Marked ${analyzedTweetIds.size} post(s) as processed`);
  }
}
