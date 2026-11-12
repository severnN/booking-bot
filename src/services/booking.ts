import type { Config } from '../config.ts';
import { pgCode, PG_EXCLUSION_VIOLATION, type Db } from '../db/sql.ts';
import { computeSlots, freePostsFor, isOnGrid, type BusyInterval, type Slot } from '../domain/slots.ts';
import { addDays, isValidDate, localDate, weekday } from '../domain/time.ts';

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
const ACTIVE_SQL = `('${ACTIVE_STATUSES.join("','")}')`;

const slotTaken = () => new AppError(409, 'slot_taken', 'Это время только что заняли — выберите другое');

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
  carId: number | null;
  car: string;
  comment: string;
  source: string;
  clientConfirmed: boolean;
  client: { id: number; tgId: number | null; name: string; phone: string };
  /** Итог визита — заполняется при выдаче машины. */
  mileageKm: number | null;
  workNotes: string;
  /** Оценка клиента 1–5, если оставил отзыв. */
  rating: number | null;
}

export type BookingEvent =
  | { type: 'created'; booking: BookingView }
  | { type: 'cancelled_by_client'; booking: BookingView }
  | { type: 'rescheduled'; booking: BookingView; previousStart: string }
  | { type: 'status_changed'; booking: BookingView; previous: BookingStatus }
  | { type: 'client_confirmed'; booking: BookingView };

export type EventListener = (e: BookingEvent) => void | Promise<void>;

export class BookingService {
  db: Db;
  cfg: Config;
  now: () => Date;
  private listeners: EventListener[] = [];

  constructor(db: Db, cfg: Config, now: () => Date = () => new Date()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
  }

  on(listener: EventListener): void {
    this.listeners.push(listener);
  }

  protected emit(e: BookingEvent): void {
    for (const l of this.listeners) {
      Promise.resolve()
        .then(() => l(e))
        .catch((err) => console.error('[event listener]', err));
    }
  }

  // ---------- каталог ----------

  async listServices(): Promise<Service[]> {
    const rows = await this.db.all('SELECT id, category, name, duration_min, price_from, post_kind FROM services WHERE active ORDER BY sort, id');
    return rows.map(toService);
  }

  async getService(id: number, db: Db = this.db): Promise<Service> {
    const row = await db.one('SELECT id, category, name, duration_min, price_from, post_kind FROM services WHERE id = $1 AND active', [id]);
    if (!row) throw new AppError(404, 'service_not_found', 'Услуга не найдена');
    return toService(row);
  }

  // ---------- слоты ----------

  private async postIdsFor(kind: string, db: Db = this.db): Promise<number[]> {
    return (await db.all<{ id: number }>('SELECT id FROM posts WHERE kind = $1 AND active ORDER BY id', [kind])).map((r) => r.id);
  }

  private async closedDates(): Promise<Set<string>> {
    return new Set((await this.db.all<{ d: string }>('SELECT date::text AS d FROM closed_dates WHERE date >= CURRENT_DATE - 1')).map((r) => r.d));
  }

  private async busyFor(db: Db, postIds: number[], from: Date, to: Date, excludeBookingId?: number): Promise<BusyInterval[]> {
    if (postIds.length === 0) return [];
    const rows = await db.all<{ post_id: number; start_at: Date; end_at: Date }>(
      `SELECT post_id, start_at, end_at FROM bookings
       WHERE status IN ${ACTIVE_SQL} AND post_id = ANY($1::int[])
         AND start_at < $2 AND end_at > $3 AND id <> $4`,
      [postIds, to, from, excludeBookingId ?? -1],
    );
    return rows.map((r) => ({ postId: r.post_id, start: new Date(r.start_at), end: new Date(r.end_at) }));
  }

  /** Даты, на которые в принципе можно записаться (рабочие дни в пределах горизонта). */
  async availableDates(): Promise<string[]> {
    const today = localDate(this.now(), this.cfg.timeZone);
    const closed = await this.closedDates();
    const out: string[] = [];
    for (let i = 0; i <= this.cfg.horizonDays; i++) {
      const d = addDays(today, i);
      if (this.cfg.week[weekday(d)] && !closed.has(d)) out.push(d);
    }
    return out;
  }

  async slots(serviceId: number, date: string, excludeBookingId?: number): Promise<Slot[]> {
    if (!isValidDate(date)) throw new AppError(400, 'bad_date', 'Неверная дата');
    if (!(await this.availableDates()).includes(date)) return [];
    const svc = await this.getService(serviceId);
    const postIds = await this.postIdsFor(svc.postKind);
    // Занятость берём с запасом на сутки в обе стороны — проще, чем считать границы дня в поясе.
    const dayStart = new Date(`${date}T00:00:00Z`);
    const busy = await this.busyFor(this.db, postIds, new Date(dayStart.getTime() - 86_400_000), new Date(dayStart.getTime() + 2 * 86_400_000), excludeBookingId);
    return computeSlots({
      date,
      durationMin: svc.durationMin,
      postIds,
      busy,
      week: this.cfg.week,
      closedDates: await this.closedDates(),
      timeZone: this.cfg.timeZone,
      stepMin: this.cfg.slotStepMin,
      minLeadMin: this.cfg.minLeadMin,
      now: this.now(),
    });
  }

