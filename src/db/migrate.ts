import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './sql.ts';

const LOCK_ID = 7_420_001; // произвольная константа для advisory lock миграций

/**
 * Применяет migrations/NNN_*.sql по порядку, каждую в своей транзакции.
 * Advisory lock не даёт двум копиям приложения мигрировать одновременно.
 */
export async function migrate(db: Db, dir: string, log: (s: string) => void = console.log): Promise<number> {
  return db.tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await t.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await t.all<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
    const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      await t.run(await readFile(join(dir, f), 'utf8'));
      await t.run('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
      log(`[migrate] ${f}`);
      applied++;
    }
    return applied;
  });
}

/** Демо-данные для первого запуска: посты и каталог услуг. */
export async function seedIfEmpty(db: Db): Promise<void> {
  await db.tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock($1)', [LOCK_ID + 1]);
    const row = await t.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM services');
    if (row && row.n > 0) return;
    for (const [name, kind] of [['Подъёмник 1', 'lift'], ['Подъёмник 2', 'lift'], ['Шиномонтаж', 'tire']]) {
      await t.run('INSERT INTO posts (name, kind) VALUES ($1, $2)', [name, kind]);
    }
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
    for (const [i, it] of items.entries()) {
      await t.run('INSERT INTO services (category, name, duration_min, price_from, post_kind, sort) VALUES ($1, $2, $3, $4, $5, $6)', [...it, i]);
    }
  });
}
