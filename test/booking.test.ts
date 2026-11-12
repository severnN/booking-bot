import assert from 'node:assert/strict';
import { AppError, type BookingEvent } from '../src/services/booking.ts';
import { dbTest, makeServices, msk, NOW } from './helpers.ts';

const MON = '2026-11-16';

async function setup() {
  const s = await makeServices();
  const events: BookingEvent[] = [];
  s.bookings.on((e) => void events.push(e));
  const client = await s.users.upsertTelegram({ id: 1001, first_name: 'Иван' });
  const car = await s.users.addCar(client.id, { make: 'Kia', model: 'Rio', plate: 'а123вс 77' });
  const oil = (await s.bookings.listServices()).find((x) => x.name.startsWith('Замена масла'))!; // 60 мин, lift (2 поста)
  return { ...s, events, client, car, oil };
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

dbTest('создание записи: статус pending, назначен пост, событие отправлено', async () => {
  const { bookings, client, car, oil, events } = await setup();
  const b = await bookings.create({ userId: client.id, serviceId: oil.id, start: msk(MON, '10:00'), carId: car.id, comment: 'стук' });
  assert.equal(b.status, 'pending');
  assert.equal(b.postName, 'Подъёмник 1');
  assert.equal(b.car, 'Kia Rio (А123ВС77)');
  assert.equal(b.start, msk(MON, '10:00'));
  assert.equal(b.end, msk(MON, '11:00'));
  assert.equal(b.client.tgId, 1001);
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0].type, 'created');
});

dbTest('защита от двойной брони: два поста — две записи, третья получает slot_taken', async () => {
  const { bookings, users, oil } = await setup();
  const mk = async (tg: number, time = '12:00') => {
    const u = await users.upsertTelegram({ id: tg });
    return bookings.create({ userId: u.id, serviceId: oil.id, start: msk(MON, time), carText: 'Lada Vesta' });
  };
  assert.equal((await mk(2001)).postName, 'Подъёмник 1');
  assert.equal((await mk(2002)).postName, 'Подъёмник 2');
  assert.equal(await code(mk(2003)), 'slot_taken');
  assert.equal(await code(mk(2004, '12:30')), 'slot_taken', 'пересекающийся слот тоже занят');
  assert.ok(!(await bookings.slots(oil.id, MON)).some((s) => s.time === '12:00'));
  const tire = (await bookings.listServices()).find((x) => x.postKind === 'tire')!;
  assert.ok((await bookings.slots(tire.id, MON)).some((s) => s.time === '12:00'), 'шиномонтаж — другой ресурс');
});

dbTest('гонка: 10 параллельных записей на одно время — проходят ровно 2 (по числу постов)', async () => {
  const { bookings, users, oil } = await setup();
  const clients = await Promise.all(Array.from({ length: 10 }, (_, i) => users.upsertTelegram({ id: 6000 + i })));
  const results = await Promise.allSettled(
    clients.map((u) => bookings.create({ userId: u.id, serviceId: oil.id, start: msk(MON, '15:00'), carText: 'x' })),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 2);
  assert.ok(failed.every((r) => r.reason instanceof AppError && r.reason.code === 'slot_taken'));
});

dbTest('exclusion constraint в БД ловит пересечение, даже если код его пропустил', async () => {
  const { db, bookings, client, oil } = await setup();
  const b = await bookings.create({ userId: client.id, serviceId: oil.id, start: msk(MON, '10:00'), carText: 'x' });
  const post = await db.one<{ post_id: number }>('SELECT post_id FROM bookings WHERE id = $1', [b.id]);
  await assert.rejects(
    db.run(`INSERT INTO bookings (user_id, service_id, post_id, start_at, end_at, status) VALUES ($1, $2, $3, $4, $5, 'confirmed')`, [
      client.id,
      oil.id,
      post!.post_id,
      msk(MON, '10:30'),
      msk(MON, '11:30'),
    ]),
    (e: any) => e.code === '23P01',
  );
  // Отменённая запись слот не держит
  await bookings.cancelByClient(b.id, client.id);
  await db.run(`INSERT INTO bookings (user_id, service_id, post_id, start_at, end_at, status) VALUES ($1, $2, $3, $4, $5, 'confirmed')`, [
    client.id,
    oil.id,
    post!.post_id,
    msk(MON, '10:30'),
    msk(MON, '11:30'),
  ]);
  // А вернуть её из отмены уже нельзя — время занято
  assert.equal(await code(bookings.setStatus(b.id, 'confirmed')), 'slot_taken');
});

