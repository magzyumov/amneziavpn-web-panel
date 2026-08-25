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

  it('s2 и s3 не совпадают ни с s1/s4, ни между собой', () => {
    // Ровно то, что гарантирует апстримный generateAwgParameters: usedValues
    // засевается {s1, s4}, и уникальность форсируется только для s2 и s3.
    // s1 == s4 == 12 апстрим допускает — базовые размеры пакетов всё равно разные.
    for (const { s1, s2, s3, s4 } of runs) {
      expect([s1, s4, s3]).not.toContain(s2);
      expect([s1, s4, s2]).not.toContain(s3);
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

  it('S4 прибит к 12 — апстрим его не рандомизирует', () => {
    // protocolConstants::defaultTransportPacketJunkSize. min ниже 12 не опускает:
    // amneziawg-go 3.x с header protection такой конфиг не примет.
    for (const { s4 } of [...runs, ...Array.from({ length: 50 }, () => genPacketSizes(0))]) {
      expect(s4).toBe(12);
    }
  });

  it('границы апстримные: S1/S2 в [12,149], S3 в [12,63]', () => {
    for (const { s1, s2, s3 } of [...runs, ...Array.from({ length: 50 }, () => genPacketSizes(0))]) {
      expect(s1).toBeGreaterThanOrEqual(12); expect(s1).toBeLessThanOrEqual(149);
      expect(s2).toBeGreaterThanOrEqual(12); expect(s2).toBeLessThanOrEqual(149);
      expect(s3).toBeGreaterThanOrEqual(12); expect(s3).toBeLessThanOrEqual(63);
    }
  });
});
