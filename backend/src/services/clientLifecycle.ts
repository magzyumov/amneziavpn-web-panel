// Операции над клиентом, затрагивающие сервер: отзыв пира, возврат пира и
// полное удаление. Раньше это жило прямо в routes/clients.ts, но с появлением
// лимитов те же действия выполняет фоновый воркер — а расходиться этим двум
// путям нельзя: «удалён в панели, но работает на сервере» это дыра, а не баг
// отображения.
import { queryOne, run } from './db.js';
import {
  removeAWG2Client, removeXrayClient, removeWireGuardClient, removeTelemtClient,
  restoreAWG2Client, restoreXrayClient, restoreWireGuardClient, restoreTelemtClient,
} from './protocols/index.js';
import { extractPeerRestoreInfo } from './peerId.js';
import { deleteSubscription } from './subscription.js';
import { UserError } from './errors.js';
import type { Client, Protocol, Server } from '../types.js';

export interface ClientContext {
  client: Client;
  protocol: Protocol | null;
  server: Server | null;
}

export function loadClientContext(client: Client): ClientContext {
  const protocol = queryOne<Protocol>('SELECT * FROM protocols WHERE id = ?', [client.protocol_id]);
  const server = protocol
    ? queryOne<Server>('SELECT * FROM servers WHERE id = ?', [protocol.server_id])
    : null;
  return { client, protocol, server };
}

// Снимает пира на сервере. Бросает — вызывающий решает, что делать с записью:
// удалять её при неудавшемся отзыве нельзя, иначе «удалённый» клиент останется
// рабочим и невидимым.
export async function revokePeer(ctx: ClientContext): Promise<void> {
  const { client, protocol, server } = ctx;
  // Нечего отзывать: импортированный клиент без peer_id либо протокол/сервер
  // уже удалены вместе со всеми пирами.
  if (!client.peer_id || !protocol || !server) return;

  if      (protocol.type === 'awg2')      await removeAWG2Client(server, protocol, client.peer_id);
  else if (protocol.type === 'xray')      await removeXrayClient(server, protocol, client.peer_id);
  else if (protocol.type === 'wireguard') await removeWireGuardClient(server, protocol, client.peer_id);
  else if (protocol.type === 'telemt')    await removeTelemtClient(server, protocol, client.peer_id);
}

// Возвращает пира тем же ключом. Всё нужное лежит в сохранённом конфиге клиента,
// поэтому выданный ему профиль остаётся рабочим.
export async function restorePeer(ctx: ClientContext): Promise<void> {
  const { client, protocol, server } = ctx;
  if (!client.peer_id || !protocol || !server) {
    throw new UserError('Не хватает данных для возврата клиента на сервер (протокол или сервер удалены)');
  }

  const info = extractPeerRestoreInfo(client.config ?? null, protocol.type);
  if (!info) {
    throw new UserError('В сохранённом конфиге клиента нет данных для восстановления');
  }

  if (protocol.type === 'awg2' || protocol.type === 'wireguard') {
    if (!info.clientIp || !info.presharedKey) {
      throw new UserError('В конфиге клиента нет адреса или preshared-key');
    }
    const peer = { clientPubKey: client.peer_id, presharedKey: info.presharedKey, clientIp: info.clientIp };
    if (protocol.type === 'awg2') await restoreAWG2Client(server, protocol, peer);
    else                          await restoreWireGuardClient(server, protocol, peer);
    return;
  }

  if (protocol.type === 'xray') {
    await restoreXrayClient(server, protocol, client.peer_id);
    return;
  }

  if (protocol.type === 'telemt') {
    if (!info.secret) throw new UserError('В ссылке клиента нет secret');
    await restoreTelemtClient(server, protocol, client.peer_id, info.secret);
  }
}

// Удаление строк, связанных с клиентом. Внешние ключи в базе выключены, поэтому
// ON DELETE CASCADE не сработает и связанное удаляем явно.
export function purgeClientRows(clientId: string): void {
  deleteSubscription(clientId);
  run('DELETE FROM client_stats WHERE client_id = ?', [clientId]);
  run('DELETE FROM clients WHERE id = ?', [clientId]);
}

// Полное удаление: сначала сервер, потом база. Порядок важен — см. revokePeer.
export async function deleteClientCompletely(client: Client): Promise<void> {
  await revokePeer(loadClientContext(client));
  purgeClientRows(client.id);
}

export async function suspendClient(client: Client): Promise<void> {
  await revokePeer(loadClientContext(client));
  run('UPDATE clients SET suspended_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000), client.id]);
}

export async function resumeClient(client: Client): Promise<void> {
  await restorePeer(loadClientContext(client));
  run('UPDATE clients SET suspended_at = NULL WHERE id = ?', [client.id]);
}
