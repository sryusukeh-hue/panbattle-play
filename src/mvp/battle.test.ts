import { describe, expect, it } from 'vitest';
import { Battle, phase, pose, touching } from './battle';
import { BREADS, BREAD_IDS, LIMIT, STEP, type BreadId } from './config';

function run(b: Battle, seconds: number, target = b.player.x): void { for (let i = 0; i < seconds / STEP; i++) b.advance(STEP, target); }
function duel(p: BreadId = 'shokupan', c: BreadId = 'shokupan'): Battle { const b = new Battle(p, c); b.cpuEnabled = false; return b; }
describe('3D contact and battle rules', () => {
  it('idle never causes damage; a single swing contacts only once', () => {
    const b = duel(); run(b, 2); expect(b.cpu.hp).toBe(100); b.attack('player');
    run(b, .6); expect(b.cpu.hp).toBe(82); run(b, .6); expect(b.cpu.hp).toBe(82);
  });
  it('misses never damage; positions are deterministic', () => {
    const repeat = (): [number, number] => { const b = duel('francepan', 'francepan'); b.player.x = -LIMIT; b.cpu.x = LIMIT; b.attack('player'); run(b, .55, -LIMIT); return [b.cpu.hp, pose(b.player, 'player').z]; };
    expect(repeat()[0]).toBe(100); expect(repeat()).toEqual(repeat());
  });
  it('all nine combinations can land a hit using their common pose/contact rule', () => {
    for (const player of BREAD_IDS) for (const cpu of BREAD_IDS) {
      const b = duel(player, cpu); b.attack('player'); run(b, .7);
      expect(b.cpu.hp, `${player}/${cpu}`).toBeLessThan(100);
    }
  });
  it('locks lateral position until active ends, does not queue, then uses the current target', () => {
    const b = duel(); b.player.x = -.65; b.attack('player'); expect(b.attack('player')).toBe(false);
    run(b, .35, LIMIT); expect(b.player.x).toBe(-.65);
    run(b, .2, -LIMIT); expect(b.player.x).toBeLessThan(-.65);
    run(b, 1, -LIMIT); expect(b.player.attack).toBeNull(); expect(b.player.x).toBe(-LIMIT);
  });
  it('clashes atomically damage both, once, and recoil returns to the original distance', () => {
    const b = duel(); b.attack('cpu'); run(b, .65); b.attack('player'); run(b, .32);
    expect(b.player.hp).toBe(82); expect(b.cpu.hp).toBe(82); expect(b.player.recoil).toBeGreaterThan(0); expect(b.cpu.recoil).toBeGreaterThan(0);
    expect(b.events.filter(e => e.kind === 'clash')).toHaveLength(1);
    for (let i = 0; i < 60; i++) { b.advance(STEP, 0); expect(pose(b.player, 'player').z).toBeGreaterThan(pose(b.cpu, 'cpu').z); }
    run(b, 1); expect(b.player.hp).toBe(82); expect(b.cpu.hp).toBe(82); expect(pose(b.player, 'player').z).toBe(1.2);
  });
  it('same-frame KO draws and cannot be changed by later attacks or time', () => {
    const b = duel(); b.player.hp = 18; b.cpu.hp = 18; b.attack('cpu'); run(b, .65); b.attack('player'); run(b, .4);
    expect(b.outcome).toBe('draw'); const time = b.elapsed; expect(b.attack('player')).toBe(false); run(b, 10); expect(b.elapsed).toBe(time); expect(b.player.hp).toBe(0); expect(b.cpu.hp).toBe(0);
    expect(b.scores.dodge).toEqual({ success: 0, opportunities: 1 });
  });
  it('the CPU hit that ends a match is counted as a dodge opportunity', () => {
    const b = duel(); b.player.hp = 18; b.attack('cpu'); run(b, 2);
    expect(b.outcome).toBe('lose'); expect(b.scores.dodge).toEqual({ success: 0, opportunities: 1 });
  });
  it.each([['win', 18, 100], ['lose', 100, 18]] as const)('KO determines %s exactly once', (outcome, cpuHp, playerHp) => {
    const b = duel(); b.cpu.hp = cpuHp; b.player.hp = playerHp; b.attack(outcome === 'win' ? 'player' : 'cpu'); run(b, 2); expect(b.outcome).toBe(outcome);
  });
  it.each([['win', 73, 25], ['lose', 5, 67], ['draw', 50, 50]] as const)('timeout compares remaining HP proportions: %s', (outcome, p, c) => {
    const b = duel(); b.player.hp = p; b.cpu.hp = c; b.elapsed = 59.98; run(b, .1); expect(b.outcome).toBe(outcome); expect(b.elapsed).toBeCloseTo(60);
  });
  it('pausing freezes attacks, damage and time and discards simulation backlog', () => {
    const b = duel(); b.attack('cpu'); run(b, .1); b.setPaused(true); const before = JSON.stringify(b.cpu); run(b, 30); expect(JSON.stringify(b.cpu)).toBe(before); expect(b.elapsed).toBeCloseTo(.1);
    b.setPaused(false); b.advance(1, 0, true); expect(b.paused).toBe(true); expect(b.player.attack).toBeNull();
  });
  it('CPU fixes its target during anticipation, and lateral dodging opens exactly one counter window', () => {
    const b = duel(); b.attack('cpu'); const aim = b.cpu.attack!.aim; run(b, 1.06, LIMIT);
    expect(aim).toBe(0); expect(b.player.hp).toBe(100); expect(b.scores.dodge).toEqual({ success: 1, opportunities: 1 });
    expect(b.scores.counter).toEqual({ success: 0, opportunities: 1 });
    b.attack('player'); run(b, .35, 0); expect(b.scores.counter.success).toBe(1); expect(b.cpu.hp).toBe(77.5);
    run(b, 1); expect(b.scores.counter.success).toBe(1);
  });
  it('standing away without dodging is not a success and idle movement is not an opportunity', () => {
    const b = duel('francepan', 'francepan'); b.player.x = LIMIT; b.cpu.x = -LIMIT;
    run(b, 1, LIMIT); expect(b.scores.dodge.opportunities).toBe(0); b.attack('cpu'); run(b, 1.5, LIMIT); expect(b.scores.dodge.success).toBe(0);
  });
  it('practice never loses HP, including player attacks and clashes', () => {
    const b = new Battle('shokupan', 'shokupan', { practice: true }); b.cpuEnabled = false;
    b.attack('cpu'); run(b, .65); b.attack('player'); run(b, 1); expect([b.player.hp, b.cpu.hp]).toEqual([100, 100]); expect(b.outcome).toBeNull();
  });
  it('bread timing/reach differs as described', () => {
    expect(BREADS.francepan.reach + BREADS.francepan.height * Math.sin(BREADS.francepan.lean)).toBeGreaterThan(BREADS.shokupan.reach + BREADS.shokupan.height * Math.sin(BREADS.shokupan.lean)); expect(BREADS.croissant.windup).toBeLessThan(BREADS.shokupan.windup); expect(BREADS.francepan.recovery).toBeGreaterThan(BREADS.shokupan.recovery);
  });
  it('practice keeps offering CPU attacks beyond 60 seconds', () => {
    const b = new Battle('shokupan', 'shokupan', { practice: true }); b.practiceStage = 1;
    run(b, 70); const count = b.scores.dodge.opportunities; run(b, 5);
    expect(b.elapsed).toBeGreaterThan(74); expect(b.scores.dodge.opportunities).toBeGreaterThan(count); expect(b.outcome).toBeNull();
  });
  it('symmetric collision does not depend on update ordering', () => {
    const b = duel(); b.attack('player'); b.player.attack!.age = .3;
    const p = pose(b.player, 'player'), c = pose(b.cpu, 'cpu'); expect(touching(p, c)).toBe(touching(c, p));
  });
});

describe('CPU policy comparison', () => {
  function simulate(policy: 'mash' | 'counter', bread: BreadId): Battle {
    const b = new Battle(bread, 'shokupan', { seed: 42 }); let evading = false;
    for (let i = 0; i < 60 / STEP && !b.outcome; i++) {
      const cpuPhase = phase(b.cpu);
      if (cpuPhase === 'windup') evading = true;
      if (cpuPhase === 'recovery' || cpuPhase === 'ready') evading = false;
      const target = policy === 'counter' && evading ? (b.cpu.attack!.aim >= 0 ? -LIMIT : LIMIT) : 0;
      const attack = policy === 'mash' || (!evading && b.counterAvailable && b.elapsed <= b.counterUntil);
      b.advance(STEP, target, attack); b.drainEvents();
    }
    return b;
  }
  it.each(BREAD_IDS)('%s: reacting to telegraphs wins while retaining more HP than mashing', bread => {
    const mash = simulate('mash', bread), counter = simulate('counter', bread);
    expect(counter.outcome).toBe('win'); expect(counter.player.hp).toBeGreaterThan(mash.player.hp); expect(counter.scores.dodge.success).toBeGreaterThan(0); expect(counter.scores.counter.success).toBeGreaterThan(0);
  });
});
