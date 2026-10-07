import { test, expect, type Page } from '@playwright/test';

const STEP = 1 / 120;
async function start(page: Page, practice = false): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '食卓で勝負する →' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.getByRole('button', { name: '食卓で勝負する →' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click();
  await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await page.getByRole('button', { name: 'まずは短い練習へ →' }).click();
  if (practice) await page.getByRole('button', { name: '練習をはじめる', exact: true }).click();
  else { await page.getByRole('button', { name: '練習をスキップして対戦' }).click(); await page.clock.runFor(3100); }
  await expect(page.locator('#app')).toHaveAttribute('data-screen', practice ? 'practice' : 'battle');
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; });
}
async function untilStop(page: Page): Promise<void> {
  for (let t = 0; t < 3000; t += 16) {
    if (await page.evaluate(() => window.__panTest.battle.hitStopping)) return;
    await page.clock.runFor(16);
  }
  expect(await page.evaluate(() => window.__panTest.battle.hitStopping)).toBe(true);
}
const snapshot = (page: Page) => page.evaluate(() => {
  const { battle: b, renderer: r } = window.__panTest;
  const actor = (side: string) => {
    const a = r.actors[side];
    return { position: a.mesh.position.toArray(), rotation: a.mesh.rotation.toArray(), scale: a.mesh.scale.toArray(),
      vertices: Array.from(a.mesh.geometry.attributes.position.array), face: JSON.parse(JSON.stringify(a.expression)),
      emissive: a.mesh.material.emissive.toArray(), intensity: a.mesh.material.emissiveIntensity };
  };
  return { elapsed: b.elapsed, remaining: b.hitStopRemaining, effectDt: b.frameEffectDt, screen: window.__panTest.screen,
    actors: [actor('player'), actor('cpu')],
    crumbs: r.crumbs.map((c: any) => ({ position: c.mesh.position.toArray(), rotation: c.mesh.rotation.toArray(), life: c.life, vx: c.vx, vy: c.vy, vz: c.vz })),
    accents: r.accents.map((c: any) => ({ position: c.mesh.position.toArray(), scale: c.mesh.scale.toArray(), opacity: c.mesh.material.opacity, life: c.life })),
    impacts: Object.values(r.impacts).map((i: any) => i.life), flashes: { ...r.hitFlashes }, camera: r.camera.position.toArray(),
    shake: r.shake, zoom: r.zoom, replayClock: r.replay.clock, replayCount: r.replay.count };
});
const presentation = (s: Awaited<ReturnType<typeof snapshot>>) => ({ actors: s.actors, crumbs: s.crumbs, accents: s.accents,
  impacts: s.impacts, flashes: s.flashes, camera: s.camera, shake: s.shake, zoom: s.zoom });

for (const practice of [false, true]) test(`real frame loop holds contact, face and particles, then releases them; practice=${practice}`, async ({ page }) => {
  await start(page, practice);
  await page.evaluate(() => {
    const r = window.__panTest.renderer; (window as any).hitSounds = [];
    r.playSound = (sound: string) => (window as any).hitSounds.push(sound);
  });
  await page.keyboard.press('Space'); await untilStop(page);
  const contact = await snapshot(page);
  expect(contact.remaining).toBeCloseTo(12 * STEP); expect(contact.effectDt).toBe(0);
  expect(contact.crumbs).toHaveLength(12); expect(contact.impacts).toEqual([.18, .18]);
  expect(contact.flashes).toMatchObject({ cpu: .04 });
  expect(contact.actors[1]!.emissive).toEqual([1, 1, 1]); expect(contact.actors[0]!.emissive).not.toEqual([1, 1, 1]);
  expect(contact.actors[1]!.intensity).toBe(.30);
  expect(await page.evaluate(() => window.__panTest.renderer.zoomAmount)).toBe(.045);
  await page.clock.runFor(48);
  const held = await snapshot(page);
  expect(held.elapsed).toBe(contact.elapsed); expect(presentation(held)).toEqual(presentation(contact));
  expect(held.replayClock).toBeGreaterThan(contact.replayClock); expect(held.replayCount).toBeGreaterThan(contact.replayCount);
  await page.clock.runFor(112);
  const released = await snapshot(page);
  expect(released.elapsed).toBeGreaterThan(contact.elapsed); expect(released.remaining).toBe(0);
  expect(released.crumbs[0]!.position).not.toEqual(contact.crumbs[0]!.position); expect(released.impacts[0]).toBeLessThan(.18);
  expect(released.actors[1]!.face.clock).toBeGreaterThan(contact.actors[1]!.face.clock);
  expect(await page.evaluate(() => (window as any).hitSounds.filter((s: string) => s === 'hit'))).toEqual(['hit']);
});

