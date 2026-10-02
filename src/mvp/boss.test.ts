import { describe, expect, it } from 'vitest';
import { BREADS, BREAD_IDS, BOSS_ID, LIMIT, STEP, type BreadId } from './config';
import { Battle, BOSS, ASSIST_WINDUP, BOSS_GUARD } from './battle';
import { createBattle, phase, startAttack, startSpecial, stepBattle, type BattleEvent, type BattleState } from '../shared/battle';
import { playable as isBread } from './save';
import { METER_MAX, SPECIALS, specialDuration } from '../shared/specials';
import { CHALLENGE_ORDER, COURSE, ChallengeStore, CHALLENGE_KEY, STAGES, STAGE_SECONDS, emptyChallenge, lineup, loseStage, newRun, offerAssist, parseChallenge, recordClear, stageSeed, stageSetup, summary, winStage, type StageResult } from './challenge';
import { INTRO_CUES, INTRO_SECONDS, INTRO_SHORT_SECONDS, LANDED_Y, STAND_Y, BOSS_CAMERA, cuesBetween, introFrame } from './cinematic';
import { normalDangerHalfWidth, dangerHalfWidth } from './renderer';
import { FaceState } from './face-state';

const run = (s: BattleState, seconds: number, target: (t: number) => { A: number; B: number }): BattleEvent[] => {
  const events: BattleEvent[] = [];
  for (let t = 0; t < seconds && !s.winner; t += STEP) { const x = target(t); stepBattle(s, { A: { target: x.A, attack: false }, B: { target: x.B, attack: false } }, events); }
  return events;
};
// A boss fight as the CPU battle sets it up: course timings, the boss's sidestep speed and the KO-only rule.
function bossState(player: BreadId): BattleState {
  const s = createBattle(player, BOSS_ID, 'cpu'); s.specials = true; s.fighters.A.meter = 0; s.fighters.B.meter = 0;
  s.cpuExtra = { windup: BOSS.phase1.windup, recovery: BOSS.phase1.recovery, damage: 1 }; Object.assign(s, { limit: BOSS.limit, koOnly: true, cpuSpeed: BOSS.speed, guard: BOSS_GUARD });
  return s;
}

describe('boss roster isolation', () => {
  it('keeps the boss out of the playable six, the PvP check and the selection list', () => {
    expect(BREAD_IDS).toHaveLength(6); expect(BREAD_IDS).not.toContain(BOSS_ID);
    expect(isBread(BOSS_ID)).toBe(false); expect(isBread('shokupan')).toBe(true);
    expect(BREADS.ikkin).toMatchObject({ hp: 180, damage: 24, reach: 1.72, width: .75, height: .80, depth: .65 });
    expect(SPECIALS.ikkin.stages).toEqual([{ from: 132, to: 156, damage: 34, stop: .0833, recoil: true }]);
  });
  it('leaves PvP at 60 s and 4.8 m/s even if CPU-only fields are present', () => {
    const s = createBattle('shokupan', 'croissant', 'pvp'); Object.assign(s, { cpuSpeed: 1, koOnly: true });
    run(s, .2, () => ({ A: 0, B: 1 }));
    expect(s.fighters.B.x).toBeCloseTo(4.8 * .2, 1);
    run(s, 61, () => ({ A: 0, B: 0 }));
    expect(s.elapsed).toBeCloseTo(60, 5); expect(s.winner).toBe('draw');
  });
});

