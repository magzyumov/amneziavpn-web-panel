// Пара полей «срок действия» и «суточный лимит» — общая для создания клиента и
// правки лимитов существующего. Оба поля числовые, 0 = без ограничения.

interface Props {
  expiresInDays: string;
  dailyLimitMb: string;
  onExpiryChange: (v: string) => void;
  onLimitChange: (v: string) => void;
}

export default function LimitFields({ expiresInDays, dailyLimitMb, onExpiryChange, onLimitChange }: Props) {
  const days = Number(expiresInDays) || 0;
  const mb = Number(dailyLimitMb) || 0;

  return (
    <>
      <div className="input-group">
        <label className="input-label">Срок действия, дней (0 — бессрочно)</label>
        <input className="input input-mono" type="number" min={0} max={3650}
          value={expiresInDays} onChange={e => onExpiryChange(e.target.value)} />
        <div className="text-muted mono" style={{ fontSize: 10, marginTop: 4 }}>
          {days > 0
            ? `// по истечении клиент будет удалён, доступ отзовётся на сервере`
            : '// клиент будет действовать, пока его не удалят вручную'}
        </div>
      </div>

      <div className="input-group">
        <label className="input-label">Суточный лимит трафика, МБ (0 — без лимита)</label>
        <input className="input input-mono" type="number" min={0}
          value={dailyLimitMb} onChange={e => onLimitChange(e.target.value)} />
        <div className="text-muted mono" style={{ fontSize: 10, marginTop: 4 }}>
          {mb > 0
            ? '// при исчерпании доступ приостанавливается до начала новых суток; конфиг остаётся рабочим'
            : '// трафик не ограничен'}
        </div>
      </div>
    </>
  );
}
