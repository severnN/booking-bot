import type { Config } from '../config.ts';
import type { Db } from '../db/sql.ts';
import { nextMaintenance, type NextMaintenance, type Visit } from '../domain/maintenance.ts';
import { AppError, carLabel } from './booking.ts';

/** Запись в истории обслуживания автомобиля. */
export interface ServiceRecord {
  bookingId: number;
  date: string;
  serviceName: string;
  isMaintenance: boolean;
  mileageKm: number | null;
  notes: string;
  rating: number | null;
}

export interface CarCare {
  records: ServiceRecord[];
  next: (NextMaintenance & { lastDate: string; lastMileageKm: number | null }) | null;
}

export interface MaintenanceReminder {
  carId: number;
  carLabel: string;
  tgId: number;
  lastDate: string;
  lastMileageKm: number | null;
  next: NextMaintenance;
}

export interface Review {
  bookingId: number;
  rating: number;
  comment: string;
  createdAt: string;
  serviceName: string;
  clientName: string;
  visitDate: string;
}

export type ReviewEvent = { type: 'rated' | 'commented'; review: Review; clientTgId: number | null };

const iso = (v: Date | string) => new Date(v).toISOString();

/**
 * «Забота о клиенте» после визита: история обслуживания, напоминания о ТО, отзывы.
 */
export class CareService {
  db: Db;
  cfg: Config;
  now: () => Date;
  private listeners: ((e: ReviewEvent) => void | Promise<void>)[] = [];

  constructor(db: Db, cfg: Config, now: () => Date = () => new Date()) {
    this.db = db;
    this.cfg = cfg;
    this.now = now;
  }