test('a 25ms special stage is rendered compressed before any subsequent simulation or particle motion', async ({ page }) => {
  await start(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.player.bread = 'croissant'; b.player.meter = 100; });
  await page.clock.runFor(32); await page.keyboard.press('KeyX'); await untilStop(page);
  const contact = await snapshot(page);
  expect(contact.remaining).toBeCloseTo(3 * STEP); expect(contact.impacts).toEqual([.18]); expect(contact.crumbs).toHaveLength(4);
  await page.clock.runFor(16); expect(presentation(await snapshot(page))).toEqual(presentation(contact));
  await page.clock.runFor(48); const released = await snapshot(page);
  expect(released.elapsed).toBeGreaterThan(contact.elapsed); expect(released.crumbs[0]!.position).not.toEqual(contact.crumbs[0]!.position);
});

test('counter and boss guard keep their distinct stop and zoom, with no guard flash', async ({ page }) => {
  await start(page);
  await page.evaluate(() => { window.__panTest.battle.state.counters.A = { available: true, until: 10 }; });
  await page.keyboard.press('Space'); await untilStop(page);
  expect((await snapshot(page)).remaining).toBeCloseTo(16 * STEP);
  expect(await page.evaluate(() => window.__panTest.renderer.zoomAmount)).toBe(.075);
  await page.clock.runFor(1200);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpu.bread = 'ikkin'; b.cpu.hp = 180; b.state.guard = .25; window.__panTest.renderer.resetEffects(); });
  await page.clock.runFor(32); await page.keyboard.press('Space'); await untilStop(page);
  const guarded = await snapshot(page);
  expect(guarded.remaining).toBeCloseTo(4 * STEP); expect(guarded.crumbs).toHaveLength(3);
  expect(guarded.flashes.cpu ?? 0).toBe(0); expect(await page.evaluate(() => window.__panTest.renderer.zoomAmount)).toBe(0);
});

test('stopped inputs are dropped, Escape retains remaining time, and resume does not replay the hit sound', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const b = window.__panTest.battle; b.cpu.bread = 'croissant'; b.cpu.meter = 100; b.player.meter = 100;
    const r = window.__panTest.renderer; (window as any).hitSounds = []; r.playSound = (s: string) => (window as any).hitSounds.push(s);
    b.special('cpu');
  });
  await untilStop(page); const left = (await snapshot(page)).remaining;
  await page.keyboard.press('Space'); await page.keyboard.press('KeyX'); await page.keyboard.down('ArrowRight');
  await page.clock.runFor(48);
  expect(await page.evaluate(() => ({ attack: window.__panTest.battle.player.attack, meter: window.__panTest.battle.player.meter, x: window.__panTest.battle.player.x })))
    .toMatchObject({ attack: null, meter: 100 });
  expect(await page.evaluate(() => window.__panTest.battle.player.x)).toBeGreaterThan(0);
  await page.keyboard.up('ArrowRight'); await page.clock.runFor(1300);
  // A longer ordinary stop gives Escape and resume their own frozen interval.
  await page.keyboard.press('Space'); await untilStop(page);
  await page.keyboard.press('Escape'); const paused = (await snapshot(page)).remaining;
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause'); await page.clock.runFor(500);
  expect((await snapshot(page)).remaining).toBe(paused);
  const sounds = await page.evaluate(() => (window as any).hitSounds.length);
  await page.getByRole('button', { name: '再開する →', exact: true }).click(); await page.clock.runFor(32);
  expect((await snapshot(page)).remaining).toBeLessThan(paused);
  expect(await page.evaluate(() => (window as any).hitSounds.length)).toBe(sounds); expect(left).toBeCloseTo(3 * STEP);
});

test('the full-meter special button is unavailable during hit stop and ready again on release', async ({ page }) => {
  await start(page);
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpu.bread = 'croissant'; b.cpu.meter = b.player.meter = 100; });
  await page.clock.runFor(32);
  const button = page.locator('#special');
  await expect(button).toHaveAttribute('aria-disabled', 'false'); await expect(button).toHaveClass(/ready/);
  await page.evaluate(() => window.__panTest.battle.special('cpu')); await untilStop(page);
  await expect(button).toHaveAttribute('aria-disabled', 'true'); await expect(button).not.toHaveClass(/ready/);
  await expect(button).toHaveClass(/busy/); await expect(button).toContainText('MAX · 戻ったら使える');
  await page.clock.runFor(16); await expect(button).toHaveAttribute('aria-disabled', 'true');
  await page.clock.runFor(16); expect(await page.evaluate(() => window.__panTest.battle.hitStopping)).toBe(false);
  await expect(button).toHaveAttribute('aria-disabled', 'false'); await expect(button).toHaveClass(/ready/);
  await expect(button).not.toHaveClass(/busy/); await expect(button).toContainText('ひっさつ！');
});

