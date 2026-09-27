import { test, expect, type Page } from '@playwright/test';

async function start(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click(); await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  await page.clock.runFor(3100);
}

test('damage, anticipation, crumbs and rematch stay visual and reset for every bread', async ({ page }, info) => {
  await start(page);
  for (const bread of ['shokupan', 'francepan', 'croissant']) {
    const result = await page.evaluate(bread => {
      const { battle: b, renderer: r } = window.__panTest;
      b.cpuEnabled = false; b.advance = () => {}; b.player.bread = b.cpu.bread = bread;
      b.player.hp = b.cpu.hp = 100; b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0;
      r.resetEffects(true); r.render(b, 0, 0, true);
      const template = Array.from(r.templates.get(bread).mesh.geometry.attributes.position.array);
      const original = Array.from(r.actors.cpu.mesh.geometry.attributes.color.array);
      b.cpu.hp = 25; const frozen = JSON.stringify(b.state);
      for (let i = 0; i < 8; i++) { r.effect({ id: 1000 + i, kind: 'hit', side: 'player', x: 0, z: -1 }); r.render(b, 0, 0, true); }
      const stage = r.actors.cpu.stage, colored = Array.from(r.actors.cpu.mesh.geometry.attributes.color.array);
      const bounded = r.crumbs.length <= 48;
      for (let i = 0; i < 150; i++) r.render(b, 0, .01, true);
      const resting = r.crumbs.some((c: any) => c.mesh.position.y === .04);
      const stateUnchanged = JSON.stringify(b.state) === frozen;
      r.resetEffects(true); const cleared = r.crumbs.length === 0;
      const reset = Array.from(r.actors.cpu.mesh.geometry.attributes.color.array);
      b.cpu.hp = 100; b.attack('cpu'); b.cpu.attack.age = b.cpu.attack.windup / 2;
      r.render(b, 0, 0, true);
      const anticipation = r.actors.cpu.mesh.rotation.x, ring = r.marker.visible;
      return { stage, darker: colored.every((v: any, i: number) => v < (original[i] as number)), bounded, resting, stateUnchanged, cleared,
        restored: JSON.stringify(reset) === JSON.stringify(original), templateIntact: JSON.stringify(template) === JSON.stringify(Array.from(r.templates.get(bread).mesh.geometry.attributes.position.array)), anticipation, ring };
    }, bread);
    expect(result).toMatchObject({ stage: 3, darker: true, bounded: true, resting: true, stateUnchanged: true, cleared: true, restored: true, templateIntact: true, ring: true });
    expect(result.anticipation).toBeLessThan(-.06);
    await page.evaluate(() => { window.__panTest.battle.cpu.hp = 25; }); await page.clock.runFor(32);
    await page.screenshot({ path: info.outputPath(`${bread}-damage.png`) });
  }
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'この対戦を終了してタイトルへ' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'title'); await page.clock.runFor(32);
  expect(await page.evaluate(() => Object.values(window.__panTest.renderer.actors).every((a: any) => a.stage === 0))).toBe(true);
});

