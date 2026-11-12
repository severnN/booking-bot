import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, isOnGrid } from '../src/domain/slots.ts';
import { zonedToUtc, tzOffsetMinutes, localDate } from '../src/domain/time.ts';

const week = [null, { open: 540, close: 1200 }, { open: 540, close: 1200 }, { open: 540, close: 1200 }, { open: 540, close: 1200 }, { open: 540, close: 1200 }, { open: 600, close: 960 }];
const base = {
  date: '2026-11-16', // понедельник
  durationMin: 60,
  postIds: [1, 2],
  busy: [],
  week,
  closedDates: new Set<string>(),
  timeZone: 'Europe/Moscow',
  stepMin: 30,
  minLeadMin: 60,
  now: new Date('2026-11-15T12:00:00Z'),
};

test('часовой пояс: Москва UTC+3, Прага учитывает переход на летнее время', () => {
  assert.equal(tzOffsetMinutes(new Date('2026-11-16T00:00:00Z'), 'Europe/Moscow'), 180);
  assert.equal(zonedToUtc('2026-11-16', 9 * 60, 'Europe/Moscow').toISOString(), '2026-11-16T06:00:00.000Z');
  // 29.03.2026 Прага переходит на CEST (+2) в 02:00 → 10:00 местного = 08:00 UTC
  assert.equal(zonedToUtc('2026-03-29', 10 * 60, 'Europe/Prague').toISOString(), '2026-03-29T08:00:00.000Z');
  assert.equal(zonedToUtc('2026-03-28', 10 * 60, 'Europe/Prague').toISOString(), '2026-03-28T09:00:00.000Z');
  assert.equal(localDate(new Date('2026-11-15T22:30:00Z'), 'Europe/Moscow'), '2026-11-16');
});

test('полный рабочий день: 09:00–19:00 с шагом 30 минут для услуги на час', () => {
  const slots = computeSlots(base);
  assert.equal(slots.length, 21); // 09:00 … 19:00
  assert.equal(slots[0].time, '09:00');
  assert.equal(slots.at(-1)!.time, '19:00');
  assert.equal(slots[0].freePosts, 2);
});

test('выходной и закрытая дата — пусто', () => {
  assert.deepEqual(computeSlots({ ...base, date: '2026-11-15' }), []); // воскресенье
  assert.deepEqual(computeSlots({ ...base, closedDates: new Set(['2026-11-16']) }), []);
});

test('занятость: слот исчезает, только когда заняты все посты', () => {
  const s = (h: string) => new Date(`2026-11-16T${h}:00+03:00`);
  const oneBusy = computeSlots({ ...base, busy: [{ postId: 1, start: s('10:00'), end: s('11:00') }] });
  const ten = oneBusy.find((x) => x.time === '10:00')!;
  assert.equal(ten.freePosts, 1);

  const bothBusy = computeSlots({
    ...base,
    busy: [
      { postId: 1, start: s('10:00'), end: s('11:00') },
      { postId: 2, start: s('10:00'), end: s('11:00') },
    ],
  });
  const times = bothBusy.map((x) => x.time);
  assert.ok(!times.includes('09:30'), '09:30–10:30 пересекается');
  assert.ok(!times.includes('10:00'));
  assert.ok(!times.includes('10:30'));
  assert.ok(times.includes('09:00'), '09:00–10:00 впритык — можно');
  assert.ok(times.includes('11:00'));
});

test('нельзя записаться раньше, чем через minLead от текущего момента', () => {
  const now = new Date('2026-11-16T07:10:00Z'); // 10:10 МСК
  const slots = computeSlots({ ...base, now });
  assert.equal(slots[0].time, '11:30'); // 11:10 → ближайший шаг 11:30
});

test('isOnGrid отсекает время вне сетки и вне рабочих часов', () => {
  const g = { week, closedDates: new Set<string>(), timeZone: 'Europe/Moscow', stepMin: 30 };
  assert.ok(isOnGrid(new Date('2026-11-16T09:30:00+03:00'), 60, '2026-11-16', g));
  assert.ok(!isOnGrid(new Date('2026-11-16T09:15:00+03:00'), 60, '2026-11-16', g));
  assert.ok(!isOnGrid(new Date('2026-11-16T19:30:00+03:00'), 60, '2026-11-16', g)); // закончится в 20:30
});
