/**
 * Truth Social ingest: CivicTracker API (primary) → RSS (fallback).
 *
 * Primary:  GET civictracker.us/wp-json/civictracker/v1/proxy/social-posts
 *           Fast structured JSON, no HTML parsing, no status-page fetches.
 *
 * Fallback: runTruthSocialIngestOnce() (RSS + trumpstruth.org status pages).
 *           Activated when CivicTracker is unreachable, returns non-200,
 *           or returns an empty post list.
 *
 * tweetId convention: ts_<post_id>  ← same as the RSS path, so Mongo's
 * unique index on tweetId deduplicates posts across both sources automatically.
 */

import { NormalizedTweet } from './normalizeTweet';
import { deduplicateAndInsert } from './deduplicate';
import { runTruthSocialIngestOnce } from './truthSocialIngestJob';

const CIVIC_UUID = '3094abf7-4a95-4b8d-8c8d-af7d1c3747a1';
const CIVIC_PROXY = 'https://civictracker.us/wp-json/civictracker/v1/proxy/social-posts';
const CIVIC_UA = 'Mozilla/5.0 (compatible; truth-social-ingest/1.0; CivicTracker)';
const CIVIC_FETCH_LIMIT = 20;
const CIVIC_TIMEOUT_MS = 30_000;

type CivicPost = {
  id: number;
  platform: string;
  post_id: string;
  content: string;
  posted_at: string;
  original_url: string;
  has_media: boolean;
  media_urls: string[];
  username: string;
};

type CivicResponse = {
  posts: CivicPost[];
  total: number;
  has_more: boolean;
};

/** Fetch one page from the CivicTracker proxy. Returns null on any failure. */
async function fetchCivicPage(): Promise<CivicResponse | null> {
  const url = new URL(CIVIC_PROXY);
  url.searchParams.set('limit', String(CIVIC_FETCH_LIMIT));
  url.searchParams.set('offset', '0');
  url.searchParams.set('branch', 'executive');
  url.searchParams.set('official_uuid', CIVIC_UUID);

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CIVIC_TIMEOUT_MS);
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': CIVIC_UA },
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    console.warn(`[civic-ingest] Fetch error: ${(e as Error).message}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`[civic-ingest] HTTP ${res.status} from CivicTracker proxy`);
    return null;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    console.warn('[civic-ingest] Failed to parse CivicTracker JSON response');
    return null;
  }

  const data = json as Record<string, unknown>;

  // WordPress REST error shape
  if (typeof data.code === 'string' && typeof data.message === 'string') {
    console.warn(`[civic-ingest] CivicTracker API error: ${data.code} — ${data.message}`);
    return null;
  }

  if (!Array.isArray(data.posts)) {
    console.warn('[civic-ingest] Unexpected CivicTracker response shape (no posts array)');
    return null;
  }

  return {
    posts: data.posts as CivicPost[],
    total: typeof data.total === 'number' ? data.total : 0,
    has_more: Boolean(data.has_more),
  };
}

function isTruthSocialPost(p: CivicPost): boolean {
  return p.platform?.toLowerCase().includes('truth') ?? false;
}

function civicPostToNormalized(p: CivicPost, nowISO: string): NormalizedTweet {
  const content = (p.content || '').trim();
  const mainText = content
    || (p.has_media ? `[Media post — no text] ${p.original_url}` : `[No content] ${p.original_url}`);

  return {
    timestamp: nowISO,
    tweetId: `ts_${p.post_id}`,
    tweetUrl: p.original_url,
    mainText,
    quotedText: '',
    quotedAuthor: '',
    quotedUrl: '',
    hasQuote: false,
    images: p.media_urls || [],
    imageCount: (p.media_urls || []).length,
    authorUsername: p.username || 'realDonaldTrump',
    authorName: '',
    authorFollowers: 0,
    authorVerified: false,
    authorBlueVerified: false,
    likeCount: 0,
    retweetCount: 0,
    replyCount: 0,
    viewCount: 0,
    quoteCount: 0,
    bookmarkCount: 0,
    isReply: false,
    inReplyToId: '',
    conversationId: '',
    createdAt: p.posted_at,
    lang: '',
    source: 'civictracker-truth-social',
    ruleId: '',
    ruleTag: 'priority',
    ruleValue: 'truth-social:@realDonaldTrump',
    eventType: 'truth_post',
    processed: false,
    /** media posts wait for archive enrichment; text posts are immediately ready */
    enriched: !p.has_media,
    ingestedAt: nowISO,
    sourcePlatform: 'truth-social',
  };
}

/**
 * Primary CivicTracker ingest. Returns number inserted, or null if CivicTracker
 * was unavailable / returned no posts (caller should trigger RSS fallback).
 */
async function runCivicTrackerIngestOnce(): Promise<number | null> {
  const data = await fetchCivicPage();

  if (!data) return null;

  const truthPosts = data.posts.filter(isTruthSocialPost);

  if (truthPosts.length === 0) {
    console.log('[civic-ingest] CivicTracker returned 0 Truth Social posts — will fallback to RSS');
    return null;
  }

  const nowISO = new Date().toISOString();
  const tweets: NormalizedTweet[] = truthPosts.map((p) => civicPostToNormalized(p, nowISO));
  const mediaPosts = truthPosts.filter((p) => p.has_media);
  const textPosts = truthPosts.length - mediaPosts.length;

  console.log(
    `[civic-ingest] Fetched ${truthPosts.length} Truth Social post(s): ${textPosts} text-ready, ${mediaPosts.length} media-waiting`
  );
  for (const p of mediaPosts.slice(0, 5)) {
    console.log(
      `[civic-ingest] HOLD media post ts_${p.post_id} -> enriched=false; waiting for archive mapping/transcript`
    );
  }
  for (const p of truthPosts.filter((p) => !p.has_media).slice(0, 5)) {
    console.log(
      `[civic-ingest] READY text post ts_${p.post_id} -> enriched=true; eligible for Truth Social analysis`
    );
  }

  const inserted = await deduplicateAndInsert(tweets);
  console.log(
    `[civic-ingest] CivicTracker: ${truthPosts.length} post(s) fetched, ${inserted} new inserted (${data.total} total in API)`
  );
  return inserted;
}

/**
 * Main export — call this from the scheduler instead of runTruthSocialIngestOnce directly.
 *
 * Flow:
 *   1. Try CivicTracker proxy (fast, structured JSON)
 *   2. If ok → done
 *   3. If unavailable or empty → warn + fallback to RSS ingest
 */
export async function runTruthSocialIngestWithFallback(): Promise<void> {
  let civicResult: number | null = null;

  try {
    civicResult = await runCivicTrackerIngestOnce();
  } catch (err) {
    console.warn('[civic-ingest] Unexpected error in CivicTracker ingest:', err);
  }

  if (civicResult !== null) {
    // CivicTracker succeeded — no RSS needed this tick
    return;
  }

  // CivicTracker failed or empty → RSS fallback
  console.log('[civic-ingest] Falling back to RSS ingest...');
  try {
    await runTruthSocialIngestOnce();
  } catch (err) {
    console.error('[civic-ingest] RSS fallback also failed:', err);
  }
}
