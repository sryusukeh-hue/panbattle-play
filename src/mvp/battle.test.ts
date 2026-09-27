import { describe, expect, it } from 'vitest';
import { Battle, CPU_RECOVER_GAP, CPU_STYLE, DIFFICULTY, HIT_STOP_SECONDS, phase, pose, touching } from './battle';
import { BREADS, BREAD_IDS, LIMIT, STEP, type BreadId } from './config';
import { createBattle, startAttack, stepBattle, type BattleEvent as SharedEvent } from '../shared/battle';

function run(b: Battle, seconds: number, target = b.player.x): void { for (let i = 0; i < seconds / STEP; i++) b.advance(STEP, target); }
function duel(p: BreadId = 'shokupan', c: BreadId = 'shokupan'): Battle { const b = new Battle(p, c); b.cpuEnabled = false; return b; }
describe('3D contact and battle rules', () => {
  it.each([false, true])('hit stop freezes both fighters and the clock, including practice=%s', practice => {
    const b = duel(); b.practice = practice; b.attack('player');
    while (!b.events.some(e => e.kind === 'hit')) b.advance(STEP, 0);
    const frozen = structuredClone(b.state), poses = [pose(b.player, 'player'), pose(b.cpu, 'cpu')];
    b.advance(HIT_STOP_SECONDS / 2, LIMIT, true); b.advance(HIT_STOP_SECONDS / 2, -LIMIT, true);
    expect(b.state).toEqual(frozen); expect([pose(b.player, 'player'), pose(b.cpu, 'cpu')]).toEqual(poses);
    b.advance(STEP, 0); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
  });
  it('stops once for a clash and consumes frame remainder instead of catching up after the stop', () => {
    const b = duel(); b.attack('cpu'); run(b, .65); b.attack('player');
    while (!b.events.some(e => e.kind === 'clash')) b.advance(STEP, 0);
    const frozen = structuredClone(b.state); b.advance(.06, 0); expect(b.state).toEqual(frozen);
    b.advance(.01 + STEP, 0); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
  });
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
    expect(b.elapsed).toBeGreaterThan(70); expect(b.scores.dodge.opportunities).toBeGreaterThan(count); expect(b.outcome).toBeNull();
  });
  it('symmetric collision does not depend on update ordering', () => {
    const b = duel(); b.attack('player'); b.player.attack!.age = .3;
    const p = pose(b.player, 'player'), c = pose(b.cpu, 'cpu'); expect(touching(p, c)).toBe(touching(c, p));
  });
});

