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

  return null;
}
