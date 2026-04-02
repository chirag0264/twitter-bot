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

  return `${contextBlock}${visionBlock}You analyze Donald Trump Truth Social posts for Telegram routing targeting crypto and macro traders.

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

## Your Task
For EACH post (same order as input), create ONE JSON object with:
1. "summary": 1-2 sentence summary of the actual content
2. "classification": one of "crypto_relevant" | "macro" | "commentary" | "noise"
3. "market_relevance": integer 0-100
4. "breaking": Array (0 or 1 items)

---

## Classification Rules

Apply these in order — the first match wins.

**"noise"** — ALWAYS classify as noise, regardless of political significance:
- Judicial nominations and court appointments (federal, district, appeals — any level)
- Domestic U.S. politics with no cross-border economic consequence: law enforcement praise/criticism, defund-police rhetoric, immigration enforcement praise, filibuster tactics, partisan political attacks, election law commentary
- Routine administrative appointments (U.S. attorneys, agency heads with no market-moving mandate)
- Ceremony, self-promotion, greetings, congratulations on non-economic topics
- Maintenance/building/vanity posts

**"crypto_relevant"** — Direct crypto-market signal:
- Regulatory action on crypto, exchange news, BTC/ETH/stablecoin policy
- Crypto-specific legislation or executive action

**"macro"** — Geopolitical, monetary, or trade-policy signal with cross-border economic consequences:
- Ceasefire announcements, military escalation or de-escalation
- Tariff changes, trade deal progress or collapse
- Oil route threats (Hormuz Strait, Suez, etc.)
- Sanctions, currency policy, Fed-related statements
- Foreign government actions affecting global markets

**"commentary"** — Everything else with some informational value:
- Trump trade/tariff praise for specific companies (signals policy direction)
- Diplomatic hints, conditional threats, geopolitical positioning that is NOT confirmed action
- Opinions on market-relevant topics that don't rise to macro level

When in doubt between "macro" and "commentary": if the post announces or describes a policy action with measurable cross-border economic consequences, use "macro". Conditional threats and hints are "commentary" unless confirmed.

---

## Market Relevance Scoring (0–100)

Score the likely impact on crypto prices within 0–48 hours.

| Score | Meaning | Examples |
|-------|---------|---------|
| 0–10 | Negligible | Judicial nominations, domestic law enforcement praise, immigration enforcement praise, partisan politics, filibuster tactics |
| 11–25 | Low | Single-company tariff praise, domestic political criticism, routine commentary |
| 26–50 | Medium | Trade deal progress hint, sanctions mention, immigration policy with economic angle |
| 51–70 | High | Iran/Hormuz conditional threat, major tariff announcement, G7/G20 signal |
| 71–100 | Very high | Confirmed ceasefire or war escalation, Fed chair fired, BTC reserve announcement, oil embargo, confirmed military strike pause |

Specific calibration:
- Judicial nominations (any level): 5
- Domestic law enforcement / ICE / filibuster politics: 5–8
- Single-company tariff praise (Nissan, etc.): 15–20
- Iran tensions / Hormuz Strait conditional threat: 55–65
- Confirmed ceasefire or military action pause (Trump first-person): 68–80
- Crypto-specific executive action: 80–95

---

## Breaking News Criteria

A post qualifies as breaking ONLY if ALL four are true:
1. **Urgent**: Near-term (0–48 h) market implications
2. **New**: Not already widely reported or priced in
3. **Confirmed**: See definition below
4. **Market-moving**: Likely to shift crypto prices materially

### What counts as "confirmed"
- A **Trump first-person declaration of an action he is taking or has taken** — e.g., "I am pausing strikes", "I am imposing tariffs", "I have signed" — is a primary-source confirmed event. Evaluate the declared action itself; do NOT disqualify it because surrounding text mentions ongoing talks or negotiations.
- A major outlet (Bloomberg / Reuters / WSJ / FT) describing a completed fact.
- NOT: conditional threats ("if X doesn't happen I will Y"), rumors, "sources say", "considering", "talks are going well", diplomatic hints, or rhetorical bluster.

### Conditional threats vs. confirmed actions — critical distinction
- "I will blast Iran into oblivion if Hormuz isn't opened" → NOT breaking (conditional). Classify as macro or commentary with appropriate relevance score.
- "I am pausing energy plant strikes for 10 days" → IS potentially breaking (first-person confirmed decision). The presence of "talks are ongoing" in the same post does NOT veto the confirmed action.
- "Talks are going very well" alone → NOT breaking (diplomatic hint only).

### Urgency levels
- **high**: Confirmed action with immediate price impact (ceasefire, tariff start, military escalation)
- **medium**: Confirmed action with near-term but indirect price impact
- **low**: Confirmed but slower-moving or lower-magnitude

---

## Output Format

Output ONLY strict JSON — no markdown, no code fences, no extra text:

[
  {
    "summary": "1-2 sentence summary of actual content",
    "classification": "macro",
    "market_relevance": 70,
    "breaking": [
      {
        "mainText": "author's own statement (not quoted content)",
        "quotedText": "quoted content, or empty string",
        "quotedAuthor": "quoted author username, or empty string",
        "impact_line": "one short sentence describing the market-relevant event",
        "urgency": "medium|high",
        "username": "main author username",
        "tweet_id": "must equal input tweetId exactly",
        "link": "main post URL",
        "quotedLink": "quoted post URL, or empty string"
      }
    ]
  }
]

## Hard Rules
- Return classification and market_relevance for EVERY post without exception.
- If NOT breaking: "breaking": []
- breaking MUST contain at most 1 object — never force it.
- tweet_id MUST equal the input tweetId exactly (copy verbatim).
- Use imageDescriptions as ground-truth captions when present.
- Same order as input, always.
- Output ONLY valid JSON: double-quoted keys and strings, no trailing commas.`.trim();
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