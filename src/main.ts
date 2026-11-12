import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, readConfig } from './config.ts';
import { openDb, seedIfEmpty } from './db.ts';
import { BookingService } from './services/booking.ts';
import { UserService } from './services/users.ts';
import { createApp } from './http/server.ts';
import { TelegramApi } from './bot/api.ts';
import { Bot } from './bot/bot.ts';

loadDotEnv();
const cfg = readConfig();

if (!cfg.sessionSecret || cfg.sessionSecret.length < 32) {
  console.error('SESSION_SECRET должен быть длиной от 32 символов. Сгенерировать: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}
if (!cfg.botToken && !cfg.devLogin) {
  console.error('Не задан BOT_TOKEN (для локальной разработки без бота можно включить DEV_LOGIN=1)');
  process.exit(1);
}

const db = openDb(cfg.dbPath);
seedIfEmpty(db);

const bookings = new BookingService(db, cfg);
const users = new UserService(db);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = createApp({ cfg, bookings, users, publicDir: join(root, 'public') });
server.listen(cfg.port, () => console.log(`[http] http://localhost:${cfg.port}`));

let bot: Bot | null = null;
let timer: NodeJS.Timeout | null = null;
if (cfg.botToken) {
  bot = new Bot(new TelegramApi(cfg.botToken), cfg, bookings, users);
  void bot.start();
  timer = setInterval(() => {
    bot!.sendReminders().catch((e) => console.error('[reminders]', e));
  }, 60_000);
} else {
  console.warn('[bot] BOT_TOKEN не задан — бот и напоминания выключены');
}

const shutdown = () => {
  console.log('Остановка...');
  bot?.stop();
  if (timer) clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
