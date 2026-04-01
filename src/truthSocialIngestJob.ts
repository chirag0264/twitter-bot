import { Parser } from 'xml2js';
import { NormalizedTweet } from './normalizeTweet';
import { deduplicateAndInsert } from './deduplicate';
import { getDb } from './mongo';

const RSS_FEED_URL = 'https://www.trumpstruth.org/feed';
const TARGET_ACCOUNT = 'realdonaldtrump';
const STATUS_PAGE_UA =
  'Mozilla/5.0 (compatible; truth-social-ingest/1.0; +https://www.trumpstruth.org/)';
/** Parallel status-page fetches (RSS often omits image-only post bodies). */
const STATUS_PAGE_FETCH_CONCURRENCY = 5;

function getGuid(item: Record<string, unknown>): string {
  const g = item.guid;
  if (typeof g === 'string') return g;
  if (g && typeof g === 'object' && '_' in g && typeof (g as { _: string })._ === 'string') {
    return (g as { _: string })._;
  }
  return '';
}

function extractTruthStatusId(url: string): string | null {
  const mTs = url.match(/truthsocial\.com\/@[^/]+\/(\d+)/i);
  if (mTs) return mTs[1];
  const mArch = url.match(/trumpstruth\.org\/statuses\/(\d+)/i);
  return mArch ? mArch[1] : null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** RSS mirrors often use this when the post is image/video-only and body is empty. */
function isPlaceholderTitle(title: string): boolean {
  return /^\[No Title\]/i.test(title.trim());
}

function extractImageUrlsFromHtml(html: string): string[] {
  const urls = new Set<string>();
  const re = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[1].trim();
    if (u && !u.startsWith('data:')) urls.add(u);
  }
  return [...urls];
}

function getEnclosureImageUrls(item: Record<string, unknown>): string[] {
  const enc = item.enclosure;
  if (!enc) return [];
  const list = Array.isArray(enc) ? enc : [enc];
  const urls: string[] = [];
  for (const e of list) {
    if (e && typeof e === 'object' && '$' in e) {
      const attrs = (e as { $: { url?: string; type?: string } }).$;
      const url = attrs?.url;
      const type = (attrs?.type || '').toLowerCase();
      if (url && (type.startsWith('image/') || !type)) urls.push(url);
    }
  }
  return urls;
}

function getContentEncoded(item: Record<string, unknown>): string {
  const v =
    item['content:encoded'] ??
    item['contentEncoded'] ??
    item.content;
  return typeof v === 'string' ? v : '';
}

function decodeBasicHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Skip archive placeholder copy; still useful to omit from mainText / Grok. */
function isPlaceholderImageDescription(text: string): boolean {
  return /there is no information available for this file/i.test(text.trim());
}

function filterMeaningfulImageDescriptions(descriptions: string[]): string[] {
  return descriptions
    .map((d) => decodeBasicHtmlEntities(d.replace(/\s+/g, ' ').trim()))
    .filter((d) => d.length > 15 && !isPlaceholderImageDescription(d));
}

function formatImageDescriptionsBlock(descriptions: string[]): string {
  if (descriptions.length === 0) return '';
  return descriptions
    .map(
      (d, i) =>
        `[Attachment ${i + 1} — archive image description] ${d}`
    )
    .join('\n');
}

function buildMainTextForRssItem(params: {
  title: string;
  descRaw: string;
  contentEncoded: string;
  imageUrls: string[];
  imageDescriptions?: string[];
  postUrl: string;
}): string {
  const textFromDesc = stripHtml(params.descRaw);
  const textFromContent = stripHtml(params.contentEncoded);
  const textBody = textFromDesc || textFromContent;
  const descBlock = formatImageDescriptionsBlock(
    filterMeaningfulImageDescriptions(params.imageDescriptions ?? [])
  );

  if (textBody) {
    return descBlock ? `${textBody}\n\n${descBlock}` : textBody;
  }

  const title = params.title.trim();
  if (title && !isPlaceholderTitle(title)) {
    return descBlock ? `${title}\n\n${descBlock}` : title;
  }

  if (params.imageUrls.length > 0) {
    const n = params.imageUrls.length;
    const first = params.imageUrls[0];
    const base = `[Image/media post — ${n} asset(s)] ${first}`;
    return descBlock ? `${base}\n\n${descBlock}` : base;
  }

  if (descBlock) return descBlock;

  return `[Media-only post (no text in RSS mirror) — open link] ${params.postUrl}`;
}

