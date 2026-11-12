import type { Config } from '../config.ts';
import { tx, type DB } from '../db.ts';
import { computeSlots, freePostsFor, isOnGrid, type BusyInterval, type Slot } from '../domain/slots.ts';
import { addDays, isValidDate, localDate } from '../domain/time.ts';

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ACTIVE_STATUSES = ['pending', 'confirmed', 'in_progress', 'ready'] as const;
export const ALL_STATUSES = ['pending', 'confirmed', 'in_progress', 'ready', 'done', 'cancelled', 'no_show'] as const;
export type BookingStatus = (typeof ALL_STATUSES)[number];

export const STATUS_LABEL: Record<BookingStatus, string> = {
  pending: 'Ожидает подтверждения',
  confirmed: 'Подтверждена',
  in_progress: 'В работе',
  ready: 'Машина готова',
  done: 'Завершена',
  cancelled: 'Отменена',
  no_show: 'Клиент не приехал',
};

const MAX_ACTIVE_PER_USER = 3;

export interface Service {
  id: number;
  category: string;
  name: string;
  durationMin: number;
  priceFrom: number;
  postKind: string;
}

export interface BookingView {
  id: number;
  status: BookingStatus;
  start: string;
  end: string;
  service: { id: number; name: string; durationMin: number; priceFrom: number };
  postName: string;
  car: string;
  comment: string;
  source: string;
  clientConfirmed: boolean;
  client: { id: number; tgId: number | null; name: string; phone: string };
}

export type BookingEvent =
  | { type: 'created'; booking: BookingView }
  | { type: 'cancelled_by_client'; booking: BookingView }
  | { type: 'rescheduled'; booking: BookingView; previousStart: string }
  | { type: 'status_changed'; booking: BookingView; previous: BookingStatus }
  | { type: 'client_confirmed'; booking: BookingView };

export type EventListener = (e: BookingEvent) => void | Promise<void>;

const ACTIVE_SQL = `('${ACTIVE_STATUSES.join("','")}')`;

export class BookingService {
  db: DB;
  cfg: Config;
  now: () => Date;
  private listeners: EventListener[] = [];

  constructor(db: DB, cfg: Config, now: () => Date = () => new Date()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
  }

  on(listener: EventListener): void {
    this.listeners.push(listener);
  }

  private emit(e: BookingEvent): void {
    for (const l of this.listeners) {
      Promise.resolve()
        .then(() => l(e))
        .catch((err) => console.error('[event listener]', err));
    }
  }

  // ---------- каталог ----------

  listServices(): Service[] {
    return (
      this.db
        .prepare('SELECT id, category, name, duration_min, price_from, post_kind FROM services WHERE active = 1 ORDER BY sort, id')
        .all() as any[]
    ).map(toService);
  }

  getService(id: number): Service {
    const row = this.db.prepare('SELECT id, category, name, duration_min, price_from, post_kind FROM services WHERE id = ? AND active = 1').get(id);
    if (!row) throw new AppError(404, 'service_not_found', 'Услуга не найдена');
    return toService(row);
  }

  // ---------- слоты ----------

  private postIdsFor(kind: string): number[] {
    return (this.db.prepare('SELECT id FROM posts WHERE kind = ? AND active = 1 ORDER BY id').all(kind) as { id: number }[]).map((r) => r.id);
  }

  private closedDates(): Set<string> {
    return new Set((this.db.prepare('SELECT date FROM closed_dates').all() as { date: string }[]).map((r) => r.date));
  }