for (const width of [360, 430]) test(`CPU KO replays without combat updates, skips by keyboard and saves a result image at ${width}px`, async ({ page }, info) => {
  test.setTimeout(process.env.CI ? 120000 : 60000); // KO, finish, replay, pause, share and rematch in one scenario
  await page.setViewportSize({ width, height: 740 }); await start(page);
  await page.evaluate(() => {
    const { battle: b, save } = window.__panTest; b.cpuEnabled = false; b.cpu.hp = 18;
    b.scores.dodge = { success: 2, opportunities: 3 }; b.scores.counter = { success: 1, opportunities: 2 };
    const record = save.record.bind(save); (window as any).recordCount = 0;
    save.record = (...args: any[]) => { (window as any).recordCount++; return record(...args); };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await page.clock.runFor(2100); await page.keyboard.press('Space'); await page.clock.runFor(400);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'finish');
  await expect(page.locator('.finish-banner strong')).toHaveText('K.O.!'); await expect(page.locator('.finish-banner span')).toHaveText('YOU WIN');
  await page.screenshot({ path: info.outputPath('finish.png') });
  await page.clock.runFor(1900); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay');
  const frozen = await page.evaluate(() => JSON.stringify(window.__panTest.battle.state));
  const metrics = await page.evaluate(() => window.__panDiagnostics().metrics.frames);
  await page.screenshot({ path: info.outputPath('replay.png') });
  await page.clock.runFor(700); await page.keyboard.press('Space'); await page.clock.runFor(100);
  expect(await page.evaluate(() => JSON.stringify(window.__panTest.battle.state))).toBe(frozen);
  expect(await page.evaluate(() => window.__panDiagnostics().metrics.frames)).toBe(metrics);
  await page.keyboard.press('Escape'); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
  await page.clock.runFor(800); expect(await page.evaluate(() => JSON.stringify(window.__panTest.battle.state))).toBe(frozen);
  await page.getByRole('button', { name: '再開する →' }).click(); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay');
  const skip = page.getByRole('button', { name: 'リプレイをスキップ →' }); await skip.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'こんがり、勝利！' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).recordCount)).toBe(1);
  await expect(page.getByText('2成功 / 3機会', { exact: true })).toBeVisible();
  const share = page.getByRole('button', { name: '結果を画像で共有・保存', exact: true }); await expect(share).toBeEnabled();
  const download = page.waitForEvent('download'); await share.click(); const image = await download;
  expect(image.suggestedFilename()).toBe('panbattle-result.png'); await image.saveAs(info.outputPath('result-share.png'));
  await page.screenshot({ path: info.outputPath('result.png') });
  await page.getByText('この試合の動作計測', { exact: true }).click();
  await expect(page.locator('.diagnostics pre')).toContainText('振りの強さ：対象なし（センサー入力なし）');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click(); await page.clock.runFor(3100);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
  expect(await page.evaluate(() => Object.values(window.__panTest.renderer.actors).every((a: any) => a.stage === 0))).toBe(true);
});

test('result diagnostics show sensor peaks and calibrated tilt without persisting samples', async ({ page }, info) => {
  await start(page);
  await page.evaluate(async () => {
    const { input, battle } = window.__panTest; battle.cpuEnabled = false;
    (window.DeviceMotionEvent as any).requestPermission = async () => 'granted'; (window.DeviceOrientationEvent as any).requestPermission = async () => 'granted';
    const send = (roll: number, acceleration: number) => {
      const angle = roll * Math.PI / 180, event = new Event('devicemotion');
      Object.defineProperties(event, { acceleration: { value: { x: acceleration, y: 0, z: 0 } },
        accelerationIncludingGravity: { value: { x: acceleration - 9.8 * Math.sin(angle), y: 9.8 * Math.cos(angle), z: 0 } } });
      window.dispatchEvent(event);
    };
    const permission = input.request(); send(10, 0); await permission;
    input.sensor.calibrate(performance.now()); input.mode = 'sensor'; input.sensor.attackSensitivity = window.__panTest.save.data.attackSensitivity = 1.4;
    send(-10, 9); send(35, 12); battle.elapsed = 59.99;
  });
  await page.clock.runFor(32); await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
  await page.getByText('この試合の動作計測', { exact: true }).click();
  await expect(page.locator('.diagnostics pre')).toContainText('振りの強さ：最大 12.0 m/s²');
  await expect(page.locator('.diagnostics pre')).toContainText('攻撃しきい値（設定） 5.0 m/s²');
  await expect(page.locator('.diagnostics pre')).toContainText('左右傾き（構え基準）：-20.0〜25.0度');
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('panbattle.3d.v1')!)).some(key => /metrics|swing|threshold/i.test(key)))).toBe(false);
  await page.screenshot({ path: info.outputPath('sensor-diagnostics.png') });
});

