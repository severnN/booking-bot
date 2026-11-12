import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, readConfig } from './config.ts';
import { Db } from './db/sql.ts';
import { createPgPool } from './db/pool.ts';
import { migrate, seedIfEmpty } from './db/migrate.ts';
import { BookingService } from './services/booking.ts';
import { UserService } from './services/users.ts';
import { CareService } from './services/care.ts';
import { createApp } from './http/server.ts';
import { TelegramApi } from './bot/api.ts';
import { Bot } from './bot/bot.ts';

loadDotEnv();
const cfg = readConfig();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
  fail('SESSION_SECRET должен быть длиной от 32 символов. Сгенерировать: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"');
}
if (!cfg.databaseUrl) fail('Не задан DATABASE_URL (postgres://user:pass@host:5432/db)');
if (!cfg.botToken && !cfg.devLogin) fail('Не задан BOT_TOKEN (для локальной разработки без бота можно включить DEV_LOGIN=1)');
if (cfg.botToken && cfg.botMode === 'webhook') {
  if (!cfg.webAppUrl.startsWith('https://')) fail('Для BOT_MODE=webhook нужен публичный WEBAPP_URL с https://. Для разработки — BOT_MODE=polling');
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(cfg.webhookSecret)) fail('Для BOT_MODE=webhook задайте WEBHOOK_SECRET: 16–256 символов A-Z, a-z, 0-9, _ и -');
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const db = Db.fromPool(await createPgPool(cfg.databaseUrl));
await migrate(db, join(root, 'migrations'));
await seedIfEmpty(db);

const bookings = new BookingService(db, cfg);
const users = new UserService(db);
const care = new CareService(db, cfg);
const bot = cfg.botToken ? new Bot(new TelegramApi(cfg.botToken), cfg, bookings, users, care) : null;

const server = createApp({
  cfg,
  bookings,
  users,
  care,
  publicDir: join(root, 'public'),
  onTelegramUpdate: bot && cfg.botMode === 'webhook' ? (u) => bot.handleUpdate(u) : undefined,
  healthCheck: async () => {
    await db.one('SELECT 1');
  },
});
server.listen(cfg.port, () => console.log(`[http] http://localhost:${cfg.port}`));

const timers: NodeJS.Timeout[] = [];
if (bot) {
  if (cfg.botMode === 'webhook') {
    await bot.setup().catch((e) => console.error('[bot] setup:', e.message));
    await bot.setWebhook().catch((e) => console.error('[bot] setWebhook:', e.message));
  } else {
    void bot.startPolling();
  }
  // Безопасно запускать в каждой копии приложения: записи «забираются» атомарно.
  timers.push(
    setInterval(() => {
      bot.sendReminders().catch((e) => console.error('[reminders]', e));
    }, 60_000),
    // Напоминания о плановом ТО — раз в час достаточно.
    setInterval(() => {
      bot.sendMaintenanceReminders().catch((e) => console.error('[maintenance]', e));
    }, 3_600_000),
  );
} else {
  console.warn('[bot] BOT_TOKEN не задан — бот и напоминания выключены');
}

const shutdown = () => {
  console.log('Остановка...');
  bot?.stop();
  timers.forEach(clearInterval);
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
