import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Проверка initData из Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyWebAppInitData(initData: string, botToken: string, maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000)): TgUser | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  if (!safeEqualHex(check, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') ?? '');
    return typeof user?.id === 'number' ? user : null;
  } catch {
    return null;
  }
}

/**
 * Проверка данных Telegram Login Widget — вход в веб-версии вне Telegram.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyLoginWidget(data: Record<string, unknown>, botToken: string, maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000)): TgUser | null {
  if (!botToken || typeof data?.hash !== 'string') return null;
  const pairs = Object.entries(data)
    .filter(([k, v]) => k !== 'hash' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHash('sha256').update(botToken).digest();
  const check = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  if (!safeEqualHex(check, data.hash)) return null;
  const authDate = Number(data.auth_date);
  if (!authDate || nowSec - authDate > maxAgeSec) return null;
  const id = Number(data.id);
  if (!Number.isSafeInteger(id)) return null;
  return {
    id,
    first_name: typeof data.first_name === 'string' ? data.first_name : undefined,
    last_name: typeof data.last_name === 'string' ? data.last_name : undefined,
    username: typeof data.username === 'string' ? data.username : undefined,
  };
}

// ---------- сессии: подписанный токен без хранения на сервере ----------

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signSession(userId: number, secret: string, ttlSec = 30 * 24 * 3600, nowSec = Math.floor(Date.now() / 1000)): string {
  const payload = b64u(JSON.stringify({ uid: userId, exp: nowSec + ttlSec }));
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof uid !== 'number' || typeof exp !== 'number' || exp < nowSec) return null;
    return uid;
  } catch {
    return null;
  }
}
