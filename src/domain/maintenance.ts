/**
 * Расчёт следующего планового ТО по истории визитов. Чистые функции.
 *
 * Правило: ТО раз в `months` месяцев или каждые `km` километров — что наступит раньше.
 * Текущий пробег мы не знаем (только на момент визитов), поэтому дату «по пробегу»
 * оцениваем по среднему пробегу в месяц: из истории, а если её мало — из настройки.
 */

export interface Visit {
  at: Date;
  mileageKm: number | null;
}

export interface MaintenanceRule {
  months: number;
  km: number;
  defaultKmPerMonth: number;
}

export interface NextMaintenance {
  /** Расчётная дата следующего ТО. */
  dueDate: Date;
  /** Пробег, на котором нужно ТО (если знаем пробег на последнем ТО). */
  dueKm: number | null;
  /** Чем определена дата: временем или пробегом. */
  reason: 'time' | 'mileage';
  /** Оценка пробега в месяц, если её удалось посчитать по истории. */
  kmPerMonth: number | null;
}

const DAY = 86_400_000;
const AVG_MONTH = 30.44 * DAY;

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  // 31 января + 1 месяц → 28/29 февраля, а не 3 марта
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

/** Средний пробег в месяц по визитам с известным пробегом (нужно ≥ 2 точки и ≥ 30 дней между ними). */
export function estimateKmPerMonth(visits: Visit[]): number | null {
  const pts = visits.filter((v) => v.mileageKm != null).sort((a, b) => a.at.getTime() - b.at.getTime());
  if (pts.length < 2) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const days = (last.at.getTime() - first.at.getTime()) / DAY;
  const km = last.mileageKm! - first.mileageKm!;
  if (days < 30 || km <= 0) return null;
  return Math.round((km / days) * 30.44);
}

export function nextMaintenance(lastMaintenance: Visit, history: Visit[], rule: MaintenanceRule): NextMaintenance {
  const byTime = addMonths(lastMaintenance.at, rule.months);
  const kmPerMonth = estimateKmPerMonth(history);
  if (lastMaintenance.mileageKm == null) {
    return { dueDate: byTime, dueKm: null, reason: 'time', kmPerMonth };
  }
  const dueKm = lastMaintenance.mileageKm + rule.km;
  const rate = kmPerMonth ?? rule.defaultKmPerMonth;
  if (rate <= 0) return { dueDate: byTime, dueKm, reason: 'time', kmPerMonth };
  const byKm = new Date(lastMaintenance.at.getTime() + (rule.km / rate) * AVG_MONTH);
  return byKm < byTime
    ? { dueDate: byKm, dueKm, reason: 'mileage', kmPerMonth }
    : { dueDate: byTime, dueKm, reason: 'time', kmPerMonth };
}
