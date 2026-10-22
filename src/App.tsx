import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowDown, ArrowDownToLine, ArrowUp, Battery, BatteryLow, Bell, CalendarDays,
  ChartNoAxesColumnIncreasing, Check, CheckCheck, ChevronRight, CircleHelp, Clock3,
  House, Info, LoaderCircle, Minus, Monitor, MousePointer2, Power, Radio, RefreshCw,
  Settings as SettingsIcon, ShieldCheck, SlidersHorizontal, Square, TriangleAlert, X,
} from 'lucide-react';
import * as api from './api';
import type { Dashboard, HistoryView, Settings } from './api';
import BatteryChart from './BatteryChart';

type Page = 'overview' | 'history' | 'settings';
type Notice = { text: string; error: boolean };
const ranges = [{ label: '24小时', hours: 24 }, { label: '7天', hours: 168 }, { label: '30天', hours: 720 }, { label: '全部', hours: null }];
const dateText = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const shortDate = (timestamp: number) => {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === new Date().toDateString() ? `今天 ${time}` : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className="toggle" type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}><span /></button>;
}
function SettingRow({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><span className="setting-icon">{icon}</span><div className="setting-copy"><strong>{title}</strong><p>{description}</p></div><div className="setting-control">{children}</div></div>;
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [data, setData] = useState<Dashboard>({ current: null, settings: api.defaults, last_error: null, warnings: [], history_count: 0, monitoring: false, stats: { first_recorded_at: null, today_consumption: null, yesterday_consumption: null } });
  const [draft, setDraft] = useState<Settings>(api.defaults);
  const dirty = useRef(false);
  const [isDirty, setDirty] = useState(false);
  const [range, setRange] = useState<number | null>(24);
  const [history, setHistory] = useState<HistoryView>({ points: [], records: [], total: 0 });
  const [active, setActive] = useState(!api.desktop);
  const activeRef = useRef(!api.desktop);
  const [syncKey, setSyncKey] = useState(0);
  const [now, setNow] = useState(Date.now());
  const snapshotVersion = useRef(0);
  const draftVersion = useRef(0);
  const savingRef = useRef(false);
  const readings = history.points;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, error = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 9000 : 5000);
  }, []);
  const acceptData = useCallback((next: Dashboard) => {
    snapshotVersion.current++;
    setData(next);
    setNow(Date.now());
    if (!dirty.current) setDraft(next.settings);
    setLoading(false);
  }, []);
  useEffect(() => {
    let disposed = false;
    const unsubscribers: (() => void)[] = [];
    let visibilityVersion = 0;
    const subscribe = async (pending: Promise<() => void>) => {
      const unsubscribe = await pending;
      if (disposed) unsubscribe(); else unsubscribers.push(unsubscribe);
    };
    const load = async () => {
      const version = ++snapshotVersion.current;
      try {
        const value = await api.dashboard();
        if (!disposed && activeRef.current && version === snapshotVersion.current) acceptData(value);
      } catch (error) {
        if (!disposed && activeRef.current && version === snapshotVersion.current) { setLoading(false); notify(errorText(error), true); }
      }
    };
    const updateVisibility = async (resync = false) => {
      const version = ++visibilityVersion;
      try {
        const visible = document.visibilityState !== 'hidden' && (!api.desktop || (await getCurrentWindow().isVisible() && !await getCurrentWindow().isMinimized()));
        if (disposed || version !== visibilityVersion) return;
        const resumed = visible && !activeRef.current;
        activeRef.current = visible;
        setActive(visible);
        if (!visible) snapshotVersion.current++;
        if (visible && (resumed || resync)) { setSyncKey(key => key + 1); void load(); }
      } catch (error) { if (!disposed && version === visibilityVersion) notify(errorText(error), true); }
    };
    const onVisibility = () => void updateVisibility(true);
    document.addEventListener('visibilitychange', onVisibility);
    const start = async () => {
      try {
        if (api.desktop) {
          await Promise.all([
            subscribe(listen<Dashboard>('battery-updated', e => { if (!disposed && activeRef.current) acceptData(e.payload); })),
            subscribe(listen<string>('battery-error', e => { if (!disposed && activeRef.current) notify(e.payload, true); })),
            subscribe(listen<boolean>('window-visibility', e => {
              if (disposed) return;
              if (e.payload) void updateVisibility(true);
              else { visibilityVersion++; snapshotVersion.current++; activeRef.current = false; setActive(false); }
            })),
            subscribe(getCurrentWindow().onFocusChanged(e => void updateVisibility(e.payload))),
            subscribe(getCurrentWindow().onResized(() => void updateVisibility())),
          ]);
        }
      } catch (error) { if (!disposed) notify(errorText(error), true); }
      if (!disposed) await updateVisibility(true);
    };
    void start();
    return () => { disposed = true; document.removeEventListener('visibilitychange', onVisibility); unsubscribers.forEach(fn => fn()); };
  }, [acceptData, notify]);
  const showsHistory = page !== 'settings';
  useEffect(() => {
    if (!active || !showsHistory) return;
    let disposed = false;
    api.history(range).then(value => { if (!disposed && activeRef.current) setHistory(value); }).catch(error => { if (!disposed && activeRef.current) notify(errorText(error), true); });
    return () => { disposed = true; };
  }, [active, showsHistory, range, data.current?.timestamp, data.history_count, syncKey, notify]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  const current = data.current;
  const recent = current !== null && now - current.timestamp <= Math.max(data.settings.poll_seconds * 3, 180) * 1000;
  const connected = recent && !data.last_error && data.monitoring;
  const low = current !== null && current.percent < data.settings.threshold;
  const title = page === 'overview' ? '电量总览' : page === 'history' ? '电量历史' : '提醒设置';
  const firstRecorded = data.stats.first_recorded_at;
  const recordedDays = firstRecorded === null ? '—' : Date.now() - firstRecorded < 86400000 ? '＜1' : Math.floor((Date.now() - firstRecorded) / 86400000);
  const todayConsumption = data.stats.today_consumption;
  const yesterdayConsumption = data.stats.yesterday_consumption;
  const consumptionDifference = todayConsumption !== null && yesterdayConsumption !== null ? todayConsumption - yesterdayConsumption : null;

  async function refreshNow() {
    if (refreshing) return;
    setRefreshing(true);
    try { const next = await api.refresh(); acceptData(next); if (next.last_error) notify(next.last_error, true); else if (next.warnings.length) notify(`电量已读取；${next.warnings.join('；')}`, true); else notify('电量已更新'); }
    catch (error) { notify(errorText(error), true); }
    finally { setRefreshing(false); }
  }
  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    draftVersion.current++;
    setDraft(old => ({ ...old, [key]: value })); dirty.current = true; setDirty(true);
  }
  async function persist() {
    if (savingRef.current) return;
    savingRef.current = true;
    const version = draftVersion.current;
    setSaving(true);
    try {
      const next = await api.saveSettings(draft);
      snapshotVersion.current++;
      setData(old => ({ ...old, settings: next }));
      if (version === draftVersion.current) {
        setDraft(next); dirty.current = false; setDirty(false);
        notify('设置已保存，下次采样将使用新设置');
      } else notify('设置已保存，后续修改尚未保存');
    }
    catch (error) { notify(errorText(error), true); }
    finally { savingRef.current = false; setSaving(false); }
  }
  async function exportCsv() {
    setExporting(true);
    try { const path = await api.exportHistory(); if (path) notify(`已导出至 ${path}`); }
    catch (error) { notify(errorText(error), true); }
    finally { setExporting(false); }
  }
  async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close') {
    if (!api.desktop) return;
    try { await getCurrentWindow()[action](); } catch (error) { notify(errorText(error), true); }
  }
  const rangeControl = <div className="segmented" aria-label="历史时间范围">{ranges.filter(r => page === 'history' || r.hours !== null).map(r => <button key={String(r.hours)} aria-label={r.hours === 24 ? '24 小时' : r.hours === 168 ? '7 天' : r.hours === 720 ? '30 天' : '全部'} className={range === r.hours ? 'active' : ''} onClick={() => setRange(r.hours)} aria-pressed={range === r.hours}>{r.label}</button>)}</div>;

  return <div className="app-shell">
    <header className="titlebar" data-tauri-drag-region onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) void windowAction('toggleMaximize'); }}>
      <div className="window-brand" aria-label="妙控板电量管家">
        <svg viewBox="0 0 42 30" aria-hidden="true"><rect x="3" y="3" width="35" height="23" rx="3" /><path d="M4 22.5h33" /></svg>
        <strong>妙控板电量管家</strong><span>TRACKPAD</span>
      </div>
      <div className="window-controls">
        <button aria-label="最小化" disabled={!api.desktop} onClick={() => void windowAction('minimize')}><Minus size={17} strokeWidth={1.3} /></button>
        <button aria-label="最大化或还原" disabled={!api.desktop} onClick={() => void windowAction('toggleMaximize')}><Square size={13} strokeWidth={1.3} /></button>
        <button className="window-close" aria-label="关闭窗口" disabled={!api.desktop} onClick={() => void windowAction('close')}><X size={19} strokeWidth={1.3} /></button>
      </div>
    </header>
    <div className="window-body">
      <aside className="sidebar" inert={showHelp}>
        <nav aria-label="主导航">{([{ id: 'overview', text: '总览', label: '电量总览', icon: House }, { id: 'history', text: '电量历史', label: '电量历史', icon: ChartNoAxesColumnIncreasing }, { id: 'settings', text: '设置', label: '偏好设置', icon: SettingsIcon }] as const).map(item => <button key={item.id} aria-label={item.label} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => { setPage(item.id); if (item.id === 'overview' && range === null) setRange(24); }} aria-current={page === item.id ? 'page' : undefined}><item.icon size={26} strokeWidth={1.6} /><span>{item.text}</span>{page === item.id && <span className="nav-indicator" />}</button>)}</nav>
      </aside>
      <main className="main-panel" inert={showHelp}>
        <header className="page-heading">
          <div className="heading-title"><h1>{title}</h1>{page === 'overview' && <span className={`connection-status ${connected ? 'online' : ''}`}><span />{loading ? '正在连接' : connected ? '已连接' : current ? '显示上次记录' : '等待设备连接'}</span>}</div>
          {page !== 'settings' && <button aria-label="立即刷新" className="button refresh-button" onClick={() => void refreshNow()} disabled={refreshing || loading}><RefreshCw size={21} className={refreshing ? 'spinning' : ''} />{refreshing ? '读取中' : '刷新'}</button>}
        </header>
        {!api.desktop && <div className="preview-banner"><Info size={15} /><span>{api.demo ? '演示模式 · 当前电量与历史记录均为示意数据' : '浏览器预览 · 启动桌面应用后即可读取设备、记录电量并使用托盘'}</span></div>}
        {data.warnings.length > 0 && <div className="device-warning" role="status"><TriangleAlert size={20} /><div><strong>部分功能需要处理</strong>{data.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
        {page === 'overview' && <div className="page-content overview-page" key="overview">
          <section className={`hero-card ${low ? 'is-low' : ''}`} aria-label="当前电量">
            <div className="hero-copy">
              <h2>{current?.device_name || 'Magic Trackpad'}</h2>
              <div className="battery-number">{loading ? '···' : current ? current.percent : '—'}<span>%</span></div>
              <span className="battery-caption">{connected ? '当前电量' : current ? '上次记录电量' : '连接后自动获取电量'}</span>
              <div className="battery-meter"><span style={{ width: `${current?.percent ?? 0}%` }} /></div>
              <div className="last-updated">{current ? `上次检查：${shortDate(current.timestamp)}` : '首次读数到达后开始记录'}</div>
            </div>
            <div className="hero-art"><img src="/trackpad-prototype.png" alt="银白色 Magic Trackpad" draggable="false" /></div>
          </section>
          {data.last_error && <div className="device-warning" role="status"><TriangleAlert size={20} /><div><strong>暂时无法更新电量</strong><p>{data.last_error}</p></div><button className="text-button" onClick={() => void refreshNow()} disabled={refreshing}>重试</button></div>}
          <section className="surface chart-card">
            <div className="section-header"><div className="chart-heading"><h2>电量趋势</h2><p>每{data.settings.poll_seconds >= 60 ? `${data.settings.poll_seconds / 60}分钟` : `${data.settings.poll_seconds}秒`}自动记录</p></div>{rangeControl}</div>
            <BatteryChart readings={readings} hours={range} threshold={data.settings.threshold} />
          </section>
          <div className="stats-grid">
            <section className="surface stat-card"><span className="stat-icon"><ChartNoAxesColumnIncreasing size={31} strokeWidth={2.4} /></span><div><p>今日消耗</p><strong>{todayConsumption === null ? '—' : todayConsumption}<small>%</small></strong><span className={consumptionDifference !== null && consumptionDifference > 0 ? 'comparison higher' : 'comparison'}>{consumptionDifference !== null ? <>{consumptionDifference > 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}{consumptionDifference === 0 ? '相比昨日基本持平' : `比昨日${consumptionDifference > 0 ? '多' : '少'}消耗 ${Math.abs(consumptionDifference)}%`}</> : '至少两条记录后显示每日变化'}</span></div></section>
            <section className="surface stat-card"><span className="stat-icon"><CalendarDays size={29} strokeWidth={1.8} /></span><div><p>已记录</p><strong>{recordedDays}<small>天</small></strong><span>{firstRecorded ? `自 ${new Date(firstRecorded).toLocaleDateString('sv-SE')} 起` : '连接妙控板后开始记录'}</span></div></section>
          </div>
        </div>}
        {page === 'history' && <div className="page-content" key="history">
          <section className="surface chart-card history-chart"><div className="section-header"><div className="chart-heading"><h2>电量趋势</h2><p>查看使用与充电的变化</p></div>{rangeControl}</div><BatteryChart readings={readings} hours={range} threshold={data.settings.threshold} /></section>
          <section className="surface records-card"><div className="section-header"><div><h2>采样记录</h2><p>{history.total > 100 ? `共 ${history.total} 条，展示最近 100 条；导出包含全部历史` : `共 ${history.total} 条真实采样记录`}</p></div><button className="button" onClick={() => void exportCsv()} disabled={exporting || !data.history_count}><ArrowDownToLine size={17} />{exporting ? '导出中' : '导出全部 CSV'}</button></div><div className="table-scroll"><table><thead><tr><th>采样时间</th><th>设备</th><th>电量</th><th>读取来源</th></tr></thead><tbody>{[...history.records].reverse().map((reading, index) => <tr key={`${reading.timestamp}-${index}`}><td className="tabular">{dateText(reading.timestamp)}</td><td><MousePointer2 size={15} />{reading.device_name}</td><td><span className={`table-percent ${reading.percent < data.settings.threshold ? 'low' : ''}`}><Battery size={17} />{reading.percent}%</span></td><td className="muted">{reading.source}</td></tr>)}</tbody></table>{!history.total && <div className="table-empty">这个时间范围内还没有记录</div>}</div></section>
        </div>}
        {page === 'settings' && <div className="page-content settings-page" key="settings">
          <section className="surface settings-section">
            <div className="settings-section-title"><Bell size={22} /><h2>电量与提醒</h2></div>
            <SettingRow icon={<Bell size={23} />} title="低电量提醒" description="电量低于设定值时发送桌面通知"><Toggle checked={draft.notifications_enabled} onChange={value => change('notifications_enabled', value)} label="低电量提醒" /></SettingRow>
            <SettingRow icon={<BatteryLow size={23} />} title="提醒阈值" description="低于这个百分比时提醒充电"><div className="number-control"><input aria-label="提醒阈值" type="number" min="1" max="100" value={draft.threshold} onChange={event => change('threshold', Math.max(1, Math.min(100, Number(event.target.value))))} /><span>%</span></div></SettingRow>
            <SettingRow icon={<Clock3 size={23} />} title="采样间隔" description="成功读取的电量会自动加入历史记录"><select aria-label="采样间隔" value={draft.poll_seconds} onChange={event => change('poll_seconds', Number(event.target.value))}><option value={60}>1分钟</option><option value={180}>3分钟</option><option value={300}>5分钟</option><option value={600}>10分钟</option><option value={900}>15分钟</option><option value={1800}>30分钟</option></select></SettingRow>
            <SettingRow icon={<CheckCheck size={23} />} title="重复提醒间隔" description="持续低电量时按此间隔提醒"><select aria-label="重复提醒间隔" value={draft.reminder_minutes} onChange={event => change('reminder_minutes', Number(event.target.value))}><option value={15}>15分钟</option><option value={30}>30分钟</option><option value={60}>1小时</option><option value={120}>2小时</option><option value={240}>4小时</option></select></SettingRow>
          </section>
          <section className="surface settings-section">
            <div className="settings-section-title"><Monitor size={22} /><h2>启动与托盘</h2></div>
            <SettingRow icon={<Power size={23} />} title="开机自启" description="登录 Windows 后自动启动电量管家"><Toggle checked={draft.autostart} onChange={value => change('autostart', value)} label="开机自启" /></SettingRow>
            <SettingRow icon={<Monitor size={23} />} title="启动时隐藏到托盘" description="后台记录，点击托盘图标打开窗口"><Toggle checked={draft.start_minimized} onChange={value => change('start_minimized', value)} label="启动时隐藏到托盘" /></SettingRow>
            <SettingRow icon={<SlidersHorizontal size={23} />} title="关闭窗口后驻留托盘" description="从托盘菜单可以完全退出应用"><Toggle checked={draft.close_to_tray} onChange={value => change('close_to_tray', value)} label="关闭窗口后驻留托盘" /></SettingRow>
          </section>
          <div className="save-bar"><span>{isDirty ? <><span className="unsaved-dot" /> 有尚未保存的更改</> : <><Check size={17} /> 当前设置已保存</>}</span><div>{isDirty && <button className="text-button" disabled={saving} onClick={() => { setDraft(data.settings); dirty.current = false; setDirty(false); }}>撤销更改</button>}<button className="button primary" disabled={!isDirty || saving} onClick={() => void persist()}>{saving ? <LoaderCircle size={17} className="spinning" /> : <Check size={17} />}{saving ? '保存中' : '保存设置'}</button></div></div>
          <footer className="settings-footer"><span><ShieldCheck size={16} /> 所有记录仅保存在这台电脑</span><button className="text-button" onClick={() => setShowHelp(true)}><CircleHelp size={17} /> 使用帮助</button></footer>
        </div>}
      </main>
    </div>
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={20} /> : <Check size={20} />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X size={17} /></button></div>}
    {showHelp && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setShowHelp(false); }}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onKeyDown={event => { if (event.key === 'Escape') setShowHelp(false); }}><button autoFocus className="dialog-close" aria-label="关闭帮助" onClick={() => setShowHelp(false)}><X size={21} /></button><h2 id="help-title">妙控板电量管家</h2><p className="help-intro">适用于 Lightning 款 Apple Magic Trackpad。</p><div className="help-step"><Radio size={23} /><div><strong>保持蓝牙连接</strong><p>在 Windows 中配对并唤醒妙控板，即可自动读取电量。读取失败时请检查蓝牙连接与当前驱动。</p></div></div><div className="help-step"><Clock3 size={23} /><div><strong>自动记录电量变化</strong><p>默认每 5 分钟采样一次。设备休眠或断连时保留旧记录，恢复后继续采样。</p></div></div><div className="help-step"><Bell size={23} /><div><strong>托盘与提醒</strong><p>关闭窗口后继续工作。托盘右键菜单可刷新、打开窗口或退出，悬停图标查看当前电量。系统专注模式可能隐藏提醒。</p></div></div><button className="button primary" onClick={() => setShowHelp(false)}>知道了 <ChevronRight size={17} /></button></section></div>}
  </div>;
}