/** Truth Social URL in guid, or trumpstruth.org mirror (feed is Trump-only). */
function isTargetTruthItem(guidUrl: string, link: string): boolean {
  const g = guidUrl.toLowerCase();
  const l = link.toLowerCase();
  if (g.includes(`truthsocial.com/@${TARGET_ACCOUNT}/`)) return true;
  if (l.includes(`truthsocial.com/@${TARGET_ACCOUNT}/`)) return true;
  if (/trumpstruth\.org\/statuses\/\d+/.test(g)) return true;
  if (/trumpstruth\.org\/statuses\/\d+/.test(l)) return true;
  return false;
}

function isVideoAttachmentUrl(url: string): boolean {
  const pathPart = url.split('?')[0].toLowerCase();
  return /\.(mp4|webm|mov|m4v|mkv|mpeg)(\?|$)/.test(pathPart);
}

/** Drop video URLs; Grok vision and alerts care about raster images. */
function filterRasterImageUrls(urls: string[]): string[] {
  return [...new Set(urls)].filter((u) => !isVideoAttachmentUrl(u));
}

type StatusPageData = {
  images: string[];
  imageDescriptions: string[];
  originalTruthId?: string;
  originalTruthUrl?: string;
};

/**
 * Parse trumpstruth.org status HTML: public Linode archive image URLs + archive "Image Description" text.
 * Omits static-assets.truthsocial.com URLs (often 403 for Grok / external fetchers).
 */
async function fetchStatusPageData(postUrl: string): Promise<StatusPageData> {
  if (!postUrl) return { images: [], imageDescriptions: [] };
  try {
    const res = await fetch(postUrl, {
      headers: { 'User-Agent': STATUS_PAGE_UA },
    });
    if (!res.ok) {
      console.warn(`[truth-social] Status page HTTP ${res.status}: ${postUrl}`);
      return { images: [], imageDescriptions: [] };
    }
    const html = await res.text();
    const urls = new Set<string>();
    const linodeHref =
      /href="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
    const linodeSrc =
      /src="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = linodeHref.exec(html)) !== null) urls.add(m[1].trim());
    while ((m = linodeSrc.exec(html)) !== null) urls.add(m[1].trim());

    const descriptions: string[] = [];
    const detailBlockRe =
      /class="status-details-attachment__text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = detailBlockRe.exec(html)) !== null) {
      const text = m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 10) descriptions.push(text);
    }

    if (descriptions.length === 0) {
      const altRe =
        /class="status-attachment__image"[^>]*alt="([^"]+)"/gi;
      while ((m = altRe.exec(html)) !== null) {
        const text = decodeBasicHtmlEntities(
          m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim()
        );
        if (text.length > 10) descriptions.push(text);
      }
    }

    const originalTruthId =
      html.match(/TRUTH Social status ID[\s\S]{0,200}?<code>(\d+)<\/code>/i)?.[1] ||
      html.match(/truthsocial\.com\/@[^/]+\/(\d+)/i)?.[1];
    const originalTruthUrl =
      html.match(/<a href="(https:\/\/truthsocial\.com\/@[^"]+\/\d+)" target="_blank">/i)?.[1];

    return {
      images: [...urls],
      imageDescriptions: descriptions,
      ...(originalTruthId ? { originalTruthId } : {}),
      ...(originalTruthUrl ? { originalTruthUrl } : {}),
    };
  } catch (e) {
    console.warn(`[truth-social] Status page fetch failed ${postUrl}:`, e);
    return { images: [], imageDescriptions: [] };
  }
}