  private busyFor(postIds: number[], from: Date, to: Date, excludeBookingId?: number): BusyInterval[] {
    if (postIds.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT post_id, start_at, end_at FROM bookings
         WHERE status IN ${ACTIVE_SQL}
           AND post_id IN (${postIds.map(() => '?').join(',')})
           AND start_at < ? AND end_at > ?
           AND id != ?`,
      )
      .all(...postIds, to.toISOString(), from.toISOString(), excludeBookingId ?? -1) as { post_id: number; start_at: string; end_at: string }[];
    return rows.map((r) => ({ postId: r.post_id, start: new Date(r.start_at), end: new Date(r.end_at) }));
  }

  /** Список доступных для записи дат (с учётом выходных) — для календаря в клиенте. */
  availableDates(): string[] {
    const today = localDate(this.now(), this.cfg.timeZone);
    const closed = this.closedDates();
    const out: string[] = [];
    for (let i = 0; i <= this.cfg.horizonDays; i++) {
      const d = addDays(today, i);
      const [y, m, dd] = d.split('-').map(Number);
      const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
      if (this.cfg.week[wd] && !closed.has(d)) out.push(d);
    }
    return out;
  }

  slots(serviceId: number, date: string, excludeBookingId?: number): Slot[] {
    if (!isValidDate(date)) throw new AppError(400, 'bad_date', 'Неверная дата');
    if (!this.availableDates().includes(date)) return [];
    const svc = this.getService(serviceId);
    const postIds = this.postIdsFor(svc.postKind);
    // Берём занятость с запасом на сутки в обе стороны — проще, чем считать границы дня в поясе.
    const dayStart = new Date(`${date}T00:00:00Z`);
    const busy = this.busyFor(postIds, new Date(dayStart.getTime() - 86_400_000), new Date(dayStart.getTime() + 2 * 86_400_000), excludeBookingId);
    return computeSlots({
      date,
      durationMin: svc.durationMin,
      postIds,
      busy,
      week: this.cfg.week,
      closedDates: this.closedDates(),
      timeZone: this.cfg.timeZone,
      stepMin: this.cfg.slotStepMin,
      minLeadMin: this.cfg.minLeadMin,
      now: this.now(),
    });
  }

  // ---------- записи ----------

  private validateStart(svc: Service, startIso: string, opts: { skipLead?: boolean } = {}): { start: Date; end: Date } {
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) throw new AppError(400, 'bad_start', 'Неверное время');
    const date = localDate(start, this.cfg.timeZone);
    if (!opts.skipLead) {
      if (!this.availableDates().includes(date)) throw new AppError(409, 'date_unavailable', 'На эту дату запись недоступна');
      if (start.getTime() < this.now().getTime() + this.cfg.minLeadMin * 60_000) {
        throw new AppError(409, 'too_soon', 'Это время уже недоступно для записи');
      }
    }
    const grid = { week: this.cfg.week, closedDates: this.closedDates(), timeZone: this.cfg.timeZone, stepMin: this.cfg.slotStepMin };
    if (!isOnGrid(start, svc.durationMin, date, grid)) throw new AppError(409, 'off_grid', 'Сервис в это время не работает');
    return { start, end: new Date(start.getTime() + svc.durationMin * 60_000) };
  }

  /** Найти свободный пост внутри уже открытой транзакции. */
  private pickPost(svc: Service, start: Date, end: Date, excludeBookingId?: number): number {
    const postIds = this.postIdsFor(svc.postKind);
    const free = freePostsFor(start, end, postIds, this.busyFor(postIds, start, end, excludeBookingId));
    if (free.length === 0) throw new AppError(409, 'slot_taken', 'Это время только что заняли — выберите другое');
    return free[0];
  }

  create(input: { userId: number; serviceId: number; start: string; carId?: number | null; carText?: string; comment?: string; source?: 'app' | 'admin' }): BookingView {
    const svc = this.getService(input.serviceId);
    const isAdmin = input.source === 'admin';
    const { start, end } = this.validateStart(svc, input.start, { skipLead: isAdmin });

    if (input.carId != null) {
      const car = this.db.prepare('SELECT id FROM cars WHERE id = ? AND user_id = ? AND archived = 0').get(input.carId, input.userId);
      if (!car) throw new AppError(400, 'car_not_found', 'Автомобиль не найден');
    } else if (!isAdmin && !input.carText?.trim()) {
      throw new AppError(400, 'car_required', 'Укажите автомобиль');
    }

    const id = tx(this.db, () => {
      if (!isAdmin) {
        const { n } = this.db
          .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status IN ${ACTIVE_SQL} AND end_at > ?`)
          .get(input.userId, this.now().toISOString()) as { n: number };
        if (n >= MAX_ACTIVE_PER_USER) throw new AppError(409, 'too_many', `Можно иметь не больше ${MAX_ACTIVE_PER_USER} активных записей`);
      }
      const postId = this.pickPost(svc, start, end);
      const r = this.db
        .prepare(
          `INSERT INTO bookings (user_id, car_id, car_text, service_id, post_id, start_at, end_at, status, comment, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.userId,
          input.carId ?? null,
          (input.carText ?? '').trim().slice(0, 200),
          svc.id,
          postId,
          start.toISOString(),
          end.toISOString(),
          isAdmin ? 'confirmed' : 'pending',
          (input.comment ?? '').trim().slice(0, 1000),
          isAdmin ? 'admin' : 'app',
        );
      return Number(r.lastInsertRowid);
    });
    const view = this.get(id);
    this.emit({ type: 'created', booking: view });
    return view;
  }

  get(id: number): BookingView {
    const row = this.db.prepare(`${VIEW_SQL} WHERE b.id = ?`).get(id);
    if (!row) throw new AppError(404, 'booking_not_found', 'Запись не найдена');
    return toView(row);
  }

  private getOwned(id: number, userId: number): BookingView {
    const b = this.get(id);
    if (b.client.id !== userId) throw new AppError(404, 'booking_not_found', 'Запись не найдена');
    return b;
  }

  listForUser(userId: number): BookingView[] {
    // Активные + последние 10 завершённых
    const active = this.db.prepare(`${VIEW_SQL} WHERE b.user_id = ? AND b.status IN ${ACTIVE_SQL} ORDER BY b.start_at`).all(userId);
    const past = this.db.prepare(`${VIEW_SQL} WHERE b.user_id = ? AND b.status NOT IN ${ACTIVE_SQL} ORDER BY b.start_at DESC LIMIT 10`).all(userId);
    return [...active, ...past].map(toView);
  }

  private assertClientCanChange(b: BookingView): void {
    if (!['pending', 'confirmed'].includes(b.status)) throw new AppError(409, 'not_changeable', 'Эту запись уже нельзя изменить');
    if (new Date(b.start).getTime() <= this.now().getTime()) throw new AppError(409, 'not_changeable', 'Время записи уже прошло');
  }

  cancelByClient(id: number, userId: number): BookingView {
    const b = this.getOwned(id, userId);
    this.assertClientCanChange(b);
    this.db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(this.now().toISOString(), id);
    const view = this.get(id);
    this.emit({ type: 'cancelled_by_client', booking: view });
    return view;
  }

  reschedule(id: number, userId: number, newStart: string): BookingView {
    const b = this.getOwned(id, userId);
    this.assertClientCanChange(b);
    const svc = this.getService(b.service.id);
    const { start, end } = this.validateStart(svc, newStart);
    tx(this.db, () => {
      const postId = this.pickPost(svc, start, end, id);
      // После переноса запись снова ждёт подтверждения сервиса, напоминания сбрасываются.
      this.db
        .prepare(
          `UPDATE bookings SET post_id = ?, start_at = ?, end_at = ?, status = 'pending',
             reminded_24h = 0, reminded_2h = 0, client_confirmed = 0, updated_at = ? WHERE id = ?`,
        )
        .run(postId, start.toISOString(), end.toISOString(), this.now().toISOString(), id);
    });
    const view = this.get(id);
    this.emit({ type: 'rescheduled', booking: view, previousStart: b.start });
    return view;
  }

  confirmByClient(id: number, userId: number): BookingView {
    const b = this.getOwned(id, userId);
    if (!ACTIVE_STATUSES.includes(b.status as any)) throw new AppError(409, 'not_changeable', 'Запись неактивна');
    this.db.prepare('UPDATE bookings SET client_confirmed = 1, updated_at = ? WHERE id = ?').run(this.now().toISOString(), id);
    const view = this.get(id);
    this.emit({ type: 'client_confirmed', booking: view });
    return view;
  }

  // ---------- админ ----------

  schedule(date: string): { posts: { id: number; name: string; kind: string }[]; bookings: BookingView[] } {
    if (!isValidDate(date)) throw new AppError(400, 'bad_date', 'Неверная дата');
    const posts = this.db.prepare('SELECT id, name, kind FROM posts WHERE active = 1 ORDER BY id').all() as any[];
    const dayStart = new Date(`${date}T00:00:00Z`);
    const rows = this.db
      .prepare(`${VIEW_SQL} WHERE b.start_at >= ? AND b.start_at < ? ORDER BY b.start_at`)
      .all(new Date(dayStart.getTime() - 86_400_000).toISOString(), new Date(dayStart.getTime() + 2 * 86_400_000).toISOString());
    const bookings = rows.map(toView).filter((b) => localDate(new Date(b.start), this.cfg.timeZone) === date);
    return { posts, bookings };
  }

  setStatus(id: number, status: BookingStatus): BookingView {
    if (!ALL_STATUSES.includes(status)) throw new AppError(400, 'bad_status', 'Неизвестный статус');
    const b = this.get(id);
    if (b.status === status) return b;
    this.db.prepare('UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now().toISOString(), id);
    const view = this.get(id);
    this.emit({ type: 'status_changed', booking: view, previous: b.status });
    return view;
  }

  // ---------- напоминания ----------

  /** Записи, которым пора отправить напоминание. kind: '24h' | '2h'. */
  dueReminders(kind: '24h' | '2h'): BookingView[] {
    const hours = kind === '24h' ? 24 : 2;
    const col = kind === '24h' ? 'reminded_24h' : 'reminded_2h';
    const now = this.now();
    const until = new Date(now.getTime() + hours * 3_600_000);
    // Для 24h не шлём, если до визита уже меньше 3 часов — тогда сработает 2h.
    const from = kind === '24h' ? new Date(now.getTime() + 3 * 3_600_000) : now;
    return (
      this.db
        .prepare(`${VIEW_SQL} WHERE b.status IN ('pending','confirmed') AND b.${col} = 0 AND b.start_at > ? AND b.start_at <= ? AND u.tg_id IS NOT NULL`)
        .all(from.toISOString(), until.toISOString()) as any[]
    ).map(toView);
  }

  markReminded(id: number, kind: '24h' | '2h'): void {
    const col = kind === '24h' ? 'reminded_24h' : 'reminded_2h';
    this.db.prepare(`UPDATE bookings SET ${col} = 1 WHERE id = ?`).run(id);
  }
}

const VIEW_SQL = `
  SELECT b.id, b.status, b.start_at, b.end_at, b.comment, b.source, b.client_confirmed, b.car_text,
         s.id AS s_id, s.name AS s_name, s.duration_min, s.price_from,
         p.name AS post_name,
         c.make, c.model, c.year, c.plate,
         u.id AS u_id, u.tg_id, u.name AS u_name, u.phone
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN posts p ON p.id = b.post_id
  JOIN users u ON u.id = b.user_id
  LEFT JOIN cars c ON c.id = b.car_id`;

function toService(r: any): Service {
  return { id: r.id, category: r.category, name: r.name, durationMin: r.duration_min, priceFrom: r.price_from, postKind: r.post_kind };
}

export function carLabel(c: { make?: string | null; model?: string | null; year?: number | null; plate?: string | null }): string {
  return [c.make, c.model, c.year ? String(c.year) : '', c.plate ? `(${c.plate})` : ''].filter(Boolean).join(' ');
}

function toView(r: any): BookingView {
  return {
    id: r.id,
    status: r.status,
    start: r.start_at,
    end: r.end_at,
    service: { id: r.s_id, name: r.s_name, durationMin: r.duration_min, priceFrom: r.price_from },
    postName: r.post_name,
    car: r.make ? carLabel(r) : r.car_text,
    comment: r.comment,
    source: r.source,
    clientConfirmed: !!r.client_confirmed,
    client: { id: r.u_id, tgId: r.tg_id ?? null, name: r.u_name, phone: r.phone },
  };
}
