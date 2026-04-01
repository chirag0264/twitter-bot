/**
 * CivicTracker executive member feed → Truth Social (and optional all-platform) posts.
 *
 * The member HTML page renders an empty #socialPostsContainer and fills it via the same
 * REST proxy the browser uses:
 *   GET .../wp-json/civictracker/v1/proxy/social-posts
 *
 * Usage:
 *   node index.js
 *   node index.js --uuid 3094abf7-4a95-4b8d-8c8d-af7d1c3747a1
 *   node index.js --max 50
 *   node index.js --all-platforms
 *
 * Poll + JSON store (posts deduped by id; poll_log controlled by --poll-log):
 *   node index.js --poll
 *   node index.js --poll --poll-log errors     # default: only failed requests in poll_log; skip disk write if no new posts
 *   node index.js --poll --poll-log all        # every probe (rate-limit debugging)
 *   node index.js --poll --poll-log none       # never poll_log; still merge new posts
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const DEFAULT_UUID = "3094abf7-4a95-4b8d-8c8d-af7d1c3747a1";
const PROXY_BASE = "https://civictracker.us/wp-json/civictracker/v1/proxy";

const UA =
  "Mozilla/5.0 (compatible; backend-twitter-bot/1.0; CivicTracker feed reader)";

const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_OUT_FILE = path.join(__dirname, "civictracker_truth_posts.json");

function parseArgs(argv) {
  const out = {
    uuid: DEFAULT_UUID,
    pageSize: 20,
    maxPosts: Infinity,
    truthOnly: true,
    poll: false,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
    outFile: DEFAULT_OUT_FILE,
    runs: 0,
    pollLimit: 20,
    capPosts: 5000,
    pollLog: "errors",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all-platforms") out.truthOnly = false;
    else if (a === "--poll") out.poll = true;
    else if (a === "--poll-log-all") out.pollLog = "all";
    else if (a === "--poll-log" && argv[i + 1]) {
      const v = String(argv[++i]).toLowerCase();
      if (v === "all" || v === "errors" || v === "none") out.pollLog = v;
    }
    else if (a === "--uuid" && argv[i + 1]) {
      out.uuid = argv[++i];
    } else if (a === "--max" && argv[i + 1]) {
      out.maxPosts = Math.max(1, parseInt(argv[++i], 10) || 50);
    } else if (a === "--page-size" && argv[i + 1]) {
      out.pageSize = Math.min(100, Math.max(1, parseInt(argv[++i], 10) || 20));
    } else if (a === "--interval-ms" && argv[i + 1]) {
      out.intervalMs = Math.max(1000, parseInt(argv[++i], 10) || DEFAULT_POLL_INTERVAL_MS);
    } else if (a === "--out" && argv[i + 1]) {
      out.outFile = path.resolve(argv[++i]);
    } else if (a === "--runs" && argv[i + 1]) {
      out.runs = Math.max(0, parseInt(argv[++i], 10) || 0);
    } else if (a === "--poll-limit" && argv[i + 1]) {
      out.pollLimit = Math.min(100, Math.max(1, parseInt(argv[++i], 10) || 20));
    } else if (a === "--cap" && argv[i + 1]) {
      out.capPosts = Math.max(100, parseInt(argv[++i], 10) || 5000);
    }
  }
  return out;
}

function isTruthSocialPost(post) {
  return String(post.platform || "")
    .toLowerCase()
    .includes("truth");
}

function slimPost(post) {
  return {
    id: post.id,
    platform: post.platform,
    post_id: post.post_id,
    content: post.content,
    posted_at: post.posted_at,
    original_url: post.original_url,
    has_media: post.has_media,
    media_urls: post.media_urls || [],
    username: post.username,
  };
}

function pickRateLimitHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  const keys = [
    "retry-after",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "ratelimit-limit",
    "ratelimit-remaining",
    "ratelimit-reset",
    "cf-ray",
  ];
  for (const k of keys) {
    const v = headers[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

async function fetchSocialPage(officialUuid, limit, offset) {
  const url = `${PROXY_BASE}/social-posts`;
  const res = await axios.get(url, {
    params: {
      limit,
      offset,
      branch: "executive",
      official_uuid: officialUuid,
    },
    headers: { "User-Agent": UA },
    validateStatus: () => true,
  });

  const { data, status, headers } = res;
  if (status !== 200) {
    const err = new Error(`HTTP ${status}: ${JSON.stringify(data).slice(0, 400)}`);
    err.status = status;
    err.headers = headers;
    err.data = data;
    throw err;
  }
  if (data && data.code && data.message) {
    const err = new Error(`${data.code}: ${data.message}`);
    err.status = status;
    err.headers = headers;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * One GET; returns success payload or error info (for poller / rate-limit tests).
 */
