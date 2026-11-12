import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    tg_id       INTEGER UNIQUE,            -- NULL для клиентов, записанных вручную по телефону
    name        TEXT NOT NULL DEFAULT '',
    phone       TEXT NOT NULL DEFAULT '',
    consent_at  TEXT,                       -- согласие на обработку ПДн
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE cars (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    make       TEXT NOT NULL,
    model      TEXT NOT NULL DEFAULT '',
    year       INTEGER,
    plate      TEXT NOT NULL DEFAULT '',
    vin        TEXT NOT NULL DEFAULT '',
    archived   INTEGER NOT NULL DEFAULT 0
  );

  -- Пост = подъёмник/бокс/место шиномонтажа. Ресурс, который занимает запись.
  CREATE TABLE posts (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    kind    TEXT NOT NULL,                  -- lift | tire | wash | ...
    active  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE services (
    id            INTEGER PRIMARY KEY,
    category      TEXT NOT NULL,
    name          TEXT NOT NULL,
    duration_min  INTEGER NOT NULL,
    price_from    INTEGER NOT NULL DEFAULT 0, -- в рублях
    post_kind     TEXT NOT NULL,
    sort          INTEGER NOT NULL DEFAULT 0,
    active        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE closed_dates (
    date    TEXT PRIMARY KEY,               -- YYYY-MM-DD, местная
    reason  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE bookings (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    car_id        INTEGER REFERENCES cars(id),
    car_text      TEXT NOT NULL DEFAULT '',  -- для ручных записей без «гаража»
    service_id    INTEGER NOT NULL REFERENCES services(id),
    post_id       INTEGER NOT NULL REFERENCES posts(id),
    start_at      TEXT NOT NULL,             -- ISO UTC
    end_at        TEXT NOT NULL,
    status        TEXT NOT NULL,             -- pending | confirmed | in_progress | ready | done | cancelled | no_show
    comment       TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'app', -- app | admin
    reminded_24h  INTEGER NOT NULL DEFAULT 0,
    reminded_2h   INTEGER NOT NULL DEFAULT 0,
    client_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX bookings_post_time ON bookings(post_id, start_at);
  CREATE INDEX bookings_user ON bookings(user_id, start_at);
  CREATE INDEX bookings_start ON bookings(start_at);
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Выполнить fn в транзакции BEGIN IMMEDIATE — блокирует запись сразу, чтобы два клиента не заняли один слот. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Демо-данные для первого запуска: посты и каталог услуг. */
export function seedIfEmpty(db: DB): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM services').get() as { n: number };
  if (n > 0) return;
  const post = db.prepare('INSERT INTO posts (name, kind) VALUES (?, ?)');
  post.run('Подъёмник 1', 'lift');
  post.run('Подъёмник 2', 'lift');
  post.run('Шиномонтаж', 'tire');

  const svc = db.prepare(
    'INSERT INTO services (category, name, duration_min, price_from, post_kind, sort) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const items: [string, string, number, number, string][] = [
    ['ТО', 'Замена масла и фильтра', 60, 1500, 'lift'],
    ['ТО', 'Плановое ТО', 120, 5000, 'lift'],
    ['Диагностика', 'Компьютерная диагностика', 30, 1200, 'lift'],
    ['Диагностика', 'Диагностика ходовой', 60, 1000, 'lift'],
    ['Ремонт', 'Замена тормозных колодок', 60, 1800, 'lift'],
    ['Ремонт', 'Ремонт подвески (осмотр + оценка)', 90, 2500, 'lift'],
    ['Шины', 'Сезонная переобувка', 60, 2400, 'tire'],
    ['Шины', 'Балансировка 4 колёс', 30, 1200, 'tire'],
  ];
  items.forEach((it, i) => svc.run(...it, i));
}
