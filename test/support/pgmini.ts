/**
 * Минимальный клиент PostgreSQL (wire protocol v3) — ТОЛЬКО для тестов в окружении,
 * где пакет `pg` не установлен. Повторяет поведение `pg` в том, что важно приложению:
 * - без параметров — простой протокол (несколько операторов), с параметрами — extended;
 * - int2/int4/int8/float → number, bool → boolean, timestamptz/date → Date, json → объект;
 * - ошибки сервера — Error с полем code (SQLSTATE).
 * Аутентификация: только trust (локальная тестовая база).
 */
import { connect, type Socket } from 'node:net';
import type { PoolClientLike, PoolLike, QueryResultLike } from '../../src/db/sql.ts';

interface Field {
  name: string;
  oid: number;
}

function parseValue(oid: number, v: string): unknown {
  switch (oid) {
    case 16: return v === 't';
    case 20: case 21: case 23: case 700: case 701: return Number(v);
    case 114: case 3802: return JSON.parse(v);
    case 1114: return new Date(v.replace(' ', 'T') + 'Z');
    case 1184: return new Date(v.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 1082: { const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d); }
    default: return v;
  }
}

function serialize(p: unknown): Buffer | null {
  if (p === null || p === undefined) return null;
  if (p instanceof Date) return Buffer.from(p.toISOString());
  if (typeof p === 'boolean') return Buffer.from(p ? 't' : 'f');
  if (Array.isArray(p)) {
    return Buffer.from(`{${p.map((x) => (x === null || x === undefined ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`);
  }
  if (typeof p === 'object') return Buffer.from(JSON.stringify(p));
  return Buffer.from(String(p));
}

const cstr = (s: string) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
function msg(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

class Conn implements PoolClientLike {
  private sock!: Socket;
  private buf = Buffer.alloc(0);
  private waiters: ((m: { type: string; body: Buffer }) => void)[] = [];
  private inbox: { type: string; body: Buffer }[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  broken = false;
  onRelease: (c: Conn, destroy: boolean) => void = () => {};

  async open(url: URL): Promise<void> {
    this.sock = connect(Number(url.port || 5432), url.hostname);
    this.sock.on('data', (d) => this.feed(d as Buffer));
    this.sock.on('error', () => (this.broken = true));
    this.sock.on('close', () => (this.broken = true));
    await new Promise<void>((res, rej) => { this.sock.once('connect', () => res()); this.sock.once('error', rej); });
    const params = ['user', decodeURIComponent(url.username || 'postgres'), 'database', url.pathname.slice(1) || 'postgres', 'client_encoding', 'UTF8', 'TimeZone', 'UTC'];
    const body = Buffer.concat([i32(196608), ...params.map(cstr), Buffer.from([0])]);
    this.sock.write(Buffer.concat([i32(body.length + 4), body]));
    for (;;) {
      const m = await this.next();
      if (m.type === 'R' && m.body.readInt32BE(0) !== 0) throw new Error('pgmini: поддерживается только trust-аутентификация');
      if (m.type === 'E') throw this.error(m.body);
      if (m.type === 'Z') return;
    }
  }

  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const m = { type: String.fromCharCode(this.buf[0]), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      const w = this.waiters.shift();
      w ? w(m) : this.inbox.push(m);
    }
  }

  private next(): Promise<{ type: string; body: Buffer }> {
    const m = this.inbox.shift();
    if (m) return Promise.resolve(m);
    return new Promise((r) => this.waiters.push(r));
  }

  private error(body: Buffer): Error & { code?: string } {
    const fields: Record<string, string> = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const t = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      fields[t] = body.subarray(i + 1, end).toString();
      i = end + 1;
    }
    const e: Error & { code?: string; detail?: string } = new Error(fields.M ?? 'postgres error');
    e.code = fields.C;
    e.detail = fields.D;
    return e;
  }

  query<T = any>(text: string, params?: unknown[]): Promise<QueryResultLike<T>> {
    const run = this.chain.then(() => this.exec<T>(text, params));
    this.chain = run.catch(() => {});
    return run;
  }

  private async exec<T>(text: string, params?: unknown[]): Promise<QueryResultLike<T>> {
    if (params === undefined) {
      this.sock.write(msg('Q', cstr(text)));
    } else {
      const vals = params.map(serialize);
      const bind = Buffer.concat([
        cstr(''), cstr(''), i16(0), i16(vals.length),
        ...vals.flatMap((v) => (v === null ? [i32(-1)] : [i32(v.length), v])),
        i16(0),
      ]);
      this.sock.write(Buffer.concat([
        msg('P', Buffer.concat([cstr(''), cstr(text), i16(0)])),
        msg('B', bind),
        msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
        msg('E', Buffer.concat([cstr(''), i32(0)])),
        msg('S', Buffer.alloc(0)),
      ]));
    }
    let fields: Field[] = [];
    let rows: any[] = [];
    let rowCount: number | null = null;
    let err: Error | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case 'T': {
          const n = m.body.readInt16BE(0);
          let o = 2;
          fields = [];
          rows = [];
          for (let k = 0; k < n; k++) {
            const end = m.body.indexOf(0, o);
            const name = m.body.subarray(o, end).toString();
            o = end + 1;
            const oid = m.body.readInt32BE(o + 6);
            o += 18;
            fields.push({ name, oid });
          }
          break;
        }
        case 'D': {
          const n = m.body.readInt16BE(0);
          let o = 2;
          const row: Record<string, unknown> = {};
          for (let k = 0; k < n; k++) {
            const len = m.body.readInt32BE(o);
            o += 4;
            if (len === -1) row[fields[k].name] = null;
            else {
              row[fields[k].name] = parseValue(fields[k].oid, m.body.subarray(o, o + len).toString());
              o += len;
            }
          }
          rows.push(row);
          break;
        }
        case 'C': {
          const tag = m.body.subarray(0, m.body.length - 1).toString().split(' ');
          const last = Number(tag.at(-1));
          rowCount = Number.isFinite(last) ? last : null;
          break;
        }
        case 'E':
          err = this.error(m.body);
          break;
        case 'Z':
          if (err) throw err;
          return { rows, rowCount };
        default:
          break; // 1, 2, n, N, S, I — игнорируем
      }
    }
  }

  release(err?: Error | boolean): void {
    this.onRelease(this, !!err || this.broken);
  }

  close(): void {
    try {
      this.sock.end(msg('X', Buffer.alloc(0)));
    } catch {}
  }
}

export class MiniPool implements PoolLike {
  private url: URL;
  private idle: Conn[] = [];
  private all = new Set<Conn>();

  constructor(connectionString: string) {
    this.url = new URL(connectionString);
  }

  async connect(): Promise<Conn> {
    let c = this.idle.pop();
    while (c?.broken) c = this.idle.pop();
    if (!c) {
      c = new Conn();
      await c.open(this.url);
      this.all.add(c);
      c.onRelease = (conn, destroy) => {
        if (destroy) {
          conn.close();
          this.all.delete(conn);
        } else this.idle.push(conn);
      };
    }
    return c;
  }

  async query<T = any>(text: string, params?: unknown[]): Promise<QueryResultLike<T>> {
    const c = await this.connect();
    try {
      const r = await c.query<T>(text, params);
      c.release();
      return r;
    } catch (e) {
      c.release();
      throw e;
    }
  }

  async end(): Promise<void> {
    for (const c of this.all) c.close();
    this.all.clear();
    this.idle = [];
  }
}
