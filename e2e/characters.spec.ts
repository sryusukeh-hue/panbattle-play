import { test, expect, type Page } from '@playwright/test';

// The six-bread roster (plans/EXECPLAN-CHARACTERS.md): selection screen, the three added breads' faces, their
// special telegraphs as the CPU, and the saved choice. Browser time is fake so screenshots land on known moments.
const NEW = { melonpan: ['メロンパン', 'ころころメロンローラー'], currypan: ['カレーパン', '二度揚げカレーボンバー'], creampan: ['クリームパン', 'ふわっとクリームパーン'] } as const;
const ALL = ['shokupan', 'francepan', 'croissant', 'melonpan', 'currypan', 'creampan'];
async function start(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
}
async function fight(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click(); await page.getByRole('button', { name: '練習をスキップして対戦' }).click();
  await page.clock.runFor(3100); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
}
async function runUntil(page: Page, ready: () => Promise<boolean>, limit = 4000): Promise<void> {
  for (let t = 0; t < limit; t += 50) { if (await ready()) return; await page.clock.runFor(50); }
  expect(await ready(), `condition within ${limit} ms`).toBe(true);
}

for (const [width, height] of [[320, 568], [360, 740], [390, 844], [430, 932]] as const) test(`selection shows six face cards and the picked bread's details at ${width}x${height}`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await start(page);
  const cards = page.locator('.bread-card');
  await expect(cards).toHaveCount(6); await expect(page.locator('.bread-card img')).toHaveCount(6);
  await expect(page.getByText('6種類とも、最初から遊べます。')).toBeVisible();
  // Two columns, three rows, nothing wider than the screen.
  const boxes = await cards.evaluateAll(list => list.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
  expect(new Set(boxes.map(b => Math.round(b.x))).size).toBe(2); expect(new Set(boxes.map(b => Math.round(b.y))).size).toBe(3);
  for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.w).toBeLessThanOrEqual(width); expect(box.h).toBeGreaterThanOrEqual(44); }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const [id, [name, special]] of Object.entries(NEW)) {
    await page.locator(`[data-bread="${id}"]`).click();
    await expect(page.locator(`[data-bread="${id}"]`)).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator(`[data-bread="${id}"]`)).toBeFocused();
    await expect(page.locator('[aria-pressed="true"].bread-card')).toHaveCount(1);
    await expect(page.locator('#bread-detail > b')).toHaveText(name); await expect(page.locator('.bread-special b')).toHaveText(special);
    await expect(page.locator('#bread-detail .pips')).toHaveCount(5);
    await page.locator('#opponent').selectOption(id); await expect(page.locator('#opponent-tip')).toContainText(special);
    if (id === 'melonpan') await page.screenshot({ path: info.outputPath(`select-${width}.png`), fullPage: true });
  }
  // The start button can always be reached (the sheet scrolls on short screens).
  const startButton = page.getByRole('button', { name: 'まずは短い練習へ →' }); await startButton.scrollIntoViewIfNeeded(); await expect(startButton).toBeInViewport();
  expect(errors).toEqual([]);
});

test('ability pips use fixed ranges: the strongest hitter and the quickest recovery show five', async ({ page }) => {
  await start(page);
  const pips = async (id: string): Promise<Record<string, number>> => {
    await page.locator(`[data-bread="${id}"]`).click();
    return page.locator('#bread-detail .pips').evaluateAll(list => Object.fromEntries(list.map(e => { const [name, value] = e.getAttribute('aria-label')!.split(' '); return [name, Number(value!.split('/')[0])]; })));
  };
  expect(await pips('currypan')).toMatchObject({ パワー: 5, 戻りの速さ: 1, とどく長さ: 1 });
  expect(await pips('creampan')).toMatchObject({ 出の速さ: 1, 戻りの速さ: 5, 横の広さ: 5 });
  expect(await pips('francepan')).toMatchObject({ とどく長さ: 5, 横の広さ: 1 });
  expect(await pips('croissant')).toMatchObject({ 出の速さ: 5 });
});

