// Агрегация снимков client_stats в то, что показывает вкладка статистики.
//
// Воркер пишет НАКОПИТЕЛЬНЫЕ счётчики (rx_bytes/tx_bytes растут, пока живёт
// VPN-контейнер, и обнуляются при его рестарте). Поэтому трафик за период — это
// сумма положительных приращений между соседними снимками, а не значение
// последнего снимка: последний снимок один и тот же независимо от выбранного
// окна, из-за чего 1 час и 30 дней показывали одинаковые цифры.

export interface StatsSample {
  ts: number;
  rx_bytes: number;
  tx_bytes: number;
}

export interface RatePoint {
  ts: number;
  rxRate: number;
  txRate: number;
}

// Отрицательное приращение = счётчик обнулился (рестарт контейнера). Трафик до
// рестарта уже учтён предыдущими приращениями, поэтому просто клампим в 0 —
// теряется лишь то, что прошло между последним снимком и самим рестартом.
function delta(prev: number, next: number): number {
  return next >= prev ? next - prev : 0;
}

// Суммарный трафик за период. rows должны идти по возрастанию ts; первый элемент
// служит только базой отсчёта, поэтому для точности в него стоит передавать
// снимок, взятый ДО начала окна.
export function sumTraffic(rows: readonly StatsSample[]): { rx: number; tx: number } {
  let rx = 0, tx = 0;
  for (let i = 1; i < rows.length; i++) {
    rx += delta(rows[i - 1].rx_bytes, rows[i].rx_bytes);
    tx += delta(rows[i - 1].tx_bytes, rows[i].tx_bytes);
  }
  return { rx, tx };
}

// Прореживание до ~одной точки на бакет: в каждом бакете берём последний снимок.
export function downsample<T extends StatsSample>(rows: readonly T[], bucketSec: number): T[] {
  if (bucketSec <= 0) return [...rows];
  const lastByBucket = new Map<number, T>();
  for (const r of rows) lastByBucket.set(Math.floor(r.ts / bucketSec), r);
  return [...lastByBucket.values()].sort((a, b) => a.ts - b.ts);
}

// Скорость (байт/с) между соседними точками — для графика.
export function rateSeries(rows: readonly StatsSample[]): RatePoint[] {
  const out: RatePoint[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const dt = b.ts - a.ts;
    if (dt <= 0) continue;
    out.push({
      ts: b.ts,
      rxRate: delta(a.rx_bytes, b.rx_bytes) / dt,
      txRate: delta(a.tx_bytes, b.tx_bytes) / dt,
    });
  }
  return out;
}
