import axios from 'axios';
import { config } from './config';
import { NormalizedTweet } from './normalizeTweet';

const GROK_MODEL = 'grok-4-1-fast-reasoning';

/** Max images appended per request (xAI fetches URLs server-side). */
const GROK_VISION_MAX_IMAGES = Number(
  process.env.GROK_VISION_MAX_IMAGES ?? '16'
);
const GROK_VISION_MAX_PER_POST = Number(
  process.env.GROK_VISION_MAX_PER_POST ?? '4'
);

// Minimal Grok client using xAI-style chat completions API.
// You may need to adjust the URL/shape to match your xAI account.
const GROK_API_URL = process.env.GROK_API_URL || 'https://api.x.ai/v1/chat/completions';

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Vision APIs expect raster images, not video attachments. */
function isLikelyVideoUrl(u: string): boolean {
  const path = u.split('?')[0].toLowerCase();
  return /\.(mp4|webm|mov|m4v|mkv|mpeg)(\?|$)/.test(path);
}

/** Truth Social CDN often returns 403 to xAI's image fetcher — skip for vision. */
function isLikelyBlockedVisionUrl(u: string): boolean {
  return /static-assets[^/]*\.truthsocial\.com/i.test(u);
}

/**
 * Build the vision attachment list in strict per-post order so the prompt's
 * "each post's images correspond to that post's imageUrls" statement is exact.
 *
 * No cross-post dedup: if the same URL appears in two posts it is attached
 * twice (rare in practice) so the model can map images ↔ posts reliably.
 * Only caps applied: perPost per post, maxTotal globally.
 */
function collectVisionImageUrls(tweets: NormalizedTweet[]): string[] {
  const maxTotal = Math.max(1, Math.min(32, GROK_VISION_MAX_IMAGES));
  const perPost = Math.max(1, Math.min(8, GROK_VISION_MAX_PER_POST));
  const out: string[] = [];

  for (const t of tweets) {
    const imgs = (t.images || []).filter(
      (u) =>
        isHttpUrl(u) &&
        !isLikelyVideoUrl(u) &&
        !isLikelyBlockedVisionUrl(u)
    );
    for (const u of imgs.slice(0, perPost)) {
      out.push(u.trim());
      if (out.length >= maxTotal) return out;
    }
  }
  return out;
}

/** Crisp one-story rule: only structural changes in an ongoing story are breaking. */
const ONE_STORY_RULE = `
## ONE-STORY RULE
For any major ongoing story (war, conflict, crisis): only the FIRST development is breaking. After that, flag ONLY a STRUCTURAL change: conflict ends/pauses (ceasefire, peace deal), new state formally enters (Article 5), chokepoint confirmed open/shut, nuclear dimension confirmed, or hard data materially worsens supply. Everything else — more strikes, leadership killed, new targets, statements, envoy comments — is NOT breaking (breaking: []).
This rule applies to market events too: if multiple posts from different accounts report the same S&P500/Nasdaq100 crash on the same US trading day (ET session), only the FIRST is breaking; later posts adding percentages or dollar-loss figures are NOT breaking (breaking: []).
`.trim();

