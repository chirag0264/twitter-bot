import axios from 'axios';
import { config } from './config';

export async function sendTelegramMessage(params: {
  chatId: string;
  text: string;
}): Promise<void> {
  if (!config.telegramBotToken) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN is not set; skipping alert');
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  await axios.post(url, {
    chat_id: params.chatId,
    text: params.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

