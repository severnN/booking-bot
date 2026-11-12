import type { Db } from '../db/sql.ts';
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
  return { id: r.id, tgId: r.tg_id ?? null, name: r.name, phone: r.phone, consentAt: r.consent_at ? new Date(r.consent_at).toISOString() : null };
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
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Создать или обновить пользователя по данным из Telegram. */
  async upsertTelegram(tg: { id: number; first_name?: string; last_name?: string }): Promise<User> {
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 100);
    const r = await this.db.one(
      `INSERT INTO users (tg_id, name) VALUES ($1, $2)
       ON CONFLICT (tg_id) DO UPDATE SET name = CASE WHEN users.name = '' THEN EXCLUDED.name ELSE users.name END
       RETURNING *`,
      [tg.id, name],
    );
    return toUser(r);
  }

  async get(id: number): Promise<User> {
    const r = await this.db.one('SELECT * FROM users WHERE id = $1', [id]);
    if (!r) throw new AppError(404, 'user_not_found', 'Пользователь не найден');
    return toUser(r);
  }

  async byTgId(tgId: number): Promise<User | null> {
    const r = await this.db.one('SELECT * FROM users WHERE tg_id = $1', [tgId]);
    return r ? toUser(r) : null;
  }

  async updateProfile(id: number, input: { name?: unknown; phone?: unknown; consent?: unknown }): Promise<User> {
    const u = await this.get(id);
    const name = input.name !== undefined ? str(input.name, 100) : u.name;
    const phone = input.phone !== undefined ? normalizePhone(str(input.phone, 30)) : u.phone;
    if (phone && (phone.length < 8 || phone.length > 16)) throw new AppError(400, 'bad_phone', 'Проверьте номер телефона');
    const giveConsent = input.consent === true && !u.consentAt;
    await this.db.run(`UPDATE users SET name = $1, phone = $2, consent_at = CASE WHEN $3::boolean THEN now() ELSE consent_at END WHERE id = $4`, [
      name,
      phone,
      giveConsent,
      id,
    ]);
    return this.get(id);
  }

  async setPhone(id: number, phone: string): Promise<void> {
    await this.db.run('UPDATE users SET phone = $1 WHERE id = $2', [normalizePhone(phone), id]);
  }

  /** Клиент, записанный админом по телефону. Ищем по номеру, иначе создаём без tg_id. */
  async findOrCreateByPhone(name: string, phone: string): Promise<User> {
    const p = normalizePhone(phone);
    if (!p) throw new AppError(400, 'bad_phone', 'Укажите телефон клиента');
    const existing = await this.db.one('SELECT * FROM users WHERE phone = $1 ORDER BY tg_id IS NULL, id LIMIT 1', [p]);
    if (existing) return toUser(existing);
    return toUser(await this.db.one('INSERT INTO users (name, phone) VALUES ($1, $2) RETURNING *', [name.trim().slice(0, 100), p]));
  }

  // ---------- гараж ----------

  async cars(userId: number): Promise<Car[]> {
    return (await this.db.all('SELECT * FROM cars WHERE user_id = $1 AND NOT archived ORDER BY id', [userId])).map(toCar);
  }

  async addCar(userId: number, input: { make?: unknown; model?: unknown; year?: unknown; plate?: unknown; vin?: unknown }): Promise<Car> {
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
    const row = await this.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM cars WHERE user_id = $1 AND NOT archived', [userId]);
    if ((row?.n ?? 0) >= 10) throw new AppError(409, 'too_many_cars', 'Слишком много автомобилей в гараже');
    const r = await this.db.one('INSERT INTO cars (user_id, make, model, year, plate, vin) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *', [
      userId,
      make,
      str(input.model, 50),
      yearNum,
      plate,
      vin,
    ]);
    return toCar(r);
  }

  /** Удаляем «мягко», чтобы не ломать историю записей. */
  async removeCar(userId: number, carId: number): Promise<void> {
    const n = await this.db.run('UPDATE cars SET archived = true WHERE id = $1 AND user_id = $2', [carId, userId]);
    if (n === 0) throw new AppError(404, 'car_not_found', 'Автомобиль не найден');
  }
}
