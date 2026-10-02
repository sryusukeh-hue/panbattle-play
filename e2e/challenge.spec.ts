import { test, expect, type Page } from '@playwright/test';

// 勝ち抜きチャレンジ + boss (plans/EXECPLAN-BOSS.md): ladder, stage win/loss/retry, the saved run across a reload,
// the boss entrance (skip, short repeat, reduced motion), the champion ending and the crown on the selection card.
// Browser time is fake; outcomes are forced through the DEV hook so each step lands on a known moment.
async function enter(page: Page): Promise<void> {
  await page.getByRole('button', { name: '👑 勝ち抜きチャレンジ' }).click();
  await page.getByText('補助操作で遊ぶ', { exact: true }).click(); await page.getByRole('button', { name: 'キーボード', exact: true }).click();
  await page.getByRole('button', { name: 'この位置で開始' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'challenge');
}
async function open(page: Page, reduced = false): Promise<string[]> {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./?test=1'); await expect(page.getByRole('button', { name: '👑 勝ち抜きチャレンジ' })).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await enter(page);
  return errors;
}
const screen = (page: Page) => page.evaluate(() => window.__panTest.screen as string);
async function runUntil(page: Page, ready: () => Promise<boolean>, limit = 8000): Promise<void> {
  for (let t = 0; t < limit; t += 100) { if (await ready()) return; await page.clock.runFor(100); }
  expect(await ready(), `condition within ${limit} ms`).toBe(true);
}
// Ends the running stage: 'win' knocks the CPU out, 'lose' the player; then skips the replay to the stage result.
async function finish(page: Page, how: 'win' | 'lose'): Promise<void> {
  await runUntil(page, async () => await screen(page) === 'battle');
  await page.evaluate(how => { const b = window.__panTest.battle; b.cpuEnabled = false; if (how === 'win') b.cpu.hp = 0; else b.player.hp = 0; }, how);
  await runUntil(page, async () => ['finish', 'replay'].includes(await screen(page)));
  await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
}
// Jumps the saved run to the boss stage with five cleared stages on record.
async function toBoss(page: Page, seenIntro: boolean, score = 90): Promise<void> {
  await page.evaluate(([seen, score]) => {
    const c = window.__panTest.challenge, r = c.data.run, res = { score, dodge: 3, chances: 3, counters: 1, seconds: 25 };
    c.update((d: any) => ({ ...d, seenIntro: seen, run: { ...r, stage: 5, results: [res, res, res, res, res] } }));
    window.__panTest.transition('ladder');
  }, [seenIntro, score] as const);
}

test('a run: pick a bread, clear a stage, lose and retry, keep progress over a reload', async ({ page }, info) => {
  test.setTimeout(process.env.CI ? 240_000 : 90_000); // several stages / the entrance, software-rendered
  const errors = await open(page);
  await page.locator('[data-bread="creampan"]').click();
  await expect(page.locator('[data-bread="creampan"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'クリームパンで 挑戦する →' }).click();
  // Ladder: six rungs, the boss hidden as a silhouette, the first opponent is the toast slice.
  await expect(page.locator('.rung')).toHaveCount(6);
  await expect(page.locator('.rung.boss b')).toHaveText('？？？'); await expect(page.locator('.rung.boss .silhouette')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'つぎは 食パン' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('ladder.png') });
  await page.getByRole('button', { name: 'たたかう →' }).click();
  await expect(page.locator('.countdown em')).toContainText('ステージ1 · 食パン');
  await expect(page.locator('#timer')).toHaveText('45');
  await finish(page, 'win');
  await expect(page.getByRole('heading', { name: '食パンに勝利！' })).toBeVisible();
  await page.getByRole('button', { name: '次の相手へ →' }).click();
  await expect(page.locator('.rung.done')).toHaveCount(1); await expect(page.locator('.cheer .cheer')).toHaveCount(1);
  // Two defeats at stage 2: the same stage again, then the optional helper appears on the ladder.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'たたかう →' }).click();
    await finish(page, 'lose');
    await expect(page.getByRole('heading', { name: 'もう一回！' })).toBeVisible();
    await page.getByRole('button', { name: '進行画面へ' }).click();
    await expect(page.getByRole('heading', { name: 'つぎは メロンパン' })).toBeVisible();
  }
  const assist = page.getByRole('button', { name: /お助け/ });
  await expect(assist).toHaveAttribute('aria-pressed', 'false'); await assist.click();
  await expect(page.getByRole('button', { name: /お助け/ })).toHaveAttribute('aria-pressed', 'true');
  // Free-battle records are untouched by the challenge.
  expect(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('panbattle.3d.v1') ?? '{"best":{}}').best ?? {}))).toEqual([]);
  // Reload: the run continues from stage 2.
  await page.reload(); await expect(page.getByRole('button', { name: '👑 勝ち抜きチャレンジ' })).toBeEnabled();
  await enter(page);
  await expect(page.locator('.run-resume')).toContainText('ステージ 2 / 6'); await expect(page.locator('.run-resume')).toContainText('再挑戦 2回');
  await page.getByRole('button', { name: 'つづきから遊ぶ →' }).click();
  await expect(page.getByRole('heading', { name: 'つぎは メロンパン' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the boss: entrance with skip, 90 s fight, second form, champion ending, run result and the crown', async ({ page }, info) => {
  test.setTimeout(process.env.CI ? 240_000 : 90_000); // several stages / the entrance, software-rendered
  const errors = await open(page);
  await page.getByRole('button', { name: '食パンで 挑戦する →' }).click();
  await toBoss(page, false);
  await expect(page.getByRole('heading', { name: 'ついに、ボス戦！' })).toBeVisible();
  await expect(page.locator('.rung.boss b')).toHaveText('一斤食パン');
  await page.getByRole('button', { name: 'ボスに挑む →' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'intro');
  // The fight has not started: no clock and no AI during the entrance.
  await page.clock.runFor(4600);
  await expect(page.locator('#intro-name strong')).toHaveText('一斤食パン');
  await page.screenshot({ path: info.outputPath('boss-intro.png') });
  expect(await page.evaluate(() => [window.__panTest.screen, window.__panTest.battle.elapsed])).toEqual(['intro', 0]);
  const skip = page.getByRole('button', { name: 'スキップ ›' });
  const box = await skip.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  await skip.click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'countdown');
  await expect(page.locator('.countdown em')).toContainText('BOSS · 一斤食パン · 90秒');
  await runUntil(page, async () => await screen(page) === 'battle');
  await expect(page.locator('#cpu-hp')).toHaveText('180'); await expect(page.locator('.health.enemy > span')).toContainText('BOSS');
  expect(Number(await page.locator('#timer').textContent())).toBeGreaterThanOrEqual(89);
  // HP bars are a share of the maximum (180 must not draw wider than the track), and 90 HP starts the second form.
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 90; });
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = true; });
  await page.clock.runFor(200);
  await page.evaluate(() => { window.__panTest.battle.cpuEnabled = false; });
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('#cpu-health')!.style.width)).toBe('50%');
  expect(await page.evaluate(() => window.__panTest.battle.bossPhase)).toBe(2);
  await expect(page.locator('#banner')).toHaveText('焼きたてモード！');
  await page.clock.runFor(700); // the toasting ramps in over .6 s
  await page.screenshot({ path: info.outputPath('boss-phase2.png') });
  await finish(page, 'win');
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'champion');
  expect(await page.evaluate(() => window.__panTest.renderer.heat)).toBeGreaterThan(.9); // still toasted in the ending
  await expect(page.getByText('食卓チャンピオン！')).toBeVisible(); await expect(page.locator('.champion-cheer > span')).toHaveCount(5);
  await page.clock.runFor(1500); await page.screenshot({ path: info.outputPath('champion.png') });
  await page.getByRole('button', { name: '結果を見る →' }).click();
  await expect(page.getByRole('heading', { name: '勝ち抜き、達成！' })).toBeVisible();
  await expect(page.locator('.clear-marks .mark')).toHaveCount(6);
  await page.screenshot({ path: info.outputPath('run-result.png'), fullPage: true });
  await page.getByRole('button', { name: 'もう一度チャレンジ →' }).click();
  await expect(page.locator('[data-bread="shokupan"] .crown')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a time-out against a standing boss is a retry, and the second entrance is the short one', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 90_000); // several stages / the entrance, software-rendered
  const errors = await open(page);
  await page.getByRole('button', { name: '食パンで 挑戦する →' }).click();
  await toBoss(page, true, 70);
  await expect(page.getByRole('button', { name: '登場をもう一度見る' })).toBeVisible();
  await page.getByRole('button', { name: 'ボスに挑む →' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'intro');
  await page.clock.runFor(1400);
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'countdown');
  await runUntil(page, async () => await screen(page) === 'battle');
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.cpu.hp = 150; b.player.hp = 100; b.elapsed = 89.9; });
  await runUntil(page, async () => ['finish', 'replay'].includes(await screen(page)));
  await expect(page.locator('.finish-banner span')).toHaveText('時間切れ…');
  await page.getByRole('button', { name: 'リプレイをスキップ →' }).click();
  await expect(page.getByRole('heading', { name: '時間切れ… ボスを倒しきろう' })).toBeVisible();
  expect(await page.evaluate(() => window.__panTest.challenge.data.run.stage)).toBe(5);
  expect(errors).toEqual([]);
});

