import { describe, it, expect } from 'vitest';
import {
  sh, shInt, assertContainerName, assertDomain, assertPort,
  assertMagicHeader, assertUint32Range, assertWgKey, assertOnOff,
} from './shell.js';
import { UserError } from './errors.js';

describe('sh', () => {
  it('оборачивает в кавычки и экранирует одинарную кавычку', () => {
    expect(sh('простое')).toBe("'простое'");
    expect(sh("it's")).toBe("'it'\\''s'");
    expect(sh(null)).toBe("''");
  });

  // Главное, ради чего sh существует: shell-метасимволы не должны разрывать команду.
  it('обезвреживает попытку инъекции', () => {
    expect(sh("x'; rm -rf /; echo '")).toBe("'x'\\''; rm -rf /; echo '\\'''");
  });
});

describe('shInt', () => {
  it('пропускает целые в диапазоне', () => {
    expect(shInt(42, { min: 0, max: 100 })).toBe(42);
    expect(shInt('7', { min: 0, max: 10 })).toBe(7);
  });

  it('отвергает дробные, нечисловые и выход за границы', () => {
    for (const bad of [1.5, 'abc', NaN, 101, -1]) {
      expect(() => shInt(bad, { min: 0, max: 100 })).toThrow(UserError);
    }
  });

  // Number('') и Number(null) дают 0 — на этом очищенное поле формы молча
  // превращалось в Jc = 0 вместо дефолта. Пустое значение должно отвергаться.
  it('отвергает пустые значения, а не приводит их к 0', () => {
    for (const empty of ['', '   ', null, undefined, false]) {
      expect(() => shInt(empty, { min: 0, max: 100 })).toThrow(UserError);
    }
  });
});

describe('assertContainerName', () => {
  it('пропускает docker-совместимые имена', () => {
    expect(assertContainerName('amnezia-awg2')).toBe('amnezia-awg2');
  });

  it('отвергает имена с shell-метасимволами', () => {
    for (const bad of ['a b', 'a;b', '-leading', '$(id)', '']) {
      expect(() => assertContainerName(bad)).toThrow(UserError);
    }
  });
});

describe('assertDomain', () => {
  it('пропускает валидные домены', () => {
    expect(assertDomain('www.google.com')).toBe('www.google.com');
  });

  it('отвергает мусор и метасимволы', () => {
    for (const bad of ['-bad.com', 'a b.com', 'a;b.com', 'a|b']) {
      expect(() => assertDomain(bad)).toThrow(UserError);
    }
  });
});

describe('assertPort', () => {
  it('принимает границы 1 и 65535', () => {
    expect(assertPort(1)).toBe(1);
    expect(assertPort(65535)).toBe(65535);
  });

  it('отвергает 0 и 65536', () => {
    expect(() => assertPort(0)).toThrow(UserError);
    expect(() => assertPort(65536)).toThrow(UserError);
  });
});

describe('assertMagicHeader', () => {
  it('принимает одиночный uint32 и диапазон', () => {
    expect(assertMagicHeader('1020325451')).toBe('1020325451');
    expect(assertMagicHeader('5-1000000')).toBe('5-1000000');
  });

  it('отвергает перевёрнутый диапазон', () => {
    expect(() => assertMagicHeader('100-5')).toThrow(/range start > end/);
  });

  it('отвергает 0 — H1-H4 начинаются с 1', () => {
    expect(() => assertMagicHeader('0')).toThrow(UserError);
  });

  it('отвергает всё, что не число и не диапазон', () => {
    for (const bad of ['abc', '1-2-3', '5 - 10', '$(id)']) {
      expect(() => assertMagicHeader(bad)).toThrow(UserError);
    }
  });
});

describe('assertUint32Range', () => {
  it('в отличие от magic header допускает 0 (AWG трактует как «не задано»)', () => {
    expect(assertUint32Range('0')).toBe('0');
    expect(assertUint32Range('22-30')).toBe('22-30');
  });

  it('отвергает перевёрнутый диапазон и мусор', () => {
    expect(() => assertUint32Range('30-22')).toThrow(/range start > end/);
    expect(() => assertUint32Range('abc')).toThrow(UserError);
  });
});

describe('assertWgKey', () => {
  // 32 байта в base64 = 43 символа + '='.
  const valid = '2PgMtXNQAWt9ul11vICYNYiLKBM8aO0cjMHWvWbbHng=';

  it('принимает ключ правильной длины', () => {
    expect(assertWgKey(valid)).toBe(valid);
  });

  it('отвергает обрезанный ключ, лишние символы и мусор', () => {
    for (const bad of [valid.slice(0, 20), `${valid}extra`, 'not a key', '']) {
      expect(() => assertWgKey(bad)).toThrow(UserError);
    }
  });
});

describe('assertOnOff', () => {
  it('принимает on/off в любом регистре и нормализует', () => {
    expect(assertOnOff('on')).toBe('on');
    expect(assertOnOff('OFF')).toBe('off');
  });

  it('отвергает всё, что не понимает awg-tools parse_bool', () => {
    for (const bad of ['', 'true', 'false', '1', '0', 'yes']) {
      expect(() => assertOnOff(bad, 'randomTrailers')).toThrow(UserError);
    }
  });
});
