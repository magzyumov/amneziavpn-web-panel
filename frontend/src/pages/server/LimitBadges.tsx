import type { ClientLimits } from '../../api';
import { formatBytes } from './format';

// Срок действия и суточный трафик одной строкой. Один компонент на обе стороны
// панели: администратор в карточке протокола и владелец на «Моих клиентах»
// должны видеть одно и то же — расхождение здесь читалось бы как баг доступа.

export function formatExpiry(expiresAt: number | null): { text: string; soon: boolean } | null {
  if (!expiresAt) return null;
  const left = expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return { text: 'истёк', soon: true };
  const hours = Math.floor(left / 3600);
  if (hours < 24) return { text: `${hours || 1} ч`, soon: true };
  const days = Math.floor(hours / 24);
  return { text: `${days} дн.`, soon: days <= 1 };
}

interface Props extends ClientLimits {
  /** Компактный режим для плотных таблиц (карточка протокола). */
  compact?: boolean;
}

export default function LimitBadges({ expires_at, daily_limit_bytes, suspended_at, used_today, compact }: Props) {
  const expiry = formatExpiry(expires_at);
  const hasTraffic = daily_limit_bytes > 0;
  if (!expiry && !hasTraffic && !suspended_at) return null;

  const fontSize = compact ? 10 : 11;
  const share = hasTraffic ? Math.min(1, used_today / daily_limit_bytes) : 0;

  return (
    <span className="mono" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize, flexWrap: 'wrap' }}>
      {suspended_at && (
        <span
          className="badge badge-stopped"
          title="Суточный лимит трафика исчерпан. Доступ вернётся автоматически с началом новых суток — конфиг менять не нужно."
          style={{ cursor: 'help' }}
        >⏸ лимит</span>
      )}
      {expiry && (
        <span
          style={{ color: expiry.soon ? 'var(--danger, #e5534b)' : 'var(--text-muted)' }}
          title={`Клиент будет удалён ${new Date(expires_at! * 1000).toLocaleString('ru-RU')}`}
        >⏳ {expiry.text}</span>
      )}
      {hasTraffic && (
        <span
          style={{ color: share >= 1 ? 'var(--danger, #e5534b)' : 'var(--text-muted)' }}
          title="Трафик за текущие сутки и суточный лимит"
        >↕ {formatBytes(used_today)} / {formatBytes(daily_limit_bytes)}</span>
      )}
    </span>
  );
}
