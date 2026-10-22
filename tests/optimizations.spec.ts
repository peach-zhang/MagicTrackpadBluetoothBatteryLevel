import { expect, test, type Page } from '@playwright/test';
import type { ChartReading, Dashboard, HistoryView, Reading, Settings } from '../src/api';

const NOW = Date.UTC(2026, 9, 22, 2);
const settings: Settings = {
  threshold: 20, poll_seconds: 300, notifications_enabled: true,
  autostart: false, start_minimized: false, close_to_tray: true, reminder_minutes: 60,
};
const reading = (timestamp = NOW, percent = 76): Reading => ({
  timestamp, percent, device_name: 'Magic Trackpad', device_id: 'test-trackpad', source: 'HID',
});
const historyView = (points: ChartReading[]): HistoryView => ({ points, records: points.slice(-100), total: points.length });
const initialHistory = historyView([0, 1, 2].map(index => ({ ...reading(NOW - (2 - index) * 300000, 80 - index * 2), break_before: false })));

type NativeEvent = { event: string; id: number; payload: unknown };
type NativeCall = { command: string; args: Record<string, unknown> };
type NativeMock = {
  dashboard: Dashboard;
  history: HistoryView;
  historyByRange: Record<string, HistoryView>;
  calls: NativeCall[];
  visible: boolean;
  pendingSaveCount: number;
  emit: (event: string, payload: unknown) => void;
  listenerCount: (event: string) => number;
  resolveNextSave: () => void;
};
declare global {
  interface Window { __batteryTest: NativeMock }
}

async function openNative(page: Page, options: {
  dashboard?: Partial<Dashboard>; history?: HistoryView;
  historyByRange?: Record<string, HistoryView>; delaySaves?: boolean;
} = {}) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(({ snapshot, history, historyByRange, delaySaves }) => {
    const callbacks = new Map<number, (event: NativeEvent) => void>();
    const listeners = new Map<string, Map<number, number>>();
    const pendingSaves: { settings: Settings; resolve: (settings: Settings) => void }[] = [];
    let nextId = 1;
    const unregister = (event: string, id: number) => {
      const handlers = listeners.get(event);
      const callbackId = handlers?.get(id);
      if (callbackId !== undefined) callbacks.delete(callbackId);
      handlers?.delete(id);
    };
    const mock: NativeMock = {
      dashboard: snapshot, history, historyByRange, calls: [], visible: true, pendingSaveCount: 0,
      listenerCount: event => listeners.get(event)?.size ?? 0,
      emit(event, payload) {
        if (event === 'window-visibility') mock.visible = payload === true;
        for (const [id, callbackId] of listeners.get(event) ?? []) {
          callbacks.get(callbackId)?.({ event, id, payload: structuredClone(payload) });
        }
      },
      resolveNextSave() {
        const pending = pendingSaves.shift();
        if (!pending) throw new Error('No pending settings save');
        mock.pendingSaveCount = pendingSaves.length;
        mock.dashboard.settings = structuredClone(pending.settings);
        pending.resolve(structuredClone(pending.settings));
      },
    };
    Object.assign(window, {
      isTauri: true,
      __batteryTest: mock,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: unregister },
      __TAURI_INTERNALS__: {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(callback: (event: NativeEvent) => void, once = false) {
          const id = nextId++;
          callbacks.set(id, event => { if (once) callbacks.delete(id); callback(event); });
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        async invoke(command: string, args: Record<string, unknown> = {}) {
          mock.calls.push({ command, args: structuredClone(args) });
          switch (command) {
            case 'plugin:event|listen': {
              const event = String(args.event);
              const id = nextId++;
              if (!listeners.has(event)) listeners.set(event, new Map());
              listeners.get(event)!.set(id, Number(args.handler));
              return id;
            }
            case 'plugin:event|unlisten': unregister(String(args.event), Number(args.eventId)); return;
            case 'plugin:window|is_visible': return mock.visible;
            case 'plugin:window|is_minimized': return false;
            case 'get_dashboard':
            case 'refresh_battery': return structuredClone(mock.dashboard);
            case 'get_history_view': return structuredClone(mock.historyByRange[String(args.hours)] ?? mock.history);
            case 'save_settings': {
              const next = structuredClone(args.settings as Settings);
              if (delaySaves) return new Promise<Settings>(resolve => {
                pendingSaves.push({ settings: next, resolve });
                mock.pendingSaveCount = pendingSaves.length;
              });
              mock.dashboard.settings = next;
              return structuredClone(next);
            }
            case 'export_history': return 'C:\\battery-history.csv';
            default: throw new Error(`Unexpected native command: ${command}`);
          }
        },
      },
    });
  }, {
    snapshot: {
      current: reading(), settings: { ...settings }, last_error: null, warnings: [], history_count: initialHistory.total,
      monitoring: true, stats: { first_recorded_at: NOW - 86400000, today_consumption: 4, yesterday_consumption: 6 },
      ...options.dashboard,
    } satisfies Dashboard,
    history: options.history ?? initialHistory,
    historyByRange: options.historyByRange ?? {},
    delaySaves: options.delaySaves ?? false,
  });
  await page.goto('/');
  await expect(page.getByText('已连接', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__batteryTest.listenerCount('battery-updated'))).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__batteryTest.listenerCount('window-visibility'))).toBe(1);
}

