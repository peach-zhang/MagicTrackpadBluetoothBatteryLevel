import { useMemo, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import type { Reading } from './api';

const WIDTH = 900, HEIGHT = 220, LEFT = 48, RIGHT = 18, TOP = 20, BOTTOM = 35;
function timeLabel(timestamp: number, hours: number | null, showDate: boolean) {
  return new Date(timestamp).toLocaleString('zh-CN', hours !== null && hours <= 24
    ? { ...(showDate ? { month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).replaceAll('/', '-');
}
export default function BatteryChart({ readings, hours, threshold, pollSeconds }: {
  readings: Reading[]; hours: number | null; threshold: number; pollSeconds: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => [...readings].sort((a, b) => a.timestamp - b.timestamp), [readings]);
  const end = Math.max(Date.now(), data.at(-1)?.timestamp ?? 0);
  const start = hours === null ? Math.min(data[0]?.timestamp ?? end - 86400000, end - 3600000) : end - hours * 3600000;
  const minimum = data.reduce((value, point) => Math.min(value, point.percent), 100);
  const lower = minimum >= 60 ? 50 : 0;
  const x = (timestamp: number) => LEFT + (timestamp - start) / (end - start) * (WIDTH - LEFT - RIGHT);
  const y = (percent: number) => TOP + (100 - percent) / (100 - lower) * (HEIGHT - TOP - BOTTOM);
  const intervals = data.slice(1).map((point, i) => point.timestamp - data[i].timestamp).filter(value => value > 0).sort((a, b) => a - b);
  const typicalInterval = intervals.length >= 2 ? intervals[Math.floor(intervals.length / 2)] : pollSeconds * 1000;
  const gapLimit = Math.max(pollSeconds * 4000, typicalInterval * 4);
  const segments: Reading[][] = [];
  for (const point of data) {
    const segment = segments.at(-1);
    if (!segment || point.device_id !== segment.at(-1)!.device_id || point.timestamp - segment.at(-1)!.timestamp > gapLimit) segments.push([point]);
    else segment.push(point);
  }
  const selected = hover === null ? null : data[hover];
  const newest = data.at(-1);
  const first = data[0];
  if (!data.length) return <div className="chart-empty"><span className="empty-symbol"><ChartNoAxesCombined size={32} strokeWidth={1.5} /></span><strong>等待第一条电量记录</strong><p>连接妙控板后，电量变化会自动绘制在这里</p></div>;
  function nearest(fraction: number) {
    const target = start + fraction * (end - start);
    let lo = 0, hi = data.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].timestamp < target) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(data[lo - 1].timestamp - target) < Math.abs(data[lo].timestamp - target)) lo--;
    setHover(lo);
  }
  return <div className="chart-wrap">
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`电量趋势，共${data.length}条记录，最新${newest?.percent}%`}
      tabIndex={0} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); nearest(Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * WIDTH - LEFT) / (WIDTH - LEFT - RIGHT)))); }}
      onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setHover(Math.max(0, Math.min(data.length - 1, (hover ?? data.length - 1) + (event.key === 'ArrowRight' ? 1 : -1)))); } }}>
      <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#78b88e" stopOpacity=".23" /><stop offset="100%" stopColor="#78b88e" stopOpacity=".07" /></linearGradient></defs>
      {Array.from({ length: 6 }, (_, i) => lower + i * (100 - lower) / 5).map(percent => <g key={percent}><line x1={LEFT} y1={y(percent)} x2={WIDTH - RIGHT} y2={y(percent)} stroke="#e5e9e8" /><text x={LEFT - 12} y={y(percent) + 5} textAnchor="end" className="axis-label">{percent}%</text></g>)}
      {Array.from({ length: 7 }, (_, index) => {
        const timestamp = start + (end - start) * index / 6;
        const previous = start + (end - start) * (index - 1) / 6;
        const showDate = index === 0 || new Date(timestamp).toDateString() !== new Date(previous).toDateString();
        return <g key={index}><line x1={x(timestamp)} x2={x(timestamp)} y1={TOP} y2={y(lower) + 6} stroke="#e8ebea" /><text x={x(timestamp)} y={HEIGHT - 6} textAnchor={index === 0 ? 'start' : index === 6 ? 'end' : 'middle'} className="axis-label">{timeLabel(timestamp, hours, showDate)}</text></g>;
      })}
      {threshold >= lower && <g><line x1={LEFT} y1={y(threshold)} x2={WIDTH - RIGHT} y2={y(threshold)} stroke="#c5ae85" strokeDasharray="4 5" /><text x={WIDTH - RIGHT - 3} y={y(threshold) - 6} textAnchor="end" className="threshold-label">提醒线 {threshold}%</text></g>}
      {segments.map((segment, index) => {
        const line = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.timestamp).toFixed(2)},${y(point.percent).toFixed(2)}`).join(' ');
        const stride = Math.max(1, Math.ceil(segment.length / 23));
        return <g key={index}><path d={`${line} L${x(segment.at(-1)!.timestamp)},${y(lower)} L${x(segment[0].timestamp)},${y(lower)} Z`} fill="url(#chart-fill)" /><path d={line} fill="none" stroke="#478c57" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />{segment.filter((_, i) => i % stride === 0).map(point => <circle key={point.timestamp} cx={x(point.timestamp)} cy={y(point.percent)} r="2.8" fill="#438652" />)}</g>;
      })}
      {first && newest && x(newest.timestamp) - x(first.timestamp) > 80 && <g><circle cx={x(first.timestamp)} cy={y(first.percent)} r="4.8" fill="#408650" /><text x={x(first.timestamp) + 5} y={y(first.percent) - 13} textAnchor="start" className="point-label">{first.percent}%</text></g>}
      {newest && <g><circle cx={x(newest.timestamp)} cy={y(newest.percent)} r="5" fill="#408650" /><text x={x(newest.timestamp) - 1} y={y(newest.percent) - 13} textAnchor="end" className="point-label">{newest.percent}%</text></g>}
      {selected && <g><line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={TOP} y2={y(lower)} stroke="#9ab3a1" strokeDasharray="3 3" /><circle cx={x(selected.timestamp)} cy={y(selected.percent)} r="5" fill="#235a3f" stroke="white" strokeWidth="2" /></g>}
    </svg>
    {selected && <div className="chart-tooltip" style={{ left: `${Math.max(14, Math.min(84, x(selected.timestamp) / WIDTH * 100))}%` }}><span>{new Date(selected.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><strong>{selected.percent}%</strong></div>}
    <span className="sr-only">曲线可用左右方向键查看每次采样。</span>
  </div>;
}
