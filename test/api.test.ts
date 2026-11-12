import { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/http/server.ts';
import { TelegramApi } from '../src/bot/api.ts';
import { Bot } from '../src/bot/bot.ts';
import { dbTest, makeServices, msk, ADMIN_TG, BOT_TOKEN, makeInitData, TEST_DB_URL } from './helpers.ts';

const listen = (srv: Server) => new Promise<string>((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`)));

// Фейковый Telegram Bot API: записывает все вызовы.
const tgCalls: { method: string; params: any }[] = [];
const fakeTg = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const method = req.url!.split('/').pop()!;
  tgCalls.push({ method, params: JSON.parse(body || '{}') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1 } }));
});

const s = TEST_DB_URL ? await makeServices() : (null as never);
let bot: Bot;
const app = s
  ? createApp({
      cfg: s.cfg,
      bookings: s.bookings,
      users: s.users,
      care: s.care,
      publicDir: new URL('../public', import.meta.url).pathname,
      onTelegramUpdate: (u) => bot.handleUpdate(u),
      healthCheck: async () => void (await s.db.one('SELECT 1')),
    })
  : createServer();
let base = '';

after(() => {
  app.close();
  fakeTg.close();
});

const call = async (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) => {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any };
};
const tick = () => new Promise((r) => setTimeout(r, 50));

dbTest('полный сценарий: вход через Mini App → запись → уведомление админу → подтверждение кнопкой', async () => {
  base = await listen(app);
  const tgBase = await listen(fakeTg);
  bot = new Bot(new TelegramApi(BOT_TOKEN, tgBase), s.cfg, s.bookings, s.users, s.care);

  // статика
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /telegram-web-app\.js/);
  assert.equal((await fetch(base + '/../src/main.ts')).status, 404);

  // без токена — 401
  assert.equal((await call('/api/me')).status, 401);

  // вход через initData. auth_date — реальное «сейчас», т.к. проверка свежести идёт по системным часам.
  const initData = makeInitData({ id: 1001, first_name: 'Иван' }, Math.floor(Date.now() / 1000));
  const auth = await call('/api/auth/webapp', { method: 'POST', body: { initData } });
  assert.equal(auth.status, 200, JSON.stringify(auth.data));
  const token = auth.data.token;
  assert.equal(auth.data.isAdmin, false);
  assert.equal((await call('/api/auth/webapp', { method: 'POST', body: { initData: initData + 'x' } })).status, 401);

  const services = (await call('/api/services')).data;
  const oil = services.find((x: any) => x.name.startsWith('Замена масла'));
  const dates = (await call('/api/dates')).data as string[];
  assert.equal(dates[0], '2026-11-16'); // воскресенье 15-го — выходной
  const slots = (await call(`/api/slots?serviceId=${oil.id}&date=2026-11-16`)).data;
  assert.equal(slots[0].time, '09:00');

  // без согласия на ПДн и без телефона — ошибки
  const noConsent = await call('/api/bookings', { method: 'POST', token, body: { serviceId: oil.id, start: slots[0].start, carText: 'Kia' } });
  assert.equal(noConsent.data.error, 'consent_required');
  const noPhone = await call('/api/bookings', { method: 'POST', token, body: { serviceId: oil.id, start: slots[0].start, carText: 'Kia', consent: true } });
  assert.equal(noPhone.data.error, 'phone_required');

  const car = (await call('/api/cars', { method: 'POST', token, body: { make: 'Kia', model: 'Rio' } })).data;
  const created = await call('/api/bookings', {
    method: 'POST',
    token,
    body: { serviceId: oil.id, start: slots[0].start, carId: car.id, phone: '8 900 123-45-67', consent: true, comment: '<b>стук</b>' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.status, 'pending');
  const me = (await call('/api/me', { token })).data;
  assert.equal(me.user.phone, '+79001234567');
  assert.ok(me.user.consentAt);

  await tick();
  const adminMsg = tgCalls.find((c) => c.method === 'sendMessage' && c.params.chat_id === ADMIN_TG);
  assert.ok(adminMsg, 'админу пришло уведомление');
  assert.match(adminMsg.params.text, /Новая запись/);
  assert.match(adminMsg.params.text, /&lt;b&gt;стук/, 'HTML экранирован');
  assert.equal(adminMsg.params.reply_markup.inline_keyboard[0][0].callback_data, `ok:${created.data.id}`);
  assert.ok(tgCalls.some((c) => c.method === 'sendMessage' && c.params.chat_id === 1001), 'клиенту пришло «заявка принята»');

  // не-админ не может подтвердить кнопкой
  tgCalls.length = 0;
  await bot.handleUpdate({ callback_query: { id: 'q1', data: `ok:${created.data.id}`, from: { id: 1001 }, message: { chat: { id: 1001 }, message_id: 5 } } });
  assert.equal((await s.bookings.get(created.data.id)).status, 'pending');
  assert.match(tgCalls.find((c) => c.method === 'answerCallbackQuery')!.params.text, /администратора/);

  // админ подтверждает → клиенту уходит «подтверждена»
  tgCalls.length = 0;
  await bot.handleUpdate({ callback_query: { id: 'q2', data: `ok:${created.data.id}`, from: { id: ADMIN_TG, first_name: 'Админ' }, message: { chat: { id: ADMIN_TG }, message_id: 7 } } });
  await tick();
  assert.equal((await s.bookings.get(created.data.id)).status, 'confirmed');
  assert.ok(tgCalls.some((c) => c.method === 'editMessageText' && c.params.reply_markup.inline_keyboard[0][0].callback_data === `rdy:${created.data.id}`));
  assert.ok(tgCalls.some((c) => c.method === 'sendMessage' && c.params.chat_id === 1001 && /подтверждена/.test(c.params.text)));

  // клиент видит запись; админские эндпоинты ему закрыты
  const list = (await call('/api/bookings', { token })).data;
  assert.equal(list[0].status, 'confirmed');
  assert.equal((await call('/api/admin/schedule?date=2026-11-16', { token })).status, 403);

  // напоминание за сутки с кнопками
  tgCalls.length = 0;
  assert.equal(await bot.sendReminders(), 1);
  const rem = tgCalls.find((c) => c.method === 'sendMessage')!;
  assert.match(rem.params.text, /Напоминаем/);
  assert.equal(rem.params.reply_markup.inline_keyboard[0][0].callback_data, `cc:${created.data.id}`);
  assert.equal(await bot.sendReminders(), 0, 'повторно не шлём');

  // клиент жмёт «Буду»
  await bot.handleUpdate({ callback_query: { id: 'q3', data: `cc:${created.data.id}`, from: { id: 1001 }, message: { chat: { id: 1001 }, message_id: 9 } } });
  assert.equal((await s.bookings.get(created.data.id)).clientConfirmed, true);
});

dbTest('админ: вход, расписание, запись по телефону, смена статуса', async () => {
  const auth = await call('/api/auth/dev', { method: 'POST', body: { tgId: ADMIN_TG, name: 'Админ' } });
  const token = auth.data.token;
  assert.equal(auth.data.isAdmin, true);
  const oil = (await call('/api/services')).data[0];
  const created = await call('/api/admin/bookings', {
    method: 'POST',
    token,
    body: { serviceId: oil.id, start: msk('2026-11-16', '15:00'), clientName: 'Ольга', phone: '+7 911 000-00-00', carText: 'VW Polo' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.status, 'confirmed');
  const day = (await call('/api/admin/schedule?date=2026-11-16', { token })).data;
  assert.equal(day.bookings.length, 2);
  const r = await call(`/api/admin/bookings/${created.data.id}/status`, { method: 'POST', token, body: { status: 'in_progress' } });
  assert.equal(r.data.status, 'in_progress');
  assert.equal((await call(`/api/admin/bookings/${created.data.id}/status`, { method: 'POST', token, body: { status: 'hacked' } })).status, 400);
});

dbTest('бот: /start просит номер и даёт кнопку Mini App; чужой контакт не принимается', async () => {
  tgCalls.length = 0;
  await bot.handleUpdate({ message: { chat: { id: 7007, type: 'private' }, from: { id: 7007, first_name: 'Новый' }, text: '/start' } });
  assert.ok(tgCalls.some((c) => c.params.reply_markup?.keyboard?.[0]?.[0]?.request_contact));
  assert.ok(tgCalls.some((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://example.com'));

  await bot.handleUpdate({ message: { chat: { id: 7007, type: 'private' }, from: { id: 7007 }, contact: { user_id: 1, phone_number: '+70000000000' } } });
  assert.equal((await s.users.byTgId(7007))!.phone, '');
  await bot.handleUpdate({ message: { chat: { id: 7007, type: 'private' }, from: { id: 7007 }, contact: { user_id: 7007, phone_number: '79005556677' } } });
  assert.equal((await s.users.byTgId(7007))!.phone, '+79005556677');
});

dbTest('вебхук: проверка секрета, апдейт обрабатывается, /healthz', async () => {
  const post = (secret: string | null, body: unknown) =>
    fetch(base + '/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
      body: JSON.stringify(body),
    });
  const upd = { update_id: 1, message: { chat: { id: 8008, type: 'private' }, from: { id: 8008, first_name: 'Вебхук' }, text: '/start' } };
  assert.equal((await post(null, upd)).status, 401);
  assert.equal((await post('wrong-secret-wrong-sec', upd)).status, 401);
  tgCalls.length = 0;
  assert.equal((await post('test-webhook-secret-123', upd)).status, 200);
  assert.ok(await s.users.byTgId(8008), 'пользователь создан из апдейта');
  assert.ok(tgCalls.some((c) => c.method === 'sendMessage' && c.params.chat_id === 8008));
  // Ошибка в обработке не должна превращаться в 500, иначе Telegram будет повторять апдейт
  assert.equal((await post('test-webhook-secret-123', { update_id: 2, callback_query: { id: 'x', data: 'ok:999999', from: { id: ADMIN_TG }, message: { chat: { id: 1 }, message_id: 1 } } })).status, 200);
  const h = await fetch(base + '/healthz');
  assert.equal(h.status, 200);
});