describe('boss rules in the core', () => {
  it('runs 90 s and a time-out never beats a standing boss, even ahead on HP ratio', () => {
    const s = bossState('shokupan'); s.fighters.B.hp = 150;
    run(s, 95, () => ({ A: 0, B: 0 }));
    expect(s.elapsed).toBeCloseTo(90, 5); expect(s.winner).toBe('B');
  });
  it('a level time-out still loses to a standing boss; only a double KO is a draw', () => {
    const level = bossState('shokupan'); level.fighters.A.hp = 50; level.fighters.B.hp = 90;
    run(level, 95, () => ({ A: 0, B: 0 })); expect(level.winner).toBe('B');
    const full = bossState('shokupan'); run(full, 95, () => ({ A: 0, B: 0 })); expect(full.winner).toBe('B');
    const double = bossState('shokupan'); double.fighters.A.hp = 0; double.fighters.B.hp = 0; run(double, .1, () => ({ A: 0, B: 0 })); expect(double.winner).toBe('draw');
  });
  it('a knocked-out boss is a win, and a challenge stage stops at its own 45 s', () => {
    const s = bossState('melonpan'); s.fighters.B.hp = 0; run(s, .1, () => ({ A: 0, B: 0 })); expect(s.winner).toBe('A');
    const b = new Battle('shokupan', 'creampan', { profile: COURSE[0], limit: STAGE_SECONDS }); b.cpuEnabled = false; b.cpu.hp = 40;
    for (let i = 0; i < 60 * 50 && !b.outcome; i++) b.advance(1 / 50, 0);
    expect(b.elapsed).toBeCloseTo(45, 4); expect(b.outcome).toBe('win');
  });
  it('crust guard: a quarter of a normal hit while the boss is ready, full damage in its recovery, from a counter or a special', () => {
    const hit = (setup: (s: BattleState) => void): { dealt: number; events: BattleEvent[] } => {
      const s = bossState('shokupan'), events: BattleEvent[] = []; setup(s);
      startAttack(s, 'A', events); const before = s.fighters.B.hp;
      run(s, .6, () => ({ A: 0, B: 0 })).forEach(e => events.push(e));
      return { dealt: before - s.fighters.B.hp, events };
    };
    const ready = hit(() => {});
    expect(ready.dealt).toBeCloseTo(18 * BOSS_GUARD); expect(ready.events.find(e => e.kind === 'hit')?.guard).toBe(true);
    const open = hit(s => { s.fighters.B.attack = { age: 1.2, windup: .9, recovery: 1.15, spent: true, aim: 0, origin: 0, threatened: false, resolved: true, id: 99 }; });
    expect(open.dealt).toBeCloseTo(18); expect(open.events.find(e => e.kind === 'hit')?.guard).toBeUndefined();
    const counter = hit(s => { s.counters.A = { until: 99, available: true }; });
    expect(counter.dealt).toBeCloseTo(18 * 1.25);
    const s = bossState('shokupan'); s.fighters.A.meter = METER_MAX; const events: BattleEvent[] = []; startSpecial(s, 'A', events);
    run(s, specialDuration('shokupan'), () => ({ A: 0, B: 0 })); expect(BREADS.ikkin.hp - s.fighters.B.hp).toBe(32);
    const pvp = createBattle('shokupan', 'croissant', 'pvp'); pvp.guard = .1; startAttack(pvp, 'A', events);
    run(pvp, 1.2, () => ({ A: 0, B: 0 })); expect(100 - pvp.fighters.B.hp).toBe(18);
  });
  it('the boss sidesteps at 1.8 m/s', () => {
    const s = bossState('shokupan'); run(s, .5, () => ({ A: 0, B: 1.15 }));
    expect(s.fighters.B.x).toBeCloseTo(.9, 2);
  });
});

describe('every bread can avoid every boss attack after a 350 ms reaction (plans/EXECPLAN-BOSS.md 2)', () => {
  const starts = [-LIMIT, -.6, 0, .6, LIMIT];
  for (const bread of BREAD_IDS) for (const kind of ['normal', 'press'] as const) for (const x of starts) it(`${bread} from ${x} vs ${kind}`, () => {
    const s = bossState(bread), events: BattleEvent[] = [];
    s.fighters.A.x = x; s.fighters.B.x = x;
    if (kind === 'normal') expect(startAttack(s, 'B', events)).toBe(true);
    else { s.fighters.B.meter = METER_MAX; expect(startSpecial(s, 'B', events)).toBe(true); }
    const aim = s.fighters.B.attack!.aim, away = aim <= 0 ? LIMIT : -LIMIT;
    const length = kind === 'normal' ? BREADS.ikkin.windup + BOSS.phase1.windup + BREADS.ikkin.active + .1 : specialDuration(BOSS_ID) - SPECIALS.ikkin.recovery + .1;
    run(s, length, t => ({ A: t < .35 ? x : away, B: x }));
    expect(s.fighters.A.hp, `${bread} hit`).toBe(100);
  });
  it('the drawn lanes cover the real reach and stay inside the table', () => {
    for (const bread of BREAD_IDS) {
      const normal = normalDangerHalfWidth(BOSS_ID, bread), press = dangerHalfWidth(BOSS_ID, bread);
      expect(normal).toBeGreaterThan(.55); expect(normal).toBeLessThan(LIMIT);
      expect(press).toBeGreaterThan(.5); expect(press).toBeLessThan(LIMIT);
    }
  });
});

