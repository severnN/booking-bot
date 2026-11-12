import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';
import { signSession, verifyLoginWidget, verifySession, verifyWebAppInitData, type TgUser } from '../auth/telegram.ts';
import { ALL_STATUSES, AppError, type BookingService, type BookingStatus } from '../services/booking.ts';
import type { User, UserService } from '../services/users.ts';
import type { CareService } from '../services/care.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  user: User | null;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: 'none' | 'user' | 'admin';
  handler: Handler;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface AppDeps {
  cfg: Config;
  bookings: BookingService;
  users: UserService;
  care: CareService;
  publicDir: string;
  /** Обработчик апдейтов Telegram в режиме вебхука. */
  onTelegramUpdate?: (update: any) => Promise<void>;
  /** Проверка готовности (например, доступности БД) для /healthz. */
  healthCheck?: () => Promise<void>;
}

export function createApp(deps: AppDeps): Server {
  const { cfg, bookings, users, care } = deps;
  const routes: Route[] = [];
  const add = (method: string, path: string, auth: Route['auth'], handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '(\\d+)';
        }) +
        '$',
    );
    routes.push({ method, pattern, keys, auth, handler });
  };

  const isAdmin = (u: User | null) => !!u?.tgId && cfg.adminIds.includes(u.tgId);
  const login = async (tg: TgUser) => {
    const user = await users.upsertTelegram(tg);
    return { token: signSession(user.id, cfg.sessionSecret), user, isAdmin: isAdmin(user) };
  };
  const intParam = (v: unknown, name: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new AppError(400, 'bad_param', `Неверный параметр ${name}`);
    return n;
  };

  // ---------- публичное ----------

  add('GET', '/api/config', 'none', () => ({
    botUsername: cfg.botUsername,
    serviceName: cfg.serviceName,
    serviceAddress: cfg.serviceAddress,
    servicePhone: cfg.servicePhone,
    timeZone: cfg.timeZone,
    devLogin: cfg.devLogin,
  }));

  add('GET', '/api/services', 'none', () => bookings.listServices());
  add('GET', '/api/dates', 'none', () => bookings.availableDates());
  add('GET', '/api/slots', 'none', ({ url }) => {
    const exclude = url.searchParams.get('excludeBooking');
    return bookings.slots(intParam(url.searchParams.get('serviceId'), 'serviceId'), url.searchParams.get('date') ?? '', exclude ? Number(exclude) : undefined);
  });

  // ---------- вход ----------

  add('POST', '/api/auth/webapp', 'none', ({ body }) => {
    const tg = verifyWebAppInitData(String(body?.initData ?? ''), cfg.botToken);
    if (!tg) throw new AppError(401, 'bad_init_data', 'Не удалось проверить данные Telegram');
    return login(tg);
  });

  add('POST', '/api/auth/widget', 'none', ({ body }) => {
    const tg = verifyLoginWidget(body ?? {}, cfg.botToken);
    if (!tg) throw new AppError(401, 'bad_widget_data', 'Не удалось проверить вход через Telegram');
    return login(tg);
  });

  add('POST', '/api/auth/dev', 'none', ({ body }) => {
    if (!cfg.devLogin) throw new AppError(404, 'not_found', 'Not found');
    return login({ id: intParam(body?.tgId, 'tgId'), first_name: String(body?.name ?? 'Тестовый клиент') });
  });

  // ---------- клиент ----------

  add('GET', '/api/me', 'user', async ({ user }) => ({ user, cars: await users.cars(user!.id), isAdmin: isAdmin(user) }));
  add('PUT', '/api/me', 'user', ({ user, body }) => users.updateProfile(user!.id, body ?? {}));

  add('POST', '/api/cars', 'user', ({ user, body }) => users.addCar(user!.id, body ?? {}));
  add('DELETE', '/api/cars/:id', 'user', async ({ user, params }) => {
    await users.removeCar(user!.id, Number(params.id));
    return { ok: true };
  });

  add('GET', '/api/cars/:id/care', 'user', ({ user, params }) => care.carCare(user!.id, Number(params.id)));
  add('POST', '/api/bookings/:id/review', 'user', ({ user, params, body }) => care.rate(Number(params.id), user!.id, body?.rating, body?.comment));

  add('GET', '/api/bookings', 'user', ({ user }) => bookings.listForUser(user!.id));
  add('POST', '/api/bookings', 'user', async ({ user, body }) => {
    const u = user!;
    if (!u.consentAt && body?.consent !== true) throw new AppError(400, 'consent_required', 'Нужно согласие на обработку персональных данных');
    const phone = body?.phone ?? u.phone;
    const fresh = await users.updateProfile(u.id, { phone, name: body?.name ?? u.name, consent: body?.consent === true });
    if (!fresh.phone) throw new AppError(400, 'phone_required', 'Укажите телефон для связи');
    return bookings.create({
      userId: u.id,
      serviceId: intParam(body?.serviceId, 'serviceId'),
      start: String(body?.start ?? ''),
      carId: body?.carId != null && body.carId !== '' ? intParam(body.carId, 'carId') : null,
      carText: typeof body?.carText === 'string' ? body.carText : '',
      comment: typeof body?.comment === 'string' ? body.comment : '',
    });
  });
  add('POST', '/api/bookings/:id/cancel', 'user', ({ user, params }) => bookings.cancelByClient(Number(params.id), user!.id));
  add('POST', '/api/bookings/:id/reschedule', 'user', ({ user, params, body }) => bookings.reschedule(Number(params.id), user!.id, String(body?.start ?? '')));
  add('POST', '/api/bookings/:id/confirm', 'user', ({ user, params }) => bookings.confirmByClient(Number(params.id), user!.id));

  // ---------- админ ----------

  add('GET', '/api/admin/schedule', 'admin', ({ url }) => bookings.schedule(url.searchParams.get('date') ?? ''));
  add('POST', '/api/admin/bookings/:id/status', 'admin', ({ params, body }) => {
    const status = String(body?.status ?? '') as BookingStatus;
    if (!ALL_STATUSES.includes(status)) throw new AppError(400, 'bad_status', 'Неизвестный статус');
    return bookings.setStatus(Number(params.id), status);
  });
  add('POST', '/api/admin/bookings/:id/complete', 'admin', ({ params, body }) => bookings.complete(Number(params.id), body ?? {}));
  add('GET', '/api/admin/reviews', 'admin', () => care.reviewsSummary());
  add('POST', '/api/admin/bookings', 'admin', async ({ body }) => {
    const client = await users.findOrCreateByPhone(String(body?.clientName ?? ''), String(body?.phone ?? ''));
    return bookings.create({
      userId: client.id,
      serviceId: intParam(body?.serviceId, 'serviceId'),
      start: String(body?.start ?? ''),
      carText: String(body?.carText ?? ''),
      comment: String(body?.comment ?? ''),
      source: 'admin',
    });
  });

  // ---------- обработка запроса ----------

  const authenticate = async (req: IncomingMessage): Promise<User | null> => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    const uid = verifySession(h.slice(7), cfg.sessionSecret);
    if (!uid) return null;
    try {
      return await users.get(uid);
    } catch {
      return null;
    }
  };

  const publicRoot = resolve(deps.publicDir);
  const serveStatic = async (res: ServerResponse, pathname: string) => {
    let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/' || rel === '') rel = '/index.html';
    let file = join(publicRoot, rel);
    if (!file.startsWith(publicRoot)) return send(res, 403, { error: 'forbidden' });
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
    } catch {
      // SPA: неизвестные пути без расширения отдаём index.html
      if (extname(rel)) return send(res, 404, { error: 'not_found' });
      file = join(publicRoot, 'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  };

  /**
   * Вебхук Telegram. Проверяем секрет из заголовка, отвечаем 200 даже при ошибке обработки:
   * иначе Telegram будет повторять один и тот же апдейт.
   */
  const handleWebhook = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !deps.onTelegramUpdate || !cfg.webhookSecret) return send(res, 404, { error: 'not_found' });
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    const want = Buffer.from(cfg.webhookSecret);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return send(res, 401, { error: 'unauthorized' });
    const update = await readJson(req, 1024 * 1024);
    try {
      await deps.onTelegramUpdate(update);
    } catch (e) {
      console.error('[webhook] update', update?.update_id, e);
    }
    return send(res, 200, { ok: true });
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        try {
          await deps.healthCheck?.();
          return send(res, 200, { ok: true });
        } catch {
          return send(res, 503, { ok: false });
        }
      }
      if (url.pathname === '/telegram/webhook') return await handleWebhook(req, res);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });
        return await serveStatic(res, url.pathname);
      }
      let pathMatched = false;
      for (const r of routes) {
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        const user = r.auth === 'none' ? null : await authenticate(req);
        if (r.auth !== 'none' && !user) throw new AppError(401, 'unauthorized', 'Нужно войти');
        if (r.auth === 'admin' && !isAdmin(user)) throw new AppError(403, 'forbidden', 'Только для администратора');
        const body = req.method === 'GET' ? null : await readJson(req);
        const result = await r.handler({ req, res, url, params, body, user });
        return send(res, 200, result ?? { ok: true });
      }
      throw new AppError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found', 'Not found');
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[http]', req.method, url.pathname, e);
      return send(res, 500, { error: 'internal', message: 'Внутренняя ошибка' });
    }
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError(413, 'too_large', 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'bad_json', 'Неверный JSON');
  }
}
