// Единственный источник отображаемых названий и иконок протоколов.
//
// Специально НЕ берём их из protocols.name в БД: там лежит снимок имени на момент
// установки, он никогда не обновляется, и после переименования протокола старые
// карточки продолжали показывать старое название. Всё, что нужно для заголовка,
// выводится из type + config, поэтому расхождение невозможно by design.
import type { ProtocolRecord } from './api';

export type ProtocolType = ProtocolRecord['type'];

export const PROTOCOL_ICONS: Record<ProtocolType, string> = {
  awg2: '🛡️', xray: '⚡', wireguard: '🔒', telemt: '📨',
};

// Имена того, что получаешь при установке СЕЙЧАС. Для awg2 это 3.1 — более
// старые инсталляции понижаются до 3.0/2.0 в protocolTitle по protocolVersion.
export const PROTOCOL_NAMES: Record<ProtocolType, string> = {
  awg2: 'AmneziaWG 3.1',
  xray: 'Xray VLESS Reality',
  wireguard: 'WireGuard',
  telemt: 'Telemt',
};

interface TitleSource {
  type: ProtocolType;
  config?: Record<string, unknown> | string | null;
}

// Ключ 'awg2' и контейнер 'amnezia-awg2' — идентификаторы слота из апстрима
// (DockerContainer::Awg2), а не версия протокола: тот же контейнер обслуживает
// все версии AmneziaWG, и различить их можно только по protocolVersion в конфиге.
// '3' — инсталляции с header protection, но без параметров AWG 3.1;
// '3.1' — то, что ставится сейчас.
const AWG_VERSION_NAMES: Record<string, string> = {
  '3.1': 'AmneziaWG 3.1',
  '3': 'AmneziaWG 3.0',
};

export function protocolTitle(p: TitleSource): string {
  const base = PROTOCOL_NAMES[p.type] ?? p.type;
  if (p.type !== 'awg2') return base;
  const config = typeof p.config === 'string' ? safeParse(p.config) : p.config;
  return AWG_VERSION_NAMES[String(config?.protocolVersion)] ?? 'AmneziaWG 2.0';
}

function safeParse(raw: string): Record<string, unknown> | null {
  try { return JSON.parse(raw); } catch { return null; }
}
