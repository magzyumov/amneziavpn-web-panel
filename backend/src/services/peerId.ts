// Извлекает peer_id (pubkey для AWG/WG, UUID для Xray) из stored client.config.
// Использует тот же формат хранения, что и routes/clients.ts:
//   AWG/WG: "<conf>\n---AMNEZIA_JSON---\n<json>" где json.client_pub_key
//   Xray:   "vless://<uuid>@host:port?..."
//
// Используется и в db.ts (миграция бэкфилла), и в routes/clients.ts (на create).
export function extractPeerId(config: string | null, protocolType: string): string | null {
  if (!config) return null;

  if (protocolType === 'awg2' || protocolType === 'wireguard') {
    const parts = config.split('\n---AMNEZIA_JSON---\n');
    if (!parts[1]) return null;
    try {
      const json = JSON.parse(parts[1]) as { client_pub_key?: string };
      return json.client_pub_key || null;
    } catch { return null; }
  }

  if (protocolType === 'xray') {
    const m = config.match(/^vless:\/\/([0-9a-f-]{36})@/i);
    return m ? m[1] : null;
  }

  // Telemt: config — это tg://proxy ссылка с secret=<linkSecret>.
  // linkSecret = ee<secret32><domainHex> (FakeTLS); dd<secret32> — secure mode,
  // Telemt в нём не работает, но старые записи разбираем тем же кодом.
  if (protocolType === 'telemt') {
    const m = config.match(/[?&]secret=([0-9a-fA-F]+)/);
    if (!m) return null;
    const linkSecret = m[1];
    // Вырезаем «сырой» 32-символьный secret из-под dd/ee префикса.
    const raw = /^(dd|ee)/i.test(linkSecret) ? linkSecret.slice(2, 34) : linkSecret.slice(0, 32);
    // peer_id должен совпадать с username в [access.users] (addTelemtClient:
    // c_<первые 12 hex секрета>) — по нему мапим API-статистику.
    return `c_${raw.slice(0, 12)}`;
  }

  return null;
}

// Всё, что нужно, чтобы вернуть пира на сервер ТЕМ ЖЕ ключом, каким он был
// выпущен. Нужно при снятии приостановки по суточному лимиту: конфиг у клиента
// на руках уже есть, перевыпускать его нельзя — иначе приостановка на сутки
// превращалась бы в обязательную переустановку профиля.
//
// Ничего лишнего мы не храним: адрес и PSK и так лежат в выданном конфиге,
// pubkey/uuid — в peer_id.
export interface PeerRestoreInfo {
  /** WG/AWG: адрес пира без маски (Address = 10.8.1.3/32 → 10.8.1.3). */
  clientIp?: string;
  /** WG/AWG: preshared-key пира. */
  presharedKey?: string;
  /** Telemt: «сырой» 32-символьный secret (без ee/dd-префикса ссылки). */
  secret?: string;
}

export function extractPeerRestoreInfo(config: string | null, protocolType: string): PeerRestoreInfo | null {
  if (!config) return null;

  if (protocolType === 'awg2' || protocolType === 'wireguard') {
    const conf = config.split('\n---AMNEZIA_JSON---\n')[0];
    const ip  = conf.match(/^\s*Address\s*=\s*([0-9a-fA-F.:]+)/m);
    const psk = conf.match(/^\s*PresharedKey\s*=\s*(\S+)/m);
    if (!ip || !psk) return null;
    return { clientIp: ip[1], presharedKey: psk[1] };
  }

  if (protocolType === 'telemt') {
    const m = config.match(/[?&]secret=([0-9a-fA-F]+)/);
    if (!m) return null;
    const linkSecret = m[1];
    const raw = /^(dd|ee)/i.test(linkSecret) ? linkSecret.slice(2, 34) : linkSecret.slice(0, 32);
    return raw.length === 32 ? { secret: raw } : null;
  }

  // Xray: восстановление идёт по одному peer_id (uuid), больше ничего не нужно.
  if (protocolType === 'xray') return {};

  return null;
}
