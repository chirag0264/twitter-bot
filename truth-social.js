/**
 * Standalone RSS → trump_truths.json test script only.
 * NOT used by npm start / src/index.ts. Production Truth Social path:
 * truthSocialIngestJob.ts → Mongo tweets → slowPath → Grok (incl. vision when RSS has image URLs).
 *
 * CLI:
 *   node truth-social.js              — poller + Telegram (optional)
 *   node truth-social.js --audit      — print latest 20 posts (images + descriptions), no file write
 *   node truth-social.js --audit --write | -w  — same audit, merge results into trump_truths.json
 *   node truth-social.js --backfill   — enrich existing JSON rows with image URLs from status pages
 */
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js"); // Will need to install this package

// --- CONFIGURATION ---
const TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";       // Replace with your BotFather token
const TELEGRAM_CHAT_ID = "YOUR_TELEGRAM_CHAT_ID";           // Replace with your chat ID
const RSS_FEED_URL = "https://www.trumpstruth.org/feed";
const DATA_FILE = path.join(__dirname, "trump_truths.json");
const POLLING_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes, as the site updates every few minutes
const TARGET_TRUTH_ACCOUNT = "realdonaldtrump";
let telegramDisabled = false;

// --- HELPERS ---
function getStoredPosts() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(data);
    } catch (e) {
      console.error("Error reading or parsing data file:", e);
      return [];
    }
  }
  return [];
}

function storePosts(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2), "utf8");
}

async function sendTelegramMessage(text) {
  const tokenMissing =
    !TELEGRAM_BOT_TOKEN ||
    TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN";
  const chatMissing =
    !TELEGRAM_CHAT_ID || TELEGRAM_CHAT_ID === "YOUR_TELEGRAM_CHAT_ID";

  if (telegramDisabled || tokenMissing || chatMissing) {
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: true, // Prevent Telegram from generating a preview for the link
      }),
    });
    const result = await response.json();
    if (!result.ok) {
      const description = String(result.description || "");
      if (description.toLowerCase().includes("not found")) {
        telegramDisabled = true;
        console.warn(
          "Telegram endpoint not found. Notifications disabled; storing posts only."
        );
        return false;
      }
      console.error("Telegram Error:", description);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
    return false;
  }
}

// --- CORE LOGIC ---
async function fetchAndParseRssFeed() {
  try {
    const response = await fetch(RSS_FEED_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const xml = await response.text();
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xml);
    let items = result.rss?.channel?.item || [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    return items;
  } catch (error) {
    console.error("Error fetching or parsing RSS feed:", error);
    return [];
  }
}

function getItemSourceUrl(item) {
  if (!item) return "";
  const guid = item.guid;
  if (typeof guid === "string") return guid;
  if (guid && typeof guid._ === "string") return guid._;
  return "";
}

function isTargetAccountPost(item) {
  if (!item) return false;
  const guid = getItemSourceUrl(item).toLowerCase();
  const link = String(item.link || "").toLowerCase();
  if (guid.includes(`truthsocial.com/@${TARGET_TRUTH_ACCOUNT}/`)) return true;
  if (link.includes(`truthsocial.com/@${TARGET_TRUTH_ACCOUNT}/`)) return true;
  // trumpstruth.org feed uses /statuses/37505 guids (Trump-only archive)
  if (/trumpstruth\.org\/statuses\/\d+/.test(guid)) return true;
  if (/trumpstruth\.org\/statuses\/\d+/.test(link)) return true;
  return false;
}

function getContentEncoded(item) {
  const v =
    item["content:encoded"] ?? item.contentEncoded ?? item.content;
  return typeof v === "string" ? v : "";
}

function extractImageUrlsFromHtml(html) {
  if (!html || typeof html !== "string") return [];
  const urls = new Set();
  const re = /<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1].trim();
    if (u && !u.startsWith("data:")) urls.add(u);
  }
  return [...urls];
}

function getEnclosureImageUrls(item) {
  const enc = item.enclosure;
  if (!enc) return [];
  const list = Array.isArray(enc) ? enc : [enc];
  const urls = [];
  for (const e of list) {
    if (e && typeof e === "object" && e.$) {
      const url = e.$.url;
      const type = String(e.$.type || "").toLowerCase();
      if (url && (type.startsWith("image/") || !type)) urls.push(url);
    }
  }
  return urls;
}

