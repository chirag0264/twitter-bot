import { config } from './config';

export interface NormalizedTweet {
  timestamp: string;
  tweetId: string;
  tweetUrl: string;
  mainText: string;
  quotedText: string;
  quotedAuthor: string;
  quotedUrl: string;
  hasQuote: boolean;
  images: string[];
  imageCount: number;
  authorUsername: string;
  authorName: string;
  authorFollowers: number;
  authorVerified: boolean;
  authorBlueVerified: boolean;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  viewCount: number;
  quoteCount: number;
  bookmarkCount: number;
  isReply: boolean;
  inReplyToId: string;
  conversationId: string;
  createdAt: string;
  lang: string;
  source: string;
  ruleId: string;
  ruleTag: string;
  ruleValue: string;
  eventType: string;
  processed: boolean;
  ingestedAt: string;
}

interface RawTweet {
  tweetId?: string;
  id?: string;
  text?: string;
  mainText?: string;
  quotedText?: string;
  quoted_tweet?: {
    text?: string;
    url?: string;
    author?: { userName?: string };
  };
  quotedAuthor?: string;
  quotedUrl?: string;
  tweetUrl?: string;
  url?: string;
  images?: string[];
  imageCount?: number;
  authorUsername?: string;
  authorName?: string;
  authorFollowers?: number;
  authorVerified?: boolean;
  authorBlueVerified?: boolean;
  author?: {
    userName?: string;
    name?: string;
    followers?: number;
    isVerified?: boolean;
    isBlueVerified?: boolean;
  };
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  viewCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
  isReply?: boolean;
  inReplyToId?: string;
  conversationId?: string;
  createdAt?: string;
  lang?: string;
  source?: string;
}

export function normalizeTweetsFromSearch(data: {
  tweets?: RawTweet[];
  rule_id?: string;
}): NormalizedTweet[] {
  const tweets = data.tweets ?? [];
  const nowISO = new Date().toISOString();

  return tweets.map((tweet) => {
    const tweetId = tweet.tweetId || tweet.id || '';
    const mainText = tweet.mainText || tweet.text || '';

    const quotedText =
      tweet.quotedText || tweet.quoted_tweet?.text || '';
    const quotedAuthor =
      tweet.quotedAuthor || tweet.quoted_tweet?.author?.userName || '';
    const quotedUrl = tweet.quotedUrl || tweet.quoted_tweet?.url || '';

    const authorUsernameRaw =
      tweet.authorUsername || tweet.author?.userName || 'unknown';
    const authorUsername = authorUsernameRaw;
    const authorKey = authorUsernameRaw.toLowerCase();

    let ruleTag = 'other';
    if (config.priorityAccounts.includes(authorKey)) {
      ruleTag = 'priority';
    } else if (config.normalAccounts.includes(authorKey)) {
      ruleTag = 'group';
    }

    const ruleValue = `from:${authorUsername} -filter:replies`;
    const ruleId = data.rule_id || '';
    const eventType = 'tweet';

    return {
      timestamp: nowISO,
      tweetId,
      tweetUrl: tweet.tweetUrl || tweet.url || '',
      mainText,
      quotedText,
      quotedAuthor,
      quotedUrl,
      hasQuote: quotedText.length > 0,
      images: tweet.images || [],
      imageCount: tweet.imageCount || 0,
      authorUsername,
      authorName: tweet.authorName || tweet.author?.name || '',
      authorFollowers:
        tweet.authorFollowers || tweet.author?.followers || 0,
      authorVerified:
        tweet.authorVerified || tweet.author?.isVerified || false,
      authorBlueVerified:
        tweet.authorBlueVerified || tweet.author?.isBlueVerified || false,
      likeCount: tweet.likeCount || 0,
      retweetCount: tweet.retweetCount || 0,
      replyCount: tweet.replyCount || 0,
      viewCount: tweet.viewCount || 0,
      quoteCount: tweet.quoteCount || 0,
      bookmarkCount: tweet.bookmarkCount || 0,
      isReply: tweet.isReply || false,
      inReplyToId: tweet.inReplyToId || '',
      conversationId: tweet.conversationId || '',
      createdAt: tweet.createdAt || '',
      lang: tweet.lang || '',
      source: tweet.source || '',
      ruleId: ruleId,
      ruleTag,
      ruleValue,
      eventType,
      processed: false,
      ingestedAt: nowISO,
    };
  });
}

