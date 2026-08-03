import { describe, it, expect } from 'vitest';
import { renderTemplate, removePeerBlock } from './common.js';

describe('renderTemplate', () => {
  it('подставляет значения по плейсхолдерам', () => {
    expect(renderTemplate('port = $PORT\nhost = $HOST', { PORT: 443, HOST: 'example.com' }))
      .toBe('port = 443\nhost = example.com');
  });

  it('подставляет все вхождения одного плейсхолдера', () => {
    expect(renderTemplate('$P:$P', { P: 'x' })).toBe('x:x');
  });

  // Пустое значение схлопывает строку-плейсхолдер в пустую — именно на этом
  // держится вставка необязательных блоков (AWG3-параметры, I2-I5): либо строка
  // целиком, либо ничего. Строка вида "I2 = " ломает awg setconf.
  it('пустое значение оставляет пустую строку, а не "key = "', () => {
    const out = renderTemplate('I1 = $A\n$OPTIONAL\n[Peer]', { A: 'v', OPTIONAL: '' });
    expect(out).toBe('I1 = v\n\n[Peer]');
    expect(out).not.toMatch(/=\s*$/m);
  });

  it('многострочное значение раскрывается в несколько строк', () => {
    expect(renderTemplate('$BLOCK[Peer]', { BLOCK: 'A = 1\nB = 2\n' }))
      .toBe('A = 1\nB = 2\n[Peer]');
  });

  it('нетронутые плейсхолдеры остаются как есть', () => {
    expect(renderTemplate('$KNOWN $UNKNOWN', { KNOWN: 'ok' })).toBe('ok $UNKNOWN');
  });
});

describe('removePeerBlock', () => {
  const conf = [
    '[Interface]',
    'PrivateKey = SERVERKEY',
    'ListenPort = 51820',
    '',
    '[Peer]',
    'PublicKey = AAA',
    'AllowedIPs = 10.8.1.2/32',
    '',
    '[Peer]',
    'PublicKey = BBB',
    'AllowedIPs = 10.8.1.3/32',
    '',
  ].join('\n');

  it('удаляет только указанного пира', () => {
    const out = removePeerBlock(conf, 'AAA');
    expect(out).not.toContain('AAA');
    expect(out).toContain('BBB');
    expect(out).toContain('10.8.1.3/32');
  });

  it('сохраняет секцию [Interface]', () => {
    const out = removePeerBlock(conf, 'AAA');
    expect(out).toContain('[Interface]');
    expect(out).toContain('PrivateKey = SERVERKEY');
    expect(out).toContain('ListenPort = 51820');
  });

  it('неизвестный ключ ничего не меняет', () => {
    expect(removePeerBlock(conf, 'ZZZ')).toBe(conf);
  });

  it('удаление единственного пира оставляет только [Interface]', () => {
    const single = '[Interface]\nPrivateKey = K\n\n[Peer]\nPublicKey = AAA\n';
    const out = removePeerBlock(single, 'AAA');
    expect(out).toContain('[Interface]');
    expect(out).not.toContain('[Peer]');
  });
});
