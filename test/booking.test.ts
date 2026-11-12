import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, type BookingEvent } from '../src/services/booking.ts';
import { makeServices, msk, NOW } from './helpers.ts';

const MON = '2026-11-16';

function setup() {
  const s = makeServices();
  const events: BookingEvent[] = [];
  s.bookings.on((e) => void events.push(e));
  const client = s.users.upsertTelegram({ id: 1001, first_name: 'Иван' });
  const car = s.users.addCar(client.id, { make: 'Kia', model: 'Rio', plate: 'а123вс 77' });
  const oil = s.bookings.listServices().find((x) => x.name.startsWith('Замена масла'))!; // 60 мин, lift (2 поста)
  return { ...s, events, client, car, oil };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'ok';
};

test('создание записи: статус pending, назначен пост, событие отправлено', async () => {
  const { bookings, client, car, oil, events } = setup();
  const b = bookings.create({ userId: client.id, serviceId: oil.id, start: msk(MON, '10:00'), carId: car.id, comment: 'стук' });
  assert.equal(b.status, 'pending');
  assert.equal(b.postName, 'Подъёмник 1');
  assert.equal(b.car, 'Kia Rio (А123ВС77)');
  assert.equal(b.end, msk(MON, '11:00').replace('.000Z', '.000Z'));
  await new Promise((r) => setImmediate(r));
  assert.equal(events[0].type, 'created');
});

test('защита от двойной брони: два поста — две записи, третья получает slot_taken', () => {
  const { bookings, users, oil } = setup();
  const mk = (tg: number) => {
    const u = users.upsertTelegram({ id: tg });
    return bookings.create({ userId: u.id, serviceId: oil.id, start: msk(MON, '12:00'), carText: 'Lada Vesta' });
  };
  assert.equal(mk(2001).postName, 'Подъёмник 1');
  assert.equal(mk(2002).postName, 'Подъёмник 2');
  assert.equal(code(() => mk(2003)), 'slot_taken');
  // Пересекающийся по времени слот тоже занят
  const u = users.upsertTelegram({ id: 2004 });
  assert.equal(code(() => bookings.create({ userId: u.id, serviceId: oil.id, start: msk(MON, '12:30'), carText: 'x' })), 'slot_taken');
  // Слот исчез из выдачи
  assert.ok(!bookings.slots(oil.id, MON).some((s) => s.time === '12:00'));
  // Шиномонтаж — другой ресурс, на 12:00 свободен
  const tire = bookings.listServices().find((x) => x.postKind === 'tire')!;
  assert.ok(bookings.slots(tire.id, MON).some((s) => s.time === '12:00'));
});

test('валидация: прошлое, вне сетки, выходной, чужая машина, лимит активных записей', () => {
  const { bookings, users, client, car, oil } = setup();
  const base = { userId: client.id, serviceId: oil.id, carId: car.id };
  assert.equal(code(() => bookings.create({ ...base, start: msk('2026-11-15', '15:30') })), 'date_unavailable'); // воскресенье
  assert.equal(code(() => bookings.create({ ...base, start: msk(MON, '10:15') })), 'off_grid');
  assert.equal(code(() => bookings.create({ ...base, start: msk(MON, '19:30') })), 'off_grid');
  assert.equal(code(() => bookings.create({ ...base, start: msk('2026-12-31', '10:00') })), 'date_unavailable'); // за горизонтом
  const other = users.upsertTelegram({ id: 3001 });
  assert.equal(code(() => bookings.create({ ...base, userId: other.id, start: msk(MON, '10:00') })), 'car_not_found');
  assert.equal(code(() => bookings.create({ userId: client.id, serviceId: oil.id, start: msk(MON, '10:00') })), 'car_required');

  for (const t of ['09:00', '11:00', '13:00']) bookings.create({ ...base, start: msk(MON, t) });
  assert.equal(code(() => bookings.create({ ...base, start: msk(MON, '15:00') })), 'too_many');
});

test('отмена освобождает слот, перенос проверяет занятость и сбрасывает статус', () => {
  const { bookings, users, client, car, oil } = setup();
  const b = bookings.create({ userId: client.id, serviceId: oil.id, carId: car.id, start: msk(MON, '10:00') });
  bookings.setStatus(b.id, 'confirmed');

  // Занимаем оба поста на 14:00
  for (const tg of [4001, 4002]) {
    const u = users.upsertTelegram({ id: tg });
    bookings.create({ userId: u.id, serviceId: oil.id, carText: 'x', start: msk(MON, '14:00') });
  }
  assert.equal(code(() => bookings.reschedule(b.id, client.id, msk(MON, '14:00'))), 'slot_taken');

  const moved = bookings.reschedule(b.id, client.id, msk(MON, '16:00'));
  assert.equal(moved.status, 'pending');
  assert.equal(moved.start, msk(MON, '16:00'));

  // Перенос на соседний слот, пересекающийся с самой собой — должен пройти (исключаем свою запись)
  const moved2 = bookings.reschedule(b.id, client.id, msk(MON, '16:30'));
  assert.equal(moved2.start, msk(MON, '16:30'));

  // Чужой не может отменить
  const stranger = users.upsertTelegram({ id: 4999 });
  assert.equal(code(() => bookings.cancelByClient(b.id, stranger.id)), 'booking_not_found');

  const c = bookings.cancelByClient(b.id, client.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(code(() => bookings.cancelByClient(b.id, client.id)), 'not_changeable');
});

test('админ: запись по телефону без Telegram сразу подтверждена, клиент находится по номеру', () => {
  const { bookings, users, oil } = setup();
  const c1 = users.findOrCreateByPhone('Сергей', '8 (900) 111-22-33');
  const c2 = users.findOrCreateByPhone('Сергей П.', '+79001112233');
  assert.equal(c1.id, c2.id);
  assert.equal(c1.phone, '+79001112233');
  const b = bookings.create({ userId: c1.id, serviceId: oil.id, start: msk(MON, '09:00'), carText: 'Ford Focus', source: 'admin' });
  assert.equal(b.status, 'confirmed');
  assert.equal(b.client.tgId, null);
  const day = bookings.schedule(MON);
  assert.equal(day.bookings.length, 1);
  assert.equal(day.posts.length, 3);
});

test('напоминания: 24ч и 2ч выбираются один раз', () => {
  let now = NOW;
  const s = makeServices(() => now);
  const u = s.users.upsertTelegram({ id: 5001 });
  const oil = s.bookings.listServices()[0];
  const b = s.bookings.create({ userId: u.id, serviceId: oil.id, start: msk('2026-11-16', '12:00'), carText: 'x' });

  // 15.11 15:00 МСК — до визита 21 час → пора 24h-напоминание, 2h ещё нет
  assert.deepEqual(s.bookings.dueReminders('24h').map((x) => x.id), [b.id]);
  assert.equal(s.bookings.dueReminders('2h').length, 0);
  s.bookings.markReminded(b.id, '24h');
  assert.equal(s.bookings.dueReminders('24h').length, 0);

  now = new Date(msk('2026-11-16', '10:30'));
  assert.deepEqual(s.bookings.dueReminders('2h').map((x) => x.id), [b.id]);
  s.bookings.markReminded(b.id, '2h');
  assert.equal(s.bookings.dueReminders('2h').length, 0);
});