async function commandCount(page: Page, command: string) {
  return page.evaluate(name => window.__batteryTest.calls.filter(call => call.command === name).length, command);
}

test('notification and storage warnings preserve a connected current reading', async ({ page }) => {
  const warnings = ['发送低电量通知失败：通知服务不可用', '保存电量记录失败：磁盘已满'];
  await openNative(page, { dashboard: { warnings } });
  await expect(page.locator('.battery-number')).toHaveText('76%');
  await expect(page.locator('.battery-caption')).toHaveText('当前电量');
  for (const warning of warnings) await expect(page.getByText(warning, { exact: true })).toBeVisible();
  await page.evaluate(() => window.__batteryTest.emit('battery-error', '发送低电量通知失败：通知服务不可用'));
  await expect(page.getByRole('alert')).toContainText(warnings[0]);
  await expect(page.locator('.connection-status')).toHaveText('已连接');
  await expect(page.locator('.battery-caption')).toHaveText('当前电量');
  await expect(page.getByText('暂时无法更新电量', { exact: true })).toHaveCount(0);
});

test('an edit made during settings save stays unsaved and can be saved next', async ({ page }) => {
  await openNative(page, { delaySaves: true });
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  const threshold = page.getByRole('spinbutton', { name: '提醒阈值' });
  await threshold.fill('25');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存中', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__batteryTest.pendingSaveCount)).toBe(1);
  await threshold.fill('35');
  await page.evaluate(() => window.__batteryTest.resolveNextSave());
  await expect(threshold).toHaveValue('35');
  await expect(page.getByText('有尚未保存的更改', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('后续修改尚未保存');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__batteryTest.dashboard.settings.threshold)).toBe(25);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__batteryTest.pendingSaveCount)).toBe(1);
  const savedThresholds = await page.evaluate(() => window.__batteryTest.calls
    .filter(call => call.command === 'save_settings').map(call => (call.args.settings as Settings).threshold));
  expect(savedThresholds).toEqual([25, 35]);
  await page.evaluate(() => window.__batteryTest.resolveNextSave());
  await expect(page.getByText('当前设置已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await expect(threshold).toHaveValue('35');
  expect(await page.evaluate(() => window.__batteryTest.dashboard.settings.threshold)).toBe(35);
});