test('reduced motion retains the same stop with no additional compression, zoom, shake or white flash', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await start(page);
  await page.keyboard.press('Space'); await untilStop(page);
  const contact = await snapshot(page);
  expect(contact.remaining).toBeCloseTo(12 * STEP); expect(contact.crumbs).toHaveLength(0); expect(contact.impacts).toEqual([]);
  expect(contact.flashes.cpu ?? 0).toBe(0); expect(contact.shake).toBe(0); expect(contact.zoom).toBe(0);
  await page.clock.runFor(48); expect(presentation(await snapshot(page))).toEqual(presentation(contact));
});

for (const kind of ['normal', 'cpu', 'middle', 'clash'] as const) test(`${kind} K.O. holds for 183ms inside the existing finish delay and records only that hold`, async ({ page }) => {
  await start(page);
  await page.evaluate(kind => {
    const b = window.__panTest.battle;
    if (kind === 'middle') { b.player.bread = 'croissant'; b.cpu.hp = 6; b.player.meter = 100; }
    else if (kind === 'cpu') b.player.hp = 18;
    else if (kind === 'clash') { b.player.hp = b.cpu.hp = 18; b.attack('cpu'); b.cpu.attack.age = .65; }
    else b.cpu.hp = 18;
  }, kind);
  if (kind === 'cpu') await page.evaluate(() => window.__panTest.battle.attack('cpu'));
  else await page.keyboard.press(kind === 'middle' ? 'KeyX' : 'Space');
  await untilStop(page); const contact = await snapshot(page);
  expect(contact.screen).toBe('finish'); expect(contact.remaining).toBeCloseTo(22 * STEP);
  expect(await page.evaluate(() => window.__panTest.renderer.zoomAmount)).toBe(.09);
  await page.clock.runFor(96); const held = await snapshot(page);
  expect(presentation(held)).toEqual(presentation(contact)); expect(held.replayClock).toBeGreaterThan(contact.replayClock);
  await page.clock.runFor(112); const released = await snapshot(page);
  expect(released.crumbs[0]!.position).not.toEqual(contact.crumbs[0]!.position);
  expect(released.replayClock - contact.replayClock).toBeCloseTo(22 * STEP, 5);
  await page.clock.runFor(608); expect((await snapshot(page)).replayClock).toBe(released.replayClock);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'finish');
  await page.clock.runFor(112); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay');
  await page.getByRole('button', { name: 'リプレイをスキップ →', exact: true }).click();
  await page.getByRole('button', { name: '同じパンで、もう一戦 →', exact: true }).click(); await page.clock.runFor(3100);
  const fresh = await snapshot(page); expect(fresh.remaining).toBe(0); expect(fresh.crumbs).toHaveLength(0); expect(fresh.zoom).toBe(0);
});

test('reduced motion K.O. uses the existing 500ms finish delay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await start(page);
  await page.evaluate(() => { window.__panTest.battle.cpu.hp = 18; });
  await page.keyboard.press('Space'); await untilStop(page); expect((await snapshot(page)).remaining).toBeCloseTo(22 * STEP);
  await page.clock.runFor(448); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'finish');
  await page.clock.runFor(64); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay');
});

test('a real boss finishing hit goes through settleStage with the same held pose and finish budget', async ({ page }) => {
  await start(page);
  await page.evaluate(async () => {
    const h = window.__panTest; await h.action('challenge-start');
    const res = { score: 90, dodge: 3, chances: 3, counters: 1, seconds: 25 };
    h.challenge.update((d: any) => ({ ...d, run: { ...d.run, stage: 5, results: [res, res, res, res, res] } }));
    h.transition('ladder');
  });
  await page.getByRole('button', { name: 'ボスに挑む →', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'intro');
  await page.getByRole('button', { name: 'スキップ ›', exact: true }).click(); await page.clock.runFor(3100);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'battle');
  await page.evaluate(() => {
    const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 18; b.state.counters.A = { available: true, until: 10 };
  });
  await page.keyboard.press('Space'); await untilStop(page); const contact = await snapshot(page);
  expect(contact.screen).toBe('finish'); expect(contact.remaining).toBeCloseTo(22 * STEP);
  expect(await page.evaluate(() => window.__panTest.challenge.data.run.results.length)).toBe(6);
  await page.clock.runFor(96); expect(presentation(await snapshot(page))).toEqual(presentation(contact));
  await page.clock.runFor(832); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'replay');
  await page.getByRole('button', { name: 'リプレイをスキップ →', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'champion');
});