/** Same sources as truthSocialIngestJob.ts — for testing whether RSS actually carries image URLs. */
function parseItemImages(item) {
  const desc = typeof item.description === "string" ? item.description : "";
  const encoded = getContentEncoded(item);
  const blob = `${desc}\n${encoded}`;
  const fromHtml = extractImageUrlsFromHtml(blob);
  const fromEnc = getEnclosureImageUrls(item);
  return [...new Set([...fromHtml, ...fromEnc])];
}

/**
 * Fetches the trumpstruth.org status HTML page and extracts:
 *   - Full-res image URLs (truth-archive.us-iad-1.linodeobjects.com only — publicly accessible)
 *   - AI-generated image descriptions from the "Image Description:" sections
 *
 * Using text descriptions instead of raw image URLs avoids 403 errors from
 * the Truth Social CDN when Grok tries to fetch them.
 */
async function fetchStatusPageData(statusLink) {
  if (!statusLink) return { images: [], imageDescriptions: [] };
  try {
    const res = await fetch(statusLink, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; trumpstruth-audit/1.0)" },
    });
    if (!res.ok) {
      console.log(`[test] Status page ${statusLink} returned HTTP ${res.status}`);
      return { images: [], imageDescriptions: [] };
    }
    const html = await res.text();

    // --- Image URLs (public archive only, skip 403-prone CDN) ---
    const urls = new Set();
    const linodeHref = /href="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
    const linoSrc   = /src="(https:\/\/truth-archive\.us-iad-1\.linodeobjects\.com\/attachments\/[^"]+)"/gi;
    let m;
    while ((m = linodeHref.exec(html)) !== null) urls.add(m[1].trim());
    while ((m = linoSrc.exec(html))   !== null) urls.add(m[1].trim());

    // --- Image descriptions from the "File Attachments" section ---
    // The archive site AI-captions every image; we grab the text and use it
    // as input to Grok instead of the image URL — no 403, no vision tokens.
    const descriptions = [];

    // Strategy 1: .status-details-attachment__text div (most complete)
    const detailBlockRe = /class="status-details-attachment__text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = detailBlockRe.exec(html)) !== null) {
      const text = m[1]
        .replace(/<[^>]+>/g, " ")   // strip any inline tags
        .replace(/\s+/g, " ")
        .trim();
      if (text && text.length > 10) descriptions.push(text);
    }

    // Strategy 2: alt attribute on .status-attachment__image (shorter but always present)
    if (descriptions.length === 0) {
      const altRe = /class="status-attachment__image"[^>]*alt="([^"]+)"/gi;
      while ((m = altRe.exec(html)) !== null) {
        const text = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
        if (text && text.length > 10) descriptions.push(text);
      }
    }

    return {
      images: [...urls],
      imageDescriptions: descriptions,
    };
  } catch (e) {
    console.error(`[test] Failed to fetch status page ${statusLink}: ${e.message}`);
    return { images: [], imageDescriptions: [] };
  }
}

/** Legacy thin wrapper so --backfill still works. */
async function fetchStatusPageImages(statusLink) {
  const { images } = await fetchStatusPageData(statusLink);
  return images;
}

function shapePost(item) {
  const images = parseItemImages(item);
  return {
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    description: item.description,
    images,
    imageCount: images.length,
  };
}

/**
 * Like shapePost but also fetches the status page to grab:
 *   - Image URLs (for posts where RSS description is empty)
 *   - Image descriptions (text captions generated by the archive site)
 *
 * Image descriptions are preferred over raw URLs for Grok because the Truth
 * Social CDN returns 403 to external fetchers — text captions always work.
 */