test('each added bread shows its face as the CPU, telegraphs its special in red, and the special can be dodged', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await start(page); await fight(page);
  for (const [id, [, special]] of Object.entries(NEW)) {
    await page.evaluate(id => {
      const b = window.__panTest.battle; b.cpuEnabled = true; b.cpu.bread = id; b.player.hp = b.cpu.hp = 100; b.player.x = b.cpu.x = 0; b.cpuTarget = 0;
      b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0; b.player.meter = 0; b.cpu.meter = 0; b.nextCpu = 1e9; b.nextMove = 1e9; b.rageUsed = true;
    }, id);
    await page.clock.runFor(300);
    // Eyes sit on the surface of the new models: both anchors were found and the decal has triangles.
    const face = await page.evaluate(() => { const t = window.__panTest.renderer.actors.cpu.face; return { eyes: t.eyes.filter(Boolean).length, decal: t.decal?.index.length ?? 0 }; });
    expect(face.eyes).toBe(2); expect(face.decal).toBeGreaterThan(30);
    await page.screenshot({ path: info.outputPath(`${id}-face.png`) });
    await page.evaluate(() => { const b = window.__panTest.battle; b.cpu.meter = 100; b.fullSince = -10; b.nextCpu = 0; });
    await runUntil(page, async () => page.evaluate(() => !!window.__panTest.battle.cpu.attack?.special), 1500);
    await page.clock.runFor(150);
    await expect(page.locator('#cutin strong')).toHaveText(special);
    await page.screenshot({ path: info.outputPath(`${id}-cutin.png`) });
    await page.clock.runFor(900);
    const marks = await page.evaluate(id => window.__panTest.renderer.marks.cpu[id].filter((m: any) => m.visible).length, id);
    expect(marks).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: info.outputPath(`${id}-telegraph.png`) });
    await page.keyboard.down('ArrowRight');
    await runUntil(page, async () => page.evaluate(() => !window.__panTest.battle.cpu.attack?.special), 5000);
    await page.keyboard.up('ArrowRight');
    const after = await page.evaluate(() => { const b = window.__panTest.battle; return { hp: b.player.hp, meter: b.player.meter }; });
    expect(after).toEqual({ hp: 100, meter: 30 });
    expect(await page.evaluate(() => Object.values(window.__panTest.renderer.marks.cpu).flat().some((m: any) => m.visible))).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('each added bread lands its special as the player, with its own strike shape', async ({ page }, info) => {
  test.setTimeout(90_000);
  await start(page); await fight(page);
  for (const id of Object.keys(NEW)) {
    await page.evaluate(id => {
      const b = window.__panTest.battle; b.cpuEnabled = false; b.player.bread = id; b.cpu.bread = 'shokupan'; b.player.hp = b.cpu.hp = 100; b.player.x = b.cpu.x = 0;
      b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0; b.player.meter = 100;
    }, id);
    await page.clock.runFor(200); await page.keyboard.press('KeyX'); await page.clock.runFor(700);
    await runUntil(page, async () => page.evaluate(() => window.__panTest.battle.cpu.hp < 100));
    await page.clock.runFor(50); await page.screenshot({ path: info.outputPath(`${id}-strike.png`) });
    await runUntil(page, async () => page.evaluate(() => !window.__panTest.battle.player.attack));
  }
});

test('the melon pan fills its meter with three dodges', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page); await page.locator('[data-bread="melonpan"]').click(); await fight(page);
  for (let i = 1; i <= 3; i++) {
    await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = true; b.player.x = b.cpu.x = 0; b.cpuTarget = 0; b.nextMove = 1e9; b.nextCpu = 0; b.rageUsed = true; });
    await runUntil(page, async () => page.evaluate(() => !!window.__panTest.battle.cpu.attack));
    await page.evaluate(() => { window.__panTest.battle.nextCpu = 1e9; });
    await page.keyboard.down('ArrowRight');
    await runUntil(page, async () => page.evaluate(() => !window.__panTest.battle.cpu.attack), 5000);
    await page.keyboard.up('ArrowRight');
    expect(await page.evaluate(() => window.__panTest.battle.player.meter)).toBe(Math.min(100, 35 * i));
  }
  await expect(page.locator('#special')).toHaveText('ひっさつ！');
});

test('a picked new bread and opponent survive a reload and start a match', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await start(page);
  await page.locator('[data-bread="currypan"]').click(); await page.locator('#opponent').selectOption('creampan');
  expect(await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('panbattle.3d.v1')!); return [s.bread, s.cpu]; })).toEqual(['currypan', 'creampan']);
  await page.reload(); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await expect(page.locator('#save-warning')).toBeHidden();
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await expect(page.locator('[data-bread="currypan"]')).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('#opponent')).toHaveValue('creampan');
  await fight(page);
  await expect(page.locator('.health').first()).toContainText('カレーパン'); await expect(page.locator('.health.enemy')).toContainText('クリームパン');
  expect(await page.evaluate(() => Object.keys(window.__panTest.renderer.marks.player))).toEqual(ALL);
  expect(errors).toEqual([]);
});

