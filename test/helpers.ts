import { createHmac } from 'node:crypto';
import { readConfig } from '../src/config.ts';
import { openDb, seedIfEmpty } from '../src/db.ts';
import { BookingService } from '../src/services/booking.ts';
import { UserService } from '../src/services/users.ts';

export const BOT_TOKEN = '123456:TEST-TOKEN';
export const ADMIN_TG = 999;

export function makeCfg(extra: Record<string, string> = {}) {
  return readConfig({
    TIMEZONE: 'Europe/Moscow',
    SESSION_SECRET: 's'.repeat(40),
    ADMIN_TG_IDS: String(ADMIN_TG),
    BOT_TOKEN,
    BOT_USERNAME: 'test_autoservice_bot',
    WEBAPP_URL: 'https://example.com',
    DEV_LOGIN: '1',
    ...extra,
  });
}

/** «Сейчас» в тестах: вс 15.11.2026 15:00 по Москве. Пн 16.11 — рабочий день 09–20. */
export const NOW = new Date('2026-11-15T12:00:00Z');

export function makeServices(now: () => Date = () => NOW, extra: Record<string, string> = {}) {
  const cfg = makeCfg(extra);
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const bookings = new BookingService(db, cfg, now);
  const users = new UserService(db);
  return { cfg, db, bookings, users };
}

/** Местное московское время → ISO UTC. */
export const msk = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`).toISOString();

/** Собираем initData так же, как это делает Telegram. */
export function makeInitData(user: object, authDate: number, token = BOT_TOKEN): string {
  const fields: Record<string, string> = { auth_date: String(authDate), query_id: 'AAH', user: JSON.stringify(user) };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

