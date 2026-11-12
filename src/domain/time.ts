/**
 * Работа с часовым поясом сервиса без внешних библиотек.
 * В БД всё хранится в UTC (ISO-строки), часы работы задаются в местном времени.
 */

/** Смещение пояса относительно UTC в минутах для конкретного момента. */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Местная дата YYYY-MM-DD + минуты от полуночи → момент в UTC. */
export function zonedToUtc(date: string, minutes: number, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, mo - 1, d, 0, minutes);
  let offset = tzOffsetMinutes(new Date(naive), timeZone);
  let result = naive - offset * 60_000;
  // Повторная коррекция на случай перехода на летнее/зимнее время в этот день.
  const offset2 = tzOffsetMinutes(new Date(result), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    result = naive - offset * 60_000;
  }
  return new Date(result);
}

/** Момент → местная дата YYYY-MM-DD. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Момент → «HH:MM» по местному времени. */
export function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** День недели (0 = вс) для местной даты. */
export function weekday(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** «пт, 14 ноября, 10:30» — для сообщений бота. */
export function humanDateTime(at: Date, timeZone: string): string {
  const s = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return s;
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