const TIPS = { melonpan: '輪が消えるまで、戻らず待とう', currypan: '丸が2つとも消えるまで、戻らず待とう', creampan: '赤い輪の外まで逃げよう' } as const;
for (const [id, tip] of Object.entries(TIPS)) test(`special drill against a ${id} CPU: the tip says how to dodge it, a partial dodge does not pass, real input completes it`, async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(value => localStorage.setItem('panbattle.3d.v1', value), JSON.stringify({ version: 1, sound: false, sensitivity: 1, bread: 'shokupan', cpu: id, practiced: true, best: {} }));
  await start(page);
  await page.getByRole('button', { name: 'NEW! ひっさつだけ練習する' }).click();
  await expect(page.locator('#play-tip')).toContainText('4 / 4'); await expect(page.locator('#play-tip')).toContainText(tip);
  const step = (): Promise<string> => page.evaluate(() => window.__panTest.battle.specialStep);
  const cpuSpecial = (): Promise<boolean> => page.evaluate(() => !!window.__panTest.battle.cpu.attack?.special);
  // First time: stand still and take it. The drill must not move on.
  await runUntil(page, cpuSpecial, 5000); await runUntil(page, async () => !(await cpuSpecial()), 6000);
  expect(await step()).toBe('dodge'); expect(await page.evaluate(() => window.__panTest.battle.player.hp)).toBe(100);
  if (id === 'melonpan' || id === 'currypan') {
    // Second time: step out, then come back before the last hit window closes. Still no pass.
    await runUntil(page, cpuSpecial, 5000);
    await page.keyboard.down('ArrowRight');
    await runUntil(page, async () => page.evaluate(() => { const b = window.__panTest.battle; return b.cpu.attack.age >= b.cpu.attack.windup + .05; }), 4000);
    await page.keyboard.up('ArrowRight');
    await runUntil(page, async () => !(await cpuSpecial()), 6000);
    expect(await step()).toBe('dodge');
  }
  // Then do what the tip says: out, and stay out until it is over.
  await runUntil(page, cpuSpecial, 5000);
  await page.keyboard.down('ArrowRight'); await runUntil(page, async () => (await step()) === 'fire', 6000); await page.keyboard.up('ArrowRight');
  await expect(page.locator('#play-tip')).toContainText('ひっさつを当てよう');
  await runUntil(page, async () => page.evaluate(() => { const b = window.__panTest.battle; return Math.abs(b.player.x - b.cpu.x) < .05 && b.canSpecial('player'); }), 5000);
  await page.keyboard.press('KeyX');
  await runUntil(page, async () => page.evaluate(() => window.__panTest.screen === 'practice-done'), 6000);
  await expect(page.getByText('ひっさつのコツをつかめました')).toBeVisible();
});

test('telegraphs mean what they show: curry dots count down 2-1-0, the cream patch follows the swipe on both sides', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page); await fight(page);
  const fire = async (side: 'player' | 'cpu', bread: string): Promise<void> => {
    await page.evaluate(({ side, bread }) => {
      const b = window.__panTest.battle; b.cpuEnabled = false; b.player.hp = b.cpu.hp = 100; b.player.x = b.cpu.x = .2;
      b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0; b[side].bread = bread; b[side].meter = 100;
      b.special(side, side === 'cpu' ? .35 : 0);
    }, { side, bread });
    await page.clock.runFor(700); // the cut-in
  };
  const shown = (side: string, bread: string): Promise<number[]> => page.evaluate(({ side, bread }) => window.__panTest.renderer.marks[side][bread].map((m: any) => m.visible ? 1 : 0), { side, bread });
  const tick = (side: string): Promise<number> => page.evaluate(side => { const a = window.__panTest.battle[side].attack; return a ? Math.round((a.age - a.special.extra) * 120) : 999; }, side);
  // Curry as the CPU with the gentle wind-up stretch: ring + fill stay through the gap, dots go out one by one.
  await fire('cpu', 'currypan');
  await runUntil(page, async () => (await tick('cpu')) >= 40); expect(await shown('cpu', 'currypan')).toEqual([1, 1, 1, 1]);
  await runUntil(page, async () => (await tick('cpu')) >= 90); expect(await tick('cpu')).toBeLessThan(130); expect(await shown('cpu', 'currypan')).toEqual([1, 1, 0, 1]);
  await runUntil(page, async () => (await tick('cpu')) >= 150); expect(await shown('cpu', 'currypan')).toEqual([0, 0, 0, 0]);
  await runUntil(page, async () => page.evaluate(() => !window.__panTest.battle.cpu.attack), 4000);
  // Cream: the bright patch sits where the bread is; the arrow points the way it travels (mirrored for the CPU).
  for (const side of ['player', 'cpu'] as const) {
    await fire(side, 'creampan');
    const sign = side === 'player' ? 1 : -1, xs: number[] = [];
    for (let i = 0; i < 40; i++) {
      await page.clock.runFor(50);
      const sample = await page.evaluate(side => {
        const { battle: b, renderer: r } = window.__panTest, a = b[side].attack;
        if (!a?.special || a.age < a.windup || a.age >= a.windup + .35) return null;
        const [outline, fill, arrow] = r.marks[side].creampan;
        return { fill: fill.position.x, bread: r.actors[side].mesh.position.x, aim: a.aim, outline: outline.position.x, half: outline.scale.x, arrow: arrow.position.x };
      }, side);
      if (!sample) continue;
      expect(sample.fill).toBeCloseTo(sample.bread, 5); expect(sample.outline).toBe(sample.aim);
      expect(Math.abs(sample.bread - sample.aim)).toBeLessThanOrEqual(.28 + 1e-6); expect(sample.half).toBeGreaterThan(.28 + .4);
      expect(Math.sign(sample.arrow - sample.aim)).toBe(sign);
      xs.push((sample.bread - sample.aim) * sign);
    }
    expect(xs.length).toBeGreaterThan(3); expect(xs[0]!).toBeLessThan(xs.at(-1)!); // moves toward the arrow
    await runUntil(page, async () => page.evaluate(side => !window.__panTest.battle[side].attack, side), 4000);
  }
});