  on(listener: (e: ReviewEvent) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  private emit(e: ReviewEvent): void {
    for (const l of this.listeners) {
      Promise.resolve()
        .then(() => l(e))
        .catch((err) => console.error('[review listener]', err));
    }
  }

  private get rule() {
    return { months: this.cfg.maintenanceMonths, km: this.cfg.maintenanceKm, defaultKmPerMonth: this.cfg.avgKmPerMonth };
  }

  // ---------- история ----------

  private async records(carId: number): Promise<ServiceRecord[]> {
    const rows = await this.db.all(
      `SELECT b.id, b.start_at, b.mileage_km, b.work_notes, s.name, s.is_maintenance, r.rating
       FROM bookings b
       JOIN services s ON s.id = b.service_id
       LEFT JOIN reviews r ON r.booking_id = b.id
       WHERE b.car_id = $1 AND b.status = 'done'
       ORDER BY b.start_at DESC`,
      [carId],
    );
    return rows.map((r) => ({
      bookingId: r.id,
      date: iso(r.start_at),
      serviceName: r.name,
      isMaintenance: r.is_maintenance,
      mileageKm: r.mileage_km ?? null,
      notes: r.work_notes,
      rating: r.rating ?? null,
    }));
  }

  private calcNext(records: ServiceRecord[]): CarCare['next'] {
    const last = records.find((r) => r.isMaintenance);
    if (!last) return null;
    const visits: Visit[] = records.map((r) => ({ at: new Date(r.date), mileageKm: r.mileageKm }));
    const next = nextMaintenance({ at: new Date(last.date), mileageKm: last.mileageKm }, visits, this.rule);
    return { ...next, lastDate: last.date, lastMileageKm: last.mileageKm };
  }

  /** История и следующее ТО для автомобиля клиента. */
  async carCare(userId: number, carId: number): Promise<CarCare> {
    const car = await this.db.one('SELECT id FROM cars WHERE id = $1 AND user_id = $2', [carId, userId]);
    if (!car) throw new AppError(404, 'car_not_found', 'Автомобиль не найден');
    const records = await this.records(carId);
    return { records, next: this.calcNext(records) };
  }

  // ---------- напоминания о ТО ----------

  /**
   * Автомобили, которым пора на ТО, — каждый «забирается» атомарно (условный UPDATE),
   * так что при нескольких копиях приложения напоминание уйдёт один раз на каждое ТО.
   * Не напоминаем, если клиент уже записан на ТО.
   */
  async claimMaintenanceReminders(): Promise<MaintenanceReminder[]> {
    const candidates = await this.db.all(
      `SELECT DISTINCT ON (c.id) c.id AS car_id, c.make, c.model, c.year, c.plate, c.maint_reminded_booking_id,
              u.tg_id, b.id AS last_id
       FROM cars c
       JOIN users u ON u.id = c.user_id
       JOIN bookings b ON b.car_id = c.id AND b.status = 'done'
       JOIN services s ON s.id = b.service_id AND s.is_maintenance
       WHERE NOT c.archived AND u.tg_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM bookings f JOIN services fs ON fs.id = f.service_id
           WHERE f.car_id = c.id AND fs.is_maintenance AND f.status IN ('pending','confirmed') AND f.start_at > $1
         )
       ORDER BY c.id, b.start_at DESC`,
      [this.now()],
    );
    const horizon = this.now().getTime() + this.cfg.maintenanceNoticeDays * 86_400_000;
    const out: MaintenanceReminder[] = [];
    for (const c of candidates) {
      if (c.maint_reminded_booking_id === c.last_id) continue;
      const care = this.calcNext(await this.records(c.car_id));
      if (!care || care.dueDate.getTime() > horizon) continue;
      const claimed = await this.db.run(
        'UPDATE cars SET maint_reminded_booking_id = $1 WHERE id = $2 AND maint_reminded_booking_id IS DISTINCT FROM $1',
        [c.last_id, c.car_id],
      );
      if (claimed === 0) continue; // другая копия приложения успела раньше
      out.push({ carId: c.car_id, carLabel: carLabel(c), tgId: c.tg_id, lastDate: care.lastDate, lastMileageKm: care.lastMileageKm, next: care });
    }
    return out;
  }

  // ---------- отзывы ----------

  private async reviewView(bookingId: number): Promise<{ review: Review; clientTgId: number | null }> {
    const r = await this.db.one(
      `SELECT r.booking_id, r.rating, r.comment, r.created_at, s.name AS service_name, u.name AS client_name, u.tg_id, b.start_at
       FROM reviews r JOIN bookings b ON b.id = r.booking_id JOIN services s ON s.id = b.service_id JOIN users u ON u.id = b.user_id
       WHERE r.booking_id = $1`,
      [bookingId],
    );
    return {
      review: {
        bookingId: r.booking_id,
        rating: r.rating,
        comment: r.comment,
        createdAt: iso(r.created_at),
        serviceName: r.service_name,
        clientName: r.client_name,
        visitDate: iso(r.start_at),
      },
      clientTgId: r.tg_id ?? null,
    };
  }

  private async assertReviewable(bookingId: number, userId: number): Promise<void> {
    const b = await this.db.one<{ status: string }>('SELECT status FROM bookings WHERE id = $1 AND user_id = $2', [bookingId, userId]);
    if (!b) throw new AppError(404, 'booking_not_found', 'Запись не найдена');
    if (b.status !== 'done') throw new AppError(409, 'not_done', 'Оценить можно только завершённый визит');
  }

  /** Поставить или изменить оценку. Комментарий необязателен. */
  async rate(bookingId: number, userId: number, rating: unknown, comment?: unknown): Promise<Review> {
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError(400, 'bad_rating', 'Оценка — от 1 до 5');
    await this.assertReviewable(bookingId, userId);
    const text = typeof comment === 'string' ? comment.trim().slice(0, 2000) : '';
    await this.db.run(
      `INSERT INTO reviews (booking_id, rating, comment) VALUES ($1, $2, $3)
       ON CONFLICT (booking_id) DO UPDATE
         SET rating = EXCLUDED.rating,
             comment = CASE WHEN EXCLUDED.comment <> '' THEN EXCLUDED.comment ELSE reviews.comment END,
             updated_at = now()`,
      [bookingId, n, text],
    );
    const v = await this.reviewView(bookingId);
    this.emit({ type: text ? 'commented' : 'rated', ...v });
    return v.review;
  }

  /** Дописать комментарий к уже поставленной оценке (например, ответом боту). */
  async comment(bookingId: number, userId: number, comment: string): Promise<Review> {
    await this.assertReviewable(bookingId, userId);
    const text = comment.trim().slice(0, 2000);
    if (!text) throw new AppError(400, 'empty_comment', 'Пустой комментарий');
    const n = await this.db.run('UPDATE reviews SET comment = $1, updated_at = now() WHERE booking_id = $2', [text, bookingId]);
    if (n === 0) throw new AppError(409, 'no_rating', 'Сначала поставьте оценку');
    const v = await this.reviewView(bookingId);
    this.emit({ type: 'commented', ...v });
    return v.review;
  }

  /** Для админа: средняя оценка и последние отзывы. */
  async reviewsSummary(limit = 20): Promise<{ average: number | null; count: number; recent: Review[] }> {
    const agg = await this.db.one<{ avg: number | null; n: number }>('SELECT round(avg(rating)::numeric, 2)::float8 AS avg, COUNT(*)::int AS n FROM reviews');
    const ids = await this.db.all<{ booking_id: number }>('SELECT booking_id FROM reviews ORDER BY created_at DESC LIMIT $1', [limit]);
    const recent: Review[] = [];
    for (const { booking_id } of ids) recent.push((await this.reviewView(booking_id)).review);
    return { average: agg?.avg ?? null, count: agg?.n ?? 0, recent };
  }
}
