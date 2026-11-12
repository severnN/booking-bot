import { createHmac, randomBytes } from 'node:crypto';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { Db, type PoolLike } from '../src/db/sql.ts';
import { migrate, seedIfEmpty } from '../src/db/migrate.ts';
import { BookingService } from '../src/services/booking.ts';
import { UserService } from '../src/services/users.ts';
import { CareService } from '../src/services/care.ts';

export const BOT_TOKEN = '123456:TEST-TOKEN';
export const ADMIN_TG = 999;

/**
 * Тесты, которым нужна БД, работают с настоящим PostgreSQL.
 * TEST_DATABASE_URL — сервер, где можно создавать и удалять базы (например, из docker-compose).
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? '';
export const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: TEST_DB_URL ? false : 'TEST_DATABASE_URL не задан' }, fn);

/** Пул: настоящий `pg`, если установлен, иначе встроенный тестовый драйвер. */
async function makePool(url: string): Promise<PoolLike> {
  try {
    const { createPgPool } = await import('../src/db/pool.ts');
    return await createPgPool(url, 5);
  } catch {
    const { MiniPool } = await import('./support/pgmini.ts');
    return new MiniPool(url);
  }
}

const created: { admin: PoolLike; name: string; pool: PoolLike }[] = [];
after(async () => {
  for (const c of created) {
    await c.pool.end();
    await c.admin.query(`DROP DATABASE IF EXISTS ${c.name} WITH (FORCE)`);
    await c.admin.end();
  }
});

/** Новая пустая база с применёнными миграциями — на каждый вызов. */
export async function freshDb(): Promise<Db> {
  const admin = await makePool(TEST_DB_URL);
  const name = `booking_test_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(TEST_DB_URL);
  url.pathname = `/${name}`;
  const pool = await makePool(url.toString());
  created.push({ admin, name, pool });
  const db = Db.fromPool(pool);
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)), () => {});
  await seedIfEmpty(db);
  return db;
}

export function makeCfg(extra: Record<string, string> = {}) {
  return readConfig({
    TIMEZONE: 'Europe/Moscow',
    SESSION_SECRET: 's'.repeat(40),
    ADMIN_TG_IDS: String(ADMIN_TG),
    BOT_TOKEN,
    BOT_USERNAME: 'test_autoservice_bot',
    WEBAPP_URL: 'https://example.com',
    WEBHOOK_SECRET: 'test-webhook-secret-123',
    DEV_LOGIN: '1',
    ...extra,
  });
}

/** «Сейчас» в тестах: вс 15.11.2026 15:00 по Москве. Пн 16.11 — рабочий день 09–20. */
export const NOW = new Date('2026-11-15T12:00:00Z');

export async function makeServices(now: () => Date = () => NOW, extra: Record<string, string> = {}) {
  const cfg = makeCfg(extra);
  const db = await freshDb();
  const bookings = new BookingService(db, cfg, now);
  const users = new UserService(db);
  const care = new CareService(db, cfg, now);
  return { cfg, db, bookings, users, care };
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
