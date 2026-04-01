/**
 * Archive Enrichment Job
 *
 * Runs on a cron (every 3-5 min). Looks for Truth Social posts in Mongo that
 * have `enriched: false` (media posts ingested from CivicTracker that lack
 * image descriptions). Fetches recent pages from the trumpstruth.org archive
 * to extract image descriptions + public Linode image URLs, then updates the
 * Mongo record and sets `enriched: true` so the analysis job will pick it up.
 *
 * Safety valve: posts that remain `enriched: false` for longer than
 * STALE_RELEASE_MS are force-released (set to `enriched: true`) so they
 * don't get stuck indefinitely if the archive lags or never archives the post.
 */

import { Parser } from 'xml2js';
import { getDb } from './mongo';

const RSS_FEED_URL = 'https://www.trumpstruth.org/feed';
const ARCHIVE_BASE = 'https://www.trumpstruth.org';
const UA =
  'Mozilla/5.0 (compatible; truth-social-enrich/1.0; +https://www.trumpstruth.org/)';

const CONCURRENCY = 5;
const STALE_RELEASE_MS = 30 * 60 * 1000; // 30 min

// ─── HTML parsing helpers ────────────────────────────────────────────────────

/** Extract the numeric original Truth Social status ID from archive page HTML. */
function extractOriginalTruthId(html: string): string | null {
  const m = html.match(
    /TRUTH Social status ID[\s\S]{0,200}?<code>(\d+)<\/code>/i
  );
  return m ? m[1] : null;
}

/** Extract Linode archive image URLs from status page HTML. */
function extractLinodeUrls(html: string): string[] {
  const urls = new Set<string>();
  const hrefRe =
    /href="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
  const srcRe =
    /src="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) urls.add(m[1].trim());
  while ((m = srcRe.exec(html)) !== null) urls.add(m[1].trim());
  return [...urls].filter((u) => !/\.(mp4|webm|mov|m4v|mkv|mpeg)(\?|$)/i.test(u.split('?')[0]));
}

/** Extract archive "Image Description" / "Video Transcript" text blocks. */
function extractDescriptions(html: string): string[] {
  const descriptions: string[] = [];
  const blockRe =
    /class="status-details-attachment__text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 10) descriptions.push(text);
  }

  // Fallback: alt text on attachment images
  if (descriptions.length === 0) {
    const altRe = /class="status-attachment__image"[^>]*alt="([^"]+)"/gi;
    while ((m = altRe.exec(html)) !== null) {
      const text = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#039;/g, "'")
        .trim();
      if (text.length > 10) descriptions.push(text);
    }
  }

  return descriptions.filter(
    (d) => !/there is no information available for this file/i.test(d)
  );
}

/** Rebuild mainText to include image descriptions after enrichment. */
function buildEnrichedMainText(original: string, descriptions: string[]): string {
  if (descriptions.length === 0) return original;

  const descBlock = descriptions
    .map((d, i) => `[Attachment ${i + 1} — archive image description] ${d}`)
    .join('\n');

  // Replace bare placeholder
  if (/^\[Media post — no text\]/i.test(original.trim())) {
    return descBlock;
  }

  // Avoid double-appending if already contains an attachment block
  if (original.includes('[Attachment 1 — archive image description]')) {
    return original;
  }

  return `${original}\n\n${descBlock}`;
}

// ─── RSS helpers ─────────────────────────────────────────────────────────────

/** Extract trumpstruth.org/statuses/NNNN URLs from an RSS item. */
function getArchiveUrlFromItem(item: Record<string, unknown>): string | null {
  const link = typeof item.link === 'string' ? item.link.trim() : '';
  if (/trumpstruth\.org\/statuses\/\d+/i.test(link)) return link;

  const guid = (() => {
    const g = item.guid;
    if (typeof g === 'string') return g;
    if (g && typeof g === 'object') {
      const obj = g as Record<string, unknown>;
      if (typeof obj._ === 'string') return obj._;
    }
    return '';
  })();
  if (/trumpstruth\.org\/statuses\/\d+/i.test(guid)) return guid;

  return null;
}

// ─── Main job ────────────────────────────────────────────────────────────────