test('an empty selected range can export history recorded outside that range', async ({ page }) => {
  await openNative(page, {
    dashboard: { history_count: 42 },
    historyByRange: { '168': { points: [], records: [], total: 0 } },
  });
  await expect(page.getByRole('img', { name: /电量趋势/ })).toBeVisible();
  await page.getByRole('button', { name: '电量历史', exact: true }).click();
  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(page.getByRole('button', { name: '7 天', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('这个时间范围内还没有记录', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '导出全部 CSV', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '导出全部 CSV', exact: true }).click();
  await expect.poll(() => commandCount(page, 'export_history')).toBe(1);
  await expect(page.getByRole('status')).toContainText('已导出至 C:\\battery-history.csv');
});

test('native events replace dashboard polling and hidden or settings views skip history work', async ({ page }) => {
  await openNative(page);
  await expect(page.getByRole('img', { name: /电量趋势/ })).toBeVisible();
  const dashboards = await commandCount(page, 'get_dashboard');
  const histories = await commandCount(page, 'get_history_view');
  expect(dashboards).toBeGreaterThan(0);
  await page.clock.fastForward(45000);
  expect(await commandCount(page, 'get_dashboard')).toBe(dashboards);
  expect(await commandCount(page, 'get_history_view')).toBe(histories);
  await page.evaluate(() => {
    const mock = window.__batteryTest;
    mock.emit('window-visibility', false);
    mock.dashboard = {
      ...mock.dashboard, current: { ...mock.dashboard.current!, timestamp: Date.now(), percent: 64 },
      history_count: mock.dashboard.history_count + 1,
    };
    mock.history = { points: [{ ...mock.dashboard.current!, break_before: false }], records: [mock.dashboard.current!], total: 1 };
    mock.emit('battery-updated', mock.dashboard);
  });
  await page.clock.fastForward(45000);
  await expect(page.locator('.battery-number')).toHaveText('76%');
  expect(await commandCount(page, 'get_dashboard')).toBe(dashboards);
  expect(await commandCount(page, 'get_history_view')).toBe(histories);
  await page.evaluate(() => window.__batteryTest.emit('window-visibility', true));
  await expect(page.locator('.battery-number')).toHaveText('64%');
  await expect(page.getByRole('img', { name: /共1个显示点/ })).toBeVisible();
  expect(await commandCount(page, 'get_dashboard')).toBe(dashboards + 1);
  expect(await commandCount(page, 'get_history_view')).toBeGreaterThan(histories);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  const historyOnSettings = await commandCount(page, 'get_history_view');
  await page.evaluate(() => {
    const mock = window.__batteryTest;
    mock.dashboard = {
      ...mock.dashboard, current: { ...mock.dashboard.current!, timestamp: Date.now() + 1 },
      settings: { ...mock.dashboard.settings, threshold: 27 }, history_count: mock.dashboard.history_count + 1,
    };
    mock.emit('battery-updated', mock.dashboard);
  });
  await expect(page.getByRole('spinbutton', { name: '提醒阈值' })).toHaveValue('27');
  await page.evaluate(() => {
    const mock = window.__batteryTest;
    mock.emit('window-visibility', false);
    mock.dashboard.settings.threshold = 29;
    mock.emit('window-visibility', true);
  });
  await expect(page.getByRole('spinbutton', { name: '提醒阈值' })).toHaveValue('29');
  expect(await commandCount(page, 'get_history_view')).toBe(historyOnSettings);
});

test('continuous downsampled history stays one curve across uneven bucket spacing', async ({ page }) => {
  // Each bucket retains first/min/max/last. Their spacing is not the raw polling cadence.
  const offsets = Array.from({ length: 4 }, (_, bucket) => [0, 1, 2, 19].map(offset => bucket * 20 + offset)).flat();
  const points: ChartReading[] = offsets.map((offset, index) => ({
    ...reading(NOW - (79 - offset) * 300000, [84, 72, 94, 82][index % 4]), break_before: false,
  }));
  await openNative(page, {
    history: historyView(points), dashboard: { current: reading(NOW, 82), history_count: points.length },
  });
  const chart = page.getByRole('img', { name: /电量趋势/ });
  await expect(chart).toHaveAttribute('aria-label', /共16个显示点/);
  await expect(chart.locator('path[stroke="#478c57"]')).toHaveCount(1);
});

test('chart keeps backend breaks and cached geometry while pointer and keyboard selection change', async ({ page }) => {
  const points: ChartReading[] = [90, 88, 84, 82].map((percent, index) => ({
    ...reading(NOW - (3 - index) * 600000, percent), break_before: index === 2,
  }));
  await openNative(page, { history: historyView(points), dashboard: { current: reading(NOW, 82), history_count: points.length } });
  const chart = page.getByRole('img', { name: /电量趋势/ });
  await expect(chart.locator('path[stroke="#478c57"]')).toHaveCount(2);
  const bounds = (await chart.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .98, bounds.y + bounds.height / 2);
  await expect(page.locator('.chart-tooltip strong')).toHaveText('82%');
  const paths = await chart.locator('path').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  const ticks = await chart.locator('.axis-label').allTextContents();
  await page.clock.setFixedTime(NOW + 1800000);
  await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + bounds.height / 2);
  await expect(page.locator('.chart-tooltip strong')).toHaveText('90%');
  expect(await chart.locator('path').evaluateAll(elements => elements.map(element => element.getAttribute('d')))).toEqual(paths);
  expect(await chart.locator('.axis-label').allTextContents()).toEqual(ticks);
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.chart-tooltip strong')).toHaveText('88%');
  await page.evaluate(() => {
    const mock = window.__batteryTest;
    const current = { ...mock.dashboard.current!, timestamp: Date.now(), percent: 81 };
    mock.dashboard = { ...mock.dashboard, current, history_count: mock.dashboard.history_count + 1 };
    mock.history = { points: [{ ...current, break_before: false }], records: [current], total: 1 };
    mock.emit('battery-updated', mock.dashboard);
  });
  await expect(page.getByRole('img', { name: /共1个显示点/ })).toBeVisible();
  await expect(page.locator('.chart-tooltip')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.chart-tooltip strong')).toHaveText('81%');
});
