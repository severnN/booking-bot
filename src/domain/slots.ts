import type { WorkingDay } from '../config.ts';
import { localTime, weekday, zonedToUtc } from './time.ts';

export interface BusyInterval {
  postId: number;
  start: Date;
  end: Date;
}

export interface SlotQuery {
  /** Местная дата YYYY-MM-DD. */
  date: string;
  durationMin: number;
  /** id постов (подъёмников/боксов), подходящих для услуги. */
  postIds: number[];
  busy: BusyInterval[];
  week: (WorkingDay | null)[];
  closedDates: Set<string>;
  timeZone: string;
  stepMin: number;
  minLeadMin: number;
  now: Date;
}

export interface Slot {
  start: string; // ISO UTC
  time: string; // HH:MM местное
  /** Сколько постов свободно — пригодится для «осталось мало мест». */
  freePosts: number;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Свободные посты на интервал [start, end). */
export function freePostsFor(start: Date, end: Date, postIds: number[], busy: BusyInterval[]): number[] {
  return postIds.filter((pid) => !busy.some((b) => b.postId === pid && overlaps(start, end, b.start, b.end)));
}

/** Все свободные слоты на день. Чистая функция — легко тестировать. */
export function computeSlots(q: SlotQuery): Slot[] {
  if (q.closedDates.has(q.date)) return [];
  const day = q.week[weekday(q.date)];
  if (!day || q.postIds.length === 0) return [];

  const earliest = q.now.getTime() + q.minLeadMin * 60_000;
  const slots: Slot[] = [];
  for (let m = day.open; m + q.durationMin <= day.close; m += q.stepMin) {
    const start = zonedToUtc(q.date, m, q.timeZone);
    if (start.getTime() < earliest) continue;
    const end = new Date(start.getTime() + q.durationMin * 60_000);
    const free = freePostsFor(start, end, q.postIds, q.busy);
    if (free.length > 0) {
      slots.push({ start: start.toISOString(), time: localTime(start, q.timeZone), freePosts: free.length });
    }
  }
  return slots;
}

/** Проверка, что произвольное время начала попадает в рабочую сетку дня. */
export function isOnGrid(start: Date, durationMin: number, date: string, q: Pick<SlotQuery, 'week' | 'closedDates' | 'timeZone' | 'stepMin'>): boolean {
  if (q.closedDates.has(date)) return false;
  const day = q.week[weekday(date)];
  if (!day) return false;
  for (let m = day.open; m + durationMin <= day.close; m += q.stepMin) {
    if (zonedToUtc(date, m, q.timeZone).getTime() === start.getTime()) return true;
  }
  return false;
}
