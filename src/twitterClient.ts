import axios from 'axios';
import { config } from './config';

interface TwitterSearchResponse {
  tweets?: any[];
  rule_id?: string;
  has_next_page?: boolean;
  next_cursor?: string;
}

export async function searchLatest(params: {
  sinceStr: string;
  untilStr: string;
}): Promise<TwitterSearchResponse> {
  if (!config.twitterApiKey) {
    throw new Error('TWITTERAPI_IO_API_KEY is not set');
  }

  const accounts = [
    ...config.priorityAccounts,
    ...config.normalAccounts,
  ];

  const uniqueAccounts = Array.from(new Set(accounts));

  if (uniqueAccounts.length === 0) {
    throw new Error(
      'No accounts configured. Set PRIORITY_ACCOUNTS and/or NORMAL_ACCOUNTS.'
    );
  }

  const accountExpr =
    uniqueAccounts.length === 1
      ? `from:${uniqueAccounts[0]}`
      : uniqueAccounts.map((a) => `from:${a}`).join(' OR ');

  const query = `${accountExpr} since:${params.sinceStr} until:${params.untilStr} -filter:replies include:nativeretweets`;

  const url = 'https://api.twitterapi.io/twitter/tweet/advanced_search';

  console.log(`[twitter] Query: ${query}`);
  console.log(`[twitter] Time window: ${params.sinceStr} -> ${params.untilStr}`);

  // Handle pagination - collect all tweets across pages
  const allTweets: any[] = [];
  let nextCursor: string | undefined = undefined;
  let pageCount = 0;
  const MAX_PAGES = 2; // Limit to 2 pages to avoid runaway costs

  while (pageCount < MAX_PAGES) {
    // Rate limit: free tier allows 1 request per 5 seconds
    // Wait before making request (except for first page)
    if (pageCount > 0) {
      console.log(`[twitter] Waiting 6 seconds before fetching page ${pageCount + 1} (rate limit: 1 req/5s)...`);
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }

    pageCount++;
    const requestParams: any = {
      queryType: 'Latest',
      query,
    };

    if (nextCursor) {
      requestParams.cursor = nextCursor;
    }

    try {
      const res = await axios.get<TwitterSearchResponse>(url, {
        params: requestParams,
        headers: {
          'X-API-Key': config.twitterApiKey,
        },
        timeout: 300_000,
      });

      const tweets = res.data.tweets || [];
      allTweets.push(...tweets);

      console.log(`[twitter] Page ${pageCount}: ${tweets.length} tweets (total so far: ${allTweets.length})`);

      // Check if there are more pages
      // Must have: has_next_page === true AND a valid non-empty next_cursor
      const hasMorePages = res.data.has_next_page === true;
      const hasValidCursor = res.data.next_cursor && 
                            typeof res.data.next_cursor === 'string' && 
                            res.data.next_cursor.trim() !== '';

      if (hasMorePages && hasValidCursor && pageCount < MAX_PAGES) {
        nextCursor = res.data.next_cursor;
        console.log(`[twitter] More pages available, continuing pagination...`);
        continue;
      } else {
        if (!hasMorePages) {
          console.log(`[twitter] No more pages (has_next_page: ${res.data.has_next_page})`);
        } else if (!hasValidCursor) {
          console.log(`[twitter] No more pages (invalid/empty next_cursor)`);
        } else if (pageCount >= MAX_PAGES) {
          console.log(`[twitter] Max page limit (${MAX_PAGES}) reached, stopping pagination`);
        }
        break;
      }
    } catch (error: any) {
      // Handle errors (rate limits, network issues, etc.)
      console.error(`[twitter] Error on page ${pageCount}:`, error.message);
      if (error.response) {
        console.error(`[twitter] API returned status ${error.response.status}`);
        if (error.response.status === 429) {
          console.error(`[twitter] Rate limit hit - TwitterAPI.io charges 300 credits per error!`);
        }
        console.error(`[twitter] Response data:`, JSON.stringify(error.response.data, null, 2));
      }
      // Break pagination on error to avoid runaway costs
      console.log(`[twitter] Stopping pagination due to error`);
      break;
    }
  }

  const tweetIds = allTweets.map((t: any) => t.tweetId || t.id || 'unknown');
  console.log(`[twitter] Total API returned ${allTweets.length} tweets across ${pageCount} page(s)`);
  console.log(`[twitter] Tweet IDs: ${tweetIds.slice(0, 10).join(', ')}${tweetIds.length > 10 ? '...' : ''}`);

  return {
    tweets: allTweets,
    rule_id: undefined, // Not available in advanced_search
  };
}

