import { describe, expect, it } from 'vitest';
import { BREAD_IDS, BREADS, LIMIT, STEP, type BreadId } from './rules';
import { createBattle, stepBattle, startAttack, startSpecial, canSpecial, pose, phase, specialTouching, otherSlot, SLOTS, type BattleState, type BattleEvent, type Commands } from './battle';
import { SPECIALS, METER_GAIN, METER_MAX, specialFrame, specialDuration, motionTime, liveStage } from './specials';

const still = (s: BattleState): Commands => ({ A: { target: s.fighters.A.x, attack: false }, B: { target: s.fighters.B.x, attack: false } });
function run(s: BattleState, seconds: number, commands = still(s), events: BattleEvent[] = []): void {
  for (let i = 0; i < Math.ceil(seconds / STEP); i++) stepBattle(s, commands, events);
}
function cpuBattle(a: BreadId, b: BreadId, practice = false): BattleState {
  const s = createBattle(a, b, 'cpu', practice); s.specials = true; s.fighters.A.meter = 0; s.fighters.B.meter = 0; return s;
}
const total = (bread: BreadId): number => SPECIALS[bread].stages.reduce((n, stage) => n + stage.damage, 0);
const combinations = BREAD_IDS.flatMap(a => BREAD_IDS.map(b => [a, b] as const));

describe('special move data', () => {
  it.each(BREAD_IDS)('%s keyframes start and end at rest and stages sit inside the active window', bread => {
    const spec = SPECIALS[bread], first = specialFrame(bread, 0), last = specialFrame(bread, 99);
    for (const frame of [first, last]) {
      expect(frame.alpha).toBeCloseTo(0); expect(frame.lift).toBeCloseTo(0); expect(frame.travel).toBeCloseTo(0); expect(frame.lean).toBeCloseTo(0);
      expect(frame.scale.every(v => Math.abs(v - 1) < 1e-9)).toBe(true);
    }
    expect(spec.keys.at(-1)!.t).toBeCloseTo(spec.windup + spec.active + spec.recovery);
    for (const stage of spec.stages) {
      expect(stage.from * STEP).toBeGreaterThanOrEqual(spec.windup - 1e-9);
      expect(stage.to * STEP).toBeLessThanOrEqual(spec.windup + spec.active + 1e-9);
    }
    for (let t = 0; t <= specialDuration(bread); t += .01) {
      const f = specialFrame(bread, t);
      expect(Math.max(...f.scale)).toBeLessThanOrEqual(1.3 + 1e-9);
      expect(Number.isFinite(f.roll)).toBe(true);
    }
  });
  it('damage is 32 / 36 / 6+6+16 and a CPU wind-up stretch keeps active and recovery timing', () => {
    expect(BREAD_IDS.map(total)).toEqual([32, 36, 28]);
    expect(SPECIALS.croissant.stages.map(s => s.damage)).toEqual([6, 6, 16]);
    expect(motionTime('shokupan', .70 + .35, .35)).toBeCloseTo(.70);
    expect(motionTime('shokupan', .525, .35)).toBeCloseTo(.35);
    expect(motionTime('shokupan', 1.05 + .2, .2)).toBeCloseTo(1.05);
    expect(liveStage('croissant', 70)).toBe(0); expect(liveStage('croissant', 80)).toBe(-1); expect(liveStage('croissant', 110)).toBe(2);
  });
});