function buildPrompt(
  tweets: NormalizedTweet[],
  context?: string,
  visionUrlsForBlock?: string[]
): string {
  const visionUrls = visionUrlsForBlock ?? collectVisionImageUrls(tweets);
  const perPost = Math.max(1, Math.min(8, GROK_VISION_MAX_PER_POST));

  const trunc = (s: string | null | undefined, max = 1000): string =>
    (s ?? '').slice(0, max);

  const tweetsJson = JSON.stringify(
    tweets.map((t) => {
      const imageUrls = (t.images || [])
        .filter(
          (u) =>
            isHttpUrl(u) &&
            !isLikelyVideoUrl(u) &&
            !isLikelyBlockedVisionUrl(u)
        )
        .slice(0, perPost);
      const descs = (t.imageDescriptions || []).slice(0, perPost);
      return {
        mainText: trunc(t.mainText),
        quotedText: trunc(t.quotedText),
        quotedAuthor: t.quotedAuthor ?? '',
        authorUsername: t.authorUsername,
        tweetUrl: t.tweetUrl,
        quotedUrl: t.quotedUrl ?? '',
        tweetId: t.tweetId,
        sourcePlatform: t.sourcePlatform || 'twitter',
        imageUrls,
        ...(descs.length > 0 ? { imageDescriptions: descs } : {}),
      };
    })
  );

  const visionBlock =
    visionUrls.length > 0
      ? `## VISION (multimodal)
This message includes ${visionUrls.length} image attachment(s) appended after the text in strict per-post order: all images for post[0] first (in imageUrls order), then all images for post[1], and so on, up to the global cap. A post with an empty imageUrls contributes zero attachments; the next attachment belongs to the next post that has imageUrls. Use visible text, charts, screenshots, and headlines in images together with mainText and quotedText. If an image fails to load, rely on text fields only. Note: a post may have imageDescriptions but no imageUrls — in that case imageDescriptions are the sole media context and must be used.

`
      : '';

  const contextBlock =
    context && context.trim()
      ? `${context.trim()}\n\n`
      : '';

  return `${ONE_STORY_RULE}\n\n${contextBlock}${visionBlock}You are a CRYPTO MARKET breaking-news detector. Focus ONLY on news that can realistically move cryptocurrency prices in the next 0–48 hours.

Here are new posts from monitored accounts (Twitter and/or Truth Social):
${tweetsJson}

Each input object contains:
- sourcePlatform: "twitter" or "truth-social" (where the post was published)
- mainText: The author's own words/reaction
- quotedText: Content they're quoting (if any)
- quotedAuthor: Who they're quoting
- authorUsername: The main author handle
- tweetUrl: Link to the post (Twitter or Truth Social)
- quotedUrl: Link to the quoted post (if any)
- tweetId: Unique id (Truth Social ids are prefixed ts_)
- imageUrls: Public http(s) image URLs safe for vision (Linode archive, Twitter CDN, etc.; Truth Social static-asset URLs are omitted because they often 403 externally)
- imageDescriptions: Optional text captions from trumpstruth.org for Truth Social attachments — use these as ground truth for embedded screenshots/media when imageUrls are missing or fail to load

Your Task:
For EACH post (same order as input), create ONE JSON object with:
1. "summary": 1-2 sentence summary (combine mainText + quotedText context if both exist)
2. "breaking": Array (0 or 1 items) for breaking news

Breaking News Criteria:
A post is breaking news ONLY if it meets ALL THREE conditions:
1. Urgent, new, and time-sensitive
2. CONFIRMED event — passes ONE of these bars:
   (a) Primary-source confirmation: official statement, direct quote from authority, or the author IS the primary source (e.g. a president posting directly).
   (b) Major outlet (Bloomberg/Reuters/WSJ/FT) explicitly states the event HAS happened — not "is considering", "in talks", or "sources say". A post merely quoting or linking Bloomberg does NOT count; the Bloomberg/Reuters report itself must describe a completed fact.
   Anything else ("reportedly", "sources say", "said to", rumours, speculation) = NOT confirmed = NOT breaking.
3. Falls into ONE of these categories that can realistically move BTC/ETH within 0–48h:

Web3/Crypto (any ONE of these):
- Exchange outages, hacks, exploits (major exchanges: Binance, Coinbase, Kraken, OKX, Bybit)
- Major token listings/delistings on top 5 exchanges
- NEW PLATFORM LAUNCHES from major exchanges (like KuCoin Alpha)
- Protocol exploits/vulnerabilities (>$10M impact)
- Major governance decisions affecting token prices
- DeFi hacks, rug pulls, liquidations (>$10M)
- Blockchain network disruptions or hard forks
- Major crypto partnerships/acquisitions (>$100M deals)
- Regulatory actions SPECIFICALLY targeting crypto (SEC/CFTC crypto enforcement, new crypto laws)
- Crypto company funding rounds (>$50M) ONLY if they materially change market structure (e.g., new major exchange, L2 infrastructure, stablecoin infrastructure, or trading venue)
- WHALE ACTIVITY: Large on-chain BTC/ETH transactions (>$50M)
- Major exchange announcements affecting trading
- Bitcoin/Ethereum ETF approvals/denials, major flows, or major court/regulatory rulings
- ETF flows: confirmed daily BTC/ETH ETF net flows that are unusually large (ex: >$500M net in/out)
- Stablecoin issuer action: freezes, banking disruption, or sudden large mint/burn events affecting major stablecoins (USDT, USDC, DAI)
- Stablecoin depegs or major stablecoin regulatory news

Macro/Markets (breaking ONLY if confirmed AND likely to move BTC/ETH within 0–48h):

PRIORITY: Major equity index regime shifts (S&P500 or Nasdaq100 only)
- Breaking if EITHER condition is met (confirmed by credible outlet or primary data):
  • Index is up or down ≥2% on the day (intraday or close).
  • Post uses "biggest daily move/gain/loss since [date]" language for S&P500 or Nasdaq100.
- Urgency: "medium" for ≥2% / "biggest since" signals; "high" for ≥5% crashes.
- These are market-structure signals that correlate with crypto direction within 0–48h — prioritise over the general "stock news" exclusion.
- NOT breaking: moves <2% with no "biggest since" language, individual sector or single-stock moves (Apple, Tesla, etc.).

Other Macro/Markets (breaking if confirmed):
- Rates shock: clear catalyst that can move US 2Y / 10Y yields
  * Official central bank rate decisions / policy statements / surprise shifts (Fed, ECB, BOJ, etc.) - NOT general speeches or interviews
  * Key economic data releases: CPI, PPI, jobs (NFP/unemployment/wage growth), GDP — especially if surprising vs expectations
  * NOT breaking: Political drama, Fed Chair speculation, or threats about Fed personnel (only actual policy decisions/data count)
- Geopolitical shock: confirmed major escalation (war strikes, missile attacks, major sanctions, shipping chokepoint disruptions) likely to cause global risk-off within 0–48h
- Economic policy directly affecting crypto (banking restrictions on crypto, tax policy)

NOT breaking:
- General stock market news (Netflix, Warner Bros, Apple, Tesla, etc.) - EXCEPT major equity index regime shifts (Nasdaq/S&P500) which ARE breaking (see priority rule above)
- Traditional finance M&A (unless it involves crypto companies)
- Large funding/investor news for NON-CRYPTO companies
- Unconfirmed reports: "said to", "reportedly", "sources say" from non-credible sources or without clear market-moving impact (Bloomberg/Reuters/WSJ/FT reports ARE acceptable if clearly market-moving)
- Political opinions or statements (unless new crypto regulation)
- Fed Chair speculation, political pressure on Fed, or Fed independence threats (e.g., "Trump threatens Powell" - NOT breaking)
- Long-term forecasts or predictions (e.g., "Goldman raises 2026 gold forecast to $5,400" - NOT breaking)
- Energy/commodity price moves (nat gas, oil, etc.) - NOT breaking
- General central banker speeches or interviews (only official rate decisions/policy statements count)
- Minor geopolitical tensions or routine diplomatic statements (only major escalations count)
- Memes, opinions, commentary
- Motivational content
- Old news reposts
- Low-impact announcements
- Rumors, speculation, or bidding news (only confirmed deals)
- Small altcoin news (focus on top 20 cryptocurrencies by market cap)
- Regular business news without crypto connection

Output ONLY strict JSON:
[
  {
    "summary": "short summary combining mainText and quotedText context",
    "breaking": [
      {
        "mainText": "author's reaction/comment",
        "quotedText": "quoted content (empty string if none)",
        "quotedAuthor": "quoted author username (empty string if none)",
        "impact_line": "one short sentence: why breaking and crypto impact (e.g. risk-off; BTC/ETH sell-off risk 0-48h)",
        "urgency": "low|medium|high",
        "username": "main author username",
        "tweet_id": "tweet id",
        "link": "main tweet URL",
        "quotedLink": "quoted tweet URL (empty string if none)"
      }
    ]
  }
]

Rules:
- If NOT breaking: "breaking": []
- breaking MUST contain at most 1 object — never output more than one item in the array.
- PRIORITY: S&P500/Nasdaq100 ≥2% moves or "biggest since" are breaking (see equity rule above).
- BE STRICT for everything else: when in doubt, it's NOT breaking.
- CRYPTO FOCUS: if it doesn't affect crypto prices, it's NOT breaking.
- CONFIRMED ONLY: apply the confirmation standard above; quoting or linking a credible outlet is NOT enough — the outlet must describe a completed fact.
- tweet_id MUST equal the input tweetId exactly.
- Analyze BOTH mainText AND quotedText together for context; include both in the breaking object when a quote is present.
- imageDescriptions should be treated as ground-truth captions for attached media even when imageUrls is empty.
- impact_line: one short sentence only; no long explanation.
- Output ONLY valid JSON: double quotes for all keys and strings, no trailing commas, no markdown, no code fences, no extra text.
- Same order as input.
`.trim();
}

export async function analyzeTweetsWithGrok(
  tweets: NormalizedTweet[],
  context?: string
): Promise<any> {
  if (!config.grokApiKey) {
    throw new Error('GROK_API_KEY is not set');
  }

  const visionUrls = collectVisionImageUrls(tweets);
  const prompt = buildPrompt(tweets, context, visionUrls);

  const userContent: string | ChatContentPart[] =
    visionUrls.length > 0
      ? [
          { type: 'text', text: prompt },
          ...visionUrls.map((url) => ({
            type: 'image_url' as const,
            image_url: { url, detail: 'high' as const },
          })),
        ]
      : prompt;

   // Optional sampling controls (match n8n settings if you know them)
  const temperature =
    process.env.GROK_TEMPERATURE !== undefined
      ? Number(process.env.GROK_TEMPERATURE)
      : undefined;
  const topP =
    process.env.GROK_TOP_P !== undefined
      ? Number(process.env.GROK_TOP_P)
      : undefined;

  const res = await axios.post(
    GROK_API_URL,
    {
      model: GROK_MODEL,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(topP !== undefined ? { top_p: topP } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${config.grokApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 120_000,
    }
  );

  return res.data;
}

