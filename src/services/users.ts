import type { DB } from '../db.ts';
import { AppError, carLabel } from './booking.ts';

export interface User {
  id: number;
  tgId: number | null;
  name: string;
  phone: string;
  consentAt: string | null;
}

export interface Car {
  id: number;
  make: string;
  model: string;
  year: number | null;
  plate: string;
  vin: string;
  label: string;
}

function toUser(r: any): User {
  return { id: r.id, tgId: r.tg_id ?? null, name: r.name, phone: r.phone, consentAt: r.consent_at ?? null };
}

function toCar(r: any): Car {
  return { id: r.id, make: r.make, model: r.model, year: r.year ?? null, plate: r.plate, vin: r.vin, label: carLabel(r) };
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  // 8XXXXXXXXXX → +7XXXXXXXXXX (РФ); в остальном просто добавляем «+».
  if (digits.length === 11 && digits.startsWith('8')) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export class UserService {
  db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** Создать или обновить пользователя по данным из Telegram. */
  upsertTelegram(tg: { id: number; first_name?: string; last_name?: string }): User {
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 100);
    this.db
      .prepare(`INSERT INTO users (tg_id, name) VALUES (?, ?) ON CONFLICT(tg_id) DO UPDATE SET name = CASE WHEN users.name = '' THEN excluded.name ELSE users.name END`)
      .run(tg.id, name);
    return toUser(this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tg.id));
  }

  get(id: number): User {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!r) throw new AppError(404, 'user_not_found', 'Пользователь не найден');
    return toUser(r);
  }

  byTgId(tgId: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
    return r ? toUser(r) : null;
  }

  updateProfile(id: number, input: { name?: unknown; phone?: unknown; consent?: unknown }): User {
    const u = this.get(id);
    const name = input.name !== undefined ? str(input.name, 100) : u.name;
    const phone = input.phone !== undefined ? normalizePhone(str(input.phone, 30)) : u.phone;
    if (phone && (phone.length < 8 || phone.length > 16)) throw new AppError(400, 'bad_phone', 'Проверьте номер телефона');
    const consentAt = input.consent === true && !u.consentAt ? new Date().toISOString() : u.consentAt;
    this.db.prepare('UPDATE users SET name = ?, phone = ?, consent_at = ? WHERE id = ?').run(name, phone, consentAt, id);
    return this.get(id);
  }

  setPhone(id: number, phone: string): void {
    this.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(normalizePhone(phone), id);
  }

  /** Клиент, записанный админом по телефону. Ищем по номеру, иначе создаём без tg_id. */
  findOrCreateByPhone(name: string, phone: string): User {
    const p = normalizePhone(phone);
    if (!p) throw new AppError(400, 'bad_phone', 'Укажите телефон клиента');
    const existing = this.db.prepare('SELECT * FROM users WHERE phone = ? ORDER BY tg_id IS NULL, id LIMIT 1').get(p);
    if (existing) return toUser(existing);
    const r = this.db.prepare('INSERT INTO users (name, phone) VALUES (?, ?)').run(name.trim().slice(0, 100), p);
    return this.get(Number(r.lastInsertRowid));
  }

  // ---------- гараж ----------

  cars(userId: number): Car[] {
    return (this.db.prepare('SELECT * FROM cars WHERE user_id = ? AND archived = 0 ORDER BY id').all(userId) as any[]).map(toCar);
  }

  addCar(userId: number, input: { make?: unknown; model?: unknown; year?: unknown; plate?: unknown; vin?: unknown }): Car {
    const make = str(input.make, 50);
    if (!make) throw new AppError(400, 'make_required', 'Укажите марку');
    const yearNum = input.year === undefined || input.year === '' || input.year === null ? null : Number(input.year);
    const thisYear = new Date().getFullYear();
    if (yearNum !== null && (!Number.isInteger(yearNum) || yearNum < 1950 || yearNum > thisYear + 1)) {
      throw new AppError(400, 'bad_year', 'Проверьте год выпуска');
    }
    const plate = str(input.plate, 15).toUpperCase().replace(/\s+/g, '');
    const vin = str(input.vin, 17).toUpperCase();
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new AppError(400, 'bad_vin', 'VIN должен состоять из 17 символов');
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM cars WHERE user_id = ? AND archived = 0').get(userId) as { n: number };
    if (n >= 10) throw new AppError(409, 'too_many_cars', 'Слишком много автомобилей в гараже');
    const r = this.db
      .prepare('INSERT INTO cars (user_id, make, model, year, plate, vin) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, make, str(input.model, 50), yearNum, plate, vin);
    return toCar(this.db.prepare('SELECT * FROM cars WHERE id = ?').get(Number(r.lastInsertRowid)));
  }

  /** Удаляем «мягко», чтобы не ломать историю записей. */
  removeCar(userId: number, carId: number): void {
    const r = this.db.prepare('UPDATE cars SET archived = 1 WHERE id = ? AND user_id = ?').run(carId, userId);
    if (r.changes === 0) throw new AppError(404, 'car_not_found', 'Автомобиль не найден');
  }
}
