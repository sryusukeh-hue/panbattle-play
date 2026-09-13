import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page) {
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
}
async function battle(page: Page) {
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click();
  await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle', { timeout: 6000 });
}
for (const width of [360, 390, 430]) test(`independent sensitivity settings migrate and work by keyboard at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 740 });
  await page.addInitScript(() => localStorage.setItem('panbattle.3d.v1', JSON.stringify({ version: 1, sound: false, sensitivity: 1.2, bread: 'shokupan', cpu: 'shokupan', practiced: false, best: {} })));
  await boot(page); await page.getByRole('button', { name: '設定', exact: true }).click();
  const attack = page.getByRole('slider', { name: '攻撃の出やすさ' }), tilt = page.getByRole('slider', { name: '回避のしやすさ' });
  await expect(attack).toHaveValue('1.2'); await expect(tilt).toHaveValue('1.2');
  await attack.focus(); await page.keyboard.press('ArrowLeft'); await expect(attack).toHaveValue('1.1');
  await tilt.focus(); await page.keyboard.press('ArrowRight'); await expect(tilt).toHaveValue('1.3');
  expect(await page.evaluate(() => {
    const { attackSensitivity, tiltSensitivity, sensitivity } = JSON.parse(localStorage.getItem('panbattle.3d.v1')!);
    return { attackSensitivity, tiltSensitivity, sensitivity };
  })).toEqual({ attackSensitivity: 1.1, tiltSensitivity: 1.3, sensitivity: 1.2 });
  await page.screenshot({ path: info.outputPath('settings.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '戻る', exact: true }).click(); await battle(page);
  await page.keyboard.press('Escape'); await expect(attack).toHaveValue('1.1'); await expect(tilt).toHaveValue('1.3');
  expect(await page.locator('.sheet').evaluate(e => e.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: info.outputPath('pause-settings.png') });
  const exit = page.getByRole('button', { name: 'この対戦を終了してタイトルへ' });
  await exit.focus(); await expect(exit).toBeInViewport();
  await page.keyboard.press('Enter'); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'title');
});

test('combat accents, low HP, sound priority and pause cleanup share the rendering path', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page); await battle(page);
  await page.evaluate(() => {
    const { battle: b, renderer: r } = window.__panTest;
    b.cpuEnabled = false; b.advance = () => {}; b.player.hp = 25; b.attack('cpu');
    const sounds: string[] = []; (window as any).feedbackSounds = sounds; r.playSound = (sound: string) => sounds.push(sound);
    const original = r.render.bind(r); r.render = (v: any, t: number, _dt: number, active: boolean) => original(v, t, 0, active);
  });
  await expect(page.locator('.health.critical')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).feedbackSounds)).toEqual(['telegraph', 'danger']);
  await page.screenshot({ path: info.outputPath('telegraph-low-hp.png') });
  await page.evaluate(() => {
    const { battle: b } = window.__panTest;
    b.cpu.attack = null;
    b.events.push({ id: 900, kind: 'counter', side: 'player', x: 0, z: 0 }, { id: 901, kind: 'hit', side: 'player', x: 0, z: 0 });
  });
  await expect(page.locator('#toast')).toContainText('反撃成功');
  await expect.poll(() => page.evaluate(() => (window as any).feedbackSounds)).toEqual(['telegraph', 'danger', 'counter']);
  await expect.poll(() => page.evaluate(() => window.__panTest.renderer.accents.length)).toBe(1);
  await page.screenshot({ path: info.outputPath('counter-impact.png') });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__panTest.renderer.accents.length + window.__panTest.renderer.crumbs.length)).toBe(0);
  await page.getByRole('button', { name: '再開する →' }).click();
  await page.evaluate(() => {
    const b = window.__panTest.battle;
    b.events.push({ id: 900, kind: 'counter', side: 'player', x: 0, z: 0 });
  });
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => (window as any).feedbackSounds)).toEqual(['telegraph', 'danger', 'counter']);
  expect(errors).toEqual([]);
});

test('reduced motion retains static danger and success text; unavailable audio stays playable', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { value: class { constructor() { throw new Error('unavailable'); } } }); });
  await boot(page); await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByLabel('音を鳴らす').check(); await expect(page.locator('#toast')).toContainText('音を再生できません');
  await page.getByLabel('音を鳴らす').uncheck(); await page.getByRole('button', { name: '戻る', exact: true }).click(); await battle(page);
  await page.evaluate(() => {
    const b = window.__panTest.battle; b.cpuEnabled = false; b.player.hp = 25;
    b.events.push({ id: 900, kind: 'dodge', side: 'player', x: 0, z: 1.2 });
  });
  await expect(page.locator('#toast')).toContainText('回避成功');
  await expect(page.locator('.health.critical')).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate(() => window.__panTest.renderer.accents.length)).toBe(0);
  await page.screenshot({ path: info.outputPath('reduced-motion-dodge.png') });
  await page.keyboard.press('Space'); await expect(page.locator('#cpu-hp')).toHaveText('82');
});