test('reduced motion: the entrance is the still 1.2 s version', async ({ page }) => {
  const errors = await open(page, true);
  await page.getByRole('button', { name: '食パンで 挑戦する →' }).click();
  await toBoss(page, false, 70);
  await page.getByRole('button', { name: 'ボスに挑む →' }).click();
  await page.clock.runFor(300); await expect(page.locator('#intro-name')).toBeVisible();
  await page.clock.runFor(1100); await expect(page.locator('#app')).toHaveAttribute('data-screen', 'countdown');
  expect(errors).toEqual([]);
});

for (const [width, height] of [[320, 568], [430, 932]] as const) test(`challenge screens fit ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  const errors = await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const start = page.getByRole('button', { name: /挑戦する →/ }); await start.scrollIntoViewIfNeeded(); await start.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const fight = page.getByRole('button', { name: 'たたかう →' }); await fight.scrollIntoViewIfNeeded(); await expect(fight).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a challenge save that cannot be written says so and never claims progress is kept', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) { if (key === 'panbattle.challenge.v1') throw new Error('quota'); return set.call(this, key, value); };
  });
  const errors = await open(page);
  await page.getByRole('button', { name: '食パンで 挑戦する →' }).click();
  await expect(page.locator('#save-warning')).toBeVisible(); await expect(page.locator('#save-warning')).toContainText('保存できませんでした');
  await expect(page.getByRole('button', { name: 'タイトルへ（保存できていません）' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'タイトルへ（続きは保存されます）' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the boss lane stays until its hit window closes, and a paused entrance holds its frame', async ({ page }) => {
  test.setTimeout(process.env.CI ? 240_000 : 90_000); // several stages / the entrance, software-rendered
  const errors = await open(page);
  await page.getByRole('button', { name: '食パンで 挑戦する →' }).click();
  await toBoss(page, false);
  await page.getByRole('button', { name: 'ボスに挑む →' }).click();
  await page.clock.runFor(500);
  // Everything on screen holds: camera, the boss up in the air, the challenger's idle bob, the wobbling plates.
  const held = async () => page.evaluate(() => { const r = window.__panTest.renderer, round = (v: number) => +v.toFixed(4);
    return { cam: r.camera.position.toArray().map(round), y: round(r.actors.cpu.mesh.position.y), player: round(r.actors.player.mesh.position.y), plates: r.plates.map((p: any) => round(p.mesh.position.y)) }; });
  await page.evaluate(() => window.__panTest.pause('テスト'));
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'pause');
  await page.clock.runFor(200); const a = await held(); await page.clock.runFor(1500); const b = await held();
  expect(b).toEqual(a); expect(a.y).toBeGreaterThan(1.5); // still up in the air, not standing at 1.43
  await page.getByRole('button', { name: '再開する →' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-screen', 'intro');
  await page.getByRole('button', { name: 'スキップ ›' }).click();
  await runUntil(page, async () => await screen(page) === 'battle');
  await page.evaluate(() => { const b = window.__panTest.battle; b.cpuEnabled = false; b.player.x = -1.15; b.cpu.x = 0; b.attack('cpu'); });
  const lane = () => page.evaluate(() => window.__panTest.renderer.bossLane[0].visible as boolean);
  await page.clock.runFor(500); expect(await lane()).toBe(true);
  await runUntil(page, async () => page.evaluate(() => { const a = window.__panTest.battle.cpu.attack; return !!a && a.age > a.windup + .05; }), 2000);
  await page.clock.runFor(50); expect(await lane()).toBe(true); // inside the active window
  await runUntil(page, async () => page.evaluate(() => { const a = window.__panTest.battle.cpu.attack; return !a || a.age > a.windup + .25; }), 2000);
  await page.clock.runFor(50); expect(await lane()).toBe(false);
  expect(errors).toEqual([]);
});
