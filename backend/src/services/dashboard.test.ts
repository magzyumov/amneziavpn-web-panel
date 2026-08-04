import { describe, it, expect } from 'vitest';
import { trafficByDay, trafficByClient, fillMissingDays, dayKey, type HourlySample } from './dashboard.js';

const s = (client_id: string, ts: number, rx: number, tx: number): HourlySample =>
  ({ client_id, ts, rx_bytes: rx, tx_bytes: tx });

const DAY = 24 * 3600;
const noon = (dayOffset: number) => Math.floor(new Date(2026, 7, 4 + dayOffset, 12, 0, 0).getTime() / 1000);

describe('трафик по суткам', () => {
  it('считает приращения, а не значения счётчиков', () => {
    const rows = [s('c1', noon(0), 100, 50), s('c1', noon(0) + 3600, 300, 150)];
    expect(trafficByDay(rows)).toEqual([{ day: dayKey(noon(0)), rx: 200, tx: 100 }]);
  });

  // Первый снимок клиента — только база отсчёта: его накопленное значение это
  // трафик за всё прошлое, засчитывать его в сутки нельзя.
  it('первый снимок клиента не даёт трафика', () => {
    expect(trafficByDay([s('c1', noon(0), 10_000, 10_000)])).toEqual([]);
  });

  it('приращение относится к суткам позднего снимка', () => {
    const rows = [s('c1', noon(0), 0, 0), s('c1', noon(1), 500, 0)];
    expect(trafficByDay(rows)).toEqual([{ day: dayKey(noon(1)), rx: 500, tx: 0 }]);
  });

  it('складывает разных клиентов в одни сутки', () => {
    const rows = [
      s('c1', noon(0), 0, 0), s('c1', noon(0) + 60, 100, 0),
      s('c2', noon(0), 0, 0), s('c2', noon(0) + 60, 0, 70),
    ].sort((a, b) => a.client_id.localeCompare(b.client_id) || a.ts - b.ts);
    expect(trafficByDay(rows)).toEqual([{ day: dayKey(noon(0)), rx: 100, tx: 70 }]);
  });

  // Рестарт контейнера и возврат приостановленного пира обнуляют счётчики.
  it('обнуление счётчика не уходит в минус', () => {
    const rows = [
      s('c1', noon(0), 5000, 5000),
      s('c1', noon(0) + 3600, 0, 0),
      s('c1', noon(0) + 7200, 80, 20),
    ];
    expect(trafficByDay(rows)).toEqual([{ day: dayKey(noon(0)), rx: 80, tx: 20 }]);
  });
});

describe('трафик по клиентам', () => {
  it('счётчики клиентов не смешиваются', () => {
    const rows = [
      s('c1', noon(0), 0, 0), s('c1', noon(0) + 60, 100, 10),
      s('c2', noon(0), 0, 0), s('c2', noon(0) + 60, 7, 3),
    ];
    const totals = trafficByClient(rows);
    expect(totals.get('c1')).toEqual({ rx: 100, tx: 10 });
    expect(totals.get('c2')).toEqual({ rx: 7, tx: 3 });
  });

  it('клиент с одним снимком в итоги не попадает', () => {
    expect(trafficByClient([s('c1', noon(0), 999, 999)]).size).toBe(0);
  });
});

describe('заполнение пропущенных суток', () => {
  it('дни без трафика становятся нулями, а не пропадают', () => {
    const now = noon(0);
    const filled = fillMissingDays([{ day: dayKey(now), rx: 10, tx: 5 }], 3, now);
    expect(filled).toHaveLength(3);
    expect(filled.map(d => d.day)).toEqual([dayKey(now - 2 * DAY), dayKey(now - DAY), dayKey(now)]);
    expect(filled[0]).toEqual({ day: dayKey(now - 2 * DAY), rx: 0, tx: 0 });
    expect(filled[2]).toEqual({ day: dayKey(now), rx: 10, tx: 5 });
  });

  it('последний элемент — всегда сегодня', () => {
    const now = noon(0);
    expect(fillMissingDays([], 14, now).at(-1)!.day).toBe(dayKey(now));
  });
});
