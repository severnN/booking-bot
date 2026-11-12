import type { PoolLike } from './sql.ts';

/**
 * Пул соединений на базе пакета `pg`.
 * Импорт динамический, чтобы модуль грузился только там, где реально нужен.
 */
export async function createPgPool(connectionString: string, max = 10): Promise<PoolLike> {
  const moduleName = 'pg'; // через переменную — чтобы typecheck не требовал установленного пакета
  const mod: any = await import(moduleName);
  const pg = mod.default ?? mod;
  // bigint (int8) → number. Telegram ID и COUNT(*) укладываются в 2^53, строки нам не нужны.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (e: Error) => console.error('[pg] idle client error', e.message));
  return pool as PoolLike;
}