describe('special meter', () => {
  it('a normal hit gives +25, a counter +40, a dodge +30 and a clash +10 to each side', () => {
    let s = cpuBattle('shokupan', 'shokupan'), events: BattleEvent[] = [];
    startAttack(s, 'A', events); run(s, 2, still(s), events);
    expect(s.fighters.A.meter).toBe(METER_GAIN.hit); expect(s.fighters.B.meter).toBe(0);

    s = cpuBattle('shokupan', 'shokupan'); events = [];
    startAttack(s, 'B', events);
    const dodge = still(s); dodge.A.target = LIMIT;
    while (!s.counters.A.available && s.elapsed < 3) stepBattle(s, dodge, events);
    expect(s.fighters.A.meter).toBe(METER_GAIN.dodge);
    startAttack(s, 'A', events); const back = still(s); back.A.target = 0; run(s, 2, back, events);
    expect(s.scores.A.counter.success).toBe(1);
    expect(s.fighters.A.meter).toBe(METER_GAIN.dodge + METER_GAIN.counter);

    s = cpuBattle('croissant', 'croissant'); events = [];
    s.cpuExtra = { windup: 0, recovery: 0 };
    stepBattle(s, { A: { target: 0, attack: true }, B: { target: 0, attack: true } }, events); run(s, 2, still(s), events);
    expect(events.filter(e => e.kind === 'clash')).toHaveLength(1);
    expect([s.fighters.A.meter, s.fighters.B.meter]).toEqual([METER_GAIN.clash, METER_GAIN.clash]);
  });
  it('caps at 100, never grows from misses, time or being hit, and stays absent in PvP', () => {
    const s = cpuBattle('shokupan', 'francepan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 90; startAttack(s, 'A', events); run(s, 2, still(s), events);
    expect(s.fighters.A.meter).toBe(METER_MAX); expect(s.fighters.B.meter).toBe(0);
    run(s, 5, still(s), events); expect(s.fighters.B.meter).toBe(0);
    s.fighters.B.x = LIMIT; startAttack(s, 'A', events); run(s, 2, still(s), events);
    expect(s.fighters.B.meter).toBe(0); // a swing that was never near is not a dodge
    const pvp = createBattle('shokupan', 'shokupan'); startAttack(pvp, 'A', []); run(pvp, 2);
    expect('meter' in pvp.fighters.A).toBe(false); expect(pvp.fighters.A.attack).toBeNull();
  });
  it('the CPU earns +30 for a real sidestep even when it gets no counter window (gentle/normal)', () => {
    const s = cpuBattle('shokupan', 'croissant'), events: BattleEvent[] = [];
    startAttack(s, 'A', events); const away = still(s); away.B.target = -LIMIT; run(s, 2, away, events);
    expect(s.fighters.B.meter).toBe(METER_GAIN.dodge); expect(s.counters.B.available).toBe(false);
  });
});

describe('special activation', () => {
  it('needs a full meter, no attack, no recoil and no winner; a refused request keeps the meter', () => {
    const s = cpuBattle('shokupan', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 99; expect(startSpecial(s, 'A', events)).toBe(false); expect(s.fighters.A.meter).toBe(99);
    s.fighters.A.meter = 100; startAttack(s, 'A', events); expect(startSpecial(s, 'A', events)).toBe(false); expect(s.fighters.A.meter).toBe(100);
    s.fighters.A.attack = null; s.fighters.A.recoil = .1; expect(canSpecial(s, 'A')).toBe(false);
    s.fighters.A.recoil = 0; s.winner = 'B'; expect(canSpecial(s, 'A')).toBe(false);
    s.winner = null; expect(startSpecial(s, 'A', events)).toBe(true); expect(s.fighters.A.meter).toBe(0);
    expect(startSpecial(s, 'A', events)).toBe(false);
    expect(events.filter(e => e.kind === 'special')).toHaveLength(1);
  });
  it('is rejected by the core in PvP even with a full meter', () => {
    const s = createBattle('shokupan', 'shokupan'); s.specials = true; s.fighters.A.meter = 100;
    expect(startSpecial(s, 'A', [])).toBe(false);
    const plain = createBattle('croissant', 'francepan'), requested = createBattle('croissant', 'francepan');
    const eventsPlain: BattleEvent[] = [], eventsRequested: BattleEvent[] = [];
    for (let i = 0; i < 400; i++) {
      const attack = i % 90 === 0;
      stepBattle(plain, { A: { target: .3, attack }, B: { target: -.2, attack: i % 130 === 0 } }, eventsPlain);
      stepBattle(requested, { A: { target: .3, attack, special: true }, B: { target: -.2, attack: i % 130 === 0, special: true } }, eventsRequested);
    }
    expect(requested).toEqual(plain); expect(eventsRequested).toEqual(eventsPlain);
  });
  it('both sides can start on the same tick regardless of slot order', () => {
    const s = cpuBattle('francepan', 'croissant'), events: BattleEvent[] = [];
    s.fighters.A.meter = s.fighters.B.meter = 100;
    stepBattle(s, { A: { target: 0, attack: true, special: true }, B: { target: 0, attack: false, special: true } }, events);
    expect(events.filter(e => e.kind === 'special').map(e => e.side)).toEqual(['A', 'B']);
    expect(events.some(e => e.kind === 'attack')).toBe(false);
    expect(s.fighters.A.attack?.special && s.fighters.B.attack?.special).toBeTruthy();
    run(s, 3, still(s), events);
    expect(s.fighters.A.hp).toBe(100 - total('croissant')); expect(s.fighters.B.hp).toBe(100 - total('francepan'));
  });
});

describe('special hits and dodges', () => {
  it.each(combinations)('%s special lands its full damage on a still %s, once per stage', (a, b) => {
    for (const slot of SLOTS) {
      const s = cpuBattle(a, b), other = otherSlot(slot), events: BattleEvent[] = [];
      s.cpuExtra = { windup: 0, recovery: 0, damage: 3 };
      s.fighters[slot].meter = 100; s.counters[slot] = { until: 99, available: true };
      expect(startSpecial(s, slot, events)).toBe(true);
      const bread = s.fighters[slot].bread;
      run(s, specialDuration(bread) + .1, still(s), events);
      expect(s.fighters[other].hp).toBe(100 - total(bread));
      expect(events.filter(e => e.kind === 'special-hit').map(e => e.stage)).toEqual(SPECIALS[bread].stages.map((_, i) => i));
      expect(s.fighters[slot].meter).toBe(0); expect(s.fighters[other].meter).toBe(0);
      expect(s.scores[other].dodge).toEqual({ success: 0, opportunities: 1 });
      expect(s.fighters[slot].attack).toBeNull();
    }
  });
  it.each(combinations)('%s special can be fully dodged by %s with an early sidestep, never touching during active', (a, b) => {
    for (const slot of SLOTS) {
      const s = cpuBattle(a, b), other = otherSlot(slot), events: BattleEvent[] = [], bread = s.fighters[slot].bread;
      s.fighters[slot].meter = 100; startSpecial(s, slot, events);
      const dodge = still(s); dodge[other].target = LIMIT;
      for (let i = 0; i < Math.ceil(specialDuration(bread) / STEP); i++) {
        stepBattle(s, dodge, events);
        const attacker = s.fighters[slot];
        if (attacker.attack?.special && phase(attacker) === 'active')
          expect(specialTouching(bread, pose(attacker, slot), pose(s.fighters[other], other))).toBe(false);
      }
      expect(s.fighters[other].hp).toBe(100);
      expect(s.scores[other].dodge).toEqual({ success: 1, opportunities: 1 });
      expect(s.fighters[other].meter).toBe(METER_GAIN.dodge);
      expect(events.some(e => e.kind === 'dodge' && e.side === other && e.special)).toBe(true);
      expect(events.some(e => e.kind === 'miss' && e.side === slot && e.special)).toBe(true);
    }
  });
  it.each([-LIMIT, -.6, 0, .6, LIMIT])('a target at x=%s always has a safe side to escape to', x => {
    for (const [a, b] of combinations) {
      const s = cpuBattle(a, b), events: BattleEvent[] = [];
      s.fighters.B.x = x; s.fighters.A.meter = 100; startSpecial(s, 'A', events);
      const escape = still(s); escape.B.target = x > 0 ? -LIMIT : LIMIT;
      run(s, specialDuration(a), escape, events);
      expect(s.fighters.B.hp).toBe(100);
    }
  });
  it('the aim stays locked after activation', () => {
    const s = cpuBattle('francepan', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.B.x = .5; s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    const aim = s.fighters.A.attack!.aim;
    const move = still(s); move.B.target = -LIMIT; run(s, .3, move, events);
    expect(s.fighters.A.attack!.aim).toBe(aim); expect(aim).toBe(.5);
  });
  it('croissant partial hits add up only the stages that touched and give no dodge credit', () => {
    const s = cpuBattle('croissant', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    const stay = still(s);
    while (!events.some(e => e.kind === 'special-hit')) stepBattle(s, stay, events);
    const escape = still(s); escape.B.target = LIMIT; run(s, 1.2, escape, events);
    expect(s.fighters.B.hp).toBe(100 - 6);
    expect(s.scores.B.dodge).toEqual({ success: 0, opportunities: 1 }); expect(s.fighters.B.meter).toBe(0);
    expect(s.counters.B.available).toBe(false);
  });
  it('no invulnerability: a normal hit during the wind-up still hurts, and a KO cancels later stages', () => {
    const s = cpuBattle('croissant', 'croissant'), events: BattleEvent[] = [];
    s.cpuExtra = { windup: 0, recovery: 0 };
    s.fighters.B.meter = 100; startSpecial(s, 'B', events, .35); startAttack(s, 'A', events);
    run(s, .5, still(s), events);
    expect(s.fighters.B.hp).toBe(100 - BREADS.croissant.damage);
    expect(s.fighters.B.attack?.special).toBeTruthy();
    s.fighters.A.hp = 6; run(s, 2, still(s), events);
    expect(s.winner).toBe('B'); expect(s.fighters.A.hp).toBe(0);
    expect(events.filter(e => e.kind === 'special-hit')).toHaveLength(1);
  });
  it('practice never changes HP but still resolves stages; time-up stops later stages', () => {
    const p = cpuBattle('croissant', 'francepan', true), events: BattleEvent[] = [];
    p.fighters.A.meter = 100; startSpecial(p, 'A', events); run(p, 2, still(p), events);
    expect(p.fighters.B.hp).toBe(100); expect(events.filter(e => e.kind === 'special-hit')).toHaveLength(3);
    const t = cpuBattle('croissant', 'francepan'); t.elapsed = 60 - .6; t.fighters.A.meter = 100; startSpecial(t, 'A', []);
    run(t, 2); expect(t.winner).not.toBeNull(); expect(t.fighters.B.hp).toBe(100 - 6);
  });
  it('a dodged special opens a counter window worth +40 and 1.25x on the next normal hit', () => {
    const s = cpuBattle('shokupan', 'francepan'), events: BattleEvent[] = [];
    s.fighters.B.meter = 100; startSpecial(s, 'B', events, .1);
    const dodge = still(s); dodge.A.target = LIMIT;
    while (!s.counters.A.available && s.elapsed < 3) stepBattle(s, dodge, events);
    expect(s.fighters.A.meter).toBe(30);
    // The francepan is still recovering near its locked aim (x=0); step back in and punish it.
    const back = still(s); back.A.target = 0; while (Math.abs(s.fighters.A.x) > .05) stepBattle(s, back, events);
    startAttack(s, 'A', events); run(s, 1.2, back, events);
    expect(s.fighters.B.hp).toBe(100 - BREADS.shokupan.damage * 1.25); expect(s.fighters.A.meter).toBe(70);
  });
  it('movement is locked through the wind-up, active window and the first recovery lock', () => {
    const s = cpuBattle('francepan', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    const right = still(s); right.A.target = LIMIT; const spec = SPECIALS.francepan;
    run(s, spec.windup + spec.active + spec.lock - .02, right, events); expect(s.fighters.A.x).toBe(0);
    run(s, .2, right, events); expect(s.fighters.A.x).toBeGreaterThan(0);
  });
  it('same inputs give the same state and events', () => {
    const play = (): [BattleState, BattleEvent[]] => {
      const s = cpuBattle('croissant', 'shokupan'), events: BattleEvent[] = [];
      s.fighters.A.meter = s.fighters.B.meter = 100;
      for (let i = 0; i < 900; i++) stepBattle(s, { A: { target: Math.sin(i / 40), attack: i % 70 === 0, special: i === 5 }, B: { target: Math.cos(i / 50), attack: i % 95 === 0, special: i === 200 } }, events);
      return [s, events];
    };
    expect(play()).toEqual(play());
  });
});
