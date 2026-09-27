import { test, expect, type Page } from '@playwright/test';

declare global { interface Window { __panTest: any; __panDiagnostics: () => any } }
async function boot(page: Page): Promise<void> {
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
}
// Synthetic 16ms sensor samples and short counter windows use browser time.
// CI software rendering must not turn a valid fixture into missing sensor data.
async function bootWithClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await boot(page); await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
}
async function advanceUntil(page: Page, ready: () => Promise<boolean>): Promise<void> {
  for (let elapsed = 0; elapsed < 5000; elapsed += 50) {
    if (await ready()) return;
    await page.clock.runFor(50);
  }
  expect(await ready(), 'condition within 5 seconds of browser time').toBe(true);
}
async function select(page: Page, mode = 'タッチ操作'): Promise<void> {
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
}
async function fight(page: Page, clock = false): Promise<void> {
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click();
  await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  if (clock) await page.clock.runFor(3100);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle', { timeout: 6000 });
}
test('first run, keyboard combat, pause/resume, result, rematch and legacy save', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('panbattle.save', '{"keep":"legacy"}'));
  await boot(page); await select(page, 'キーボード'); await fight(page);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; });
  await page.keyboard.press('Space'); await expect(page.locator('#cpu-hp')).toHaveText('82');
  await page.keyboard.press('Escape'); await expect(page.getByRole('heading', { name: 'ちょっと、ひと休み' })).toBeVisible();
  const frozen = await page.evaluate(() => window.__panDiagnostics());
  await page.waitForTimeout(400); expect((await page.evaluate(() => window.__panDiagnostics())).elapsed).toBe(frozen.elapsed);
  await page.getByRole('button', { name: '再開する →' }).click();
  await page.evaluate(() => { window.__panTest.battle.elapsed = 59.99; });
  await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
  await expect(page.getByRole('heading', { name: 'こんがり、勝利！' })).toBeVisible();
  await expect(page.getByText('機会なし', { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem('panbattle.save'))).toBe('{"keep":"legacy"}');
  await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle', { timeout: 6000 });
  expect((await page.evaluate(() => window.__panDiagnostics())).hp).toEqual([100, 100]);
  expect(errors).toEqual([]);
});
test('touch pointer emits once, releases movement and rejects queued attacks during pause/countdown', async ({ page }) => {
  await boot(page); await select(page); await fight(page);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; });
  await page.locator('[data-control="attack"]').click(); await expect(page.locator('#cpu-hp')).toHaveText('82');
  await page.waitForTimeout(1000); await expect(page.locator('#cpu-hp')).toHaveText('82');
  const left = page.locator('[data-control="left"]'); const box = (await left.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__panTest.battle.player.x)).toBeLessThan(-.8);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.getByRole('button', { name: '再開する →' }).click();
  await expect.poll(() => page.evaluate(() => window.__panTest.battle.player.x)).toBe(0);
});
test('landscape, blur and long frame gaps suspend play and need manual resume', async ({ page }) => {
  await boot(page); await select(page); await fight(page);
  await page.setViewportSize({ width: 844, height: 390 }); await expect(page.getByRole('heading', { name: '縦に持ってね' })).toBeVisible();
  const paused = await page.evaluate(() => window.__panDiagnostics()); await page.waitForTimeout(400);
  expect((await page.evaluate(() => window.__panDiagnostics())).elapsed).toBe(paused.elapsed);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
  await page.getByRole('button', { name: '再開する →' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
});
test('permission denial and missing real sensor data have distinct recovery paths', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'DeviceMotionEvent', { value: class { static requestPermission() { return Promise.resolve('denied'); } }, configurable: true });
    Object.defineProperty(window, 'DeviceOrientationEvent', { value: class { static requestPermission() { return Promise.resolve('granted'); } }, configurable: true });
  });
  await boot(page); await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByRole('button', { name: '動きの利用を許可する' }).click();
  await expect(page.getByText(/動きの利用が許可されませんでした/)).toBeVisible();
  await page.evaluate(() => { (window.DeviceMotionEvent as any).requestPermission = () => Promise.resolve('granted'); });
  await page.getByRole('button', { name: '動きの利用を許可する' }).click();
  await expect(page.getByText(/動き・傾きの値が届きません/)).toBeVisible({ timeout: 6000 });
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'permission');
  await expect(page.locator('#permission-message')).toContainText('動き：未受信 / 傾き：未受信');
  await page.setViewportSize({ width: 360, height: 640 });
  await page.screenshot({ path: testInfo.outputPath('sensor-unavailable.png') });
  const fallback = page.getByText('補助操作で遊ぶ', { exact: true });
  await fallback.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'タッチ操作', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'calibrate');
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'select');
});
test('model loading and WebGL context failures freeze the game with retry', async ({ page }) => {
  await page.route('**/shokupan.glb', route => route.abort()); await page.goto('./?test=1');
  await expect(page.getByText(/3D素材を読み込めませんでした/)).toBeVisible(); await expect(page.getByRole('button', { name: '再読み込みして再試行' })).toBeVisible();
  await page.unroute('**/shokupan.glb'); await boot(page); await select(page); await fight(page);
  await page.evaluate(() => { document.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); });
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'error'); const before = await page.evaluate(() => window.__panDiagnostics());
  await page.waitForTimeout(300); expect((await page.evaluate(() => window.__panDiagnostics())).elapsed).toBe(before.elapsed);
});
test('storage failure is visible, settings and result still work', async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
  await boot(page); await page.getByRole('button', { name: '設定', exact: true }).click(); await page.getByLabel('音を鳴らす').check();
  await expect(page.locator('#save-warning')).toContainText('端末に保存できません');
  await page.getByRole('button', { name: '戻る', exact: true }).click(); await select(page); await fight(page);
  await page.evaluate(() => { window.__panTest.battle.elapsed = 59.99; }); await page.getByRole('button', { name: 'リプレイをスキップ →' }).click(); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'result');
  await expect(page.getByRole('button', { name: '同じパンで、もう一戦 →' })).toBeVisible();
});
for (const width of [360, 390, 430]) test(`three breads and all opponent combinations render without errors at ${width}px`, async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await boot(page); await page.screenshot({ path: testInfo.outputPath('title.png') }); await select(page);
    await page.setViewportSize({ width, height: 844 });
    for (const player of ['shokupan', 'francepan', 'croissant']) {
      await page.locator(`[data-bread="${player}"]`).click();
      for (const cpu of ['shokupan', 'francepan', 'croissant']) {
        await page.locator('#opponent').selectOption(cpu);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  await page.screenshot({ path: testInfo.outputPath('selection.png') });
  await fight(page); await page.screenshot({ path: testInfo.outputPath('battle.png') });
  expect(errors).toEqual([]);
});
test('practice teaches attack/dodge/counter, never damages, supports replay and skip', async ({ page }) => {
  await bootWithClock(page); await select(page, 'キーボード');
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click(); await page.getByRole('button', { name: '練習をはじめる' }).click();
  await page.keyboard.press('Space');
  await advanceUntil(page, () => page.locator('#play-tip').evaluate(e => e.textContent!.includes('2 / 3')));
  // Wait for the actual CPU anticipation, then use normal keyboard events.
  await advanceUntil(page, () => page.evaluate(() => {
    const attack = window.__panTest.battle.cpu.attack;
    return !!attack && attack.age < .2;
  }));
  await page.keyboard.down('ArrowRight');
  await advanceUntil(page, () => page.locator('#play-tip').evaluate(e => e.textContent!.includes('3 / 3')));
  await page.keyboard.up('ArrowRight'); await page.keyboard.press('Space');
  await advanceUntil(page, () => page.getByRole('heading', { name: 'いい構え！' }).isVisible());
  await expect(page.getByRole('heading', { name: 'いい構え！' })).toBeVisible();
  expect((await page.evaluate(() => window.__panDiagnostics())).hp).toEqual([100, 100]);
  expect(await page.evaluate(() => Object.keys(window.__panTest.save.data.best))).toEqual([]);
  await page.getByRole('button', { name: 'もう一度練習' }).click(); await expect(page.locator('#play-tip')).toContainText('1 / 3');
  await page.getByRole('button', { name: '練習をスキップ' }).click(); await page.clock.runFor(3100);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
});
test('synthetic sensor stream: permission, calibration, attack once, data loss, and late permission cancellation', async ({ page }) => {
  await bootWithClock(page);
  await page.evaluate(() => {
    (window.DeviceMotionEvent as any).requestPermission = () => Promise.resolve('granted');
    (window.DeviceOrientationEvent as any).requestPermission = () => Promise.resolve('granted');
    (window as any).testAcceleration = 0;
    (window as any).sensorTimer = setInterval(() => {
      const motion = new Event('devicemotion'); Object.defineProperty(motion, 'acceleration', { value: { x: (window as any).testAcceleration, y: 0, z: 0 } }); window.dispatchEvent(motion);
      const orientation = new Event('deviceorientation'); Object.defineProperty(orientation, 'gamma', { value: 0 }); window.dispatchEvent(orientation);
    }, 16);
  });
  await page.getByRole('button', { name: '食卓で勝負する →' }).click(); await page.getByRole('button', { name: '動きの利用を許可する' }).click();
  await advanceUntil(page, () => page.getByText('動き・傾きの入力を受信しています ✓').isVisible());
  await expect(page.getByText('動き・傾きの入力を受信しています ✓')).toBeVisible(); await page.getByRole('button', { name: 'この位置で開始' }).click(); await fight(page, true);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; }); await page.clock.runFor(300);
  await page.evaluate(() => { (window as any).testAcceleration = 8; }); await page.clock.runFor(70);
  await page.evaluate(() => { (window as any).testAcceleration = -9; }); await page.clock.runFor(70);
  await page.evaluate(() => { (window as any).testAcceleration = 0; }); await page.clock.runFor(600);
  await expect(page.locator('#cpu-hp')).toHaveText('82');
  expect((await page.evaluate(() => window.__panDiagnostics())).sensorAttacks).toBe(1);
  await page.evaluate(() => clearInterval((window as any).sensorTimer)); await page.clock.runFor(850);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
  await expect(page.getByText(/動きの入力が途切れました/)).toBeVisible();
  await page.getByRole('button', { name: '操作方式を選び直す', exact: true }).click();
  await page.getByRole('button', { name: '動きの利用を許可する' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'タッチ操作', exact: true }).click();
  // Deliver a late successful sample to the abandoned request.
  await page.evaluate(() => {
    const m = new Event('devicemotion'); Object.defineProperty(m, 'acceleration', { value: { x: 0, y: 0, z: 0 } }); window.dispatchEvent(m);
    const o = new Event('deviceorientation'); Object.defineProperty(o, 'gamma', { value: 0 }); window.dispatchEvent(o);
  });
  await page.clock.runFor(200); expect((await page.evaluate(() => window.__panDiagnostics())).mode).toBe('touch');
});
for (const gravitySign of [-1, 1]) test(`portrait gravity sign ${gravitySign}: permission, calibration, tilt, attack and orientation fallback`, async ({ page }, testInfo) => {
  await bootWithClock(page);
  await page.evaluate(sign => {
    (window.DeviceMotionEvent as any).requestPermission = () => Promise.resolve('granted');
    (window.DeviceOrientationEvent as any).requestPermission = () => Promise.resolve('granted');
    const fixture = (window as any).portraitSensor = { roll: 0, acceleration: 0, flat: false };
    setInterval(() => {
      const radians = fixture.roll * Math.PI / 180;
      const motion = new Event('devicemotion');
      Object.defineProperty(motion, 'acceleration', { value: { x: fixture.acceleration, y: 0, z: 0 } });
      Object.defineProperty(motion, 'accelerationIncludingGravity', { value: {
        x: fixture.acceleration - (fixture.flat ? 0 : sign * 9.8 * Math.sin(radians)),
        y: fixture.flat ? 0 : sign * 9.8 * Math.cos(radians), z: fixture.flat ? sign * 9.8 : 0,
      } });
      window.dispatchEvent(motion);
      const orientation = new Event('deviceorientation');
      Object.defineProperty(orientation, 'gamma', { value: fixture.flat ? -20 : 0 });
      window.dispatchEvent(orientation);
    }, 16);
  }, gravitySign);
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByRole('button', { name: '動きの利用を許可する' }).click();
  await advanceUntil(page, () => page.getByText('動き・傾きの入力を受信しています ✓').isVisible());
  await expect(page.getByText('動き・傾きの入力を受信しています ✓')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sensor-ready.png') });
  await page.getByRole('button', { name: 'この位置で開始' }).click(); await fight(page, true);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; (window as any).portraitSensor.roll = 25; });
  await advanceUntil(page, () => page.evaluate(() => window.__panTest.battle.player.x > .8));
  await page.evaluate(() => { (window as any).portraitSensor.roll = 0; });
  await advanceUntil(page, () => page.evaluate(() => Math.abs(window.__panTest.battle.player.x) < .1));
  await page.evaluate(() => { (window as any).portraitSensor.acceleration = 8; });
  await page.clock.runFor(700);
  await expect(page.locator('#cpu-hp')).toHaveText('82');
  await page.evaluate(() => { (window as any).portraitSensor.acceleration = 0; (window as any).portraitSensor.flat = true; });
  await advanceUntil(page, () => page.evaluate(() => window.__panTest.battle.player.x < -.5));
  expect((await page.evaluate(() => window.__panDiagnostics())).sensorAttacks).toBe(1);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
});
for (const width of [360, 390, 430]) test(`all bread silhouettes stay within portrait view at lateral extremes, attack and recoil at ${width}px`, async ({ page }, testInfo) => {
  await boot(page); await select(page); await fight(page);
  // Resizing forces a slow software-rendered frame; this test measures framing, not the long-frame pause.
  await page.evaluate(() => { window.__panTest.stallPause = false; });
    await page.setViewportSize({ width, height: 844 });
    for (const bread of ['shokupan', 'francepan', 'croissant']) for (const x of [-1.15, 0, 1.15]) for (const state of ['ready', 'attack', 'recoil']) {
      await page.evaluate(({ bread, x, state }) => {
        const b = window.__panTest.battle;
        b.player.bread = b.cpu.bread = bread; b.player.x = x; b.cpu.x = -x; b.player.attack = b.cpu.attack = null;
        b.player.recoil = b.cpu.recoil = 0;
        if (state === 'attack') { b.attack('player'); b.attack('cpu'); b.player.attack.age = b.player.attack.windup + .14; b.cpu.attack.age = b.cpu.attack.windup + .14; }
        if (state === 'recoil') b.player.recoil = b.cpu.recoil = .19;
        b.advance = () => {}; b.cpuEnabled = false;
      }, { bread, x, state });
      await page.waitForTimeout(50);
      const bounds = await page.evaluate(() => window.__panTest.renderer.projectedBounds());
      for (const [side, box] of Object.entries(bounds) as [string, any][]) {
        expect(box.left, `${width}/${bread}/${x}/${state}/${side} left`).toBeGreaterThan(0);
        expect(box.right, `${width}/${bread}/${x}/${state}/${side} right`).toBeLessThan(1);
        expect(box.top, `${width}/${bread}/${x}/${state}/${side} HUD`).toBeGreaterThan(.19);
        expect(box.bottom, `${width}/${bread}/${x}/${state}/${side} controls`).toBeLessThan(.82);
      }
      if (width === 390 && x === 0) await page.screenshot({ path: testInfo.outputPath(`${bread}-${state}.png`) });
    }
});
test('three rematches compare past records, persist after reload and never save an abandoned match', async ({ page }, testInfo) => {
  test.setTimeout(process.env.CI ? 120000 : 60000); // three full matches plus finish/replay presentation
  await boot(page); await select(page); await fight(page);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(i => {
      const b = window.__panTest.battle; b.cpuEnabled = false;
      b.scores.dodge = { success: i + 1, opportunities: 3 }; b.scores.counter = { success: i, opportunities: 2 };
      b.elapsed = 59.99;
    }, i);
    await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'result');
    if (i === 0) await expect(page.getByText('記録なし', { exact: true })).toHaveCount(2);
    else await expect(page.getByText('自己ベスト更新', { exact: true })).toHaveCount(2);
    if (i === 0) { await page.getByText('この試合の動作計測', { exact: true }).click(); await expect(page.locator('.diagnostics pre')).toContainText('対象なし（攻撃入力なし）'); }
    if (i === 2) await page.screenshot({ path: testInfo.outputPath('result.png') });
    await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click();
    await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle', { timeout: 6000 });
    expect((await page.evaluate(() => window.__panDiagnostics())).hp).toEqual([100, 100]);
  }
  const saved = await page.evaluate(() => localStorage.getItem('panbattle.3d.v1'));
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'この対戦を終了してタイトルへ' }).click();
  expect(await page.evaluate(() => localStorage.getItem('panbattle.3d.v1'))).toBe(saved);
  await page.reload(); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  expect(await page.evaluate(() => JSON.stringify(window.__panTest.save.data))).toBe(saved);
});
