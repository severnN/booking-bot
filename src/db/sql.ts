/**
 * Тонкая обёртка над пулом соединений PostgreSQL.
 * Интерфейс — подмножество API пакета `pg`, поэтому в проде используется он,
 * а в тестах можно подставить любой совместимый пул.
 */
export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number | null;
}

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResultLike<T>>;
}

export interface PoolClientLike extends Queryable {
  release(err?: Error | boolean): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

/** Ошибка PostgreSQL с SQLSTATE-кодом. */
export const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
export const PG_EXCLUSION_VIOLATION = '23P01';
export const PG_UNIQUE_VIOLATION = '23505';

export class Db {
  private q: Queryable;
  private pool: PoolLike | null;

  constructor(q: Queryable, pool: PoolLike | null = null) {
    this.q = q;
    this.pool = pool;
  }

  static fromPool(pool: PoolLike): Db {
    return new Db(pool, pool);
  }

  /** Без параметров идёт простой протокол (можно несколько операторов — нужно миграциям). */
  private exec<T>(text: string, params: unknown[]) {
    return params.length ? this.q.query<T>(text, params) : this.q.query<T>(text);
  }

  async all<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    return (await this.exec<T>(text, params)).rows;
  }

  async one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.exec<T>(text, params)).rows[0];
  }

  async run(text: string, params: unknown[] = []): Promise<number> {
    return (await this.exec(text, params)).rowCount ?? 0;
  }

  /**
   * Транзакция на отдельном соединении. Вложенный вызов выполняется внутри внешней транзакции.
   */
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this);
    const client = await this.pool.connect();
    const inner = new Db(client, null);
    try {
      await client.query('BEGIN');
      const result = await fn(inner);
      await client.query('COMMIT');
      client.release();
      return result;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (rollbackErr) {
        client.release(true);
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}
