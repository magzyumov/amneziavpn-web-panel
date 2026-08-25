import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { renderTemplate, removePeerBlock, runArgsSha, driftFromLabels } from './common.js';

describe('renderTemplate', () => {
  it('подставляет значения по плейсхолдерам', () => {
    expect(renderTemplate('port = $PORT\nhost = $HOST', { PORT: 443, HOST: 'example.com' }))
      .toBe('port = 443\nhost = example.com');
  });

  it('подставляет все вхождения одного плейсхолдера', () => {
    expect(renderTemplate('$P:$P', { P: 'x' })).toBe('x:x');
  });

  // Имя одной переменной может быть префиксом другой. Наивная подстановка по
  // порядку объявления съедала начало длинной и оставляла хвост: из
  // "$XRAY_SECURITY" + "$XRAY_SECURITY_SETTINGS" получалось "none_SETTINGS",
  // а клиентский конфиг переставал быть валидным JSON.
  it('не портит переменную, чьё имя начинается с имени другой', () => {
    expect(renderTemplate('$A|$A_LONG', { A: 'x', A_LONG: 'y' })).toBe('x|y');
    expect(renderTemplate('$A_LONG|$A', { A_LONG: 'y', A: 'x' })).toBe('y|x');
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

describe('runArgsSha', () => {
  const args = ['--restart always', '-p 51820:51820/udp', 'amnezia-awg2:3.0.3'];

  it('стабилен для одних и тех же аргументов', () => {
    expect(runArgsSha(args)).toBe(runArgsSha([...args]));
  });

  // Ради этого отпечаток и нужен: поменяли флаг в коде — работающий контейнер
  // остаётся со старыми аргументами, и это должно стать заметно.
  it('меняется при изменении любого аргумента', () => {
    expect(runArgsSha(args)).not.toBe(runArgsSha([...args.slice(0, 1), '-p 443:443/udp', args[2]]));
    expect(runArgsSha(args)).not.toBe(runArgsSha([...args, '--cap-add=NET_ADMIN']));
  });

  it('чувствителен к порядку аргументов', () => {
    expect(runArgsSha(args)).not.toBe(runArgsSha([args[1], args[0], args[2]]));
  });
});

describe('driftFromLabels', () => {
  const DF = 'FROM alpine:3.15\nRUN true';
  const ARGS = ['--name x', '-p 443:443/tcp', 'img:1'];
  const okImage = createHash('sha256').update(DF).digest('hex').slice(0, 16);

  it('совпадающие метки — расхождения нет', () => {
    expect(driftFromLabels(runArgsSha(ARGS), okImage, DF, ARGS)).toEqual({ image: false, runArgs: false });
  });

  it('ловит и другой Dockerfile, и другие аргументы запуска', () => {
    expect(driftFromLabels('deadbeef', okImage, DF, ARGS).runArgs).toBe(true);
    expect(driftFromLabels(runArgsSha(ARGS), 'deadbeef', DF, ARGS).image).toBe(true);
  });

  it('пустая метка не считается расхождением', () => {
    // Контейнеры и образы старше самих меток. Иначе «устарел» горел бы у всех,
    // кто ни разу не переустанавливался, — то есть у всех сразу.
    expect(driftFromLabels('', '', DF, ARGS)).toEqual({ image: false, runArgs: false });
  });
});