  // ---------- записи ----------

  private async validateStart(svc: Service, startIso: string, opts: { skipLead?: boolean } = {}): Promise<{ start: Date; end: Date }> {
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) throw new AppError(400, 'bad_start', 'Неверное время');
    const date = localDate(start, this.cfg.timeZone);
    if (!opts.skipLead) {
      if (!(await this.availableDates()).includes(date)) throw new AppError(409, 'date_unavailable', 'На эту дату запись недоступна');
      if (start.getTime() < this.now().getTime() + this.cfg.minLeadMin * 60_000) {
        throw new AppError(409, 'too_soon', 'Это время уже недоступно для записи');
      }
    }
    const grid = { week: this.cfg.week, closedDates: await this.closedDates(), timeZone: this.cfg.timeZone, stepMin: this.cfg.slotStepMin };
    if (!isOnGrid(start, svc.durationMin, date, grid)) throw new AppError(409, 'off_grid', 'Сервис в это время не работает');
    return { start, end: new Date(start.getTime() + svc.durationMin * 60_000) };
  }

  /**
   * Выбор свободного поста внутри транзакции. Advisory lock по типу поста сериализует
   * параллельные записи на один ресурс; exclusion constraint в БД — вторая линия защиты.
   */
  private async pickPost(t: Db, svc: Service, start: Date, end: Date, excludeBookingId?: number): Promise<number> {
    await t.run('SELECT pg_advisory_xact_lock(hashtext($1))', [`post_kind:${svc.postKind}`]);
    const postIds = await this.postIdsFor(svc.postKind, t);
    const free = freePostsFor(start, end, postIds, await this.busyFor(t, postIds, start, end, excludeBookingId));
    if (free.length === 0) throw slotTaken();
    return free[0];
  }

  async create(input: { userId: number; serviceId: number; start: string; carId?: number | null; carText?: string; comment?: string; source?: 'app' | 'admin' }): Promise<BookingView> {
    const svc = await this.getService(input.serviceId);
    const isAdmin = input.source === 'admin';
    const { start, end } = await this.validateStart(svc, input.start, { skipLead: isAdmin });

    if (input.carId != null) {
      const car = await this.db.one('SELECT id FROM cars WHERE id = $1 AND user_id = $2 AND NOT archived', [input.carId, input.userId]);
      if (!car) throw new AppError(400, 'car_not_found', 'Автомобиль не найден');
    } else if (!isAdmin && !input.carText?.trim()) {
      throw new AppError(400, 'car_required', 'Укажите автомобиль');
    }

    let id: number;
    try {
      id = await this.db.tx(async (t) => {
        if (!isAdmin) {
          // Блокируем строку клиента, чтобы лимит активных записей нельзя было обойти параллельными запросами.
          await t.run('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
          const row = await t.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = $1 AND status IN ${ACTIVE_SQL} AND end_at > $2`, [
            input.userId,
            this.now(),
          ]);
          if ((row?.n ?? 0) >= MAX_ACTIVE_PER_USER) throw new AppError(409, 'too_many', `Можно иметь не больше ${MAX_ACTIVE_PER_USER} активных записей`);
        }
        const postId = await this.pickPost(t, svc, start, end);
        const r = await t.one<{ id: number }>(
          `INSERT INTO bookings (user_id, car_id, car_text, service_id, post_id, start_at, end_at, status, comment, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            input.userId,
            input.carId ?? null,
            (input.carText ?? '').trim().slice(0, 200),
            svc.id,
            postId,
            start,
            end,
            isAdmin ? 'confirmed' : 'pending',
            (input.comment ?? '').trim().slice(0, 1000),
            isAdmin ? 'admin' : 'app',
          ],
        );
        return r!.id;
      });
    } catch (e) {
      if (pgCode(e) === PG_EXCLUSION_VIOLATION) throw slotTaken();
      throw e;
    }
    const view = await this.get(id);
    this.emit({ type: 'created', booking: view });
    return view;
  }

  async get(id: number): Promise<BookingView> {
    const row = await this.db.one(`${VIEW_SQL} WHERE b.id = $1`, [id]);
    if (!row) throw new AppError(404, 'booking_not_found', 'Запись не найдена');
    return toView(row);
  }

  async getMany(ids: number[]): Promise<BookingView[]> {
    if (ids.length === 0) return [];
    return (await this.db.all(`${VIEW_SQL} WHERE b.id = ANY($1::int[]) ORDER BY b.start_at`, [ids])).map(toView);
  }

  protected async getOwned(id: number, userId: number): Promise<BookingView> {
    const b = await this.get(id);
    if (b.client.id !== userId) throw new AppError(404, 'booking_not_found', 'Запись не найдена');
    return b;
  }

  async listForUser(userId: number): Promise<BookingView[]> {
    // Активные + последние 10 завершённых
    const active = await this.db.all(`${VIEW_SQL} WHERE b.user_id = $1 AND b.status IN ${ACTIVE_SQL} ORDER BY b.start_at`, [userId]);
    const past = await this.db.all(`${VIEW_SQL} WHERE b.user_id = $1 AND b.status NOT IN ${ACTIVE_SQL} ORDER BY b.start_at DESC LIMIT 10`, [userId]);
    return [...active, ...past].map(toView);
  }

  private assertClientCanChange(b: BookingView): void {
    if (!['pending', 'confirmed'].includes(b.status)) throw new AppError(409, 'not_changeable', 'Эту запись уже нельзя изменить');
    if (new Date(b.start).getTime() <= this.now().getTime()) throw new AppError(409, 'not_changeable', 'Время записи уже прошло');
  }

  async cancelByClient(id: number, userId: number): Promise<BookingView> {
    const b = await this.getOwned(id, userId);
    this.assertClientCanChange(b);
    // Условие на статус в UPDATE — защита от гонки с действием администратора.
    const n = await this.db.run(`UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('pending','confirmed')`, [id]);
    if (n === 0) throw new AppError(409, 'not_changeable', 'Эту запись уже нельзя изменить');
    const view = await this.get(id);
    this.emit({ type: 'cancelled_by_client', booking: view });
    return view;
  }

  async reschedule(id: number, userId: number, newStart: string): Promise<BookingView> {
    const b = await this.getOwned(id, userId);
    this.assertClientCanChange(b);
    const svc = await this.getService(b.service.id);
    const { start, end } = await this.validateStart(svc, newStart);
    try {
      await this.db.tx(async (t) => {
        const postId = await this.pickPost(t, svc, start, end, id);
        // После переноса запись снова ждёт подтверждения сервиса, напоминания сбрасываются.
        const n = await t.run(
          `UPDATE bookings SET post_id = $1, start_at = $2, end_at = $3, status = 'pending',
             reminded_24h = false, reminded_2h = false, client_confirmed = false, updated_at = now()
           WHERE id = $4 AND status IN ('pending','confirmed')`,
          [postId, start, end, id],
        );
        if (n === 0) throw new AppError(409, 'not_changeable', 'Эту запись уже нельзя изменить');
      });
    } catch (e) {
      if (pgCode(e) === PG_EXCLUSION_VIOLATION) throw slotTaken();
      throw e;
    }
    const view = await this.get(id);
    this.emit({ type: 'rescheduled', booking: view, previousStart: b.start });
    return view;
  }

  async confirmByClient(id: number, userId: number): Promise<BookingView> {
    const b = await this.getOwned(id, userId);
    if (!(ACTIVE_STATUSES as readonly string[]).includes(b.status)) throw new AppError(409, 'not_changeable', 'Запись неактивна');
    await this.db.run('UPDATE bookings SET client_confirmed = true, updated_at = now() WHERE id = $1', [id]);
    const view = await this.get(id);
    this.emit({ type: 'client_confirmed', booking: view });
    return view;
  }

  // ---------- админ ----------

  async schedule(date: string): Promise<{ posts: { id: number; name: string; kind: string }[]; bookings: BookingView[] }> {
    if (!isValidDate(date)) throw new AppError(400, 'bad_date', 'Неверная дата');
    const posts = await this.db.all('SELECT id, name, kind FROM posts WHERE active ORDER BY id');
    const rows = await this.db.all(`${VIEW_SQL} WHERE (b.start_at AT TIME ZONE $1)::date = $2::date ORDER BY b.start_at`, [this.cfg.timeZone, date]);
    return { posts, bookings: rows.map(toView) };
  }

  async setStatus(id: number, status: BookingStatus): Promise<BookingView> {
    if (!(ALL_STATUSES as readonly string[]).includes(status)) throw new AppError(400, 'bad_status', 'Неизвестный статус');
    const b = await this.get(id);
    if (b.status === status) return b;
    try {
      await this.db.run(
        `UPDATE bookings SET status = $1, updated_at = now(),
           done_at = CASE WHEN $1 = 'done' THEN COALESCE(done_at, now()) ELSE done_at END
         WHERE id = $2`,
        [status, id],
      );
    } catch (e) {
      // Например, вернуть отменённую запись, когда её время уже заняли.
      if (pgCode(e) === PG_EXCLUSION_VIOLATION) throw new AppError(409, 'slot_taken', 'Это время уже занято другой записью');
      throw e;
    }
    const view = await this.get(id);
    this.emit({ type: 'status_changed', booking: view, previous: b.status });
    return view;
  }

  /**
   * Выдача машины: статус done + пробег и что сделано — это попадает в историю обслуживания.
   */
  async complete(id: number, input: { mileageKm?: unknown; notes?: unknown }): Promise<BookingView> {
    const mileage = input.mileageKm === undefined || input.mileageKm === null || input.mileageKm === '' ? null : Number(input.mileageKm);
    if (mileage !== null && (!Number.isInteger(mileage) || mileage < 0 || mileage > 3_000_000)) {
      throw new AppError(400, 'bad_mileage', 'Проверьте пробег');
    }
    const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
    const b = await this.get(id);
    if (!['confirmed', 'in_progress', 'ready', 'done'].includes(b.status)) throw new AppError(409, 'not_changeable', 'Эту запись нельзя закрыть');
    await this.db.run(
      `UPDATE bookings SET status = 'done', mileage_km = $1, work_notes = $2, done_at = COALESCE(done_at, now()), updated_at = now() WHERE id = $3`,
      [mileage, notes, id],
    );
    const view = await this.get(id);
    if (b.status !== 'done') this.emit({ type: 'status_changed', booking: view, previous: b.status });
    return view;
  }

  // ---------- напоминания ----------

  /**
   * Атомарно «забирает» записи, которым пора напомнить, и помечает их.
   * SKIP LOCKED — чтобы при нескольких копиях приложения напоминание ушло ровно один раз.
   */
  async claimReminders(kind: '24h' | '2h'): Promise<BookingView[]> {
    const hours = kind === '24h' ? 24 : 2;
    const col = kind === '24h' ? 'reminded_24h' : 'reminded_2h';
    const now = this.now();
    const until = new Date(now.getTime() + hours * 3_600_000);
    // Для 24h не шлём, если до визита уже меньше 3 часов — тогда сработает 2h.
    const from = kind === '24h' ? new Date(now.getTime() + 3 * 3_600_000) : now;
    const rows = await this.db.all<{ id: number }>(
      `UPDATE bookings SET ${col} = true
       WHERE id IN (
         SELECT b.id FROM bookings b JOIN users u ON u.id = b.user_id
         WHERE b.status IN ('pending','confirmed') AND NOT b.${col}
           AND b.start_at > $1 AND b.start_at <= $2 AND u.tg_id IS NOT NULL
         FOR UPDATE OF b SKIP LOCKED
       )
       RETURNING id`,
      [from, until],
    );
    return this.getMany(rows.map((r) => r.id));
  }
}

