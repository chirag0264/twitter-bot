import axios from 'axios';
import { config } from './config';

interface TwitterSearchResponse {
  tweets?: any[];
  rule_id?: string;
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

  const res = await axios.get<TwitterSearchResponse>(url, {
    params: {
      queryType: 'Latest',
      query,
    },
    headers: {
      'X-API-Key': config.twitterApiKey,
    },
    timeout: 300_000,
  });

  return res.data;
}