describe('boss AI', () => {
  const boss = (player: BreadId = 'shokupan', assist = false): Battle => new Battle(player, BOSS_ID, { seed: 3, assist });
  it('sets the 90 s KO-only fight up and pads the telegraph (plus the optional helper)', () => {
    const b = boss();
    expect(b.limit).toBe(90); expect(b.state.koOnly).toBe(true); expect(b.state.cpuSpeed).toBe(1.8); expect(b.bossPhase).toBe(1);
    expect(b.state.cpuExtra!.windup).toBe(.40);
    expect(boss('shokupan', true).state.cpuExtra!.windup).toBeCloseTo(.40 + ASSIST_WINDUP);
  });
  it('enters the second form once at 90 HP, first charges at 4 s and keeps specials 8 s apart', () => {
    const b = boss(); let charged = -1; const specials: number[] = [];
    for (let i = 0; i < 40 * 60; i++) {
      b.advance(1 / 60, b.player.x);
      if (b.cpuCharging && charged < 0) charged = b.elapsed;
      for (const e of b.drainEvents()) if (e.kind === 'special' && e.side === 'cpu') specials.push(b.elapsed);
      if (b.outcome) break;
      b.player.hp = 100;
      if (b.elapsed >= 6 && b.bossPhase === 1) b.cpu.hp = 90;
    }
    expect(charged).toBeGreaterThanOrEqual(4 - 1e-6); expect(charged).toBeLessThan(4.1);
    expect(b.bossPhase).toBe(2); expect(b.phaseShiftAt).toBeGreaterThan(5.9);
    expect(specials.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < specials.length; i++) expect(specials[i]! - specials[i - 1]!).toBeGreaterThanOrEqual(BOSS.specialGap - 1e-6);
  });
  it('never pairs swings and keeps the telegraph the same in both forms', () => {
    const b = boss(); b.cpu.hp = 80; const windups = new Set<number>();
    for (let i = 0; i < 20 * 60; i++) {
      b.advance(1 / 60, b.player.x); b.player.hp = 100; b.cpu.meter = 0;
      const a = b.cpu.attack; if (a && !a.special) windups.add(Math.round(a.windup * 100));
      if (b.outcome) break;
    }
    expect(b.bossPhase).toBe(2); expect([...windups]).toEqual([90]);
  });
});

// Two scripted players (plans/EXECPLAN-BOSS.md 8): one mashes attack and special standing still; the other sidesteps
// 350 ms into each boss swing and strikes back only while the boss recovers. Mashing must lose, the core loop must win.
function botFight(bread: BreadId, bot: 'mash' | 'skilled', seed: number): { outcome: string | null; seconds: number } {
  const b = new Battle(bread, BOSS_ID, { seed }); let target = 0;
  for (let i = 0; i < 95 * 60 && !b.outcome; i++) {
    const a = b.cpu.attack, p = phase(b.cpu); let attack = true;
    if (bot === 'skilled') {
      if (a && a.age > .35 && (p === 'windup' || p === 'active')) target = a.aim <= 0 ? LIMIT : -LIMIT;
      else if (!a) target = b.cpu.x;
      attack = (p === 'recovery' || !a) && Math.abs(b.player.x - b.cpu.x) < .5;
    }
    b.advance(1 / 60, target, attack, attack); b.drainEvents();
  }
  return { outcome: b.outcome, seconds: b.elapsed };
}
describe('boss balance with scripted players', () => {
  for (const bread of BREAD_IDS) it(`${bread}: mashing loses, dodge-and-counter wins well inside 90 s`, () => {
    for (const seed of [11, 23, 47]) {
      expect(botFight(bread, 'mash', seed).outcome).not.toBe('win');
      const skilled = botFight(bread, 'skilled', seed);
      expect(skilled.outcome).toBe('win'); expect(skilled.seconds).toBeGreaterThan(25); expect(skilled.seconds).toBeLessThan(75);
    }
  });
});

