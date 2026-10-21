// Development verification only; never bundled into the desktop application.
import { chromium, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const executable = resolve(process.argv[2] || 'src-tauri/target/debug/magic-trackpad-battery.exe');
const port = Number(process.env.TRACKPAD_CDP_PORT || 9223);
const app = spawn(executable, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  windowsHide: true, stdio: 'ignore',
});
let browser, page, original;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
let appWindowHandle = '';
const nativeWindow = (close = false) => {
  const result = JSON.parse(execFileSync('pwsh', ['-NoProfile', '-Command', `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class TrackpadWindow { public delegate bool EnumProc(IntPtr h, IntPtr p); [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr p); [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder value, int length); public static bool IsMainWindow(IntPtr h) { var name = new System.Text.StringBuilder(256); GetClassNameW(h, name, 256); return name.ToString() == "Tauri Window"; } [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); public static IntPtr FindVisibleForProcess(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h,out owner); if(owner==pid && IsMainWindow(h)) { found=h; return false; } return true; },IntPtr.Zero); return found; } }';
$trackpadHandle = ${appWindowHandle ? `[IntPtr]::new(${appWindowHandle})` : `[TrackpadWindow]::FindVisibleForProcess(${app.pid})`};
[uint32]$trackpadOwner = 0;
[TrackpadWindow]::GetWindowThreadProcessId($trackpadHandle, [ref]$trackpadOwner) | Out-Null;
if ($trackpadOwner -ne ${app.pid}) { throw "Application window owner mismatch: handle=$trackpadHandle owner=$trackpadOwner expected=${app.pid}" };
${close ? '[TrackpadWindow]::PostMessage($trackpadHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null;' : ''}
@{ handle=$trackpadHandle.ToInt64().ToString(); visible=[TrackpadWindow]::IsWindowVisible($trackpadHandle) } | ConvertTo-Json -Compress
`], { encoding: 'utf8' }).trim());
  appWindowHandle = result.handle;
  return result.visible ? 'True' : 'False';
};
try {
  for (let i = 0; i < 60; i++) {
    if (app.exitCode !== null) throw new Error(`Native app exited ${app.exitCode}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) break; } catch {}
    if (i === 59) throw new Error('WebView2 debug endpoint did not start');
    await sleep(400);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let i = 0; i < 30; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes(':1420') || page.url().includes('tauri.localhost') || page.url().startsWith('tauri://'));
    if (page) break;
    await sleep(300);
  }
  assert.ok(page, 'Native WebView2 main page exists');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '电量总览', exact: true }).waitFor();
  // Honor startup-to-tray preferences, and explicitly reveal the app under test.
  const reveal = spawn(executable, [], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reveal.kill(); reject(new Error('Could not reveal the existing app')); }, 10000);
    reveal.once('exit', () => { clearTimeout(timeout); resolve(); });
  });
  await expect.poll(() => nativeWindow()).toBe('True');
  let snapshot = await invoke('refresh_battery');
  for (let i = 0; i < 40 && !snapshot.current && !snapshot.last_error; i++) {
    await sleep(250);
    snapshot = await invoke('get_dashboard');
  }
  original = snapshot.settings;
  assert.ok(snapshot.current, `Device read failed: ${snapshot.last_error}`);
  assert.ok(snapshot.current.percent >= 0 && snapshot.current.percent <= 100);
  assert.equal(snapshot.last_error, null);
  assert.ok(snapshot.stats.first_recorded_at, 'Statistics include actual first-recorded time');
  await page.locator('.battery-number').filter({ hasText: String(snapshot.current.percent) }).waitFor();
  const initialWidth = await page.evaluate(() => innerWidth);
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click();
  await expect.poll(() => page.evaluate(() => innerWidth)).not.toBe(initialWidth);
  await page.getByRole('button', { name: '最大化或还原', exact: true }).click();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(initialWidth);
  const history = await invoke('get_history', { hours: 24 });
  assert.ok(history.some(reading => reading.timestamp === snapshot.current.timestamp), 'Real sample persisted');
  const changed = { ...original, threshold: original.threshold === 21 ? 22 : 21, poll_seconds: 60 };
  const saved = await invoke('save_settings', { settings: changed });
  assert.equal(saved.threshold, changed.threshold);
  assert.equal(saved.poll_seconds, 60);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('spinbutton', { name: '提醒阈值' }).filter({ visible: true }).waitFor();
  await expect(page.getByRole('spinbutton', { name: '提醒阈值' })).toHaveValue(String(changed.threshold));
  await assert.rejects(() => invoke('save_settings', { settings: { ...changed, threshold: 0 } }));
  assert.equal((await invoke('get_dashboard')).settings.threshold, changed.threshold);
  await invoke('save_settings', { settings: { ...original, autostart: true, start_minimized: true } });
  const startup = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'MagicTrackpadBattery'], { encoding: 'utf8' });
  assert.ok(startup.toLowerCase().includes(executable.toLowerCase()), 'Autostart points to this executable');
  assert.ok(startup.includes('--minimized'), 'Autostart can start hidden');
  await invoke('save_settings', { settings: original });
  await page.getByRole('button', { name: '电量总览', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  await page.evaluate(() => Promise.all(Array.from(document.images, image => image.decode().catch(() => {}))));
  await page.screenshot({ path: 'artifacts/native-overview.png', fullPage: true, animations: 'disabled', type: 'png' });
  assert.equal(await page.getByText('浏览器预览', { exact: false }).count(), 0);
  assert.equal(await page.getByText('演示模式', { exact: false }).count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Test actual WM_CLOSE handling, then use the second-instance callback to reopen.
  await invoke('save_settings', { settings: { ...original, close_to_tray: true, poll_seconds: 10 } });
  const beforeClose = (await invoke('get_history', { hours: 24 })).length;
  assert.equal(nativeWindow(), 'True', 'Main window is visible before closing');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await sleep(500);
  assert.equal(nativeWindow(), 'False', 'Window closes into tray');
  let afterClose = beforeClose;
  for (let i = 0; i < 30 && afterClose <= beforeClose; i++) {
    await sleep(500);
    afterClose = (await invoke('get_history', { hours: 24 })).length;
  }
  assert.ok(afterClose > beforeClose, 'Automatic sampling continues with the window hidden');
  const second = spawn(executable, [], { windowsHide: true, stdio: 'ignore' });
  const secondExited = new Promise(resolve => second.once('exit', resolve));
  await Promise.race([secondExited, sleep(10000).then(() => { second.kill(); throw new Error('Second instance failed to hand off'); })]);
  await sleep(500);
  assert.equal(nativeWindow(), 'True', 'Second launch reopens the existing window');
  assert.deepEqual(errors, [], 'No WebView2 frontend runtime errors');
  const report = { checked_at: new Date().toISOString(), percent: snapshot.current.percent, device_name: snapshot.current.device_name, source: snapshot.current.source, samples: history.length, checks: ['actual HID read', 'SQLite persistence', 'native settings and validation', 'Windows startup registration', 'real WebView2 UI', 'custom titlebar maximize and restore', 'custom titlebar close to tray', 'automatic sampling while hidden', 'single instance reopen'], frontend_errors: errors };
  await writeFile('artifacts/native-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    await mkdir('artifacts', { recursive: true });
    console.error('Native page URL:', page.url());
    console.error('Native body:', (await page.locator('body').innerText()).slice(0, 4000));
    await page.screenshot({ path: 'artifacts/native-failure.png', fullPage: true }).catch(() => {});
  } else if (browser) {
    console.error('Native page URLs:', browser.contexts().flatMap(context => context.pages()).map(page => page.url()));
  }
  throw error;
} finally {
  if (original && page) { try { await invoke('save_settings', { settings: original }); } catch {} }
  if (browser) await browser.close();
  app.kill();
}
