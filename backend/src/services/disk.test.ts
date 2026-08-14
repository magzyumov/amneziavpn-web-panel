import { describe, it, expect } from 'vitest';
import { toBytes, parseReport, DISK_ITEMS } from './disk.js';

describe('toBytes', () => {
  it('читает голые байты от du -sb (с путём в строке)', () => {
    expect(toBytes('276824064\t/var/cache/apt')).toBe(276824064);
  });

  it('читает человеческие размеры docker', () => {
    expect(toBytes('1.87GB')).toBe(Math.round(1.87 * 1024 ** 3));
    expect(toBytes('331.1MB (26%)')).toBe(Math.round(331.1 * 1024 ** 2));
    expect(toBytes('0B')).toBe(0);
  });

  it('вытаскивает размер из фразы journalctl', () => {
    expect(toBytes('Archived and active journals take up 185.4M in the file system.'))
      .toBe(Math.round(185.4 * 1024 ** 2));
  });

  it('пустая строка и мусор без чисел — ноль', () => {
    expect(toBytes('')).toBe(0);
    expect(toBytes('command not found')).toBe(0);
  });

  // Хвост `du -c` — «13400\ttotal». Буква t от total принималась за терабайты,
  // и 13 КБ логов показывались как 12 ПБ.
  it('не принимает букву из слова за единицу измерения', () => {
    expect(toBytes('13400\ttotal')).toBe(13400);
    expect(toBytes('4096 total')).toBe(4096);
    expect(toBytes('512\tmisc')).toBe(512);
  });
});

describe('parseReport', () => {
  it('разбирает df и размеры по id', () => {
    const report = parseReport([
      'df\t  10093592576 8342032384 1250086912',
      'build-cache\t1.87GB ',
      'apt-cache\t276824064\t/var/cache/apt ',
    ].join('\n'));

    expect(report.usage).toEqual({ total: 10093592576, used: 8342032384, avail: 1250086912 });
    const byId = Object.fromEntries(report.items.map(i => [i.id, i.bytes]));
    expect(byId['build-cache']).toBe(Math.round(1.87 * 1024 ** 3));
    expect(byId['apt-cache']).toBe(276824064);
  });

  it('пункты без ответа показываются нулём, а не пропадают', () => {
    const report = parseReport('df\t1 1 1');
    expect(report.items).toHaveLength(DISK_ITEMS.length);
    expect(report.items.every(i => i.bytes === 0)).toBe(true);
  });

  it('отдаёт команду очистки — админ видит, что выполнится', () => {
    const report = parseReport('');
    expect(report.items.find(i => i.id === 'build-cache')?.cleanCmd).toBe('docker builder prune -af');
    expect(report.items.every(i => i.cleanCmd)).toBe(true);
  });

  it('команда снятия размера наружу не уходит — она интереса не представляет', () => {
    expect(JSON.stringify(parseReport(''))).not.toContain('docker system df');
  });
});
