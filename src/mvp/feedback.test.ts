import { describe, expect, it } from 'vitest';
import { Battle, pose, type BattleEvent } from './battle';
import { BattleFeedback, ReplayBuffer, damageStage, deformVertex, VISUAL_LIMITS } from './feedback';

const event = (kind: BattleEvent['kind'], id: number): BattleEvent => ({ id, kind, side: 'player', x: 0, z: 0 });
describe('shared combat feedback', () => {
  it('emits a low-priority heartbeat once per final second only when local time is supplied', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan');
    expect(f.update(battle, true).sound).toBeNull(); expect(f.update(battle, true, 11).sound).toBeNull();
    expect(f.update(battle, true, 10).sound).toBe('heartbeat'); expect(f.update(battle, true, 9.8).sound).toBeNull();
    f.enqueue(event('hit', 1)); expect(f.update(battle, true, 9).sound).toBe('hit'); expect(f.update(battle, true, 9).sound).toBeNull();
    f.reset(); expect(f.update(battle, true, 9).sound).toBeNull(); expect(f.update(battle, false, 8).sound).toBeNull();
    expect(f.update(battle, true, 8).sound).toBe('heartbeat'); expect(f.update(battle, true, 0).sound).toBeNull();
    f.reset(true); expect(f.update(battle, true, 10).sound).toBe('heartbeat');
  });
  it.each([[100, 0], [75.01, 0], [75, 1], [50.01, 1], [50, 2], [25.01, 2], [25, 3], [0, 3], [-1, 3], [NaN, 0]])('HP %s has damage stage %s', (hp, stage) => {
    expect(damageStage(hp)).toBe(stage); expect(damageStage(hp * 2, 200)).toBe(stage);
  });
  it('ignores invalid maximum HP for visual damage', () => { expect(damageStage(20, 0)).toBe(0); expect(damageStage(20, Infinity)).toBe(0); });
  it('bounds visual squash and bend without changing the collision pose or combat state', () => {
    const battle = new Battle('francepan', 'croissant'); battle.attack('cpu');
    const before = structuredClone(battle.state), collision = pose(battle.cpu, 'cpu');
    for (const x of [-.7, 0, .7]) for (const y of [-1, 0, 1]) for (const z of [-.3, .3]) {
      const next = deformVertex(x, y, z, .04, [0, 0, 1], 1);
      expect(Math.hypot(next[0] - x, next[1] - y, next[2] - z)).toBeLessThanOrEqual(VISUAL_LIMITS.deformation + 1e-9);
    }
    const f = new BattleFeedback(); f.enqueue(event('hit', 1)); f.update(battle, true);
    expect(pose(battle.cpu, 'cpu')).toEqual(collision); expect(battle.state).toEqual(before);
  });
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
    battle.player.hp = 25; const before = structuredClone(battle.state);
    expect(f.update(battle, true).sound).toBe('danger'); expect(f.update(battle, true).sound).toBeNull();
    expect(battle.state).toEqual(before); battle.player.hp = 0;
    expect(f.update(battle, true).sound).toBeNull();
  });
  it('retains the danger warning after a simultaneous hit, rather than permanently masking it', () => {
    const f = new BattleFeedback(), battle = new Battle('shokupan', 'shokupan'); battle.player.hp = 20;
    f.enqueue(event('hit', 1)); const result = f.update(battle, true);
    expect(result.sound).toBe('hit'); expect(result.alert).toBe(true);
    expect(f.update(battle, true).alert).toBe(false);
  });
});

describe('presentation replay buffer', () => {
  it('limits playback to the decisive window', () => {
    const replay = new ReplayBuffer<number>(); for (let i = 0; i <= 200; i++) replay.record(.01, i);
    expect(replay.start(false, .5)).toBe(true); expect(replay.next(0)!.value).toBeGreaterThanOrEqual(150);
    expect(replay.next(1.19)!.done).toBe(false); expect(replay.next(.02)).toEqual({ value: 200, done: true });
  });
  it('retains about two seconds, plays them at half speed and clears between matches', () => {
    const replay = new ReplayBuffer<number>(); expect(replay.start()).toBe(false); expect(replay.next(1)).toBeNull();
    for (let i = 0; i <= 300; i++) replay.record(.01, i);
    expect(replay.start()).toBe(true); const first = replay.next(0)!; expect(first.value).toBeGreaterThanOrEqual(100);
    expect(first.value).toBeLessThanOrEqual(101); expect(replay.next(1)!.value).toBeCloseTo(first.value + 50, -1);
    expect(replay.next(2)!.done).toBe(false); expect(replay.next(1)).toEqual({ value: 300, done: false });
    const end = replay.next(.2)!; expect(end).toEqual({ value: 300, done: true });
    replay.reset(); expect(replay.start()).toBe(false);
  });
  it('reduced motion shows the final pose briefly, including a preference change during playback', () => {
    const replay = new ReplayBuffer<number>(); for (let i = 0; i < 120; i++) replay.record(1 / 60, i);
    replay.start(true); expect(replay.next(.1)).toEqual({ value: 119, done: false }); expect(replay.next(.25)!.done).toBe(true);
    replay.start(); expect(replay.next(.1)!.value).toBeLessThan(119); expect(replay.next(.25, true)).toEqual({ value: 119, done: true });
  });
});