type TruthRssFields = {
  tweetId: string;
  tweetUrl: string;
  postUrl: string;
  originalTruthId?: string;
  title: string;
  descRaw: string;
  contentEncoded: string;
  pubDate: string;
  images: string[];
  imageDescriptions: string[];
};

function extractTruthRssFields(item: Record<string, unknown>): TruthRssFields | null {
  const guidUrl = getGuid(item);
  const link = typeof item.link === 'string' ? item.link : '';
  if (!guidUrl || !isTargetTruthItem(guidUrl, link)) return null;

  const numericId =
    extractTruthStatusId(guidUrl) || extractTruthStatusId(link);
  if (!numericId) return null;

  const tweetId = `ts_${numericId}`;
  const title = typeof item.title === 'string' ? item.title : '';
  const descRaw = typeof item.description === 'string' ? item.description : '';
  const contentEncoded = getContentEncoded(item);
  const htmlBlob = `${descRaw}\n${contentEncoded}`;
  const fromHtml = extractImageUrlsFromHtml(htmlBlob);
  const fromEnc = getEnclosureImageUrls(item);
  const images = filterRasterImageUrls([...fromHtml, ...fromEnc]);
  const postUrl = link || guidUrl;

  return {
    tweetId,
    tweetUrl: guidUrl,
    postUrl,
    title,
    descRaw,
    contentEncoded,
    pubDate: typeof item.pubDate === 'string' ? item.pubDate : '',
    images,
    imageDescriptions: [],
  };
}

function buildTruthTweetFromFields(
  fields: TruthRssFields,
  nowISO: string
): NormalizedTweet {
  const meaningfulDescs = filterMeaningfulImageDescriptions(fields.imageDescriptions);

  const mainText = buildMainTextForRssItem({
    title: fields.title,
    descRaw: fields.descRaw,
    contentEncoded: fields.contentEncoded,
    imageUrls: fields.images,
    imageDescriptions: meaningfulDescs,
    postUrl: fields.postUrl,
  });

  return {
    timestamp: nowISO,
    tweetId: fields.tweetId,
    tweetUrl: fields.tweetUrl,
    ...(fields.originalTruthId ? { originalTruthId: fields.originalTruthId } : {}),
    mainText,
    quotedText: '',
    quotedAuthor: '',
    quotedUrl: '',
    hasQuote: false,
    images: fields.images,
    imageCount: fields.images.length,
    ...(meaningfulDescs.length > 0 ? { imageDescriptions: meaningfulDescs } : {}),
    authorUsername: TARGET_ACCOUNT,
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
    createdAt: fields.pubDate,
    lang: '',
    source: 'truth-social-rss',
    ruleId: '',
    ruleTag: 'priority',
    ruleValue: `truth-social:@${TARGET_ACCOUNT}`,
    eventType: 'truth_post',
    processed: false,
    ingestedAt: nowISO,
    sourcePlatform: 'truth-social',
  };
}

/**
 * One status-page fetch per post not yet in Mongo: Linode image URLs + archive image descriptions.
 */
