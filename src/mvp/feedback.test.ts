import { describe, expect, it } from 'vitest';
import { Battle, type BattleEvent } from './battle';
import { BattleFeedback } from './feedback';

const event = (kind: BattleEvent['kind'], id: number): BattleEvent => ({ id, kind, side: 'player', x: 0, z: 0 });
describe('shared combat feedback', () => {
  it('plays counter instead of the simultaneous ordinary hit, and ignores duplicate snapshots', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan');
    f.enqueue(event('counter', 1)); f.enqueue(event('hit', 2)); f.enqueue(event('hit', 2));
    const result = f.update(battle, true);
    expect(result.sound).toBe('counter'); expect(result.events.map(e => e.kind)).toEqual(['counter', 'hit']);
    f.enqueue(event('counter', 1)); f.enqueue(event('hit', 2)); expect(f.update(battle, true)).toEqual({ events: [], sound: null, alert: false });
  });
  it('emits opponent telegraph and each swing once even if a snapshot goes back across the phase boundary', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan'); battle.attack('cpu');
    expect(f.update(battle, true).sound).toBe('telegraph'); expect(f.update(battle, true).sound).toBeNull();
    battle.cpu.attack!.age = battle.cpu.attack!.windup;
    expect(f.update(battle, true).sound).toBe('swing');
    battle.cpu.attack!.age = 0; expect(f.update(battle, true).sound).toBeNull();
    battle.cpu.attack!.age = battle.cpu.attack!.windup; expect(f.update(battle, true).sound).toBeNull();
  });
  it('drops queued effects on pause, retains deduplication on resume and resets serials for rematch', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan'); battle.attack('cpu');
    expect(f.update(battle, true).sound).toBe('telegraph');
    f.enqueue(event('dodge', 1)); f.reset();
    f.enqueue(event('dodge', 1)); expect(f.update(battle, true).events).toEqual([]);
    f.enqueue(event('hit', 2)); expect(f.update(battle, false)).toEqual({ events: [], sound: null, alert: false });
    expect(f.update(battle, true).sound).toBeNull();
    f.reset(true); expect(f.update(battle, true).sound).toBe('telegraph');
    f.enqueue(event('dodge', 1)); expect(f.update(battle, true).sound).toBe('dodge');
  });
  it('warns once at low health, never at KO, and does not modify battle state', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan');
    battle.player.hp = 25; const before = structuredClone({ player: battle.player, cpu: battle.cpu, elapsed: battle.elapsed, scores: battle.scores });
    expect(f.update(battle, true).sound).toBe('danger'); expect(f.update(battle, true).sound).toBeNull();
    expect({ player: battle.player, cpu: battle.cpu, elapsed: battle.elapsed, scores: battle.scores }).toEqual(before); battle.player.hp = 0;
    expect(f.update(battle, true).sound).toBeNull();
  });
  it('retains the danger warning after a simultaneous hit, rather than permanently masking it', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan'); battle.player.hp = 20;
    f.enqueue(event('hit', 1)); const result = f.update(battle, true);
    expect(result.sound).toBe('hit'); expect(result.alert).toBe(true);
    expect(f.update(battle, true).alert).toBe(false);
  });
});