test('pausing inside each new special keeps time, HP and marks, and nothing plays twice after resuming', async ({ page }) => {
  test.setTimeout(90_000);
  await start(page); await fight(page);
  for (const [id, at] of [['melonpan', 110], ['currypan', 100], ['creampan', 95]] as const) {
    await page.evaluate(id => {
      const b = window.__panTest.battle; b.cpuEnabled = false; b.player.bread = id; b.player.hp = b.cpu.hp = 100; b.player.x = b.cpu.x = 0;
      b.player.attack = b.cpu.attack = null; b.player.recoil = b.cpu.recoil = 0; b.player.meter = 100;
    }, id);
    await page.clock.runFor(200); await page.keyboard.press('KeyX'); await page.clock.runFor(700);
    await runUntil(page, async () => page.evaluate(at => Math.round(window.__panTest.battle.player.attack.age * 120) >= at, at));
    const snapshot = (): Promise<{ elapsed: number }> => page.evaluate(id => {
      const { battle: b, renderer: r } = window.__panTest;
      return { elapsed: b.elapsed, hp: b.cpu.hp, mask: b.player.attack?.special.mask, flashed: r.flashed.player?.mask, marks: r.marks.player[id].map((m: any) => m.visible) };
    }, id);
    const before = await snapshot();
    await page.keyboard.press('Escape'); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause'); await page.clock.runFor(1500);
    await page.getByRole('button', { name: '再開する →' }).click(); await page.clock.runFor(20);
    const after = await snapshot();
    expect({ ...after, elapsed: 0 }).toEqual({ ...before, elapsed: 0 });
    expect(after.elapsed - before.elapsed).toBeLessThan(.05);
    await runUntil(page, async () => page.evaluate(() => !window.__panTest.battle.player.attack), 4000);
    const damage = { melonpan: 26, currypan: 34, creampan: 28 }[id];
    expect(await page.evaluate(() => window.__panTest.battle.cpu.hp)).toBe(100 - damage); // each stage landed exactly once
  }
});

for (const reduced of [false, true]) test(`a new bread's special K.O. plays the replay and a rematch starts clean${reduced ? ' (reduced motion)' : ''}`, async ({ page }) => {
  test.setTimeout(90_000);
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await start(page); await page.locator('[data-bread="creampan"]').click(); await page.locator('#opponent').selectOption('currypan'); await fight(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 20; b.player.meter = 100; });
  await page.clock.runFor(100); await page.keyboard.press('KeyX');
  await runUntil(page, async () => page.evaluate(() => window.__panTest.screen === 'finish'), 4000);
  // Let the finish freeze and the slow replay run on their own.
  await runUntil(page, async () => page.evaluate(() => window.__panTest.screen === 'result'), 12000);
  await expect(page.getByRole('heading', { name: 'こんがり、勝利！' })).toBeVisible();
  await expect(page.locator('.stat', { hasText: 'ひっさつ' }).locator('b')).toHaveText('1/1');
  await page.clock.runFor(200);
  const rest = await page.evaluate(() => { const r = window.__panTest.renderer; return ['player', 'cpu'].map(side => ({ scale: r.actors[side].mesh.scale.toArray(), glow: r.actors[side].mesh.material.emissiveIntensity })); });
  expect(rest).toEqual([{ scale: [1, 1, 1], glow: 0 }, { scale: [1, 1, 1], glow: 0 }]);
  await page.getByRole('button', { name: '同じパンで、もう一戦 →' }).click(); await page.clock.runFor(3100);
  const clean = await page.evaluate(() => {
    const { battle: b, renderer: r } = window.__panTest;
    return { meter: b.player.meter, hp: [b.player.hp, b.cpu.hp], x: r.actors.player.mesh.position.x, marks: Object.values(r.marks.player).flat().some((m: any) => m.visible) };
  });
  expect(clean).toEqual({ meter: 0, hp: [100, 100], x: 0, marks: false });
  expect(errors).toEqual([]);
});
