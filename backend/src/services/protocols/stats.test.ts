import { describe, it, expect } from 'vitest';
import { withIdleXrayPeers, type PeerStats } from './stats.js';

const peer = (pubkey: string, rx = 10, tx = 20): PeerStats =>
  ({ pubkey, rxBytes: rx, txBytes: tx, lastHandshake: 0, endpoint: null });

describe('withIdleXrayPeers', () => {
  it('дописывает нули клиентам, которых нет в ответе stats API', () => {
    const out = withIdleXrayPeers([peer('a')], ['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ pubkey: 'a', rxBytes: 10, txBytes: 20 });
    expect(out[1]).toMatchObject({ pubkey: 'b', rxBytes: 0, txBytes: 0, lastHandshake: 0 });
  });

  it('не трогает уже присутствующих и переживает пустой ответ', () => {
    expect(withIdleXrayPeers([peer('a')], ['a'])).toHaveLength(1);
    expect(withIdleXrayPeers([], ['a', 'b']).map(p => p.rxBytes)).toEqual([0, 0]);
  });
});
