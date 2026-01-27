import axios from 'axios';
import { config } from './config';
import { NormalizedTweet } from './normalizeTweet';

const GROK_MODEL = 'grok-4-1-fast-reasoning';

// Minimal Grok client using xAI-style chat completions API.
// You may need to adjust the URL/shape to match your xAI account.
const GROK_API_URL = process.env.GROK_API_URL || 'https://api.x.ai/v1/chat/completions';

function buildPrompt(tweets: NormalizedTweet[]): string {
  const tweetsJson = JSON.stringify(
    tweets.map((t) => ({
      mainText: t.mainText,
      quotedText: t.quotedText,
      quotedAuthor: t.quotedAuthor,
      authorUsername: t.authorUsername,
      tweetUrl: t.tweetUrl,
      quotedUrl: t.quotedUrl,
      tweetId: t.tweetId,
    }))
  );

  return `
You are a CRYPTO MARKET breaking-news detector. Focus ONLY on news that can realistically move cryptocurrency prices in the next 0–48 hours.

Here are new tweets from accounts I follow:
${tweetsJson}

Each tweet object contains:
- mainText: The author's own words/reaction
- quotedText: Content they're quoting (if any)
- quotedAuthor: Who they're quoting
- authorUsername: The main tweet author
- tweetUrl: Link to the main tweet
- quotedUrl: Link to the quoted tweet (if any)
- tweetId: The tweet ID

Your Task:
For EACH tweet, create ONE JSON object with:
1. "summary": 1-2 sentence summary (combine mainText + quotedText context if both exist)
2. "breaking": Array (0 or 1 items) for breaking news

Breaking News Criteria:
A tweet is breaking news ONLY if it meets ALL THREE conditions:
1. Urgent, new, and time-sensitive
2. CONFIRMED event (not "said to", "reportedly", "sources say" unless confirmed by official statement, direct quote from authority, OR reported by major credible outlets (Bloomberg/Reuters/WSJ/FT) and clearly market-moving)
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

PRIORITY: Major equity index regime shifts (Nasdaq/S&P500)
- Large confirmed moves that signal risk-on/risk-off regime shifts
- Examples: "biggest daily gain/loss since [date]", "records biggest daily percentage gain", ≥2% intraday moves
- These moves often correlate with crypto direction within 0-48h
- Urgency: "medium" for regime shift signals (even if exact % not stated), "high" for ≥5% crashes
- IMPORTANT: If a tweet reports a confirmed major equity index move (especially "biggest since" or "records" language), treat it as breaking - these are market structure signals, not just stock news

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
        "reason": "why breaking and how it impacts crypto markets",
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
- PRIORITY RULE: Major equity index moves (Nasdaq/S&P500) that signal regime shifts are breaking - prioritize these over "general stock market news" exclusion
- BE STRICT for everything else: When in doubt, it's NOT breaking
- CRYPTO FOCUS: If it doesn't affect crypto prices, it's NOT breaking
- CONFIRMED ONLY: Must be actual event, not rumors or unconfirmed reports (except major credible outlets: Bloomberg/Reuters/WSJ/FT if clearly market-moving)
- tweet_id MUST equal the input tweetId exactly (use the tweetId field from the input tweet object)
- Analyze BOTH mainText AND quotedText together for context
- For quotes, include BOTH mainText and quotedText in breaking object
- NO markdown, NO code blocks, NO explanations
- MUST be valid JSON
- Same order as input
`.trim();
}

export async function analyzeTweetsWithGrok(
  tweets: NormalizedTweet[]
): Promise<any> {
  if (!config.grokApiKey) {
    throw new Error('GROK_API_KEY is not set');
  }

  const prompt = buildPrompt(tweets);

  const res = await axios.post(
    GROK_API_URL,
    {
      model: GROK_MODEL,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
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