async function fetchSocialPageProbe(officialUuid, limit, offset) {
  const url = `${PROXY_BASE}/social-posts`;
  const started = Date.now();
  try {
    const res = await axios.get(url, {
      params: {
        limit,
        offset,
        branch: "executive",
        official_uuid: officialUuid,
      },
      headers: { "User-Agent": UA },
      validateStatus: () => true,
      timeout: 60000,
    });
    const { data, status, headers } = res;
    const rl = pickRateLimitHeaders(headers);
    const ms = Date.now() - started;

    if (status !== 200) {
      return {
        ok: false,
        httpStatus: status,
        latency_ms: ms,
        rateLimitHeaders: rl,
        bodySnippet: typeof data === "object" ? JSON.stringify(data).slice(0, 500) : String(data).slice(0, 500),
        posts: [],
        has_more: false,
      };
    }
    if (data && data.code && data.message) {
      return {
        ok: false,
        httpStatus: status,
        latency_ms: ms,
        rateLimitHeaders: rl,
        apiCode: data.code,
        apiMessage: data.message,
        posts: [],
        has_more: false,
      };
    }

    return {
      ok: true,
      httpStatus: status,
      latency_ms: ms,
      rateLimitHeaders: rl,
      posts: data.posts || [],
      has_more: Boolean(data.has_more),
      total: typeof data.total === "number" ? data.total : null,
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: e.response?.status ?? null,
      latency_ms: Date.now() - started,
      rateLimitHeaders: pickRateLimitHeaders(e.response?.headers),
      error: e.message || String(e),
      posts: [],
      has_more: false,
    };
  }
}

function readStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.posts)) return j;
  } catch (_) {
    /* missing or invalid */
  }
  return {
    meta: {},
    posts: [],
    poll_log: [],
  };
}

function writeStore(filePath, store) {
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8");
}

