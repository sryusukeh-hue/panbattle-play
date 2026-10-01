import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { BREADS, BREAD_IDS, LIMIT, STEP, type BreadId } from '../shared/rules';
import { createBattle, stepBattle, startAttack, startSpecial, pose, phase, specialTouching, type BattleState, type BattleEvent, type Commands } from '../shared/battle';
import { SPECIALS, METER_MAX, specialFrame, specialDuration, specialSweep, dodgeGain } from '../shared/specials';
import { Battle, CPU_STYLE } from './battle';
import { FACES } from './face-config';
import { FaceState } from './face-state';
import { dangerHalfWidth } from './renderer';
import { SaveStore, SAVE_KEY, condition, defaults } from './save';

// The three breads added by plans/EXECPLAN-CHARACTERS.md: what makes each one different, and the ID lists that must grow with them.
const NEW: readonly BreadId[] = ['melonpan', 'currypan', 'creampan'];
const OLD: readonly BreadId[] = ['shokupan', 'francepan', 'croissant'];
const still = (s: BattleState): Commands => ({ A: { target: s.fighters.A.x, attack: false }, B: { target: s.fighters.B.x, attack: false } });
function run(s: BattleState, seconds: number, commands = still(s), events: BattleEvent[] = []): void {
  for (let i = 0; i < Math.ceil(seconds / STEP); i++) stepBattle(s, commands, events);
}
function cpuBattle(a: BreadId, b: BreadId): BattleState {
  const s = createBattle(a, b, 'cpu'); s.specials = true; s.fighters.A.meter = 0; s.fighters.B.meter = 0; return s;
}

describe('roster', () => {
  it('has six breads, every one with a model, a face, a CPU style and a listed build asset', () => {
    expect(BREAD_IDS).toEqual([...OLD, ...NEW]);
    const vite = readFileSync('vite.config.ts', 'utf8'), size = readFileSync('scripts/check-size.mjs', 'utf8');
    for (const id of BREAD_IDS) {
      expect(existsSync(`public/assets/models/${id}.glb`), `${id}.glb`).toBe(true);
      expect(vite).toContain(`'${id}'`); expect(size).toContain(`'${id}'`);
      expect(FACES[id].eyes).toHaveLength(2); expect(CPU_STYLE[id].interval).toBeGreaterThan(0);
      expect(BREADS[id].hp).toBe(100); // the HUD draws HP as a percentage
      // The gentle CPU never swings more often than once per 2.7 s.
      expect(CPU_STYLE[id].pairInterval).toBeGreaterThanOrEqual(2.7);
    }
  });
  it('the existing three keep their numbers and their special paths', () => {
    expect(BREADS.shokupan).toMatchObject({ damage: 18, windup: .20, active: .19, recovery: .47, reach: 2.03 });
    expect(BREADS.francepan).toMatchObject({ damage: 23, windup: .28, active: .23, recovery: .72, reach: 1.98 });
    expect(BREADS.croissant).toMatchObject({ damage: 14, windup: .13, active: .16, recovery: .33, reach: 2.00 });
    for (const id of OLD) {
      expect(specialSweep(id)).toBe(0); expect(dodgeGain(id)).toBe(30);
      for (let t = 0; t <= specialDuration(id); t += .05) expect(specialFrame(id, t).side).toBe(0);
    }
  });
  it('each new bread leads the roster in the thing it is about', () => {
    const best = (pick: (id: BreadId) => number): BreadId => BREAD_IDS.reduce((a, b) => pick(b) > pick(a) ? b : a);
    expect(best(id => BREADS[id].damage)).toBe('currypan');
    expect(best(id => -BREADS[id].recovery)).toBe('creampan');
    expect(best(dodgeGain)).toBe('melonpan');
    // No bread out-damages the rest per second by a wide margin.
    const dps = BREAD_IDS.map(id => BREADS[id].damage / (BREADS[id].windup + BREADS[id].active + BREADS[id].recovery));
    expect(Math.max(...dps) / Math.min(...dps)).toBeLessThan(1.25);
  });
  it('saved records for the new breads load again, and unknown breads are still refused', () => {
    const map = new Map<string, string>(), storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    const store = new SaveStore(() => storage), b = new Battle('melonpan', 'creampan'); b.outcome = 'win'; b.scores.dodge = { success: 1, opportunities: 2 };
    store.data.bread = 'melonpan'; store.data.cpu = 'creampan'; store.record(b, 'touch'); store.recordScore(b, 'touch', 80);
    const reopened = new SaveStore(() => storage);
    expect(reopened.warning).toBe(''); expect(reopened.data.bread).toBe('melonpan');
    expect(reopened.data.best[condition('melonpan', 'creampan', 'touch')]?.dodge).toEqual({ success: 1, opportunities: 2 });
    expect(reopened.data.bestScoreV2?.[condition('melonpan', 'creampan', 'touch')]).toBe(80);
    map.set(SAVE_KEY, JSON.stringify({ ...defaults(), best: { 'table-special-1/anpan/shokupan/gentle/touch': { dodge: { success: 1, opportunities: 1 } } } }));
    expect(new SaveStore(() => storage).warning).not.toBe('');
  });
  it.each(NEW)('%s has its own special face and result faces', id => {
    const rest = new FaceState(id).update(0, { phase: 'ready', special: false, charging: false, stage: 0, ending: null, look: [0, 0] }, true);
    const special = new FaceState(id).update(0, { phase: 'active', special: true, charging: false, stage: 0, ending: null, look: [0, 0] }, true);
    const win = new FaceState(id).update(0, { phase: 'ready', special: false, charging: false, stage: 0, ending: 'win', look: [0, 0] }, true);
    expect(special.mouth).not.toBe(rest.mouth); expect(win.mouth).not.toBe(rest.mouth);
    expect(rest.open).toEqual([...FACES[id].open]);
  });
});