describe('challenge course', () => {
  it('fights the other five once each, in the fixed order, then the boss', () => {
    for (const bread of BREAD_IDS) {
      const order = lineup(bread);
      expect(order).toHaveLength(STAGES); expect(order.at(-1)).toBe(BOSS_ID); expect(order).not.toContain(bread);
      expect(new Set(order).size).toBe(STAGES); expect(order.slice(0, 5)).toEqual(CHALLENGE_ORDER.filter(id => id !== bread));
    }
  });
  it('gets harder stage by stage and gives the boss its own setup', () => {
    const r = newRun('melonpan', 'touch', 9);
    for (let i = 0; i < 5; i++) expect(stageSetup(r, i)).toMatchObject({ boss: false, limit: 45, profile: COURSE[i] });
    expect(stageSetup(r, 5)).toEqual({ opponent: BOSS_ID, boss: true });
    for (let i = 1; i < 5; i++) { expect(COURSE[i]!.windup).toBeLessThanOrEqual(COURSE[i - 1]!.windup); expect(COURSE[i]!.pace).toBeLessThanOrEqual(COURSE[i - 1]!.pace); }
    expect(COURSE.every(p => !p.punish)).toBe(true);
  });
  it('advances on a win, retries the same stage on a loss, and offers help after two defeats', () => {
    const res: StageResult = { score: 80, dodge: 3, chances: 4, counters: 1, seconds: 30 };
    let r = newRun('shokupan', 'keyboard', 1); const seed = stageSeed(r);
    r = loseStage(r, 20); expect(r.stage).toBe(0); expect(stageSeed(r)).toBe(seed); expect(offerAssist(r)).toBe(false);
    r = loseStage(r, 20); expect(offerAssist(r)).toBe(true);
    r = winStage(r, res); expect(r.stage).toBe(1); expect(r.failsHere).toBe(0); expect(r.retries).toBe(2); expect(r.playSeconds).toBe(70);
    expect(summary(r).rank).toBeNull();
    for (let i = 1; i < STAGES; i++) r = winStage(r, { ...res, score: 90 });
    expect(winStage(r, res)).toBe(r);
    const s = summary(r); expect(s.cleared).toBe(6); expect(s.total).toBe(530); expect(s.rank).toBe('A'); expect(s.dodgeRate).toBeCloseTo(.75);
    let perfect = newRun('croissant', 'touch', 2); for (let i = 0; i < STAGES; i++) perfect = winStage(perfect, { ...res, score: 92 });
    expect(summary(perfect).rank).toBe('S');
    expect(summary({ ...perfect, assist: true }).rank).toBe('A');
    // Rank boundaries use the exact mean: 507/600 (84.5) is A even with a perfect run, 510 is S; 417 (69.5) is B.
    const totalOf = (scores: number[]) => { let x = newRun('melonpan', 'touch', 3); for (const score of scores) x = winStage(x, { ...res, score }); return summary(x).rank; };
    expect(totalOf([85, 85, 85, 84, 84, 84])).toBe('A'); expect(totalOf([85, 85, 85, 85, 85, 85])).toBe('S'); expect(totalOf([70, 70, 70, 69, 69, 69])).toBe('B');
    const records = recordClear(recordClear({}, perfect), r);
    expect(records.croissant).toEqual({ clears: 1, best: 552, fewestRetries: 0, perfect: true });
    expect(records.shokupan).toEqual({ clears: 1, best: 530, fewestRetries: 2, perfect: false });
  });
  it('saves stage by stage, rejects tampered data without overwriting it, and survives a failed write', () => {
    const memory = new Map<string, string>(), storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); } };
    const store = new ChallengeStore(() => storage);
    store.update(d => ({ ...d, run: newRun('currypan', 'sensor', 5) }));
    expect(parseChallenge(memory.get(CHALLENGE_KEY)!).run!.bread).toBe('currypan');
    expect(new ChallengeStore(() => storage).data.run!.order.at(-1)).toBe(BOSS_ID);
    for (const bad of [{ ...emptyChallenge(), rule: 'x' }, { ...emptyChallenge(), run: { ...newRun('currypan', 'touch', 1), order: ['ikkin'] } }, { ...emptyChallenge(), records: { ikkin: { clears: 1, best: 1, fewestRetries: 0, perfect: true } } },
      { ...emptyChallenge(), run: { ...newRun('currypan', 'touch', 1), stage: 2, results: [] } }]) {
      memory.set(CHALLENGE_KEY, JSON.stringify(bad));
      const broken = new ChallengeStore(() => storage);
      expect(broken.warning).not.toBe(''); expect(broken.update(d => d)).toBe(false); expect(memory.get(CHALLENGE_KEY)).toBe(JSON.stringify(bad));
    }
    const failing = new ChallengeStore(() => ({ getItem: () => null, setItem: () => { throw new Error('quota'); } }));
    expect(failing.update(d => ({ ...d, seenIntro: true }))).toBe(false); expect(failing.data.seenIntro).toBe(true); expect(failing.warning).not.toBe('');
  });
});

