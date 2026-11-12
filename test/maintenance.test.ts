import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, estimateKmPerMonth, nextMaintenance } from '../src/domain/maintenance.ts';

const rule = { months: 12, km: 10000, defaultKmPerMonth: 1250 };
const d = (s: string) => new Date(`${s}T10:00:00Z`);

test('addMonths: конец месяца не «перепрыгивает»', () => {
  assert.equal(addMonths(d('2026-01-31'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(addMonths(d('2028-01-31'), 1).toISOString().slice(0, 10), '2028-02-29');
  assert.equal(addMonths(d('2026-03-15'), 12).toISOString().slice(0, 10), '2027-03-15');
});

test('пробег в месяц считается по истории, если точек достаточно', () => {
  assert.equal(estimateKmPerMonth([{ at: d('2026-01-01'), mileageKm: 40000 }]), null);
  assert.equal(estimateKmPerMonth([{ at: d('2026-01-01'), mileageKm: 40000 }, { at: d('2026-01-10'), mileageKm: 41000 }]), null, 'меньше 30 дней');
  const rate = estimateKmPerMonth([
    { at: d('2025-07-01'), mileageKm: 30000 },
    { at: d('2026-01-01'), mileageKm: 42000 },
  ]);
  assert.ok(rate! > 1950 && rate! < 2050, `≈2000 км/мес, получили ${rate}`);
});

test('без пробега — только по времени', () => {
  const n = nextMaintenance({ at: d('2026-03-15'), mileageKm: null }, [], rule);
  assert.equal(n.reason, 'time');
  assert.equal(n.dueKm, null);
  assert.equal(n.dueDate.toISOString().slice(0, 10), '2027-03-15');
});

test('мало ездит — ТО по времени; много ездит — по пробегу', () => {
  // по умолчанию 1250 км/мес → 10 000 км за 8 месяцев, раньше года
  const def = nextMaintenance({ at: d('2026-03-15'), mileageKm: 50000 }, [], rule);
  assert.equal(def.reason, 'mileage');
  assert.equal(def.dueKm, 60000);
  assert.equal(def.dueDate.toISOString().slice(0, 7), '2026-11');

  // по истории 500 км/мес → по пробегу 20 месяцев, значит по времени — через год
  const slow = nextMaintenance({ at: d('2026-03-15'), mileageKm: 50000 }, [
    { at: d('2025-03-15'), mileageKm: 44000 },
    { at: d('2026-03-15'), mileageKm: 50000 },
  ], rule);
  assert.equal(slow.reason, 'time');
  assert.equal(slow.kmPerMonth, 500);
  assert.equal(slow.dueDate.toISOString().slice(0, 10), '2027-03-15');

  // 2500 км/мес → через 4 месяца
  const fast = nextMaintenance({ at: d('2026-03-15'), mileageKm: 50000 }, [
    { at: d('2025-11-15'), mileageKm: 40000 },
    { at: d('2026-03-15'), mileageKm: 50000 },
  ], rule);
  assert.equal(fast.reason, 'mileage');
  assert.equal(fast.dueDate.toISOString().slice(0, 7), '2026-07');
});