describe('melon pan: crisp charge and a roller that stays', () => {
  it('earns 35 per dodge, so three dodges fill the meter; hits and counters pay the usual amounts', () => {
    const s = cpuBattle('melonpan', 'shokupan'), events: BattleEvent[] = [];
    for (let i = 0; i < 3; i++) {
      s.fighters.A.x = 0; s.fighters.B.x = 0;
      startAttack(s, 'B', events);
      const dodge = still(s); dodge.A.target = LIMIT; run(s, 2.5, dodge, events);
      expect(s.fighters.A.meter).toBe(Math.min(METER_MAX, 35 * (i + 1)));
    }
    expect(s.fighters.A.hp).toBe(100); expect(s.fighters.B.meter).toBe(0);
    const hit = cpuBattle('melonpan', 'shokupan'); startAttack(hit, 'A', []); run(hit, 2);
    expect(hit.fighters.A.meter).toBe(25);
  });
  it('also earns 35 for dodging a whole special and for a meter-only dodge, but nothing extra in PvP', () => {
    const s = cpuBattle('francepan', 'melonpan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    const dodge = still(s); dodge.B.target = LIMIT; run(s, specialDuration('francepan'), dodge, events);
    expect(s.fighters.B.meter).toBe(35); expect(s.fighters.B.hp).toBe(100);
    // Gentle CPU: the player's swing is not "threatened", so the CPU's sidestep is credited through the meter-only path.
    const near = cpuBattle('shokupan', 'melonpan'); startAttack(near, 'A', []);
    const away = still(near); away.B.target = -LIMIT; run(near, 2, away);
    expect(near.fighters.B.meter).toBe(35); expect(near.counters.B.available).toBe(false);
    const pvp = createBattle('shokupan', 'melonpan'); startAttack(pvp, 'A', []);
    const pvpAway = still(pvp); pvpAway.B.target = -LIMIT; run(pvp, 3, pvpAway);
    expect('meter' in pvp.fighters.B).toBe(false);
  });
  it('the roller hits once for 26 however long the contact lasts, and catches a fighter who steps back in too early', () => {
    const s = cpuBattle('melonpan', 'croissant'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events); run(s, specialDuration('melonpan') + .1, still(s), events);
    expect(s.fighters.B.hp).toBe(100 - 26); expect(events.filter(e => e.kind === 'special-hit')).toHaveLength(1);
    const back = cpuBattle('melonpan', 'croissant'), backEvents: BattleEvent[] = [], spec = SPECIALS.melonpan;
    back.fighters.A.meter = 100; startSpecial(back, 'A', backEvents);
    const out = still(back); out.B.target = LIMIT; run(back, spec.windup + .1, out, backEvents);
    expect(back.fighters.B.hp).toBe(100); // outside when the roller arrived
    const home = still(back); home.B.target = 0; run(back, spec.active + .2, home, backEvents);
    expect(back.fighters.B.hp).toBe(100 - 26); expect(back.fighters.B.meter).toBe(0);
    expect(back.scores.B.dodge.success).toBe(0);
  });
});

describe('curry pan: a short strong poke and a two-beat bomber', () => {
  it('hits hardest but reaches the least', () => {
    const forward = (id: BreadId): number => BREADS[id].reach + Math.hypot(BREADS[id].height * Math.sin(BREADS[id].lean), BREADS[id].depth * Math.cos(BREADS[id].lean));
    for (const id of BREAD_IDS) expect(forward('currypan')).toBeLessThanOrEqual(forward(id) + 1e-9);
    const s = createBattle('currypan', 'shokupan', 'cpu'); startAttack(s, 'A', []); run(s, 2);
    expect(s.fighters.B.hp).toBe(100 - 26);
  });
  it('lands 10 then 24 on a fighter who stays, with no hit window between the beats', () => {
    const s = cpuBattle('currypan', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    const hp: number[] = [];
    for (let tick = 1; tick <= 160; tick++) { stepBattle(s, still(s), events); hp[tick] = s.fighters.B.hp; }
    expect(hp[71]).toBe(100); expect(hp[84]).toBe(90); expect(hp[131]).toBe(90); expect(hp[144]).toBe(66);
    const gap = SPECIALS.currypan.stages[1]!.from - SPECIALS.currypan.stages[0]!.to;
    expect(gap * STEP).toBeCloseTo(.4);
  });
  it('a fighter hit by the first beat can still step out of the second, but gets no dodge credit', () => {
    for (const bread of BREAD_IDS) {
      const s = cpuBattle('currypan', bread), events: BattleEvent[] = [];
      s.fighters.A.meter = 100; startSpecial(s, 'A', events);
      while (!events.some(e => e.kind === 'special-hit')) stepBattle(s, still(s), events);
      const escape = still(s); escape.B.target = LIMIT; run(s, 2, escape, events);
      expect(s.fighters.B.hp, bread).toBe(90); expect(s.fighters.B.meter).toBe(0);
      expect(s.scores.B.dodge).toEqual({ success: 0, opportunities: 1 });
    }
  });
});

describe('cream pan: slow out, quick back, and a sideways slap', () => {
  it('starts its swing last but is ready again first after a whiff', () => {
    for (const id of BREAD_IDS) {
      expect(BREADS.creampan.windup).toBeGreaterThanOrEqual(BREADS[id].windup);
      expect(BREADS.creampan.recovery).toBeLessThanOrEqual(BREADS[id].recovery);
    }
  });
  it('sweeps across the locked aim, mirrored between the two slots, and hits once for 28', () => {
    expect(specialSweep('creampan')).toBeCloseTo(.28);
    const spec = SPECIALS.creampan, xs: Record<'A' | 'B', number[]> = { A: [], B: [] };
    for (const slot of ['A', 'B'] as const) {
      const s = cpuBattle('creampan', 'creampan'), other = slot === 'A' ? 'B' : 'A', events: BattleEvent[] = [];
      s.fighters.A.x = .3; s.fighters.B.x = .3;
      s.fighters[slot].meter = 100; startSpecial(s, slot, events);
      const away = still(s); away[other].target = -LIMIT;
      for (let i = 0; i < Math.ceil((specialDuration('creampan') + .1) / STEP); i++) {
        stepBattle(s, away, events);
        const f = s.fighters[slot];
        if (f.attack?.special && phase(f) === 'active') { const x = pose(f, slot).x; xs[slot].push(x); expect(Math.abs(x - .3)).toBeLessThanOrEqual(.28 + 1e-9); }
      }
      expect(s.fighters[slot].attack).toBeNull(); expect(s.fighters[slot].x).toBeCloseTo(.3);
    }
    expect(Math.abs(xs.A.length - spec.active / STEP)).toBeLessThanOrEqual(1);
    // Slot A swipes toward +x, slot B toward -x: the same move seen from each player's own side.
    expect(xs.A[0]! - .3).toBeLessThan(-.2); expect(xs.A.at(-1)! - .3).toBeGreaterThan(.2);
    xs.A.forEach((x, i) => expect(x - .3).toBeCloseTo(-(xs.B[i]! - .3)));
    const s = cpuBattle('creampan', 'shokupan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events); run(s, 2, still(s), events);
    expect(s.fighters.B.hp).toBe(100 - 28); expect(events.filter(e => e.kind === 'special-hit')).toHaveLength(1);
  });
  it('reaches a small sidestep in the swipe direction that would escape without the sweep', () => {
    const s = cpuBattle('creampan', 'francepan'), events: BattleEvent[] = [];
    s.fighters.A.meter = 100; startSpecial(s, 'A', events);
    // Beyond what the slap would cover without moving sideways, on the side it travels to.
    const reach = dangerHalfWidth('creampan', 'francepan'), fixed = reach - specialSweep('creampan');
    s.fighters.B.x = fixed + .15; expect(s.fighters.B.x).toBeLessThan(reach); run(s, 2, still(s), events);
    expect(s.fighters.B.hp).toBe(100 - 28);
  });
});

describe('telegraphs', () => {
  it.each(BREAD_IDS.flatMap(a => BREAD_IDS.map(b => [a, b] as const)))('%s special never touches a still %s standing just outside the drawn lane', (a, b) => {
    const half = dangerHalfWidth(a, b);
    expect(half).toBeLessThan(LIMIT); // from the middle there is always room to get out
    for (const direction of [-1, 1]) {
      const s = cpuBattle(a, b), events: BattleEvent[] = [];
      s.fighters.A.meter = 100; startSpecial(s, 'A', events);
      s.fighters.B.x = direction * (half + .02);
      for (let i = 0; i < Math.ceil(specialDuration(a) / STEP); i++) {
        stepBattle(s, still(s), events);
        const f = s.fighters.A;
        if (f.attack?.special && phase(f) === 'active') expect(specialTouching(a, pose(f, 'A'), pose(s.fighters.B, 'B'))).toBe(false);
      }
      expect(s.fighters.B.hp).toBe(100);
    }
  });
});

describe('PvP stays untouched by the roster', () => {
  it.each(BREAD_IDS.flatMap(a => BREAD_IDS.map(b => [a, b] as const)))('%s vs %s: special requests change nothing, no meter or sweep state appears', (a, b) => {
    const plain = createBattle(a, b), requested = createBattle(a, b), eventsPlain: BattleEvent[] = [], eventsRequested: BattleEvent[] = [];
    for (let i = 0; i < 700; i++) {
      const target = Math.sin(i / 45) * LIMIT, attackA = i % 110 === 0, attackB = i % 170 === 40;
      stepBattle(plain, { A: { target, attack: attackA }, B: { target: -target, attack: attackB } }, eventsPlain);
      stepBattle(requested, { A: { target, attack: attackA, special: true }, B: { target: -target, attack: attackB, special: true } }, eventsRequested);
    }
    expect(requested).toEqual(plain); expect(eventsRequested).toEqual(eventsPlain);
    for (const f of Object.values(plain.fighters)) { expect('meter' in f).toBe(false); expect(f.attack?.special).toBeUndefined(); expect(f.attack?.near).toBeUndefined(); }
    expect(eventsPlain.some(e => e.kind === 'special' || e.kind === 'special-hit')).toBe(false);
  });
});

describe('CPU against the new specials', () => {
  it.each(NEW)('having sidestepped a %s special, the hard CPU stays out and does nothing until the last hit window closes', bread => {
    let sidesteps = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const b = new Battle(bread, 'shokupan', { seed, difficulty: 'hard' }), internals = b as unknown as { nextCpu: number; nextMove: number; sidestep: number; rageUsed: boolean };
      b.player.meter = 100; internals.rageUsed = true;
      // A swing is already scheduled 0.4 s ahead: it must wait for the special to end.
      internals.nextCpu = b.elapsed + .4; internals.nextMove = b.elapsed + .4;
      expect(b.special('player')).toBe(true);
      const id = b.player.attack!.id; let busy = false;
      for (let i = 0; i < 6 / STEP && b.player.attack?.id === id; i++) {
        b.advance(STEP, 0);
        const live = b.player.attack?.id === id && (phase(b.player) === 'windup' || phase(b.player) === 'active');
        if (internals.sidestep === id && live && b.cpu.attack) busy = true;
      }
      b.drainEvents();
      if (internals.sidestep !== id) continue;
      sidesteps++;
      expect(busy, `seed ${seed}`).toBe(false); expect(b.cpu.hp, `seed ${seed}`).toBe(100);
    }
    expect(sidesteps).toBeGreaterThan(5);
  });
  it.each(NEW)('a %s CPU fires its special from a naturally filled meter and from the rage charge', bread => {
    const fired = (setup: (b: Battle) => void): boolean => {
      const b = new Battle('shokupan', bread, { seed: 7, difficulty: 'normal' }); setup(b);
      for (let i = 0; i < 8 / STEP && !b.outcome; i++) { b.advance(STEP, 0); if (b.drainEvents().some(e => e.kind === 'special' && e.side === 'cpu')) return true; }
      return false;
    };
    expect(fired(b => { b.cpu.meter = 100; b.player.hp = 1000; })).toBe(true);
    expect(fired(b => { b.cpu.hp = 55; b.player.hp = 1000; })).toBe(true);
  });
});