test('final seconds heartbeat, automatic replay completion and reduced motion remain bounded', async ({ page }, info) => {
  test.setTimeout(process.env.CI ? 120000 : 60000); // two full endings (normal and reduced motion) with finish and replay
  await start(page);
  await page.evaluate(() => {
    const { battle: b, renderer: r } = window.__panTest; b.cpuEnabled = false; b.elapsed = 49.9;
    (window as any).endSounds = []; r.playSound = (sound: string) => (window as any).endSounds.push(sound);
  });
  await page.clock.runFor(300); await expect(page.locator('#timer')).toHaveClass('timer urgent');
  expect(await page.evaluate(() => (window as any).endSounds)).toEqual(['heartbeat']);
  await page.screenshot({ path: info.outputPath('final-seconds.png') });
  await page.clock.runFor(1800); await page.evaluate(() => { window.__panTest.battle.elapsed = 59.99; }); await page.clock.runFor(32);
  await expect(page.locator('.finish-banner strong')).toHaveText('TIME UP'); await page.clock.runFor(1600);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay'); await page.clock.runFor(4500);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'result');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click(); await page.clock.runFor(3100);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; window.__panTest.battle.elapsed = 50; }); await page.clock.runFor(32);
  await expect(page.locator('#timer')).toHaveCSS('animation-name', 'none');
  await page.evaluate(() => {
    const r = window.__panTest.renderer; r.effect({ id: 5000, kind: 'counter', side: 'player', x: 0, z: 0 }); r.effect({ id: 5001, kind: 'hit', side: 'player', x: 0, z: 0 });
  }); await page.clock.runFor(80);
  expect(await page.evaluate(() => window.__panTest.renderer.camera.position.toArray())).toEqual([.9, 5.8, 7.1]);
  expect(await page.evaluate(() => window.__panTest.renderer.crumbs.length)).toBe(0);
  await page.evaluate(() => { window.__panTest.battle.elapsed = 59.99; }); await page.clock.runFor(32);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'finish'); await page.clock.runFor(700);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay'); await page.clock.runFor(400);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'result');
});

test('difficulty, damage numbers, rank and title sound toggle', async ({ page }, info) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  const toggle = page.getByRole('button', { name: /^音 / });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await toggle.click();
  await expect(page.getByRole('button', { name: '音 オン' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.__panTest.save.data.sound)).toBe(true);
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await expect(page.locator('.bread-thumb')).toHaveCount(3);
  await page.getByRole('button', { name: 'つよい' }).click();
  await expect(page.getByRole('button', { name: 'つよい' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('つよいCPU · キーボード · 60秒 · 相手も回避します')).toBeVisible();
  await page.screenshot({ path: info.outputPath('select.png') });
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click(); await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  await expect(page.locator('.countdown em')).toHaveText('つよいCPU · 食パン');
  await page.clock.runFor(3100);
  expect(await page.evaluate(() => window.__panTest.battle.difficulty)).toBe('hard');
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 18; });
  await page.keyboard.press('Space'); await page.clock.runFor(400);
  await expect(page.locator('.popup.deal')).toHaveText('-18');
  await page.clock.runFor(1600); await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
  await expect(page.locator('.rank-letter')).toHaveText(/^[SABCD]$/);
  await expect(page.locator('.stat').first()).toContainText('100');
  await expect(page.getByText('つよいCPU · キーボード', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(window.__panTest.save.data.bestScoreV2 ?? {}))).toEqual(['table-special-1/shokupan/shokupan/hard/keyboard']);
  await page.screenshot({ path: info.outputPath('result.png'), fullPage: true });
  await expect(page.locator('.next-tip')).toContainText('反撃');
  await page.getByRole('button', { name: '反撃だけ練習する →' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'practice');
  await expect(page.locator('#play-tip')).toContainText('3 / 4');
});
