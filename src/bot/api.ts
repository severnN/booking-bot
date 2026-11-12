/** Минимальный клиент Telegram Bot API на fetch. */
export class TelegramError extends Error {
  code: number;
  constructor(code: number, description: string) {
    super(description);
    this.code = code;
  }
}

export class TelegramApi {
  token: string;
  baseUrl: string;
  constructor(token: string, baseUrl = 'https://api.telegram.org') {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });
    const data = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string };
    if (!data.ok) throw new TelegramError(data.error_code ?? res.status, data.description ?? 'Telegram API error');
    return data.result as T;
  }

  sendMessage(chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }
}

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
