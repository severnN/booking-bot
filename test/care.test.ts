import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError } from '../src/services/booking.ts';
import { TelegramApi } from '../src/bot/api.ts';
import { Bot } from '../src/bot/bot.ts';
import { ADMIN_TG, BOT_TOKEN, dbTest, makeServices, msk } from './helpers.ts';

// Фейковый Telegram Bot API
const tgCalls: { method: string; params: any }[] = [];
const fakeTg = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  tgCalls.push({ method: req.url!.split('/').pop()!, params: JSON.parse(body || '{}') });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
});
const tgBase = await new Promise<string>((r) => fakeTg.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(fakeTg.address() as AddressInfo).port}`)));
after(() => fakeTg.close());
const tick = () => new Promise((r) => setTimeout(r, 50));
const sent = (chatId: number) => tgCalls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId);

/** Прошлые визиты пишем прямо в БД: через API в прошлое не записаться. */
async function pastVisit(s: Awaited<ReturnType<typeof makeServices>>, userId: number, carId: number, serviceName: string, at: string, mileage: number | null) {
  const svc = (await s.bookings.listServices()).find((x) => x.name === serviceName)!;
  const r = await s.db.one<{ id: number }>(
    `INSERT INTO bookings (user_id, car_id, service_id, post_id, start_at, end_at, status, mileage_km, done_at)
     VALUES ($1, $2, $3, (SELECT id FROM posts WHERE kind = $4 LIMIT 1), $5, $5::timestamptz + interval '1 hour', 'done', $6, $5)
     RETURNING id`,
    [userId, carId, svc.id, svc.postKind, at, mileage],
  );
  return r!.id;
}

async function setup(now = new Date('2026-11-15T12:00:00Z')) {
  let clock = now;
  const s = await makeServices(() => clock);
  tgCalls.length = 0;
  const bot = new Bot(new TelegramApi(BOT_TOKEN, tgBase), s.cfg, s.bookings, s.users, s.care);
  const client = await s.users.upsertTelegram({ id: 1001, first_name: 'Иван' });
  const car = await s.users.addCar(client.id, { make: 'Kia', model: 'Rio' });
  return { ...s, bot, client, car, setNow: (d: Date) => (clock = d) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'ok';
};

dbTest('выдача машины: пробег и работы попадают в историю, клиенту приходит просьба оценить', async () => {
  const s = await setup();
  const oil = (await s.bookings.listServices()).find((x) => x.name.startsWith('Замена масла'))!;
  const b = await s.bookings.create({ userId: s.client.id, serviceId: oil.id, carId: s.car.id, start: msk('2026-11-16', '10:00') });
  await s.bookings.setStatus(b.id, 'in_progress');
  assert.equal(await code(s.bookings.complete(b.id, { mileageKm: -5 })), 'bad_mileage');
  const done = await s.bookings.complete(b.id, { mileageKm: '45230', notes: 'Масло 5W-30, фильтр' });
  assert.equal(done.status, 'done');
  assert.equal(done.mileageKm, 45230);

  await tick();
  const msg = sent(1001).at(-1)!;
  assert.match(msg.params.text, /45\s?230 км/);
  assert.match(msg.params.text, /истории обслуживания/);
  assert.deepEqual(msg.params.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), [1, 2, 3, 4, 5].map((n) => `rate:${b.id}:${n}`));

  const care = await s.care.carCare(s.client.id, s.car.id);
  assert.equal(care.records.length, 1);
  assert.equal(care.records[0].notes, 'Масло 5W-30, фильтр');
  assert.ok(care.next, 'замена масла — плановое ТО, есть расчёт следующего');
  assert.equal(care.next!.dueKm, 55230);

  const stranger = await s.users.upsertTelegram({ id: 2002 });
  assert.equal(await code(s.care.carCare(stranger.id, s.car.id)), 'car_not_found');
});

dbTest('отзыв через бота: оценка кнопкой, комментарий ответом, админу — алерт о низкой оценке', async () => {
  const s = await setup();
  const id = await pastVisit(s, s.client.id, s.car.id, 'Диагностика ходовой', msk('2026-11-10', '10:00'), 44000);

  // Оценить чужую или незавершённую запись нельзя
  const other = await s.users.upsertTelegram({ id: 3003 });
  assert.equal(await code(s.care.rate(id, other.id, 5)), 'booking_not_found');
  assert.equal(await code(s.care.rate(id, s.client.id, 7)), 'bad_rating');

  tgCalls.length = 0;
  await s.bot.handleUpdate({ callback_query: { id: 'q', data: `rate:${id}:2`, from: { id: 1001 }, message: { chat: { id: 1001 }, message_id: 5 } } });
  await tick();
  const prompt = sent(1001).at(-1)!;
  assert.ok(prompt.params.reply_markup.force_reply);
  assert.match(prompt.params.text, new RegExp(`отзыв к записи #${id}`));
  assert.ok(sent(ADMIN_TG).some((m) => /Низкая оценка/.test(m.params.text)), 'админ узнаёт о низкой оценке');

  tgCalls.length = 0;
  await s.bot.handleUpdate({
    message: {
      chat: { id: 1001, type: 'private' },
      from: { id: 1001 },
      text: 'Долго ждал <машину>',
      reply_to_message: { from: { id: 1, is_bot: true }, text: prompt.params.text },
    },
  });
  await tick();
  assert.match(sent(1001).at(-1)!.params.text, /Спасибо/);
  const adminMsg = sent(ADMIN_TG).find((m) => /Отзыв/.test(m.params.text))!;
  assert.match(adminMsg.params.text, /Долго ждал &lt;машину&gt;/, 'HTML экранирован');

  // Переоценка обновляет оценку, комментарий сохраняется
  await s.care.rate(id, s.client.id, 4);
  const sum = await s.care.reviewsSummary();
  assert.equal(sum.count, 1);
  assert.equal(sum.average, 4);
  assert.equal(sum.recent[0].comment, 'Долго ждал <машину>');
  assert.equal((await s.bookings.listForUser(s.client.id))[0].rating, 4);
});

