import { readFileSync, existsSync } from 'node:fs';

/** Простая загрузка .env без зависимостей: KEY=VALUE, # — комментарии. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface WorkingDay {
  /** Минуты от полуночи по местному времени сервиса. */
  open: number;
  close: number;
}

export interface Config {
  botToken: string;
  botUsername: string;
  /** Публичный HTTPS-адрес веб-клиента (нужен Telegram для Mini App). */
  webAppUrl: string;
  port: number;
  /** postgres://user:pass@host:5432/db */
  databaseUrl: string;
  /** webhook — для продакшена (несколько копий за балансировщиком), polling — для разработки. */
  botMode: 'webhook' | 'polling';
  /** Секрет, который Telegram присылает в заголовке X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret: string;
  sessionSecret: string;
  adminIds: number[];
  /** Чат (личка админа или рабочая группа), куда падают новые записи. */
  adminChatId: string;
  timeZone: string;
  slotStepMin: number;
  /** Минимум минут от «сейчас» до начала записи. */
  minLeadMin: number;
  /** На сколько дней вперёд можно записаться. */
  horizonDays: number;
  /** Индекс — день недели (0 = вс). null — выходной. */
  week: (WorkingDay | null)[];
  serviceName: string;
  serviceAddress: string;
  servicePhone: string;
  /** Плановое ТО: раз в N месяцев или каждые N км — что наступит раньше. */
  maintenanceMonths: number;
  maintenanceKm: number;
  /** За сколько дней до расчётной даты ТО напомнить. */
  maintenanceNoticeDays: number;
  /** Средний пробег в месяц, если по истории его не посчитать. */
  avgKmPerMonth: number;
  /** Только для локальной разработки: вход без Telegram по tg_id. Никогда не включать в проде. */
  devLogin: boolean;
}

function parseHours(spec: string): WorkingDay | null {
  if (!spec || spec === '-') return null;
  const [a, b] = spec.split('-');
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  return { open: toMin(a), close: toMin(b) };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Формат: "вс,пн,вт,ср,чт,пт,сб" — например "-,09:00-20:00,...,10:00-16:00"
  const weekSpec = env.WORKING_HOURS ?? '-,09:00-20:00,09:00-20:00,09:00-20:00,09:00-20:00,09:00-20:00,10:00-16:00';
  const week = weekSpec.split(',').map((s) => parseHours(s.trim()));
  if (week.length !== 7) throw new Error('WORKING_HOURS: нужно 7 значений через запятую, начиная с воскресенья');

  return {
    botToken: env.BOT_TOKEN ?? '',
    botUsername: env.BOT_USERNAME ?? '',
    webAppUrl: env.WEBAPP_URL ?? '',
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? '',
    botMode: env.BOT_MODE === 'polling' ? 'polling' : 'webhook',
    webhookSecret: env.WEBHOOK_SECRET ?? '',
    sessionSecret: env.SESSION_SECRET ?? '',
    adminIds: (env.ADMIN_TG_IDS ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    adminChatId: env.ADMIN_CHAT_ID ?? '',
    timeZone: env.TIMEZONE ?? 'Europe/Moscow',
    slotStepMin: Number(env.SLOT_STEP_MIN ?? 30),
    minLeadMin: Number(env.MIN_LEAD_MIN ?? 60),
    horizonDays: Number(env.HORIZON_DAYS ?? 14),
    week,
    serviceName: env.SERVICE_NAME ?? 'Автосервис',
    serviceAddress: env.SERVICE_ADDRESS ?? '',
    servicePhone: env.SERVICE_PHONE ?? '',
    maintenanceMonths: Number(env.MAINTENANCE_MONTHS ?? 12),
    maintenanceKm: Number(env.MAINTENANCE_KM ?? 10000),
    maintenanceNoticeDays: Number(env.MAINTENANCE_NOTICE_DAYS ?? 14),
    avgKmPerMonth: Number(env.AVG_KM_PER_MONTH ?? 1250),
    devLogin: env.DEV_LOGIN === '1',
  };
}
