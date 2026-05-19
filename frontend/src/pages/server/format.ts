// Утилиты форматирования для UI статистики.

const SI = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < SI.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${SI[i]}`;
}

export function formatBitsPerSec(bytesPerSec: number): string {
  const bps = bytesPerSec * 8;
  if (bps < 1000) return `${Math.round(bps)} bps`;
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  return `${(bps / 1_000_000_000).toFixed(2)} Gbps`;
}

export function formatRelativeTime(unixSec: number | null): string {
  if (!unixSec) return 'никогда';
  const now = Math.floor(Date.now() / 1000);
  const delta = now - unixSec;
  if (delta < 60) return 'только что';
  if (delta < 3600) return `${Math.floor(delta / 60)} мин назад`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} ч назад`;
  if (delta < 86400 * 7) return `${Math.floor(delta / 86400)} д назад`;
  return new Date(unixSec * 1000).toLocaleDateString('ru-RU');
}