dbTest('напоминание о ТО: по времени/пробегу, ровно один раз, не если уже записан', async () => {
  const s = await setup();
  // ТО было 20.01.2026 на 40 000 км; без истории пробега считаем 1250 км/мес → ~20.09.2026 по пробегу
  await pastVisit(s, s.client.id, s.car.id, 'Плановое ТО', msk('2026-01-20', '10:00'), 40000);
  // Машина без ТО в истории — не напоминаем
  const car2 = await s.users.addCar(s.client.id, { make: 'Lada' });
  await pastVisit(s, s.client.id, car2.id, 'Диагностика ходовой', msk('2025-01-20', '10:00'), null);
  // Клиент без Telegram — не напоминаем
  const phoneOnly = await s.users.findOrCreateByPhone('Пётр', '+79000000001');
  const car3 = await s.users.addCar(phoneOnly.id, { make: 'VW' });
  await pastVisit(s, phoneOnly.id, car3.id, 'Плановое ТО', msk('2025-01-20', '10:00'), 10000);

  tgCalls.length = 0;
  const [a, b] = await Promise.all([s.bot.sendMaintenanceReminders(), s.bot.sendMaintenanceReminders()]);
  assert.equal(a + b, 1, 'параллельно — одно напоминание');
  const msg = sent(1001)[0];
  assert.match(msg.params.text, /Пора на плановое ТО/);
  assert.match(msg.params.text, /Kia Rio/);
  assert.match(msg.params.text, /50\s?000 км/);
  assert.equal(msg.params.reply_markup.inline_keyboard[0][0].text, '🗓 Записаться на ТО');
  assert.equal(await s.bot.sendMaintenanceReminders(), 0, 'повторно не шлём');

  // После нового ТО цикл начинается заново, а запись на будущее ТО гасит напоминание
  await pastVisit(s, s.client.id, s.car.id, 'Замена масла и фильтра', msk('2026-11-01', '10:00'), 50500);
  assert.equal(await s.bot.sendMaintenanceReminders(), 0, 'следующее ТО ещё не скоро');
  // ~1100 км/мес по истории → следующее ТО около конца июля 2027
  s.setNow(new Date('2027-07-25T12:00:00Z'));
  const to = (await s.bookings.listServices()).find((x) => x.name === 'Плановое ТО')!;
  const future = await s.db.one<{ id: number }>(
    `INSERT INTO bookings (user_id, car_id, service_id, post_id, start_at, end_at, status) VALUES ($1, $2, $3, 1, '2027-07-28T10:00:00Z', '2027-07-28T12:00:00Z', 'confirmed') RETURNING id`,
    [s.client.id, s.car.id, to.id],
  );
  assert.equal(await s.bot.sendMaintenanceReminders(), 0, 'уже записан на ТО');
  await s.db.run(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [future!.id]);
  assert.equal(await s.bot.sendMaintenanceReminders(), 1, 'запись отменил — напоминаем о новом ТО');
});
