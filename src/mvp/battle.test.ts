import { describe, expect, it } from 'vitest';
import { Battle, CPU_RAGE, CPU_RECOVER_GAP, CPU_STYLE, DIFFICULTY, HIT_STOP_SECONDS, HIT_STOP_COUNTER_SECONDS, HIT_STOP_CLASH_SECONDS, HIT_STOP_GUARD_SECONDS, HIT_STOP_KO_SECONDS, PRACTICE_SPECIAL_STAGE, phase, pose, touching, type Side } from './battle';
import { CUTIN_SECONDS, SPECIALS } from '../shared/specials';
import { BREADS, BREAD_IDS, FIGHTER_IDS, LIMIT, STEP, type BreadId } from './config';
import { createBattle, startAttack, startSpecial, stepBattle, type BattleEvent as SharedEvent } from '../shared/battle';

function run(b: Battle, seconds: number, target = b.player.x): void { for (let i = 0; i < seconds / STEP; i++) b.advance(STEP, target); }
function duel(p: BreadId = 'shokupan', c: BreadId = 'shokupan'): Battle { const b = new Battle(p, c); b.cpuEnabled = false; return b; }
function untilStop(b: Battle, dt = STEP): void {
  for (let i = 0; i < 4 / dt && !b.hitStopping; i++) b.advance(dt, 0);
  expect(b.hitStopping).toBe(true); expect(b.frameEffectDt).toBe(0);
}
describe('synchronized CPU hit stop', () => {
  it.each(['player', 'cpu'] as const)('normal and counter durations are symmetric for %s, using the batch maximum', side => {
    for (const counter of [false, true]) {
      const b = duel(); b.state.counters[side === 'player' ? 'A' : 'B'] = { available: counter, until: 10 };
      b.attack(side); untilStop(b);
      expect(b.hitStopRemaining).toBe(counter ? HIT_STOP_COUNTER_SECONDS : HIT_STOP_SECONDS);
      expect(b.events.filter(e => e.kind === 'counter')).toHaveLength(counter ? 1 : 0);
      expect(b.events.filter(e => e.kind === 'hit')).toHaveLength(1);
    }
  });
  it('boss guard is short; an opening or counter has the ordinary or counter duration in either form', () => {
    for (const form of [1, 2] as const) for (const mode of ['guard', 'opening', 'counter'] as const) {
      const b = new Battle('shokupan', 'ikkin'); b.cpuEnabled = false; b.bossPhase = form;
      if (mode === 'opening') { b.attack('cpu'); b.cpu.attack!.age = b.cpu.attack!.windup + BREADS.ikkin.active; }
      if (mode === 'counter') b.state.counters.A = { available: true, until: 10 };
      b.attack('player'); untilStop(b);
      expect(b.hitStopRemaining).toBe(mode === 'guard' ? HIT_STOP_GUARD_SECONDS : mode === 'counter' ? HIT_STOP_COUNTER_SECONDS : HIT_STOP_SECONDS);
      expect(b.events.find(e => e.kind === 'hit')?.guard ?? false).toBe(mode === 'guard');
    }
  });
  it.each(FIGHTER_IDS)('every %s special stage stops for its specified ticks on either side', bread => {
    const ticks = { shokupan: [16], francepan: [16], croissant: [3, 3, 14], melonpan: [14], currypan: [4, 18], creampan: [14], ikkin: [18] }[bread];
    for (const side of ['player', 'cpu'] as Side[]) {
      const b = new Battle(side === 'player' ? bread : 'shokupan', side === 'cpu' ? bread : 'shokupan'); b.cpuEnabled = false;
      b.player.hp = b.cpu.hp = 1000; b[side].meter = 100;
      expect(startSpecial(b.state, side === 'player' ? 'A' : 'B', [])).toBe(true);
      for (const [stage, tick] of ticks.entries()) {
        untilStop(b);
        expect(b.drainEvents().filter(e => e.kind === 'special-hit')).toMatchObject([{ side, stage }]);
        expect(b.hitStopRemaining).toBe(tick * STEP);
        const frozen = structuredClone(b.state); b.advance(tick * STEP, 0);
        expect(b.state).toEqual(frozen); expect(b.frameEffectDt).toBe(0);
      }
    }
  });
  it.each([1 / 30, 1 / 60, 1 / 120])('draws even a 25ms middle-stage contact before consuming the stop at dt=%s', dt => {
    const b = duel('croissant'); b.player.meter = 100; startSpecial(b.state, 'A', []);
    untilStop(b, dt); expect(b.hitStopRemaining).toBe(3 * STEP);
    expect(b.player.attack!.age).toBeCloseTo(SPECIALS.croissant.windup);
    const time = b.elapsed; b.advance(3 * STEP + STEP, 0);
    expect(b.frameEffectDt).toBeCloseTo(STEP); expect(b.elapsed - time).toBeCloseTo(STEP);
  });
  it.each(['normal', 'cpu', 'middle', 'clash'] as const)('%s K.O. replaces rather than adds to the stop', mode => {
    const b = duel(mode === 'middle' ? 'croissant' : 'shokupan');
    if (mode === 'middle') { b.cpu.hp = 6; b.player.meter = 100; startSpecial(b.state, 'A', []); }
    else if (mode === 'clash') { b.player.hp = b.cpu.hp = 18; b.attack('cpu'); run(b, .65); b.attack('player'); }
    else { b[mode === 'cpu' ? 'player' : 'cpu'].hp = 18; b.attack(mode === 'cpu' ? 'cpu' : 'player'); }
    untilStop(b); expect(b.hitStopRemaining).toBe(HIT_STOP_KO_SECONDS); expect(b.outcome).not.toBeNull();
  });
  it('misses, dodges and timeouts do not stop', () => {
    const b = duel(); b.attack('cpu'); run(b, 1.5, LIMIT);
    expect(b.events.some(e => e.kind === 'dodge')).toBe(true); expect(b.hitStopRemaining).toBe(0);
    b.elapsed = b.limit - STEP; b.advance(STEP, LIMIT); expect(b.outcome).not.toBeNull(); expect(b.hitStopping).toBe(false);
  });
  it.each(['player', 'cpu'] as const)('special button readiness stays false throughout hit stop and returns on release for %s', side => {
    // Croissant's first stage leaves the full-meter victim free of attack/recoil locks.
    const b = duel(side === 'player' ? 'shokupan' : 'croissant', side === 'player' ? 'croissant' : 'shokupan');
    b.player.meter = b.cpu.meter = 100; expect(b.canSpecial(side)).toBe(true);
    expect(startSpecial(b.state, side === 'player' ? 'B' : 'A', [])).toBe(true); untilStop(b);
    expect(b[side].attack).toBeNull(); expect(b[side].recoil).toBe(0); expect(b[side].meter).toBe(100);
    // main.ts uses this predicate for the ready class, label and aria-disabled.
    expect(b.canSpecial(side)).toBe(false); expect(b.special(side)).toBe(false);
    b.advance(b.hitStopRemaining - STEP, 0); expect(b.hitStopping).toBe(true); expect(b.canSpecial(side)).toBe(false);
    b.advance(b.hitStopRemaining, 0); expect(b.hitStopping).toBe(false); expect(b.canSpecial(side)).toBe(true);
    expect(b.special(side)).toBe(true);
  });
  it.each([false, true])('drops attack/special on a frame that starts stopped and uses the latest target; special=%s', special => {
    // The first croissant stage leaves the defender free to act as soon as the stop ends.
    const b = duel('shokupan', 'croissant'); b.cpu.meter = 100; b.player.meter = 100; startSpecial(b.state, 'B', []); untilStop(b); b.drainEvents();
    const frozen = structuredClone(b.state); b.advance(STEP, LIMIT, true, special);
    expect(b.state).toEqual(frozen); expect(b.frameEffectDt).toBe(0);
    b.advance(b.hitStopRemaining + STEP, -LIMIT, true, special);
    expect(b.player.attack).toBeNull(); expect(b.player.meter).toBe(100); expect(b.freezing).toBe(false);
    expect(b.player.x).toBeLessThan(0); expect(b.frameEffectDt).toBeCloseTo(STEP); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
    expect(b.drainEvents().some(e => e.side === 'player' && ['attack', 'special'].includes(e.kind))).toBe(false);
    b.advance(STEP, LIMIT); expect(b.player.x).toBeCloseTo(0);
  });
  it('pause and a stalled frame retain the stop and CPU timers, with no backlog on resume', () => {
    const b = duel(); b.attack('player'); untilStop(b); b.cpuEnabled = true;
    const hidden = b as unknown as { nextCpu: number; nextMove: number; seed: number };
    const frozen = structuredClone(b.state), timers = [hidden.nextCpu, hidden.nextMove, hidden.seed], left = b.hitStopRemaining;
    b.advance(.3, LIMIT, true, true); expect(b.paused).toBe(true); expect(b.hitStopRemaining).toBe(left);
    b.advance(.2, LIMIT); expect(b.state).toEqual(frozen); expect(b.frameEffectDt).toBe(0);
    b.setPaused(false); b.advance(left / 2, LIMIT); expect([hidden.nextCpu, hidden.nextMove, hidden.seed]).toEqual(timers); expect(b.state).toEqual(frozen);
    b.setPaused(true); b.advance(.2, 0); b.setPaused(false); b.advance(b.hitStopRemaining, 0);
    expect(b.state).toEqual(frozen); b.advance(STEP, 0); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
  });
});
describe('3D contact and battle rules', () => {
  it.each([false, true])('hit stop freezes both fighters and the clock, including practice=%s', practice => {
    const b = duel(); b.practice = practice; b.attack('player');
    while (!b.events.some(e => e.kind === 'hit')) b.advance(STEP, 0);
    const frozen = structuredClone(b.state), poses = [pose(b.player, 'player'), pose(b.cpu, 'cpu')];
    b.advance(HIT_STOP_SECONDS / 2, LIMIT, true); b.advance(HIT_STOP_SECONDS / 2, -LIMIT, true);
    expect(b.state).toEqual(frozen); expect([pose(b.player, 'player'), pose(b.cpu, 'cpu')]).toEqual(poses);
    b.advance(STEP, 0); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
  });
  it('stops once for a clash without catching up after the stop', () => {
    const b = duel(); b.attack('cpu'); run(b, .65); b.attack('player');
    while (!b.events.some(e => e.kind === 'clash')) b.advance(STEP, 0);
    expect(b.hitStopRemaining).toBe(HIT_STOP_CLASH_SECONDS);
    const frozen = structuredClone(b.state); b.advance(HIT_STOP_CLASH_SECONDS, 0); expect(b.state).toEqual(frozen);
    b.advance(STEP, 0); expect(b.elapsed - frozen.elapsed).toBeCloseTo(STEP);
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
          if (!aims.has(attack.id)) { aims.set(attack.id, attack.aim); if (!attack.special) starts.push({ time: b.elapsed, aim: attack.aim, windup: attack.windup, recovery: attack.recovery }); }
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
    b.state.specials = false; // normal-swing policy only; specials have their own tests
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

describe('CPU battle specials', () => {
  it('the cut-in freezes combat time in real time, drops inputs, and never catches up afterwards', () => {
    const b = duel(); b.player.meter = 100;
    b.advance(STEP, 0, true, true);
    expect(b.freezing).toBe(true); expect(b.cutin?.side).toBe('player'); expect(b.player.attack?.special).toBeTruthy(); expect(b.player.meter).toBe(0);
    const frozen = structuredClone(b.state);
    for (let t = 0; t < CUTIN_SECONDS - .05; t += STEP) b.advance(STEP, LIMIT, true, true);
    expect(b.state).toEqual(frozen); expect(b.drainEvents().filter(e => e.kind === 'attack')).toHaveLength(0);
    run(b, .1, LIMIT); expect(b.freezing).toBe(false); expect(b.cutin).toBeNull();
    expect(b.elapsed).toBeLessThan(.1); expect(b.player.attack?.age).toBeLessThan(.1);
  });
  it('a pause during the cut-in keeps the remaining freeze', () => {
    const b = duel(); b.player.meter = 100; b.advance(STEP, 0, false, true); b.advance(.2, 0);
    const left = b.cutin!.left; b.setPaused(true); b.advance(.2, 0); expect(b.cutin!.left).toBe(left);
    b.setPaused(false); b.advance(.2, 0); expect(b.cutin!.left).toBeCloseTo(left - .2);
  });
  it('a CPU special due on the same update joins the player special in one cut-in', () => {
    const b = new Battle('shokupan', 'francepan', { seed: 3, difficulty: 'normal' });
    const hidden = b as unknown as { nextCpu: number; fullSince: number };
    b.player.meter = 100; b.cpu.meter = 100; hidden.fullSince = -10; hidden.nextCpu = 0;
    b.advance(STEP, 0, false, true);
    expect(b.cutin?.side).toBe('both'); expect(b.drainEvents().filter(e => e.kind === 'special').map(e => e.side)).toEqual(['player', 'cpu']);
    expect(b.cpu.attack!.windup).toBeCloseTo(SPECIALS.francepan.windup + DIFFICULTY.normal.specialWindup);
  });
  it('once per match at 60% HP the CPU charges a full meter over 1.5 s and then fires a dodgeable special', () => {
    const b = new Battle('shokupan', 'croissant', { seed: 5 }); b.cpu.hp = 60; b.player.hp = 1000;
    run(b, STEP * 2); expect(b.cpuCharging).toBe(true);
    run(b, CPU_RAGE.seconds / 2); expect(b.cpu.meter).toBeGreaterThan(40); expect(b.cpu.meter).toBeLessThan(60);
    run(b, CPU_RAGE.seconds / 2 + .05); expect(b.cpu.meter).toBe(100); expect(b.cpuCharging).toBe(false);
    let fired = false;
    for (let i = 0; i < 12 / STEP && !fired; i++) { b.advance(STEP, b.player.x); fired = b.drainEvents().some(e => e.kind === 'special' && e.side === 'cpu'); }
    expect(fired).toBe(true);
    run(b, 5); b.cpu.meter = 0; run(b, 3);
    expect(b.cpuCharging).toBe(false); expect(b.cpu.meter).toBeLessThan(100); // never a second charge
  });
  it('the CPU charge always takes the full 1.5 s, even from a partly filled meter', () => {
    const b = new Battle('shokupan', 'shokupan', { seed: 9 }); b.cpu.hp = 50; b.cpu.meter = 75; b.player.hp = 1000;
    run(b, STEP * 2); expect(b.cpuCharging).toBe(true);
    b.cpu.meter = 99.5; // a hit landed mid-charge cannot finish it early
    run(b, CPU_RAGE.seconds - .1); expect(b.cpu.meter).toBeLessThan(100); expect(b.canSpecial('cpu')).toBe(false);
    run(b, .15); expect(b.cpu.meter).toBe(100);
  });
  it('a CPU hit or dodge landing during the charge never shows a full meter before 1.5 s', () => {
    const b = new Battle('shokupan', 'shokupan', { seed: 11 }); b.cpu.hp = 50; b.cpu.meter = 80; b.player.hp = 1000;
    b.advance(STEP, 0); expect(b.cpuCharging).toBe(true); b.attack('cpu');
    let hit = false;
    for (let t = STEP; t < CPU_RAGE.seconds - .05; t += STEP) { b.advance(STEP, 0); hit ||= b.drainEvents().some(e => e.kind === 'hit' && e.side === 'cpu'); expect(b.cpu.meter).toBeLessThan(100); }
    // The charge counts combat time, so the hit stop pushes completion slightly later in real time.
    expect(hit).toBe(true); run(b, .2, 0); expect(b.cpu.meter).toBe(100);
  });
  it('practice stage 4: see and dodge the CPU special, then fire your own; nothing ever hurts', () => {
    const b = new Battle('croissant', 'shokupan', { practice: true }); b.practiceStage = PRACTICE_SPECIAL_STAGE; b.enterSpecialPractice();
    expect(b.cpu.meter).toBe(100); expect(b.player.meter).toBe(0);
    b.player.meter = 100; expect(b.canSpecial('player')).toBe(false); // no own special before the dodge
    b.advance(STEP, 0, false, true); expect(b.special('player')).toBe(false); expect(b.player.attack).toBeNull(); b.player.meter = 0;
    let seen = false;
    for (let i = 0; i < 4 / STEP && !seen; i++) { b.advance(STEP, 0); seen = !!b.cpu.attack?.special; }
    expect(seen).toBe(true); expect(b.cpu.attack!.windup).toBeCloseTo(SPECIALS.shokupan.windup + DIFFICULTY.gentle.specialWindup);
    for (let i = 0; i < 4 / STEP && (b.cpu.attack || b.freezing); i++) b.advance(STEP, LIMIT);
    expect(b.drainEvents().some(e => e.kind === 'dodge' && e.side === 'player' && e.special)).toBe(true);
    b.specialFire(); expect(b.player.meter).toBe(100);
    run(b, .5, 0); b.advance(STEP, 0, false, true); run(b, CUTIN_SECONDS + 2, 0);
    expect(b.drainEvents().filter(e => e.kind === 'special-hit' && e.side === 'player').length).toBeGreaterThan(0);
    expect([b.player.hp, b.cpu.hp]).toEqual([100, 100]);
    run(b, 1.2, 0); expect(b.player.meter).toBe(100); // refilled for another try
    expect(b.cpu.attack?.special).toBeFalsy();
  });
});