describe('CPU policy comparison', () => {
  it.each(BREAD_IDS)('%s: seeded behavior varies safely while retaining anticipation, fixed aim and recovery', bread => {
    function trace(seed: number) {
      const b = new Battle('shokupan', bread, { seed }); b.player.hp = 10000;
      const starts: { time: number; aim: number; windup: number; recovery: number }[] = [], positions: number[] = [];
      const aims = new Map<number, number>();
      for (let i = 0; i < 8000 && !b.outcome; i++) {
        b.advance(STEP, Math.sin(i * .01));
        const attack = b.cpu.attack;
        if (attack) {
          if (!aims.has(attack.id)) { aims.set(attack.id, attack.aim); starts.push({ time: b.elapsed, aim: attack.aim, windup: attack.windup, recovery: attack.recovery }); }
          expect(attack.aim).toBe(aims.get(attack.id));
        }
        if (i % 30 === 0) positions.push(b.cpu.x);
        b.drainEvents();
      }
      return { starts, positions };
    }
    const first = trace(42); expect(first).toEqual(trace(42)); expect(first).not.toEqual(trace(43));
    expect(new Set(first.positions).size).toBeGreaterThan(5);
    const intervals = first.starts.slice(1).map((s, i) => s.time - first.starts[i]!.time);
    expect(intervals.some(v => Math.abs(v - CPU_STYLE[bread].pairInterval) < STEP * 2)).toBe(true);
    expect(intervals.some(v => v >= CPU_STYLE[bread].interval)).toBe(true);
    for (const start of first.starts) { expect(start.windup).toBeGreaterThanOrEqual(BREADS[bread].windup + .65); expect(start.recovery).toBeGreaterThanOrEqual(BREADS[bread].recovery + .55); }
    for (let i = 0; i < intervals.length; i++) {
      expect(intervals[i]!).toBeGreaterThanOrEqual(2.7 - STEP);
      const previous = first.starts[i]!;
      expect(intervals[i]! - previous.windup - BREADS[bread].active - previous.recovery).toBeGreaterThanOrEqual(CPU_RECOVER_GAP - STEP);
    }
  });
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

describe('CPU difficulty', () => {
  function swings(difficulty: 'gentle' | 'normal' | 'hard') {
    const b = new Battle('shokupan', 'shokupan', { seed: 7, difficulty }); b.player.hp = 10000; b.cpu.hp = 10000;
    let misses = 0, windup = Infinity, dodges = 0;
    for (let i = 0; i < 40 / STEP; i++) {
      b.advance(STEP, 0, !b.player.attack && i % 90 === 0);
      if (b.cpu.attack) windup = Math.min(windup, b.cpu.attack.windup);
      for (const e of b.drainEvents()) { if (e.kind === 'miss' && e.side === 'player') misses++; if (e.kind === 'dodge' && e.side === 'cpu') dodges++; }
    }
    return { misses, windup, dodges };
  }
  it('keeps gentle timings and makes higher levels quicker and evasive', () => {
    const gentle = swings('gentle'), normal = swings('normal'), hard = swings('hard');
    expect(gentle.windup).toBeCloseTo(BREADS.shokupan.windup + DIFFICULTY.gentle.windup, 5);
    expect(hard.windup).toBeCloseTo(BREADS.shokupan.windup + DIFFICULTY.hard.windup, 5);
    expect(normal.windup).toBeLessThan(gentle.windup); expect(hard.windup).toBeLessThan(normal.windup);
    expect(hard.misses).toBeGreaterThan(gentle.misses); expect(gentle.dodges).toBe(0); expect(hard.dodges).toBeGreaterThan(0); expect(hard.dodges).toBeLessThanOrEqual(hard.misses);
  });
  it('practice always uses the gentle CPU', () => {
    expect(new Battle('shokupan', 'shokupan', { practice: true, difficulty: 'hard' }).difficulty).toBe('gentle');
  });
  it.each(BREAD_IDS)('%s: a reacting player can still beat the hard CPU', bread => {
    const b = new Battle(bread, 'shokupan', { seed: 42, difficulty: 'hard' }); let evading = false;
    for (let i = 0; i < 60 / STEP && !b.outcome; i++) {
      const cpuPhase = phase(b.cpu);
      if (cpuPhase === 'windup') evading = true;
      if (cpuPhase === 'recovery' || cpuPhase === 'ready') evading = false;
      const target = evading ? (b.cpu.attack!.aim >= 0 ? -LIMIT : LIMIT) : 0;
      b.advance(STEP, target, !evading && b.counterAvailable && b.elapsed <= b.counterUntil); b.drainEvents();
    }
    expect(b.player.hp).toBeGreaterThan(0); expect(b.outcome).not.toBe('lose');
  });
});

describe('CPU reads (round 3 fixes)', () => {
  it('flags a swing that restarts right after the previous one as mashing', () => {
    const b = new Battle('croissant', 'shokupan', { seed: 3, difficulty: 'hard' }); b.cpuEnabled = true; b.player.hp = b.cpu.hp = 1e4;
    const ids = new Set<number>();
    for (let i = 0; i < 3 / STEP; i++) { b.advance(STEP, 0, true); if (b.player.attack) ids.add(b.player.attack.id); b.drainEvents(); }
    expect(ids.size).toBeGreaterThan(2); expect((b as unknown as { mashed: number }).mashed).toBeGreaterThan(1);
  });
  it('sidesteps away from the fixed aim, not toward it', () => {
    const b = new Battle('shokupan', 'shokupan', { seed: 1, difficulty: 'hard' }); (b as unknown as { random: () => number }).random = () => 0;
    b.player.x = -.85; b.cpu.x = .65; (b as unknown as { nextCpu: number }).nextCpu = 99;
    b.advance(STEP, -.85, true); const aim = b.player.attack!.aim;
    for (let i = 0; i < .1 / STEP; i++) b.advance(STEP, -.85);
    expect(aim).toBeCloseTo(0, 5); expect((b as unknown as { cpuTarget: number }).cpuTarget).toBeGreaterThan(.65);
  });
  it('hard CPU earns a counter window long enough to land, with scaled damage; PvP ignores both', () => {
    const b = new Battle('shokupan', 'shokupan', { seed: 1, difficulty: 'hard' }); (b as unknown as { random: () => number }).random = () => 0;
    (b as unknown as { nextCpu: number }).nextCpu = 99; b.advance(STEP, 0, true);
    let window = 0;
    for (let i = 0; i < 1.2 / STEP && !window; i++) { b.advance(STEP, 0); if (b.state.counters.B.available) window = b.state.counters.B.until - b.elapsed; }
    expect(window).toBeGreaterThan(BREADS.shokupan.recovery + DIFFICULTY.hard.grace - .05);
    const hit = new Battle('shokupan', 'shokupan', { difficulty: 'hard' }); hit.cpuEnabled = false; hit.attack('cpu');
    for (let i = 0; i < 1.5 / STEP && hit.player.hp === 100; i++) hit.advance(STEP, 0);
    expect(100 - hit.player.hp).toBeCloseTo(BREADS.shokupan.damage * DIFFICULTY.hard.damage, 5);
    const pvp = createBattle('shokupan', 'shokupan', 'pvp'); pvp.cpuExtra = { windup: .2, recovery: .15, counters: true, damage: 3, grace: 2 };
    const events: SharedEvent[] = []; startAttack(pvp, 'B', events);
    for (let i = 0; i < 1.5 / STEP && pvp.fighters.A.hp === 100; i++) stepBattle(pvp, { A: { target: 0, attack: false }, B: { target: 0, attack: false } }, events);
    expect(100 - pvp.fighters.A.hp).toBe(BREADS.shokupan.damage);
  });
  it('hard CPU dodge leads to a counter that lands with both bonuses', () => {
    const b = new Battle('francepan', 'shokupan', { seed: 1, difficulty: 'hard' }); (b as unknown as { random: () => number }).random = () => 0;
    (b as unknown as { nextCpu: number }).nextCpu = 99; b.player.hp = 1e4; b.advance(STEP, 0, true);
    let counter = false; const before = b.player.hp;
    for (let i = 0; i < 2.5 / STEP && !counter; i++) { b.advance(STEP, 0); counter = b.drainEvents().some(e => e.kind === 'counter' && e.side === 'cpu'); }
    expect(counter).toBe(true); expect(before - b.player.hp).toBeCloseTo(BREADS.shokupan.damage * 1.25 * DIFFICULTY.hard.damage, 5);
  });
  it('PvP state and events are identical with or without CPU extras', () => {
    const run = (extra: boolean) => {
      const s = createBattle('croissant', 'francepan', 'pvp'); if (extra) s.cpuExtra = { windup: .1, recovery: .1, counters: true, damage: 3, grace: 2 };
      const events: SharedEvent[] = [];
      for (let i = 0; i < 20 / STEP; i++) stepBattle(s, { A: { target: Math.sin(i * .013), attack: i % 97 === 0 }, B: { target: Math.cos(i * .011), attack: i % 131 === 0 } }, events);
      const { cpuExtra: _ignored, ...rest } = s; return JSON.stringify({ rest, events });
    };
    expect(run(true)).toBe(run(false));
  });
});
