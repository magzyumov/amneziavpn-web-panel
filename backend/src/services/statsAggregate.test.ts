import { describe, it, expect } from 'vitest';
import { sumTraffic, downsample, rateSeries, type StatsSample } from './statsAggregate.js';

const s = (ts: number, rx: number, tx = 0): StatsSample => ({ ts, rx_bytes: rx, tx_bytes: tx });

describe('sumTraffic', () => {
  it('суммирует приращения накопительных счётчиков', () => {
    // Счётчик вырос 100 → 500, значит за период прошло 400, а не 500.
    expect(sumTraffic([s(0, 100, 10), s(60, 300, 20), s(120, 500, 45)]))
      .toEqual({ rx: 400, tx: 35 });
  });

  it('зависит от окна — в этом и был баг', () => {
    // Раньше отдавалось значение последнего снимка, одинаковое при любом окне.
    const all = [s(0, 0), s(60, 1000), s(120, 5000), s(180, 9000)];
    expect(sumTraffic(all).rx).toBe(9000);
    expect(sumTraffic(all.slice(2)).rx).toBe(4000);
    expect(sumTraffic(all.slice(3)).rx).toBe(0);
  });

  it('рестарт контейнера (счётчик обнулился) не даёт отрицательных значений', () => {
    // 0→800, затем сброс на 50 и рост до 200: 800 + 150.
    expect(sumTraffic([s(0, 0), s(60, 800), s(120, 50), s(180, 200)]).rx).toBe(950);
  });

  it('меньше двух точек = нечего вычитать', () => {
    expect(sumTraffic([])).toEqual({ rx: 0, tx: 0 });
    expect(sumTraffic([s(0, 12345, 999)])).toEqual({ rx: 0, tx: 0 });
  });

  it('первый элемент — только база отсчёта', () => {
    // Снимок до начала окна не добавляет свои байты в результат.
    expect(sumTraffic([s(0, 1_000_000), s(60, 1_000_500)]).rx).toBe(500);
  });
});

describe('downsample', () => {
  it('в каждом бакете оставляет последний снимок', () => {
    const rows = [s(0, 1), s(10, 2), s(59, 3), s(60, 4), s(119, 5)];
    expect(downsample(rows, 60).map(r => r.ts)).toEqual([59, 119]);
  });

  it('результат отсортирован по времени', () => {
    const out = downsample([s(120, 1), s(0, 2), s(60, 3)], 60);
    expect(out.map(r => r.ts)).toEqual([0, 60, 120]);
  });

  it('нулевой бакет возвращает исходные точки', () => {
    const rows = [s(0, 1), s(10, 2)];
    expect(downsample(rows, 0)).toHaveLength(2);
  });
});

describe('rateSeries', () => {
  it('считает байты в секунду между соседними точками', () => {
    expect(rateSeries([s(0, 0), s(10, 1000)])).toEqual([{ ts: 10, rxRate: 100, txRate: 0 }]);
  });

  it('пропускает точки с нулевым и отрицательным интервалом', () => {
    expect(rateSeries([s(60, 0), s(60, 100)])).toHaveLength(0);
  });

  it('после сброса счётчика скорость 0, а не отрицательная', () => {
    const out = rateSeries([s(0, 5000), s(10, 100)]);
    expect(out[0].rxRate).toBe(0);
  });
});
