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

// Имена того, что получаешь при установке СЕЙЧАС. Для awg2 это 3.0 — старые
// инсталляции понижаются до 2.0 в protocolTitle по protocolVersion.
export const PROTOCOL_NAMES: Record<ProtocolType, string> = {
  awg2: 'AmneziaWG 3.0',
  xray: 'Xray VLESS Reality',
  wireguard: 'WireGuard',
  telemt: 'Telemt',
};

interface TitleSource {
  type: ProtocolType;
  config?: Record<string, unknown> | string | null;
}

// Контейнер amnezia-awg2 обслуживает и AWG 2.0, и AWG 3.0 (header protection) —
// различить их можно только по protocolVersion в конфиге.
export function protocolTitle(p: TitleSource): string {
  const base = PROTOCOL_NAMES[p.type] ?? p.type;
  if (p.type !== 'awg2') return base;
  const config = typeof p.config === 'string' ? safeParse(p.config) : p.config;
  return config?.protocolVersion === '3' ? base : 'AmneziaWG 2.0';
}

function safeParse(raw: string): Record<string, unknown> | null {
  try { return JSON.parse(raw); } catch { return null; }
}