const VIEW_SQL = `
  SELECT b.id, b.status, b.start_at, b.end_at, b.comment, b.source, b.client_confirmed, b.car_text, b.car_id,
         s.id AS s_id, s.name AS s_name, s.duration_min, s.price_from,
         p.name AS post_name,
         c.make, c.model, c.year, c.plate,
         u.id AS u_id, u.tg_id, u.name AS u_name, u.phone,
         b.mileage_km, b.work_notes, r.rating
  FROM bookings b
  JOIN services s ON s.id = b.service_id
  JOIN posts p ON p.id = b.post_id
  JOIN users u ON u.id = b.user_id
  LEFT JOIN cars c ON c.id = b.car_id
  LEFT JOIN reviews r ON r.booking_id = b.id`;

function toService(r: any): Service {
  return { id: r.id, category: r.category, name: r.name, durationMin: r.duration_min, priceFrom: r.price_from, postKind: r.post_kind };
}

export function carLabel(c: { make?: string | null; model?: string | null; year?: number | null; plate?: string | null }): string {
  return [c.make, c.model, c.year ? String(c.year) : '', c.plate ? `(${c.plate})` : ''].filter(Boolean).join(' ');
}

const iso = (v: Date | string) => new Date(v).toISOString();

function toView(r: any): BookingView {
  return {
    id: r.id,
    status: r.status,
    start: iso(r.start_at),
    end: iso(r.end_at),
    service: { id: r.s_id, name: r.s_name, durationMin: r.duration_min, priceFrom: r.price_from },
    postName: r.post_name,
    carId: r.car_id ?? null,
    car: r.make ? carLabel(r) : r.car_text,
    comment: r.comment,
    source: r.source,
    clientConfirmed: !!r.client_confirmed,
    client: { id: r.u_id, tgId: r.tg_id ?? null, name: r.u_name, phone: r.phone },
    mileageKm: r.mileage_km ?? null,
    workNotes: r.work_notes ?? '',
    rating: r.rating ?? null,
  };
}
