import { test, expect, type Page } from '@playwright/test';

// Browser time is fake: the cut-in, wind-up and hits are stepped with page.clock so every screenshot lands on a known moment.
const NAMES = { shokupan: '爆熱ギガトースト', francepan: '雷光バゲットブレイカー', croissant: '三日月トルネード' } as const;
const DAMAGE = { shokupan: 32, francepan: 36, croissant: 28 } as const;
async function start(page: Page, mode: 'キーボード' | 'タッチ操作' = 'キーボード', saved?: object): Promise<void> {
  if (saved) await page.addInitScript(value => localStorage.setItem('panbattle.3d.v1', value), JSON.stringify(saved));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: mode, exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
}
async function fight(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click(); await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  await page.clock.runFor(3100); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
}
const state = (page: Page) => page.evaluate(() => {
  const b = window.__panTest.battle;
  return { elapsed: b.elapsed, freezing: b.freezing, playerHp: b.player.hp, cpuHp: b.cpu.hp, playerMeter: b.player.meter, cpuMeter: b.cpu.meter,
    playerSpecial: !!b.player.attack?.special, cpuSpecial: !!b.cpu.attack?.special, screen: window.__panTest.screen };
});
async function runUntil(page: Page, ready: () => Promise<boolean>, limit = 4000): Promise<void> {
  for (let t = 0; t < limit; t += 50) { if (await ready()) return; await page.clock.runFor(50); }
  expect(await ready(), `condition within ${limit} ms`).toBe(true);
}

test('every bread: X starts the cut-in, time freezes, the move lands its fixed damage and the meter resets', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await start(page); await fight(page);
  for (const bread of ['shokupan', 'francepan', 'croissant'] as const) {
    await page.evaluate(bread => {
      const b = window.__panTest.battle; b.cpuEnabled = false; b.player.bread = bread;
      b.player.hp = b.cpu.hp = 100; b.player.x = b.cpu.x = 0; b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0; b.player.meter = 100;
    }, bread);
    await page.clock.runFor(200);
    await expect(page.locator('#special')).toHaveText('ひっさつ！'); await expect(page.locator('#special')).toHaveClass(/ready/);
    await expect(page.locator('#player-meter-tag')).toHaveText('MAX');
    if (bread === 'shokupan') await page.screenshot({ path: info.outputPath('charged.png') });
    await page.keyboard.press('KeyX'); await page.clock.runFor(150);
    const frozen = await state(page);
    expect(frozen).toMatchObject({ freezing: true, playerSpecial: true, playerMeter: 0 });
    await expect(page.locator('#cutin')).toHaveClass(/show player/); await expect(page.locator('#cutin strong')).toHaveText(NAMES[bread]);
    await page.screenshot({ path: info.outputPath(`${bread}-cutin.png`) });
    await page.keyboard.press('Space'); await page.clock.runFor(250);
    expect((await state(page)).elapsed).toBe(frozen.elapsed); // no combat time and no queued swing during the cut-in
    await page.clock.runFor(450);
    await expect(page.locator('#cutin')).not.toHaveClass(/show/);
    await runUntil(page, async () => (await state(page)).cpuHp < 100 || !(await state(page)).playerSpecial);
    await page.clock.runFor(60); await page.screenshot({ path: info.outputPath(`${bread}-impact.png`) });
    await runUntil(page, async () => !(await state(page)).playerSpecial);
    const after = await state(page);
    expect(after.cpuHp).toBe(100 - DAMAGE[bread]); expect(after.playerMeter).toBe(0);
    await expect(page.locator('#special')).toHaveText('ひっさつ 0%');
    expect(await page.evaluate(() => window.__panTest.battle.player.attack)).toBeNull();
  }
  expect(errors).toEqual([]);
});

test('the CPU special shows a red telegraph and a warning, can be dodged, and dodging fills the player meter', async ({ page }, info) => {
  await start(page); await fight(page);
  await page.evaluate(() => {
    const b = window.__panTest.battle; b.cpu.meter = 100; b.fullSince = -10; b.nextCpu = 0; b.nextMove = 99;
  });
  await runUntil(page, async () => (await state(page)).cpuSpecial, 1000);
  await page.clock.runFor(150);
  await expect(page.locator('#cutin')).toHaveClass(/show cpu/); await expect(page.locator('#cutin em')).toHaveText('横へ回避！');
  await page.screenshot({ path: info.outputPath('cpu-cutin.png') });
  await page.clock.runFor(700);
  await expect(page.locator('#battle-status')).toContainText('相手のひっさつ');
  const marks = await page.evaluate(() => Object.values(window.__panTest.renderer.marks.cpu).flat().filter((m: any) => m.visible).length);
  expect(marks).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('cpu-telegraph.png') });
  await page.keyboard.down('ArrowRight');
  await runUntil(page, async () => !(await state(page)).cpuSpecial);
  await page.keyboard.up('ArrowRight');
  const after = await state(page);
  expect(after.playerHp).toBe(100); expect(after.playerMeter).toBe(30);
  expect(await page.evaluate(() => window.__panTest.battle.scores.dodge)).toEqual({ success: 1, opportunities: 1 });
});