describe('boss face', () => {
  it('rests with an angry brow in the second form, and still smiles when beaten', () => {
    const rest = { phase: 'ready' as const, special: false, charging: false, stage: 0, ending: null, look: [0, 0] as const };
    expect(new FaceState('ikkin').update(.1, rest, true).brow).toBe('up');
    expect(new FaceState('ikkin').update(.1, { ...rest, heated: true }, true).brow).toBe('angry');
    expect(new FaceState('ikkin').update(.1, { ...rest, heated: true, ending: 'lose' }, true)).toMatchObject({ eyes: 'happy', mouth: 'win', brow: 'up' });
  });
});

describe('boss entrance timeline', () => {
  it('drops, lands on the cloth at 2.55 s, rises to the stance and ends on the battle camera', () => {
    expect(introFrame(1.5).bossVisible).toBe(false);
    expect(introFrame(2.55).bossY).toBeCloseTo(LANDED_Y, 2);
    expect(introFrame(3.4).bossY).toBeCloseTo(STAND_Y, 2);
    expect(introFrame(3.0).eyes).toBe(0); expect(introFrame(3.7).eyes).toBe(1);
    expect(introFrame(4.6).title).toBe(1); expect(introFrame(2).title).toBe(0);
    expect(introFrame(INTRO_SECONDS).camera).toEqual(BOSS_CAMERA); expect(introFrame(INTRO_SECONDS).done).toBe(true); expect(introFrame(5.9).done).toBe(false);
    expect(introFrame(1).challengerVisible).toBe(false); expect(introFrame(5.5).challengerVisible).toBe(true);
    let previous = Infinity; for (let t = 2; t <= 2.55; t += .05) { const y = introFrame(t).bossY; expect(y).toBeLessThanOrEqual(previous); previous = y; }
  });
  it('fires each cue exactly once across any frame split, and the short version only names the boss', () => {
    for (const step of [1 / 60, .1, .37]) {
      const heard: string[] = []; for (let t = 0; t < INTRO_SECONDS; t += step) heard.push(...cuesBetween(t, Math.min(INTRO_SECONDS, t + step)));
      expect(heard).toEqual(INTRO_CUES.map(c => c.cue));
    }
    const short = introFrame(.5, true);
    expect(short).toMatchObject({ bossY: STAND_Y, bossVisible: true, challengerVisible: true, title: 1, done: false, camera: BOSS_CAMERA });
    expect(introFrame(INTRO_SHORT_SECONDS, true).done).toBe(true);
    expect(cuesBetween(0, .1, true)).toEqual(['theme']);
  });
});
