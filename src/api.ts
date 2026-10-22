import { invoke, isTauri } from '@tauri-apps/api/core';

export interface Reading {
  timestamp: number;
  percent: number;
  device_name: string;
  device_id: string;
  source: string;
}
export interface ChartReading extends Reading { break_before: boolean }
export interface HistoryView { points: ChartReading[]; records: Reading[]; total: number }
export interface Settings {
  threshold: number;
  poll_seconds: number;
  notifications_enabled: boolean;
  autostart: boolean;
  start_minimized: boolean;
  close_to_tray: boolean;
  reminder_minutes: number;
}
export interface DashboardStats {
  first_recorded_at: number | null;
  today_consumption: number | null;
  yesterday_consumption: number | null;
}
export interface Dashboard {
  stats: DashboardStats;
  current: Reading | null;
  settings: Settings;
  last_error: string | null;
  warnings: string[];
  history_count: number;
  monitoring: boolean;
}
export const desktop = isTauri();
export const demo = !desktop && new URLSearchParams(location.search).get('demo') === '1';
export const defaults: Settings = {
  threshold: 20, poll_seconds: 300, notifications_enabled: true,
  autostart: false, start_minimized: false, close_to_tray: true, reminder_minutes: 60,
};
const demoNow = Date.now();
const demoCount = 7 * 24 * 12;
const demoHistory: Reading[] = Array.from({ length: demoCount + 1 }, (_, i) => ({
  timestamp: demoNow - (demoCount - i) * 300000,
  percent: Math.max(0, Math.min(100, Math.round(76 + ((demoCount - i) % (4 * 24 * 12)) * 7 / (24 * 12)))),
  device_name: 'Magic Trackpad', device_id: 'demo-trackpad', source: '演示数据',
}));
let demoSettings = { ...defaults };
const preview: Dashboard = {
  current: null, settings: { ...defaults }, monitoring: false, last_error: null,
  warnings: [], history_count: 0,
  stats: { first_recorded_at: null, today_consumption: null, yesterday_consumption: null },
};
function demoSnapshot(): Dashboard {
  const midnight = new Date(demoNow).setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight); yesterday.setDate(yesterday.getDate() - 1);
  const consumption = (from: number, to: number) => {
    const samples = demoHistory.filter(r => r.timestamp >= from && r.timestamp < to);
    return samples.length < 2 ? null : samples.slice(1).reduce((sum, sample, index) => sum + Math.max(0, samples[index].percent - sample.percent), 0);
  };
  return {
    current: demoHistory.at(-1)!, settings: demoSettings,
    last_error: null, warnings: [], history_count: demoHistory.length, monitoring: true,
    stats: { first_recorded_at: demoHistory[0].timestamp, today_consumption: consumption(midnight, demoNow + 1), yesterday_consumption: consumption(yesterday.getTime(), midnight) },
  };
}
export async function dashboard(): Promise<Dashboard> {
  return desktop ? invoke('get_dashboard') : demo ? demoSnapshot() : preview;
}
export async function refresh(): Promise<Dashboard> {
  if (desktop) return invoke('refresh_battery');
  if (demo) return demoSnapshot();
  throw new Error('请运行 Tauri 桌面应用以读取妙控板电量。浏览器仅用于预览界面。');
}
export async function history(hours: number | null): Promise<HistoryView> {
  if (desktop) return invoke('get_history_view', { hours });
  if (!demo) return { points: [], records: [], total: 0 };
  const readings = demoHistory.filter(r => hours === null || r.timestamp >= demoNow - hours * 3600000);
  return { points: readings.map(reading => ({ ...reading, break_before: false })), records: readings.slice(-100), total: readings.length };
}
export async function saveSettings(settings: Settings): Promise<Settings> {
  if (desktop) return invoke('save_settings', { settings });
  if (demo) { demoSettings = { ...settings }; return demoSettings; }
  throw new Error('设置需要在 Tauri 桌面应用中保存。');
}
export async function exportHistory(): Promise<string | null> {
  if (desktop) return invoke('export_history');
  if (!demo) throw new Error('请在桌面应用中导出历史记录。');
  const csv = '\uFEFF时间,电量(%),设备\r\n' + demoHistory.map(r => `${new Date(r.timestamp).toISOString()},${r.percent},${r.device_name}`).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'trackpad-demo.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'trackpad-demo.csv（演示数据）';
}