async function shapePostWithPageFetch(item) {
  const base = shapePost(item);

  const pageLink = item.link || getItemSourceUrl(item);
  if (!pageLink) return base;

  // Always fetch status page so we get descriptions even for text posts with embeds
  const needsPageFetch = base.imageCount === 0;
  if (!needsPageFetch) {
    // Has RSS images — still fetch page for descriptions only
    console.log(`[test]   ↳ Has RSS images but fetching page for descriptions: ${pageLink}`);
  } else {
    console.log(`[test]   ↳ RSS had 0 images, fetching status page: ${pageLink}`);
  }

  const { images: pageImages, imageDescriptions } = await fetchStatusPageData(pageLink);

  return {
    ...base,
    images: base.imageCount > 0 ? base.images : pageImages,
    imageCount: base.imageCount > 0 ? base.imageCount : pageImages.length,
    imageDescriptions,
    imageDescriptionCount: imageDescriptions.length,
    imageSource: pageImages.length > 0 ? "status-page" : (base.imageCount > 0 ? "rss" : "none"),
  };
}

function logImageAudit(posts, label) {
  console.log(`\n[test] ${label}:`);
  let withImg = 0;
  let withDesc = 0;
  for (const p of posts) {
    if (p.imageCount > 0) withImg++;
    if (p.imageDescriptions && p.imageDescriptions.length > 0) withDesc++;
    const titleShort = String(p.title || "").slice(0, 60);
    const src = p.imageSource ? ` [src:${p.imageSource}]` : "";
    const descCount = p.imageDescriptions ? p.imageDescriptions.length : 0;
    console.log(`  imgs=${p.imageCount} descs=${descCount}${src} | ${titleShort}`);
    for (const u of (p.images || [])) console.log(`    🖼  ${u}`);
    for (const d of (p.imageDescriptions || [])) console.log(`    📝  ${d.slice(0, 120)}${d.length > 120 ? "…" : ""}`);
  }
  console.log(
    `[test] Summary: ${withImg}/${posts.length} have image URL | ${withDesc}/${posts.length} have image description\n`
  );
}

async function poll() {
  console.log(`[${new Date().toISOString()}] Polling RSS feed...`);
  const feedItems = await fetchAndParseRssFeed();
  if (feedItems.length === 0) {
    console.log("No items found in RSS feed.");
    return;
  }
  const trumpItems = feedItems.filter(isTargetAccountPost);
  if (trumpItems.length === 0) {
    console.log(`No posts found for @${TARGET_TRUTH_ACCOUNT} in feed.`);
    return;
  }

  const storedPosts = getStoredPosts();
  const storedLinks = new Set(storedPosts.map(p => p.link));
  
  const newItems = trumpItems.filter(item => !storedLinks.has(item.link));

  if (newItems.length > 0) {
    console.log(`Found ${newItems.length} new post(s) — fetching status pages for images…`);
    const newPosts = await Promise.all(newItems.map(shapePostWithPageFetch));
    logImageAudit(newPosts, "New posts this poll");

    for (const post of [...newPosts].reverse()) {
      const message = `<b>🚨 NEW TRUTH FROM TRUMP</b>\n\n${post.title}\n\n<a href="${post.link}">View on trumpstruth.org</a>`;
      await sendTelegramMessage(message);
    }

    const updatedList = [...newPosts, ...storedPosts].sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    storePosts(updatedList.slice(0, 100));
  } else {
    console.log("No new posts.");
  }
}

async function init() {
  console.log("Starting Trump Truth Social Monitor (trumpstruth.org RSS + Telegram)...");
  if (
    !TELEGRAM_BOT_TOKEN ||
    TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN" ||
    !TELEGRAM_CHAT_ID ||
    TELEGRAM_CHAT_ID === "YOUR_TELEGRAM_CHAT_ID"
  ) {
    console.log("Telegram config missing. Running in store-only mode.");
  }
  
  // Initial run to populate storage if empty; also backfill missing images in existing entries
  let storedPosts = getStoredPosts();
  if (storedPosts.length === 0) {
    console.log("First run: Initializing storage with latest posts from RSS...");
    const feedItems = await fetchAndParseRssFeed();
    const trumpItems = feedItems.filter(isTargetAccountPost);
    if (trumpItems.length > 0) {
      const initialPosts = await Promise.all(trumpItems.slice(0, 10).map(shapePostWithPageFetch));
      logImageAudit(initialPosts, "Initial seed (10 latest)");
      storePosts(initialPosts);
      console.log("Storage initialized with 10 posts. Notifications will start from the next new post.");
    } else {
      console.log(`Could not fetch initial posts for @${TARGET_TRUTH_ACCOUNT} from RSS feed.`);
    }
  } else {
    // Backfill image URLs for any stored entries that are missing them
    const needsImages = storedPosts.filter(p => !p.images || p.imageCount === 0);
    if (needsImages.length > 0) {
      console.log(`Backfilling images for ${needsImages.length} stored post(s) missing image data…`);
      await Promise.all(needsImages.map(async (p) => {
        const pageImages = await fetchStatusPageImages(p.link);
        if (pageImages.length > 0) {
          p.images = pageImages;
          p.imageCount = pageImages.length;
        } else {
          p.images = p.images || [];
          p.imageCount = p.imageCount || 0;
        }
      }));
      storePosts(storedPosts);
      const enriched = needsImages.filter(p => p.imageCount > 0).length;
      console.log(`Backfill complete: ${enriched}/${needsImages.length} posts now have image URLs.`);
    }
  }

  // Set interval
  setInterval(poll, POLLING_INTERVAL_MS);
  // Run immediately once
  poll();
}

