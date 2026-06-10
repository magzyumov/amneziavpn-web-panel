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

  // MTProxy / Telemt: config — это tg://proxy ссылка с secret=<linkSecret>.
  // linkSecret = dd<secret32> (secure) либо ee<secret32><domainHex> (FakeTLS).
  if (protocolType === 'mtproxy' || protocolType === 'telemt') {
    const m = config.match(/[?&]secret=([0-9a-fA-F]+)/);
    if (!m) return null;
    const linkSecret = m[1];
    // Вырезаем «сырой» 32-символьный secret из-под dd/ee префикса.
    const raw = /^(dd|ee)/i.test(linkSecret) ? linkSecret.slice(2, 34) : linkSecret.slice(0, 32);
    // Для Telemt peer_id должен совпадать с username в [access.users]
    // (addTelemtClient: c_<первые 12 hex секрета>) — по нему мапим API-статистику.
    if (protocolType === 'telemt') return `c_${raw.slice(0, 12)}`;
    return raw;
  }

  return null;
}
