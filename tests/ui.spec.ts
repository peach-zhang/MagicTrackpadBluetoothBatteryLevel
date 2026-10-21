import { expect, test } from '@playwright/test';

test('browser preview never invents a device reading and explains native actions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('等待设备连接', { exact: true })).toBeVisible();
  await expect(page.locator('.battery-number')).toHaveText('—%');
  await expect(page.getByText('等待第一条电量记录')).toBeVisible();
  await page.getByRole('button', { name: '立即刷新' }).click();
  await expect(page.getByRole('alert')).toContainText('请运行 Tauri 桌面应用');
  await expect(page.locator('.battery-number')).toHaveText('—%');
  expect(errors).toEqual([]);
});

test('history changes range and exports records while preserving demo disclosure', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.getByText('演示模式 · 当前电量与历史记录均为示意数据')).toBeVisible();
  await expect(page.locator('.battery-number')).toHaveText('76%');
  await page.getByRole('button', { name: '电量历史', exact: true }).click();
  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await expect(page.getByRole('button', { name: '7 天', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('tbody tr')).toHaveCount(100);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出全部 CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('trackpad-demo.csv');
  await page.screenshot({ path: 'artifacts/history.png', fullPage: true });
});

test('settings save applies threshold and sampling interval and undo restores saved values', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.locator('.battery-number')).toHaveText('76%');
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('spinbutton', { name: '提醒阈值' }).fill('25');
  await page.getByRole('combobox', { name: '采样间隔' }).selectOption('60');
  await page.getByRole('switch', { name: '开机自启', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('设置已保存');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: '开机自启', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('spinbutton', { name: '提醒阈值' }).fill('35');
  await page.getByRole('button', { name: '撤销更改' }).click();
  await expect(page.getByRole('spinbutton', { name: '提醒阈值' })).toHaveValue('25');
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });
  await page.getByRole('button', { name: '电量总览', exact: true }).click();
  await expect(page.getByText('每1分钟自动记录', { exact: true })).toBeVisible();
});

test('overview matches prototype without overflow and help is keyboard dismissible', async ({ page }) => {
  await page.goto('/?demo=1');
  await expect(page.locator('.battery-number')).toHaveText('76%');
  await expect(page.getByRole('img', { name: /电量趋势/ })).toBeVisible();
  await page.getByAltText('银白色 Magic Trackpad').evaluate(async (img: HTMLImageElement) => { if (!img.complete) await new Promise(resolve => img.addEventListener('load', resolve, { once: true })); });
  await expect(page.locator('.stats-grid > section')).toHaveCount(2);
  await expect(page.getByText('今日消耗', { exact: true })).toBeVisible();
  await expect(page.getByText('已记录', { exact: true })).toBeVisible();
  expect(await page.locator('.main-panel').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: 'artifacts/overview.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '偏好设置', exact: true }).click();
  await page.getByRole('button', { name: '使用帮助' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 940, height: 680 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
