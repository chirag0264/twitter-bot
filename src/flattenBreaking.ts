// Port of the n8n Flatten Breaking1 node logic

interface BreakingItem {
  mainText?: string;
  quotedText?: string;
  quotedAuthor?: string;
  reason?: string;
  urgency?: string;
  username?: string;
  tweet_id?: string;
  link?: string;
  quotedLink?: string;
}

export interface AlertRow {
  Timestamp: string;
  TweetId: string;
  MainText: string;
  QuotedText: string;
  QuotedAuthor: string;
  Reason: string;
  Urgency: string;
  Username: string;
  Link: string;
  QuotedLink: string;
  HasQuote: boolean;
}

export function flattenBreakingItems(breakingArrays: BreakingItem[][]): AlertRow[] {
  const allBreaking: AlertRow[] = [];
  const seenIds = new Set<string>();

  for (const arr of breakingArrays) {
    for (const b of arr) {
      const urgency = (b.urgency || '').toLowerCase();
      if (urgency !== 'high' && urgency !== 'medium') continue;

      const tweetId = b.tweet_id || '';
      if (!tweetId) continue;
      if (seenIds.has(tweetId)) continue;
      seenIds.add(tweetId);

      const quotedText = b.quotedText || '';

      allBreaking.push({
        Timestamp: new Date().toISOString(),
        TweetId: tweetId,
        MainText: b.mainText || '',
        QuotedText: quotedText,
        QuotedAuthor: b.quotedAuthor || '',
        Reason: b.reason || '',
        Urgency: b.urgency || 'medium',
        Username: b.username || '',
        Link: b.link || '',
        QuotedLink: b.quotedLink || '',
        HasQuote: quotedText.length > 0,
      });
    }
  }

  console.log(
    `🚨 Breaking items (deduped by TweetId): ${allBreaking.length}`
  );
  return allBreaking;
}

