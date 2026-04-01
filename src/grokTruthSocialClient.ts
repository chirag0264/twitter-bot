import axios from 'axios';
import { config } from './config';
import { NormalizedTweet } from './normalizeTweet';

const GROK_MODEL = 'grok-4-1-fast-reasoning';
const GROK_API_URL =
  process.env.GROK_API_URL || 'https://api.x.ai/v1/chat/completions';

const GROK_VISION_MAX_IMAGES = Number(
  process.env.GROK_VISION_MAX_IMAGES ?? '16'
);
const GROK_VISION_MAX_PER_POST = Number(
  process.env.GROK_VISION_MAX_PER_POST ?? '4'
);

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

function isLikelyVideoUrl(u: string): boolean {
  const path = u.split('?')[0].toLowerCase();
  return /\.(mp4|webm|mov|m4v|mkv|mpeg)(\?|$)/.test(path);
}

function isLikelyBlockedVisionUrl(u: string): boolean {
  return /static-assets[^/]*\.truthsocial\.com/i.test(u);
}

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
        sourcePlatform: t.sourcePlatform || 'truth-social',
        imageUrls,
        ...(descs.length > 0 ? { imageDescriptions: descs } : {}),
      };
    })
  );

  const visionBlock =
    visionUrls.length > 0
      ? `## VISION (multimodal)
This message includes ${visionUrls.length} image attachment(s) appended after the text in strict per-post order: all images for post[0] first (in imageUrls order), then all images for post[1], and so on, up to the global cap. A post with an empty imageUrls contributes zero attachments; the next attachment belongs to the next post that has imageUrls. If an image fails to load, rely on the text fields only. A post may have imageDescriptions but no imageUrls — in that case imageDescriptions are the sole media context and must be used.

`
      : '';

  const contextBlock =
    context && context.trim() ? `${context.trim()}\n\n` : '';

  return `${contextBlock}${visionBlock}You analyze Donald Trump Truth Social posts for Telegram routing.

Here are new Truth Social posts:
${tweetsJson}

Each input object contains:
- sourcePlatform: "truth-social"
- mainText: post text or media-derived archive text
- quotedText: quoted content if present
- quotedAuthor: quoted author if present
- authorUsername: main author username
- tweetUrl: Truth Social archive/original link
- quotedUrl: quoted post URL if present
- tweetId: unique id
- imageUrls: public image URLs safe for vision
- imageDescriptions: optional archive captions; treat as ground truth when present

Your Task:
For EACH post (same order as input), create ONE JSON object with:
1. "summary": 1-2 sentence summary
2. "classification": one of "crypto_relevant", "macro", "commentary", "noise"
3. "market_relevance": integer 0-100
4. "breaking": Array (0 or 1 items)

Breaking News Criteria:
A post is breaking ONLY if it is urgent, new, confirmed, and likely to move crypto prices in the next 0-48 hours.

Confirmed means:
- primary-source statement of a completed action/event, OR
- major outlet (Bloomberg/Reuters/WSJ/FT) describing a completed fact
- NOT rumors, "considering", "talks", "sources say", or mere opinion

Truth Social-specific note:
- Trump opinions, threats, criticism, diplomatic hints, and policy commentary are often important narrative signals but are NOT automatically breaking.
- For non-breaking posts, still assign classification and market_relevance.

Classification Rules:
- "crypto_relevant": direct crypto market impact
- "macro": broader macro/geopolitical/policy signal that could affect crypto
- "commentary": opinions, criticism, political statements, or company mentions with narrative value
- "noise": maintenance updates, self-promotion, greetings, ceremony/vanity content, or low informational value

Market Relevance Scoring:
- 0-10: no meaningful market value
- 10-30: low relevance
- 30-60: medium relevance
- 60-80: high relevance
- 80-100: very high relevance

Scoring guidance:
- UK state visit announcement: usually commentary/noise unless tied to trade/security policy
- domestic maintenance/cleaning/building brag posts: usually noise
- insurance/company criticism after disaster: commentary, sometimes medium relevance
- geopolitical claims about Iran/Hormuz/ceasefire/oil routes: usually macro, sometimes high relevance
- imageDescriptions can carry the real informational payload for media-only posts

Output ONLY strict JSON:
[
  {
    "summary": "short summary",
    "classification": "commentary",
    "market_relevance": 25,
    "breaking": [
      {
        "mainText": "author's reaction/comment",
        "quotedText": "quoted content (empty string if none)",
        "quotedAuthor": "quoted author username (empty string if none)",
        "impact_line": "one short sentence only",
        "urgency": "low|medium|high",
        "username": "main author username",
        "tweet_id": "tweet id",
        "link": "main post URL",
        "quotedLink": "quoted post URL (empty string if none)"
      }
    ]
  }
]

Rules:
- Return classification and market_relevance for EVERY post.
- If NOT breaking: "breaking": []
- breaking MUST contain at most 1 object.
- Do NOT force breaking.
- Use imageDescriptions as ground-truth media captions when present.
- tweet_id MUST equal the input tweetId exactly.
- Output ONLY valid JSON: double quotes for all keys and strings, no trailing commas, no markdown, no code fences, no extra text.
- Same order as input.`.trim();
}

export async function analyzeTruthSocialWithGrok(
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