test('touch: one special per tap above the attack button, clear refusal when not ready, no overlap with the controls', async ({ page }, info) => {
  await start(page, 'タッチ操作'); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.player.meter = 50; });
  await page.clock.runFor(100);
  const special = page.locator('#special'), attack = page.locator('[data-control="attack"]'), tip = page.locator('#play-tip');
  await expect(special).toHaveText('ひっさつ 50%'); await expect(special).toHaveAttribute('aria-disabled', 'true');
  const [s, a, t] = [await special.boundingBox(), await attack.boundingBox(), await tip.boundingBox()];
  expect(s!.y + s!.height).toBeLessThanOrEqual(a!.y - 8); expect(t!.y + t!.height).toBeLessThanOrEqual(s!.y);
  expect(s!.width).toBeGreaterThanOrEqual(112); expect(s!.height).toBeGreaterThanOrEqual(56);
  const tap = async (): Promise<void> => { const box = (await special.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); };
  await tap(); await page.clock.runFor(50);
  await expect(page.locator('#toast')).toContainText('ゲージがたりない'); expect((await state(page)).playerMeter).toBe(50);
  await page.evaluate(() => { window.__panTest.battle.player.meter = 100; }); await page.clock.runFor(100);
  await page.screenshot({ path: info.outputPath('touch-ready.png') });
  await tap(); await page.clock.runFor(50); await tap(); await page.clock.runFor(50);
  expect(await page.evaluate(() => window.__panTest.battle.drainEvents().filter((e: any) => e.kind === 'special').length)).toBeLessThanOrEqual(1);
  expect(await state(page)).toMatchObject({ playerSpecial: true, playerMeter: 0 });
  // A press that slides off the button is cancelled.
  await page.clock.runFor(3000); await page.evaluate(() => { window.__panTest.battle.player.meter = 100; }); await page.clock.runFor(100);
  const box = (await special.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 120); await page.mouse.up();
  await page.clock.runFor(100); expect((await state(page)).playerMeter).toBe(100);
});

test('existing players get a special-only drill; practice stage 4 refills and completes after a landed special', async ({ page }, info) => {
  await start(page, 'キーボード', { version: 1, sound: false, sensitivity: 1, bread: 'croissant', cpu: 'shokupan', practiced: true, best: {} });
  const drill = page.getByRole('button', { name: 'NEW! ひっさつだけ練習する' });
  await expect(drill).toBeVisible(); await drill.click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'practice');
  await expect(page.locator('#play-tip')).toContainText('4 / 4'); await expect(page.locator('#play-tip')).toContainText('見切ろう');
  await runUntil(page, async () => (await state(page)).cpuSpecial, 4000);
  await page.clock.runFor(700); await page.screenshot({ path: info.outputPath('practice-dodge.png') });
  await page.keyboard.down('ArrowRight');
  await runUntil(page, async () => await page.evaluate(() => window.__panTest.battle.specialStep === 'fire'));
  await page.keyboard.up('ArrowRight'); await page.clock.runFor(100);
  await expect(page.locator('#special')).toHaveText('ひっさつ！'); await expect(page.locator('#play-tip')).toContainText('ひっさつを当てよう');
  await page.screenshot({ path: info.outputPath('practice-special.png') });
  await page.evaluate(() => { const b = window.__panTest.battle; b.player.x = b.cpu.x; });
  await page.keyboard.press('KeyX');
  await runUntil(page, async () => (await state(page)).screen === 'practice-done', 4000);
  await expect(page.getByRole('heading', { name: 'いい構え！' })).toBeVisible(); await expect(page.getByText('ひっさつのコツをつかめました')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('panbattle.3d.v1')!).practicedSpecial)).toBe(true);
  expect((await state(page)).cpuHp).toBe(100);
  await page.getByRole('button', { name: 'パンを選び直す' }).click();
  await expect(drill).toHaveCount(0);
});

