// Что на VPS занимает место и как это почистить.
//
// Список фиксированный: за место на диске отвечают одни и те же вещи (кэш
// сборки docker, apt, журналы, ротированные логи), и каждая чистится своей
// командой. Размер и очистка описаны рядом, чтобы кнопка в панели и цифра над
// ней не разъезжались.
import { execSudo } from './ssh.js';
import { sh } from './shell.js';
import { UserError } from './errors.js';
import type { Server } from '../types.js';

export interface DiskItem {
  id: string;
  label: string;
  /** Что именно удалит кнопка — админ должен понимать это до нажатия. */
  hint: string;
  /** Печатает размер: голые байты (du -sb) или человеческое «1.87GB». */
  sizeCmd: string;
  cleanCmd: string;
}

export const DISK_ITEMS: DiskItem[] = [
  {
    id: 'build-cache',
    label: 'Кэш сборки Docker',
    hint: 'Растёт при каждом docker build. Удаление ничего не ломает — следующая сборка просто дольше.',
    sizeCmd: `docker system df --format '{{.Type}}|{{.Size}}' | awk -F'|' '$1=="Build Cache"{print $2}'`,
    cleanCmd: 'docker builder prune -af',
  },
  {
    id: 'docker-images',
    label: 'Висячие образы Docker',
    hint: 'Слои от пересобранных образов, ни на что не ссылающиеся. Образы работающих контейнеров не трогаются.',
    sizeCmd: `docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '$1=="Images"{print $2}'`,
    cleanCmd: 'docker image prune -f',
  },
  {
    id: 'docker-logs',
    label: 'Логи контейнеров',
    hint: 'json-логи docker. Обрезаются до нуля — история логов запущенных контейнеров теряется.',
    sizeCmd: 'du -scb /var/lib/docker/containers/*/*-json.log | tail -1',
    cleanCmd: 'truncate -s0 /var/lib/docker/containers/*/*-json.log',
  },
  {
    id: 'apt-cache',
    label: 'Кэш пакетов apt',
    hint: 'Скачанные .deb. Удаляются безопасно, apt перекачает при необходимости.',
    sizeCmd: 'du -sb /var/cache/apt',
    cleanCmd: 'apt-get clean',
  },
  {
    id: 'journal',
    label: 'Журналы systemd',
    hint: 'Оставит последние 50 МБ, остальное удалит.',
    sizeCmd: 'journalctl --disk-usage',
    cleanCmd: 'journalctl --vacuum-size=50M',
  },
  {
    id: 'old-logs',
    label: 'Ротированные логи',
    hint: 'Архивы в /var/log (*.gz, *.1, *.old). Текущие логи не трогаются.',
    sizeCmd: String.raw`find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -regex '.*\.[0-9]+' \) -printf '%s\n' | awk '{s+=$1} END{print s+0}'`,
    cleanCmd: String.raw`find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -regex '.*\.[0-9]+' \) -delete`,
  },
  {
    id: 'old-packages',
    label: 'Ненужные пакеты',
    hint: 'apt autoremove --purge: старые ядра и осиротевшие зависимости.',
    sizeCmd: `apt-get -s autoremove 2>/dev/null | grep -o '[0-9.]* [kMG]B disk space will be freed' | head -1`,
    cleanCmd: 'apt-get autoremove --purge -y',
  },
  {
    id: 'root-cache',
    label: 'Кэш ~/.cache',
    hint: 'Кэш инструментов root (npm, claude и т.п.). По определению одноразовый.',
    sizeCmd: 'du -sb /root/.cache',
    cleanCmd: 'rm -rf /root/.cache/*',
  },
  {
    id: 'tmp',
    label: 'Старое в /tmp',
    hint: 'Файлы в /tmp старше 7 дней. Свежие не трогаются, чтобы не выбить работающие процессы.',
    sizeCmd: String.raw`find /tmp -mindepth 1 -mtime +7 -printf '%s\n' | awk '{s+=$1} END{print s+0}'`,
    cleanCmd: 'find /tmp -mindepth 1 -mtime +7 -delete',
  },
];

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

// Первое число с необязательной единицей. Команды возвращают кто во что горазд:
// «12345\t/var/cache/apt» (du -sb), «1.87GB» (docker), «331.1MB (26%)»,
// «...take up 185.4M in the file system.» — все они сводятся сюда.
// ponytail: GB считаем как 1024^3, хотя docker имеет в виду 10^9 — на глазок
// в интерфейсе разница несущественна.
// (?![a-z]) обязателен: без него «13400\ttotal» (хвост du -c) читался как
// 13400 ТБ — «t» от «total» принималась за единицу, и логи контейнеров
// показывались как 12 ПБ.
export function toBytes(raw: string): number {
  const m = /(\d+(?:[.,]\d+)?)\s*([kmgt]i?b?|b)?(?![a-z])/i.exec(raw);
  if (!m) return 0;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * (UNITS[(m[2] || '').toLowerCase()] ?? 1));
}

export interface DiskUsage {
  total: number;
  used: number;
  avail: number;
}

// cleanCmd уезжает на фронт намеренно: админ должен видеть, что именно
// выполнится под sudo, до нажатия. Команды здесь — статические константы,
// секретов и пользовательского ввода в них нет.
export interface DiskReportItem extends Omit<DiskItem, 'sizeCmd'> {
  bytes: number;
}

export interface DiskReport {
  usage: DiskUsage;
  items: DiskReportItem[];
}

// Все размеры за один SSH-заход: девять отдельных exec'ов по 100+ мс каждый —
// это секунда ожидания на ровном месте. Каждая строка ответа — «id<TAB>размер».
function sizeScript(): string {
  const lines = DISK_ITEMS.map(item =>
    `printf '%s\\t' ${sh(item.id)}; { ${item.sizeCmd}; } 2>/dev/null | tr '\\n' ' '; echo`,
  );
  lines.unshift(`printf 'df\\t'; df -B1 --output=size,used,avail / | tail -1`);
  return lines.join('\n');
}

export function parseReport(stdout: string): DiskReport {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) values.set(line.slice(0, tab), line.slice(tab + 1));
  }

  const df = (values.get('df') || '').trim().split(/\s+/);
  const usage: DiskUsage = {
    total: Number(df[0]) || 0,
    used: Number(df[1]) || 0,
    avail: Number(df[2]) || 0,
  };

  const items = DISK_ITEMS.map(({ sizeCmd: _s, ...rest }) => ({
    ...rest,
    bytes: toBytes(values.get(rest.id) || ''),
  }));

  return { usage, items };
}

export async function collectDisk(server: Server): Promise<DiskReport> {
  const res = await execSudo(server, sizeScript());
  return parseReport(res.stdout);
}

export interface CleanResult extends DiskReport {
  output: string;
}

export async function cleanDiskItem(server: Server, itemId: string): Promise<CleanResult> {
  const item = DISK_ITEMS.find(i => i.id === itemId);
  if (!item) throw new UserError(`Unknown disk item: ${itemId}`);

  const res = await execSudo(server, item.cleanCmd);
  // Код возврата не проверяем: truncate/find/rm по пустому списку возвращают
  // ненулевой код, хотя чистить было просто нечего. Итог виден по новому размеру.
  const report = await collectDisk(server);
  return { ...report, output: [res.stdout, res.stderr].filter(Boolean).join('\n').slice(-4000) };
}