async function enrichFromStatusPages(fieldsList: TruthRssFields[]): Promise<void> {
  if (fieldsList.length === 0) return;

  const db = await getDb();
  const ids = fieldsList.map((f) => f.tweetId);
  const existing = await db
    .collection('tweets')
    .find({ tweetId: { $in: ids } }, { projection: { tweetId: 1 } })
    .toArray();
  const existingSet = new Set(existing.map((d) => String(d.tweetId ?? '')));

  const toFetch = fieldsList.filter((f) => !existingSet.has(f.tweetId));
  if (toFetch.length === 0) return;

  let withImages = 0;
  let withDescs = 0;
  for (let i = 0; i < toFetch.length; i += STATUS_PAGE_FETCH_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + STATUS_PAGE_FETCH_CONCURRENCY);
    await Promise.all(
      chunk.map(async (f) => {
        const {
          images: pageUrls,
          imageDescriptions,
          originalTruthId,
          originalTruthUrl,
        } = await fetchStatusPageData(
          f.postUrl
        );
        if (originalTruthId) {
          f.originalTruthId = originalTruthId;
          f.tweetId = `ts_${originalTruthId}`;
        }
        if (originalTruthUrl) {
          f.tweetUrl = originalTruthUrl;
        }
        const pageRaster = filterRasterImageUrls(pageUrls);
        f.images = filterRasterImageUrls([
          ...new Set([...f.images, ...pageRaster]),
        ]);
        if (pageRaster.length > 0) withImages++;
        f.imageDescriptions = filterMeaningfulImageDescriptions(imageDescriptions);
        if (f.imageDescriptions.length > 0) withDescs++;
      })
    );
  }

  console.log(
    `[truth-social] Status pages: ${toFetch.length} fetched (new ids) — ${withImages} with image URL(s), ${withDescs} with description(s)`
  );
}

export async function runTruthSocialIngestOnce(): Promise<void> {
  const res = await fetch(RSS_FEED_URL);
  if (!res.ok) {
    console.error(`[truth-social] RSS HTTP ${res.status}`);
    return;
  }

  const xml = await res.text();
  const parser = new Parser({ explicitArray: false });
  const result = (await parser.parseStringPromise(xml)) as {
    rss?: { channel?: { item?: unknown } };
  };

  const channel = result.rss?.channel;
  let items = channel?.item;
  if (!items) {
    console.log('[truth-social] No items in RSS feed');
    return;
  }
  const itemArray = Array.isArray(items) ? items : [items];

  const nowISO = new Date().toISOString();
  const fieldsList: TruthRssFields[] = [];

  for (const raw of itemArray) {
    if (!raw || typeof raw !== 'object') continue;
    const f = extractTruthRssFields(raw as Record<string, unknown>);
    if (f) fieldsList.push(f);
  }

  await enrichFromStatusPages(fieldsList);

  const tweets: NormalizedTweet[] = fieldsList.map((f) =>
    buildTruthTweetFromFields(f, nowISO)
  );

  if (tweets.length === 0) {
    console.log('[truth-social] No @realdonaldtrump posts in feed');
    return;
  }

  const db = await getDb();
  const tweetsCol = db.collection<NormalizedTweet>('tweets');

  let updatedMainRows = 0;
  const rssFallbackInserts: NormalizedTweet[] = [];

  for (const tweet of tweets) {
    const existingMain = await tweetsCol.findOne({
      tweetId: tweet.tweetId,
      source: 'civictracker-truth-social',
    });

    if (existingMain) {
      const setPayload: Partial<NormalizedTweet> = {
        tweetUrl: tweet.tweetUrl,
        ...(tweet.originalTruthId ? { originalTruthId: tweet.originalTruthId } : {}),
        ...(tweet.images.length > 0 ? { images: tweet.images, imageCount: tweet.imageCount } : {}),
        ...(tweet.imageDescriptions && tweet.imageDescriptions.length > 0
          ? { imageDescriptions: tweet.imageDescriptions }
          : {}),
        ...(tweet.mainText &&
        tweet.mainText !== `[Media-only post (no text in RSS mirror) — open link] ${tweet.tweetUrl}`
          ? { mainText: tweet.mainText }
          : {}),
      };

      if (Object.keys(setPayload).length > 0) {
        await tweetsCol.updateOne(
          { _id: (existingMain as any)._id },
          { $set: setPayload }
        );
        updatedMainRows += 1;
      }
      continue;
    }

    rssFallbackInserts.push(tweet);
  }

  const inserted = await deduplicateAndInsert(rssFallbackInserts);
  console.log(
    `[truth-social] RSS handled ${tweets.length} post(s): updated ${updatedMainRows} CivicTracker row(s), inserted ${inserted} fallback RSS row(s)`
  );
}