test('a special K.O. goes through finish and result, counts once, and a rematch starts clean', async ({ page }, info) => {
  await start(page); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 20; b.player.meter = 100; });
  await page.clock.runFor(100); await page.keyboard.press('KeyX');
  await runUntil(page, async () => (await state(page)).screen !== 'battle', 3000);
  await expect(page.locator('.finish-banner strong')).toHaveText('K.O.!');
  await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
  await expect(page.getByRole('heading', { name: 'こんがり、勝利！' })).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'ひっさつ' }).locator('b')).toHaveText('1/1');
  await page.clock.runFor(200);
  const rest = await page.evaluate(() => { const r = window.__panTest.renderer; return ['player', 'cpu'].map(side => ({ scale: r.actors[side].mesh.scale.toArray(), glow: r.actors[side].mesh.material.emissiveIntensity })); });
  expect(rest).toEqual([{ scale: [1, 1, 1], glow: 0 }, { scale: [1, 1, 1], glow: 0 }]); // the result shows the breads at rest, not frozen mid-move
  await page.screenshot({ path: info.outputPath('result.png') });
  await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click(); await page.clock.runFor(3100);
  const clean = await page.evaluate(() => {
    const { battle: b, renderer: r } = window.__panTest;
    return { meter: b.player.meter, scale: r.actors.player.mesh.scale.toArray(), marks: Object.values(r.marks.player).flat().some((m: any) => m.visible), cutin: document.querySelector('#cutin')!.className };
  });
  expect(clean).toEqual({ meter: 0, scale: [1, 1, 1], marks: false, cutin: '' });
  await expect(page.locator('#special')).toHaveText('ひっさつ 0%');
});

test('reduced motion keeps timing and damage but drops the jump, growth and spin', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await start(page); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.player.meter = 100; });
  await page.clock.runFor(100); await page.keyboard.press('KeyX'); await page.clock.runFor(150);
  await expect(page.locator('#cutin')).toHaveClass(/show/);
  await page.screenshot({ path: info.outputPath('reduced-cutin.png') });
  await page.clock.runFor(450 + 550); // cut-in, then the toast's apex at t≈0.55
  const pose = await page.evaluate(() => { const m = window.__panTest.renderer.actors.player.mesh; return { y: m.position.y, scale: m.scale.toArray() }; });
  expect(pose.scale).toEqual([1, 1, 1]); expect(pose.y).toBeCloseTo(1.43, 2);
  await runUntil(page, async () => !(await state(page)).playerSpecial);
  expect((await state(page)).cpuHp).toBe(100 - DAMAGE.shokupan);
});

test('the special button only appears during play', async ({ page }) => {
  await start(page); await fight(page);
  await expect(page.locator('#special')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#special')).toBeHidden();
  await page.getByRole('button', { name: 'この対戦を終了してタイトルへ' }).click(); await expect(page.locator('#special')).toBeHidden();
});

test('a pause during the cut-in resumes it where it stopped without advancing combat time', async ({ page }) => {
  await start(page); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.player.meter = 100; });
  await page.clock.runFor(100); await page.keyboard.press('KeyX'); await page.clock.runFor(200);
  const before = await state(page); expect(before.freezing).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
  await expect(page.locator('#cutin')).not.toHaveClass(/show/); await page.clock.runFor(1000);
  await page.getByRole('button', { name: '再開する →' }).click(); await page.clock.runFor(50);
  await expect(page.locator('#cutin')).toHaveClass(/show player/);
  const seek = -parseFloat(await page.locator('#cutin').evaluate(e => e.style.getPropertyValue('--seek')));
  expect(seek).toBeGreaterThan(.1); expect(seek).toBeLessThan(.3); // continues from ~0.2 s, not from the start
  expect((await state(page)).elapsed).toBe(before.elapsed);
  await page.clock.runFor(500); expect((await state(page)).freezing).toBe(false);
});

test('simultaneous specials share one split cut-in, and the cut-in fits a 320x568 screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await start(page); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.player.bread = 'francepan'; b.player.meter = 100; b.cpu.meter = 100; b.fullSince = -10; b.nextCpu = 0; b.nextMove = 99; b.cpuTarget = 0; });
  await page.keyboard.press('KeyX'); await page.clock.runFor(150);
  await expect(page.locator('#cutin')).toHaveClass(/show both/); await expect(page.locator('.cutin-band')).toHaveCount(2);
  for (const band of await page.locator('.cutin-text strong').all()) {
    const box = (await band.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: info.outputPath('both-cutin-320.png') });
  await page.clock.runFor(500); await expect(page.locator('#cutin')).toHaveClass(/tail/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