async function runAuditOnly() {
  const writeJson = process.argv.includes("--write") || process.argv.includes("-w");
  console.log(
    writeJson
      ? "RSS image audit + merge into trump_truths.json (--write)…"
      : "RSS image audit (console only — add --write to save trump_truths.json)…"
  );
  const feedItems = await fetchAndParseRssFeed();
  console.log(`[test] Raw feed items: ${feedItems.length}`);
  const trumpItems = feedItems.filter(isTargetAccountPost);
  if (trumpItems.length === 0 && feedItems.length > 0) {
    console.log(
      "[test] No items matched @realdonaldtrump in guid. First 3 guids:",
      feedItems.slice(0, 3).map((i) => getItemSourceUrl(i))
    );
  }

  const top20 = trumpItems.slice(0, 20);
  console.log(`[test] Shaping ${top20.length} items (fetching status pages for images + descriptions)…`);
  const shaped = await Promise.all(top20.map(shapePostWithPageFetch));
  logImageAudit(shaped, "Latest 20 @realdonaldtrump items (RSS + status-page: URLs & descriptions)");

  if (writeJson) {
    const existing = getStoredPosts();
    const byLink = new Map(existing.map((p) => [p.link, p]));
    for (const p of shaped) {
      byLink.set(p.link, p);
    }
    const merged = [...byLink.values()].sort(
      (a, b) => new Date(b.pubDate) - new Date(a.pubDate)
    );
    storePosts(merged.slice(0, 100));
    console.log(
      `[test] Saved ${shaped.length} audited row(s) into ${DATA_FILE} (${merged.length} total after merge, cap 100).`
    );
  }

  process.exit(0);
}

async function runBackfillOnly() {
  console.log("Backfilling images in trump_truths.json (no poller, no Telegram)…");
  const storedPosts = getStoredPosts();
  if (storedPosts.length === 0) {
    console.log("No stored posts to backfill.");
    process.exit(0);
  }
  const needsImages = storedPosts.filter(p => !p.images || p.imageCount === 0);
  console.log(`${needsImages.length}/${storedPosts.length} posts missing image data.`);
  if (needsImages.length === 0) {
    console.log("Nothing to backfill.");
    process.exit(0);
  }
  let enriched = 0;
  for (let i = 0; i < needsImages.length; i += STATUS_PAGE_CONCURRENCY) {
    const chunk = needsImages.slice(i, i + STATUS_PAGE_CONCURRENCY);
    await Promise.all(chunk.map(async (p) => {
      process.stdout.write(`  → ${p.link} … `);
      const imgs = await fetchStatusPageImages(p.link);
      p.images = imgs;
      p.imageCount = imgs.length;
      if (imgs.length > 0) {
        enriched++;
        console.log(`${imgs.length} image(s)`);
      } else {
        console.log("none");
      }
    }));
  }
  storePosts(storedPosts);
  console.log(`\nBackfill done: ${enriched}/${needsImages.length} posts now have images. Saved to trump_truths.json`);
  process.exit(0);
}

const STATUS_PAGE_CONCURRENCY = 5;

if (process.argv.includes("--audit")) {
  runAuditOnly().catch((e) => { console.error(e); process.exit(1); });
} else if (process.argv.includes("--backfill")) {
  runBackfillOnly().catch((e) => { console.error(e); process.exit(1); });
} else {
  init();
}
