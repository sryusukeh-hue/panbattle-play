import { describe, expect, it } from 'vitest';
import { BREAD_IDS, BREADS, LIMIT, STEP, type BreadId } from './rules';
import { createBattle, stepBattle, startAttack, phase, otherSlot, SLOTS, type Slot, type BattleState, type BattleEvent, type Commands } from './battle';

const still = (s: BattleState): Commands => ({ A: { target: s.fighters.A.x, attack: false }, B: { target: s.fighters.B.x, attack: false } });
function run(s: BattleState, seconds: number, commands = still(s), events: BattleEvent[] = []): void {
  for (let i = 0; i < Math.ceil(seconds / STEP); i++) stepBattle(s, commands, events);
}
const combinations = BREAD_IDS.flatMap(a => BREAD_IDS.map(b => [a, b] as const));

describe('shared PvP rules', () => {
  it.each(combinations)('%s against %s: each side can hit once and has the same rules', (a, b) => {
    for (const slot of SLOTS) {
      const s = createBattle(a, b), other = otherSlot(slot), events: BattleEvent[] = [];
      startAttack(s, slot, events); run(s, 2, still(s), events);
      expect(s.fighters[other].hp).toBe(100 - BREADS[s.fighters[slot].bread].damage);
      expect(s.fighters[slot].hp).toBe(100);
      expect(events.filter(e => e.kind === 'hit')).toHaveLength(1);
      expect(s.scores[other].dodge).toEqual({ success: 0, opportunities: 1 });
      expect(new Set(events.map(e => e.id)).size).toBe(events.length);
    }
  });

  it.each(combinations)('%s against %s: both sides can dodge and counter', (a, b) => {
    for (const defender of SLOTS) {
      const s = createBattle(a, b), attacker = otherSlot(defender), events: BattleEvent[] = [];
      startAttack(s, attacker, events);
      const dodge = still(s); dodge[defender].target = defender === 'A' ? LIMIT : -LIMIT;
      while (!s.counters[defender].available && s.elapsed < 2) stepBattle(s, dodge, events);
      expect(s.fighters[defender].hp).toBe(100);
      expect(s.scores[defender].dodge).toEqual({ success: 1, opportunities: 1 });
      expect(startAttack(s, defender, events)).toBe(true);
      const returnToCenter = still(s); returnToCenter[defender].target = 0;
      run(s, 2, returnToCenter, events);
      expect(s.scores[defender].counter).toEqual({ success: 1, opportunities: 1 });
      expect(s.fighters[attacker].hp).toBe(100 - BREADS[s.fighters[defender].bread].damage * 1.25);
    }
  });

  it.each(BREAD_IDS)('%s simultaneous commands clash and simultaneous KO cannot be overwritten', bread => {
    const s = createBattle(bread, bread), events: BattleEvent[] = [];
    s.fighters.A.hp = s.fighters.B.hp = BREADS[bread].damage;
    stepBattle(s, { A: { target: LIMIT, attack: true }, B: { target: -LIMIT, attack: true } }, events);
    expect(s.fighters.A.x).toBe(0); expect(s.fighters.B.x).toBe(0);
    run(s, 2, still(s), events);
    expect(s.winner).toBe('draw'); expect(s.fighters.A.hp).toBe(0); expect(s.fighters.B.hp).toBe(0);
    expect(events.filter(e => e.kind === 'clash')).toHaveLength(1);
    const result = structuredClone(s);
    run(s, 65, { A: { target: 1, attack: true }, B: { target: -1, attack: true } }, events);
    expect(s).toEqual(result); expect(startAttack(s, 'B', events)).toBe(false);
    expect(s.scores.A.dodge.opportunities).toBe(1); expect(s.scores.B.dodge.opportunities).toBe(1);
  });

  it('rejects attack reservation, locks the latest position and resumes towards current input', () => {
    for (const slot of SLOTS) {
      const s = createBattle('francepan', 'francepan'), events: BattleEvent[] = [];
      s.fighters[slot].x = -.6;
      startAttack(s, slot, events);
      const commands = still(s); commands[slot] = { target: LIMIT, attack: true };
      run(s, .1, commands, events);
      expect(s.fighters[slot].x).toBe(-.6); expect(s.attackSerial).toBe(1);
      commands[slot] = { target: -LIMIT, attack: false };
      run(s, 3, commands, events);
      expect(s.fighters[slot].x).toBe(-LIMIT); expect(s.fighters[slot].attack).toBeNull();
      expect(s.attackSerial).toBe(1);
    }
  });

  it('does not count standing outside an attack as a dodge, and closes missed counter windows', () => {
    const s = createBattle('francepan', 'francepan'), events: BattleEvent[] = [];
    s.fighters.A.x = LIMIT; s.fighters.B.x = -LIMIT;
    startAttack(s, 'A', events); run(s, 3, still(s), events);
    expect(s.scores.B.dodge).toEqual({ success: 0, opportunities: 0 });
    s.fighters.A.x = s.fighters.B.x = 0;
    startAttack(s, 'A', events);
    const dodge = still(s); dodge.B.target = LIMIT;
    run(s, 3, dodge, events);
    expect(s.scores.B.dodge.success).toBe(1);
    startAttack(s, 'B', events); run(s, 2, still(s), events);
    expect(s.scores.B.counter.success).toBe(0);
  });

  it.each([['A', 80, 20], ['B', 10, 90], ['draw', 70, 70]] as const)('timeout produces %s once', (winner, a, b) => {
    const s = createBattle('shokupan', 'croissant'); s.fighters.A.hp = a; s.fighters.B.hp = b;
    run(s, 61); expect(s.winner).toBe(winner); expect(s.elapsed).toBeCloseTo(60);
  });

  it('sanitizes invalid targets and limits speed without depending on browser frame time', () => {
    const s = createBattle('shokupan', 'shokupan');
    stepBattle(s, { A: { target: NaN, attack: false }, B: { target: Infinity, attack: false } }, []);
    expect(s.fighters.A.x).toBe(0); expect(s.fighters.B.x).toBe(0);
    stepBattle(s, { A: { target: 9999, attack: false }, B: { target: -9999, attack: false } }, []);
    expect(s.fighters.A.x).toBeCloseTo(STEP * 4.8); expect(s.fighters.B.x).toBeCloseTo(-STEP * 4.8);
  });

  it.each(combinations)('%s/%s is invariant under swapping sides and reflecting world coordinates', (a, b) => {
    const s = createBattle(a, b), reflected = createBattle(b, a);
    const command = (time: number, slot: Slot, bread: BreadId) => ({ target: Math.sin(time * (slot === 'A' ? 2.3 : 1.7)) * LIMIT,
      attack: Math.floor(time * 120) % (bread === 'francepan' ? 141 : 107) === 0 });
    for (let i = 0; i < 7201; i++) {
      const inputs = { A: command(i * STEP, 'A', a), B: command(i * STEP, 'B', b) };
      stepBattle(s, inputs, []);
      stepBattle(reflected, { A: { ...inputs.B, target: -inputs.B.target }, B: { ...inputs.A, target: -inputs.A.target } }, []);
      for (const slot of SLOTS) {
        const f = s.fighters[slot], r = reflected.fighters[otherSlot(slot)];
        expect(f.hp).toBe(r.hp); expect(f.x).toBeCloseTo(-r.x, 10);
        expect(phase(f)).toBe(phase(r)); expect(s.scores[slot]).toEqual(reflected.scores[otherSlot(slot)]);
      }
    }
    expect(reflected.winner).toBe(s.winner === 'A' ? 'B' : s.winner === 'B' ? 'A' : s.winner);
  });
});
