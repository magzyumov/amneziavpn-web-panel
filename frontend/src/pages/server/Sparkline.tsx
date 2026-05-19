// Минималистичный SVG-sparkline на две серии (rx/tx).
// Без зависимостей: считаем bbox по max(value), рисуем polyline'ы.

interface Point { ts: number; rxRate: number; txRate: number }

interface Props {
  data: Point[];
  width?: number;
  height?: number;
}

export default function Sparkline({ data, width = 460, height = 100 }: Props) {
  if (data.length < 2) {
    return (
      <div className="text-muted mono" style={{
        fontSize: 12, height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px dashed var(--border)', borderRadius: 6,
      }}>
        Недостаточно данных для графика — подождите 2–3 минуты после первого подключения
      </div>
    );
  }

  const max = Math.max(1, ...data.map(d => Math.max(d.rxRate, d.txRate)));
  const tMin = data[0].ts;
  const tMax = data[data.length - 1].ts;
  const tSpan = Math.max(1, tMax - tMin);

  const PAD = 4;
  const W = width  - PAD * 2;
  const H = height - PAD * 2;

  const xy = (ts: number, v: number) => ({
    x: PAD + ((ts - tMin) / tSpan) * W,
    y: PAD + H - (v / max) * H,
  });

  const path = (key: 'rxRate' | 'txRate') =>
    data.map(d => { const p = xy(d.ts, d[key]); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ');

  return (
    <svg width={width} height={height} style={{ background: 'var(--surface2)', borderRadius: 6, display: 'block' }}>
      {/* Сетка: 3 горизонтальные линии */}
      {[0.25, 0.5, 0.75].map(p => (
        <line key={p} x1={PAD} x2={width - PAD} y1={PAD + H * p} y2={PAD + H * p}
          stroke="var(--border)" strokeDasharray="2,3" strokeWidth={0.5} />
      ))}
      <polyline points={path('rxRate')} fill="none" stroke="#3fb950" strokeWidth={1.5} />
      <polyline points={path('txRate')} fill="none" stroke="#f0883e" strokeWidth={1.5} />
    </svg>
  );
}
