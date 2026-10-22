import { memo, useMemo, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import type { ChartReading } from './api';

const WIDTH = 900, HEIGHT = 220, LEFT = 48, RIGHT = 18, TOP = 20, BOTTOM = 35;
function timeLabel(timestamp: number, hours: number | null, showDate: boolean) {
  return new Date(timestamp).toLocaleString('zh-CN', hours !== null && hours <= 24
    ? { ...(showDate ? { month: '2-digit', day: '2-digit' } as const : {}), hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).replaceAll('/', '-');
}
function BatteryChart({ readings, hours, threshold }: {
  readings: ChartReading[]; hours: number | null; threshold: number;
}) {
  const [hover, setHover] = useState<{ readings: ChartReading[]; hours: number | null; index: number } | null>(null);
  const data = useMemo(() => readings.every((point, index) => index === 0 || point.timestamp >= readings[index - 1].timestamp)
    ? readings : [...readings].sort((a, b) => a.timestamp - b.timestamp), [readings]);
  const segments = useMemo(() => {
    // Gaps are computed from raw samples before downsampling; selected point
    // distances alone cannot distinguish a missing sample from a removed point.
    const result: ChartReading[][] = [];
    for (const point of data) {
      const segment = result.at(-1);
      const previous = segment?.at(-1);
      if (!previous || point.break_before || point.device_id !== previous.device_id) result.push([point]);
      else segment!.push(point);
    }
    return result;
  }, [data]);
  const geometry = useMemo(() => {
    // The time window advances with the data/range, never with tooltip updates.
    const end = Math.max(Date.now(), data.at(-1)?.timestamp ?? 0);
    const start = hours === null ? Math.min(data[0]?.timestamp ?? end - 86400000, end - 3600000) : end - hours * 3600000;
    const minimum = data.reduce((value, point) => Math.min(value, point.percent), 100);
    const lower = minimum >= 60 ? 50 : 0;
    const x = (timestamp: number) => LEFT + (timestamp - start) / (end - start) * (WIDTH - LEFT - RIGHT);
    const y = (percent: number) => TOP + (100 - percent) / (100 - lower) * (HEIGHT - TOP - BOTTOM);
    const paths = segments.map(segment => {
      const line = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.timestamp).toFixed(2)},${y(point.percent).toFixed(2)}`).join(' ');
      const stride = Math.max(1, Math.ceil(segment.length / 23));
      return {
        line,
        fill: `${line} L${x(segment.at(-1)!.timestamp)},${y(lower)} L${x(segment[0].timestamp)},${y(lower)} Z`,
        dots: segment.filter((_, i) => i % stride === 0).map(point => ({ x: x(point.timestamp), y: y(point.percent) })),
      };
    });
    const timeTicks = Array.from({ length: 7 }, (_, index) => {
      const timestamp = start + (end - start) * index / 6;
      const previous = start + (end - start) * (index - 1) / 6;
      const showDate = index === 0 || new Date(timestamp).toDateString() !== new Date(previous).toDateString();
      return { x: x(timestamp), label: timeLabel(timestamp, hours, showDate) };
    });
    return { start, end, lower, x, y, paths, timeTicks };
  }, [data, hours, segments]);
  const { start, end, lower, x, y } = geometry;
  const hoverIndex = hover?.readings === readings && hover.hours === hours && data.length
    ? Math.max(0, Math.min(data.length - 1, hover.index)) : null;
  const selected = hoverIndex === null ? null : data[hoverIndex];
  const newest = data.at(-1);
  const first = data[0];
  const chart = useMemo(() => <>
    <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#78b88e" stopOpacity=".23" /><stop offset="100%" stopColor="#78b88e" stopOpacity=".07" /></linearGradient></defs>
    {Array.from({ length: 6 }, (_, i) => lower + i * (100 - lower) / 5).map(percent => <g key={percent}><line x1={LEFT} y1={y(percent)} x2={WIDTH - RIGHT} y2={y(percent)} stroke="#e5e9e8" /><text x={LEFT - 12} y={y(percent) + 5} textAnchor="end" className="axis-label">{percent}%</text></g>)}
    {geometry.timeTicks.map((tick, index) => <g key={index}><line x1={tick.x} x2={tick.x} y1={TOP} y2={y(lower) + 6} stroke="#e8ebea" /><text x={tick.x} y={HEIGHT - 6} textAnchor={index === 0 ? 'start' : index === 6 ? 'end' : 'middle'} className="axis-label">{tick.label}</text></g>)}
    {threshold >= lower && <g><line x1={LEFT} y1={y(threshold)} x2={WIDTH - RIGHT} y2={y(threshold)} stroke="#c5ae85" strokeDasharray="4 5" /><text x={WIDTH - RIGHT - 3} y={y(threshold) - 6} textAnchor="end" className="threshold-label">提醒线 {threshold}%</text></g>}
    {geometry.paths.map((path, index) => <g key={index}><path d={path.fill} fill="url(#chart-fill)" /><path d={path.line} fill="none" stroke="#478c57" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />{path.dots.map((dot, i) => <circle key={i} cx={dot.x} cy={dot.y} r="2.8" fill="#438652" />)}</g>)}
    {first && newest && x(newest.timestamp) - x(first.timestamp) > 80 && <g><circle cx={x(first.timestamp)} cy={y(first.percent)} r="4.8" fill="#408650" /><text x={x(first.timestamp) + 5} y={y(first.percent) - 13} textAnchor="start" className="point-label">{first.percent}%</text></g>}
    {newest && <g><circle cx={x(newest.timestamp)} cy={y(newest.percent)} r="5" fill="#408650" /><text x={x(newest.timestamp) - 1} y={y(newest.percent) - 13} textAnchor="end" className="point-label">{newest.percent}%</text></g>}
  </>, [geometry, threshold, first, newest, lower, x, y]);
  if (!data.length) return <div className="chart-empty"><span className="empty-symbol"><ChartNoAxesCombined size={32} strokeWidth={1.5} /></span><strong>等待第一条电量记录</strong><p>连接妙控板后，电量变化会自动绘制在这里</p></div>;
  function nearest(fraction: number) {
    const target = start + fraction * (end - start);
    let lo = 0, hi = data.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].timestamp < target) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(data[lo - 1].timestamp - target) < Math.abs(data[lo].timestamp - target)) lo--;
    setHover(current => current?.readings === readings && current.hours === hours && current.index === lo ? current : { readings, hours, index: lo });
  }
  return <div className="chart-wrap">
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`电量趋势，共${data.length}个显示点，最新${newest?.percent}%`}
      tabIndex={0} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); nearest(Math.max(0, Math.min(1, ((event.clientX - rect.left) / rect.width * WIDTH - LEFT) / (WIDTH - LEFT - RIGHT)))); }}
      onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setHover({ readings, hours, index: Math.max(0, Math.min(data.length - 1, (hoverIndex ?? data.length - 1) + (event.key === 'ArrowRight' ? 1 : -1))) }); } }}>
      {chart}
      {selected && <g><line x1={x(selected.timestamp)} x2={x(selected.timestamp)} y1={TOP} y2={y(lower)} stroke="#9ab3a1" strokeDasharray="3 3" /><circle cx={x(selected.timestamp)} cy={y(selected.percent)} r="5" fill="#235a3f" stroke="white" strokeWidth="2" /></g>}
    </svg>
    {selected && <div className="chart-tooltip" style={{ left: `${Math.max(14, Math.min(84, x(selected.timestamp) / WIDTH * 100))}%` }}><span>{new Date(selected.timestamp).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><strong>{selected.percent}%</strong></div>}
    <span className="sr-only">曲线可用左右方向键查看显示的采样点；完整记录可导出 CSV。</span>
  </div>;
}
export default memo(BatteryChart);