export async function runArchiveEnrichOnce(): Promise<void> {
  const db = await getDb();
  const tweetsCol = db.collection('tweets');

  // ── Safety valve: release posts stuck as enriched: false for > STALE_RELEASE_MS ──
  const staleTime = new Date(Date.now() - STALE_RELEASE_MS).toISOString();
  const staleResult = await tweetsCol.updateMany(
    {
      sourcePlatform: 'truth-social',
      enriched: false,
      ingestedAt: { $lte: staleTime },
    },
    { $set: { enriched: true } }
  );
  if (staleResult.modifiedCount > 0) {
    console.log(
      `[archive-enrich] Released ${staleResult.modifiedCount} stale unenriched post(s) (>${STALE_RELEASE_MS / 60_000} min old)`
    );
  }

  // ── Check if there is anything left to enrich ──
  const pendingCount = await tweetsCol.countDocuments({
    sourcePlatform: 'truth-social',
    enriched: false,
  });

  if (pendingCount === 0) {
    console.log('[archive-enrich] No pending media posts — nothing to do');
    return;
  }

  console.log(`[archive-enrich] ${pendingCount} media post(s) pending enrichment`);
  const pendingSample = await tweetsCol
    .find(
      { sourcePlatform: 'truth-social', enriched: false },
      { projection: { tweetId: 1, createdAt: 1, ingestedAt: 1, mainText: 1 } }
    )
    .sort({ ingestedAt: -1 })
    .limit(5)
    .toArray();
  for (const row of pendingSample) {
    console.log(
      `[archive-enrich] WAIT ${String(row.tweetId || '')} -> holding for archive context`
    );
  }

  // ── Fetch RSS feed ──
  let xml: string;
  try {
    const res = await fetch(RSS_FEED_URL, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok) {
      console.warn(`[archive-enrich] RSS HTTP ${res.status} — skipping this tick`);
      return;
    }
    xml = await res.text();
  } catch (e) {
    console.warn(`[archive-enrich] RSS fetch error:`, e);
    return;
  }

  const parser = new Parser({ explicitArray: false });
  let result: { rss?: { channel?: { item?: unknown } } };
  try {
    result = (await parser.parseStringPromise(xml)) as typeof result;
  } catch (e) {
    console.warn('[archive-enrich] RSS XML parse error:', e);
    return;
  }

  const items = result?.rss?.channel?.item;
  if (!items) {
    console.log('[archive-enrich] RSS feed is empty');
    return;
  }
  const itemArray: Record<string, unknown>[] = Array.isArray(items)
    ? (items as Record<string, unknown>[])
    : [items as Record<string, unknown>];

  const archiveUrls = itemArray
    .map(getArchiveUrlFromItem)
    .filter((u): u is string => u !== null);

  console.log(
    `[archive-enrich] ${archiveUrls.length} archive page(s) to check from RSS`
  );

  if (archiveUrls.length === 0) return;

  // ── Fetch status pages and enrich matching Mongo records ──
  let enriched = 0;

  for (let i = 0; i < archiveUrls.length; i += CONCURRENCY) {
    const chunk = archiveUrls.slice(i, i + CONCURRENCY);

    await Promise.all(
      chunk.map(async (url) => {
        let html: string;
        try {
          const fullUrl = url.startsWith('http') ? url : `${ARCHIVE_BASE}${url}`;
          const res = await fetch(fullUrl, { headers: { 'User-Agent': UA } });
          if (!res.ok) {
            console.warn(`[archive-enrich] Status page HTTP ${res.status}: ${fullUrl}`);
            return;
          }
          html = await res.text();
        } catch (e) {
          console.warn(`[archive-enrich] Status page fetch failed ${url}:`, e);
          return;
        }

        const originalId = extractOriginalTruthId(html);
        if (!originalId) {
          console.warn(`[archive-enrich] Could not extract original post ID from ${url}`);
          return;
        }

        const tweetId = `ts_${originalId}`;
        const existing = await tweetsCol.findOne({ tweetId, enriched: false });
        if (!existing) return; // Not pending or not in DB

        const images = extractLinodeUrls(html);
        const imageDescriptions = extractDescriptions(html);
        console.log(
          `[archive-enrich] MATCH ${url} -> ${tweetId}; found ${images.length} media url(s), ${imageDescriptions.length} description/transcript block(s)`
        );
        const updatedMainText = buildEnrichedMainText(
          String(existing.mainText || ''),
          imageDescriptions
        );

        await tweetsCol.updateOne(
          { tweetId },
          {
            $set: {
              enriched: true,
              mainText: updatedMainText,
              ...(images.length > 0 && { images }),
              ...(imageDescriptions.length > 0 && { imageDescriptions }),
              imageCount: images.length,
            },
          }
        );

        enriched++;
        console.log(
          `[archive-enrich] Enriched ${tweetId}: ${imageDescriptions.length} description(s), ${images.length} image(s)`
        );
      })
    );
  }

  console.log(`[archive-enrich] Done — enriched ${enriched} post(s) this tick`);
}