function mergePosts(existing, incoming, truthOnly, cap) {
  const byId = new Map();
  for (const p of existing) {
    if (p && typeof p.id === "number") byId.set(p.id, p);
  }
  for (const p of incoming) {
    if (truthOnly && !isTruthSocialPost(p)) continue;
    const s = slimPost(p);
    byId.set(s.id, s);
  }
  const merged = [...byId.values()].sort((a, b) => {
    const ta = new Date(a.posted_at || 0).getTime();
    const tb = new Date(b.posted_at || 0).getTime();
    return tb - ta;
  });
  return merged.slice(0, cap);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runPoller(opts) {
  const {
    uuid,
    truthOnly,
    intervalMs,
    outFile,
    runs,
    pollLimit,
    capPosts,
    pollLog,
  } = opts;

  let store = readStore(outFile);
  if (!store.meta) store.meta = {};
  if (!Array.isArray(store.posts)) store.posts = [];
  if (!Array.isArray(store.poll_log)) store.poll_log = [];

  store.meta.official_uuid = uuid;
  store.meta.filter = truthOnly ? "truth_social_only" : "all_platforms";
  store.meta.poll_interval_ms = intervalMs;
  store.meta.out_file = outFile;

  let iteration = 0;

  console.log(
    `[civic-poll] started uuid=${uuid} interval=${intervalMs}ms out=${outFile} truthOnly=${truthOnly} poll_log=${pollLog}` +
      (runs > 0 ? ` runs=${runs}` : " (infinite)")
  );

  for (;;) {
    iteration += 1;
    const probe = await fetchSocialPageProbe(uuid, pollLimit, 0);

    const logEntry = {
      at: new Date().toISOString(),
      iteration,
      ok: probe.ok,
      http_status: probe.httpStatus,
      latency_ms: probe.latency_ms,
      posts_in_response: probe.posts?.length ?? 0,
      rate_limit_headers:
        Object.keys(probe.rateLimitHeaders || {}).length > 0
          ? probe.rateLimitHeaders
          : undefined,
      api_code: probe.apiCode,
      api_message: probe.apiMessage,
      error: probe.error,
      body_snippet: probe.bodySnippet,
    };

    function appendPollLog() {
      store.poll_log.push(logEntry);
      store.poll_log = store.poll_log.slice(-200);
    }

    if (probe.ok) {
      const idsBefore = new Set(store.posts.map((p) => p.id));
      store.posts = mergePosts(store.posts, probe.posts || [], truthOnly, capPosts);
      const newIds = store.posts.filter((p) => !idsBefore.has(p.id)).length;
      store.meta.last_ok_poll_at = logEntry.at;
      store.meta.last_post_count = store.posts.length;
      store.meta.api_total = probe.total ?? store.meta.api_total;
      if (newIds > 0) {
        store.meta.last_new_posts_at = logEntry.at;
        store.meta.last_new_posts_count = newIds;
      }

      if (pollLog === "all") appendPollLog();

      const line =
        `[civic-poll] #${iteration} OK ${probe.httpStatus} ${probe.latency_ms}ms ` +
        `page=${(probe.posts || []).length} new_in_store=${newIds} total_stored=${store.posts.length} has_more=${probe.has_more}` +
        (Object.keys(probe.rateLimitHeaders || {}).length
          ? ` rl=${JSON.stringify(probe.rateLimitHeaders)}`
          : "");
      console.log(line);

      // Avoid rewriting the whole JSON on every tick when nothing changed.
      const shouldWrite = newIds > 0 || pollLog === "all";
      if (shouldWrite) writeStore(outFile, store);
    } else {
      store.meta.last_error_at = logEntry.at;
      store.meta.last_error =
        logEntry.api_message || logEntry.body_snippet || logEntry.error || "unknown";
      if (pollLog !== "none") appendPollLog();
      writeStore(outFile, store);

      console.warn(
        `[civic-poll] #${iteration} FAIL http=${logEntry.http_status} ` +
          `${logEntry.latency_ms}ms ${logEntry.api_code || ""} ${store.meta.last_error}` +
          (logEntry.rate_limit_headers
            ? ` rl=${JSON.stringify(logEntry.rate_limit_headers)}`
            : "")
      );
    }

    if (runs > 0 && iteration >= runs) break;
    await sleep(intervalMs);
  }

  console.log(`[civic-poll] stopped after ${iteration} iteration(s)`);
}

async function scrapeCivicTrackerMemberPosts(options) {
  const {
    uuid: officialUuid,
    pageSize,
    maxPosts,
    truthOnly,
  } = options;

  const collected = [];
  let apiTotal = null;
  // CivicTracker currently rejects any offset other than 0 on this endpoint,
  // so treat it as a single-page fetch and rely on `limit`.
  const page = await fetchSocialPage(officialUuid, pageSize, 0);
  const posts = page.posts || [];
  if (typeof page.total === "number") apiTotal = page.total;

  for (const p of posts) {
    if (truthOnly && !isTruthSocialPost(p)) continue;
    collected.push(slimPost(p));
    if (collected.length >= maxPosts) break;
  }

  return {
    source: "civictracker.us",
    official_uuid: officialUuid,
    filter: truthOnly ? "truth_social_only" : "all_platforms",
    api_reported_total: apiTotal,
    posts_returned: collected.length,
    posts: collected,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.poll) {
    await runPoller(opts);
    return;
  }
  const result = await scrapeCivicTrackerMemberPosts(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

module.exports = {
  scrapeCivicTrackerMemberPosts,
  fetchSocialPage,
  fetchSocialPageProbe,
  runPoller,
  PROXY_BASE,
  DEFAULT_UUID,
  DEFAULT_OUT_FILE,
};