dbTest('валидация: выходной, вне сетки, за горизонтом, чужая машина, лимит активных записей', async () => {
  const { bookings, users, client, car, oil } = await setup();
  const base = { userId: client.id, serviceId: oil.id, carId: car.id };
  assert.equal(await code(bookings.create({ ...base, start: msk('2026-11-15', '15:30') })), 'date_unavailable');
  assert.equal(await code(bookings.create({ ...base, start: msk(MON, '10:15') })), 'off_grid');
  assert.equal(await code(bookings.create({ ...base, start: msk(MON, '19:30') })), 'off_grid');
  assert.equal(await code(bookings.create({ ...base, start: msk('2026-12-31', '10:00') })), 'date_unavailable');
  const other = await users.upsertTelegram({ id: 3001 });
  assert.equal(await code(bookings.create({ ...base, userId: other.id, start: msk(MON, '10:00') })), 'car_not_found');
  assert.equal(await code(bookings.create({ userId: client.id, serviceId: oil.id, start: msk(MON, '10:00') })), 'car_required');
  for (const t of ['09:00', '11:00', '13:00']) await bookings.create({ ...base, start: msk(MON, t) });
  assert.equal(await code(bookings.create({ ...base, start: msk(MON, '15:00') })), 'too_many');
});

dbTest('закрытая дата исчезает из календаря', async () => {
  const { db, bookings } = await setup();
  assert.ok((await bookings.availableDates()).includes(MON));
  await db.run(`INSERT INTO closed_dates (date, reason) VALUES ($1, 'санитарный день')`, [MON]);
  assert.ok(!(await bookings.availableDates()).includes(MON));
});

dbTest('отмена освобождает слот, перенос проверяет занятость и сбрасывает статус', async () => {
  const { bookings, users, client, car, oil } = await setup();
  const b = await bookings.create({ userId: client.id, serviceId: oil.id, carId: car.id, start: msk(MON, '10:00') });
  await bookings.setStatus(b.id, 'confirmed');
  for (const tg of [4001, 4002]) {
    const u = await users.upsertTelegram({ id: tg });
    await bookings.create({ userId: u.id, serviceId: oil.id, carText: 'x', start: msk(MON, '14:00') });
  }
  assert.equal(await code(bookings.reschedule(b.id, client.id, msk(MON, '14:00'))), 'slot_taken');
  const moved = await bookings.reschedule(b.id, client.id, msk(MON, '16:00'));
  assert.equal(moved.status, 'pending');
  assert.equal(moved.start, msk(MON, '16:00'));
  const moved2 = await bookings.reschedule(b.id, client.id, msk(MON, '16:30'));
  assert.equal(moved2.start, msk(MON, '16:30'), 'перенос внахлёст с самой собой разрешён');
  const stranger = await users.upsertTelegram({ id: 4999 });
  assert.equal(await code(bookings.cancelByClient(b.id, stranger.id)), 'booking_not_found');
  assert.equal((await bookings.cancelByClient(b.id, client.id)).status, 'cancelled');
  assert.equal(await code(bookings.cancelByClient(b.id, client.id)), 'not_changeable');
});

dbTest('админ: запись по телефону без Telegram сразу подтверждена, клиент находится по номеру', async () => {
  const { bookings, users, oil } = await setup();
  const c1 = await users.findOrCreateByPhone('Сергей', '8 (900) 111-22-33');
  const c2 = await users.findOrCreateByPhone('Сергей П.', '+79001112233');
  assert.equal(c1.id, c2.id);
  assert.equal(c1.phone, '+79001112233');
  const b = await bookings.create({ userId: c1.id, serviceId: oil.id, start: msk(MON, '09:00'), carText: 'Ford Focus', source: 'admin' });
  assert.equal(b.status, 'confirmed');
  assert.equal(b.client.tgId, null);
  const day = await bookings.schedule(MON);
  assert.equal(day.bookings.length, 1);
  assert.equal(day.posts.length, 3);
  assert.equal((await bookings.schedule('2026-11-17')).bookings.length, 0);
});

dbTest('напоминания: 24ч и 2ч забираются ровно один раз, даже параллельно', async () => {
  let now = NOW;
  const s = await makeServices(() => now);
  const u = await s.users.upsertTelegram({ id: 5001 });
  const oil = (await s.bookings.listServices())[0];
  const b = await s.bookings.create({ userId: u.id, serviceId: oil.id, start: msk('2026-11-16', '12:00'), carText: 'x' });

  const [a, c] = await Promise.all([s.bookings.claimReminders('24h'), s.bookings.claimReminders('24h')]);
  assert.deepEqual([...a, ...c].map((x) => x.id), [b.id], 'две копии приложения — одно напоминание');
  assert.equal((await s.bookings.claimReminders('2h')).length, 0);

  now = new Date(msk('2026-11-16', '10:30'));
  assert.deepEqual((await s.bookings.claimReminders('2h')).map((x) => x.id), [b.id]);
  assert.equal((await s.bookings.claimReminders('2h')).length, 0);
});
