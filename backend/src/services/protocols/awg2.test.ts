import { describe, it, expect } from 'vitest';
import { genPacketSizes } from './awg2.js';

// Базовые размеры handshake-пакетов AmneziaWG — те же константы, что в awg2.ts.
const MSG_INIT = 148, MSG_RESP = 92, MSG_COOKIE = 64;

describe('genPacketSizes', () => {
  // Генератор случайный, поэтому инварианты проверяем на выборке.
  const runs = Array.from({ length: 300 }, () => genPacketSizes(12));

  it('при header protection все S >= 12', () => {
    // amneziawg-go 3.x отвергает конфиг с S < 12, когда задан HeaderProtectionKey:
    // "Unable to modify interface: Invalid argument".
    for (const { s1, s2, s3, s4 } of runs) {
      expect(Math.min(s1, s2, s3, s4)).toBeGreaterThanOrEqual(12);
    }
  });

  it('значения не повторяются', () => {
    for (const { s1, s2, s3, s4 } of runs) {
      expect(new Set([s1, s2, s3, s4]).size).toBe(4);
    }
  });

  it('итоговые размеры пакетов не совпадают между собой', () => {
    // Совпадение base+S по разным типам пакетов делает их неразличимыми —
    // апстримный генератор специально этого избегает.
    for (const { s1, s2, s3 } of runs) {
      expect(s1 + MSG_INIT).not.toBe(s2 + MSG_RESP);
      expect(s1 + MSG_INIT).not.toBe(s3 + MSG_COOKIE);
      expect(s2 + MSG_RESP).not.toBe(s3 + MSG_COOKIE);
    }
  });

  it('без header protection допускает апстримные нижние границы', () => {
    const low = Array.from({ length: 300 }, () => genPacketSizes(0));
    // s4 генерится из диапазона 0..19 — хотя бы раз должен выпасть ниже 12,
    // иначе поведение по сути не отличается от режима с header protection.
    expect(low.some(({ s4 }) => s4 < 12)).toBe(true);
  });

  it('верхние границы соблюдаются', () => {
    for (const { s1, s2, s3, s4 } of runs) {
      expect(s1).toBeLessThanOrEqual(149);
      expect(s2).toBeLessThanOrEqual(149);
      expect(s3).toBeLessThanOrEqual(63);
      expect(s4).toBeLessThanOrEqual(19);
    }
  });
});
