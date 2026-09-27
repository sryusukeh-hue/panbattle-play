import { describe, expect, it } from 'vitest';
import { FaceState, BLINK, REACTION_TIME, blinkCurve, copyFace, decalKey, type FaceInput } from './face-state';
import { FACES } from './face-config';

const base: FaceInput = { phase: 'ready', special: false, charging: false, stage: 0, ending: null, look: [0, 0] };
const run = (face: FaceState, seconds: number, input: FaceInput = base, fps = 60, calm = false) => {
  let frame = face.update(0, input, calm);
  for (let i = 0; i < Math.round(seconds * fps); i++) frame = face.update(1 / fps, input, calm);
  return frame;
};

describe('face expression layers', () => {
  it('shows each bread its resting face and a determined face from the first wind-up frame', () => {
    const face = new FaceState('francepan');
    const rest = face.update(0, base);
    expect(rest.mouth).toBe('calm'); expect(rest.open).toEqual([...FACES.francepan.open]);
    const windup = face.update(1 / 60, { ...base, phase: 'windup' });
    expect(windup.mouth).toBe('tight'); expect(windup.brow).toBe('angry');
    expect(face.update(1 / 60, { ...base, phase: 'active' }).mouth).toBe('attack');
    expect(face.update(1 / 60, { ...base, phase: 'recovery' }).mouth).toBe('slack');
    // The toast looks sorry right up to the swing.
    expect(new FaceState('shokupan').update(0, { ...base, phase: 'windup' }).brow).toBe('worry');
  });
  it('winces for a moment when hit, then only the mouth lingers and a swing takes the face back', () => {
    const face = new FaceState('shokupan'); face.update(0, base); face.react('ouch');
    const shock = face.update(.01, base);
    expect(shock.mouth).toBe('ouch'); expect(shock.pop).toBeGreaterThan(1); expect(shock.pupil).toBeLessThan(1); expect(shock.open).toEqual([1, 1]);
    const tail = face.update(REACTION_TIME.ouch[0], base);
    expect(tail.mouth).toBe('ouch'); expect(tail.pop).toBe(1);
    face.react('ouch'); face.update(REACTION_TIME.ouch[0] + .01, base);
    expect(face.update(.01, { ...base, phase: 'windup' }).mouth).toBe('tight');
    expect(run(face, .5).mouth).toBe('calm');
  });
  it('lets a dodge grin show without stealing the wind-up face, and clears it when a new swing starts', () => {
    const face = new FaceState('croissant'); face.update(0, base); face.react('dodge');
    expect(face.update(.05, base).mouth).toBe('smug');
    expect(face.update(.01, { ...base, phase: 'windup' }).mouth).toBe('tight');
    expect(face.update(.01, base).mouth).toBe('calm');
  });
  it('keeps the wince wide open even when a blink falls due', () => {
    const face = new FaceState('shokupan', 7); face.update(0, base);
    let t = 0;
    for (; t < 20; t += 1 / 120) if (face.update(1 / 120, base).open[0] < .05) break;
    const fresh = new FaceState('shokupan', 7); fresh.update(0, base);
    run(fresh, t - .02, base, 120); fresh.react('ouch');
    for (let i = 0; i < 9; i++) expect(fresh.update(1 / 120, base).open).toEqual([1, 1]);
  });
  it('never lets a dodge grin replace a fresh wince', () => {
    const face = new FaceState('croissant'); face.update(0, base); face.react('ouch'); face.react('dodge');
    expect(face.update(.01, base).mouth).toBe('ouch');
  });
  it('grits both teeth on a clash and grins on a counter', () => {
    const face = new FaceState('shokupan'); face.update(0, base); face.react('grit');
    expect(face.update(.01, base).mouth).toBe('grit');
    face.react('counter'); const grin = face.update(.05, { ...base, look: [1, 1] });
    expect(grin.mouth).toBe('smug'); expect(grin.gaze).toEqual([0, 0]);
  });
  it('tires at the same HP stages as the bread damage', () => {
    const open = (stage: number) => new FaceState('shokupan').update(0, { ...base, stage });
    expect(open(0).sweat).toBe(false); expect(open(0).droop).toBe(0);
    expect(open(1).droop).toBe(1); expect(open(1).sweat).toBe(false);
    const [l, r] = FACES.shokupan.tired;
    expect(open(2).sweat).toBe(true); expect(open(2).open[0]).toBeCloseTo(FACES.shokupan.open[0] * (1 + l) / 2);
    // Exhausted eyes droop unevenly and the blush fades, so it never reads as the wide-eyed shock.
    expect(open(3).open).toEqual([FACES.shokupan.open[0] * l, FACES.shokupan.open[1] * r]);
    expect(open(3).cheek).toBeCloseTo(open(0).cheek / 2);
    // A swing still gets the attack eyes when exhausted.
    expect(new FaceState('shokupan').update(0, { ...base, stage: 3, phase: 'active' }).open).toEqual([1, 1]);
  });
  it('puts the result above every other layer', () => {
    const face = new FaceState('croissant'); face.update(0, base); face.react('ouch');
    const lose = face.update(.01, { ...base, phase: 'windup', ending: 'lose' });
    expect(lose.eyes).toBe('shut'); expect(lose.mouth).toBe('lose'); expect(lose.pop).toBe(1);
    expect(new FaceState('shokupan').update(0, { ...base, ending: 'win' }).eyes).toBe('happy');
    expect(new FaceState('francepan').update(0, { ...base, ending: 'draw' }).mouth).toBe('huh');
  });
  it('gives each special its own face and a serious charge', () => {
    const special = { ...base, phase: 'active' as const, special: true };
    expect(new FaceState('shokupan').update(0, special).mouth).toBe('serious');
    expect(new FaceState('francepan').update(0, special).pop).toBeGreaterThan(1);
    expect(new FaceState('croissant').update(0, special).mouth).toBe('wild');
    expect(new FaceState('croissant').update(0, { ...base, charging: true }).mouth).toBe('tight');
  });
});

describe('face timing', () => {
  const closedTimes = (fps: number, calm = false, seed = 7) => {
    const face = new FaceState('shokupan', seed), times: number[] = [];
    face.update(0, base, calm);
    for (let i = 1; i <= 20 * fps; i++) { const f = face.update(1 / fps, base, calm); if (f.open[0] < .05) times.push(i / fps); }
    return times;
  };
  const onsets = (times: number[]) => times.filter((t, i) => i === 0 || t - times[i - 1]! > .2);
  it('blinks every 3-6 s with a reproducible seed, at any frame rate', () => {
    const at60 = onsets(closedTimes(60)), at120 = onsets(closedTimes(120)), at30 = onsets(closedTimes(30));
    expect(at60.length).toBeGreaterThanOrEqual(3); expect(at60.length).toBeLessThanOrEqual(7);
    at60.forEach((t, i) => { expect(Math.abs(t - at120[i]!)).toBeLessThan(.05); expect(Math.abs(t - at30[i]!)).toBeLessThan(.07); });
    for (let i = 1; i < at60.length; i++) { expect(at60[i]! - at60[i - 1]!).toBeGreaterThanOrEqual(BLINK.min - .05); expect(at60[i]! - at60[i - 1]!).toBeLessThanOrEqual(BLINK.max + .05); }
    expect(onsets(closedTimes(60))).toEqual(at60);
    expect(onsets(closedTimes(60, false, 8))).not.toEqual(at60);
  });
  it('never blinks or glances in reduced motion and never blinks mid-swing', () => {
    expect(closedTimes(60, true)).toEqual([]);
    const face = new FaceState('shokupan', 7);
    for (let i = 0; i < 20 * 60; i++) expect(face.update(1 / 60, { ...base, phase: 'active' }).open[0]).toBe(1);
    const calm = new FaceState('shokupan', 7);
    for (let i = 0; i < 20 * 60; i++) expect(Math.abs(calm.update(1 / 60, base, true).gaze[0])).toBeLessThan(1e-9);
  });
  it('ends a glance at once when reduced motion is switched on', () => {
    const face = new FaceState('croissant', 5); face.update(0, base);
    let glancing = false;
    for (let i = 0; i < 10 * 120 && !glancing; i++) glancing = Math.abs(face.update(1 / 120, base).gaze[0]) > .3;
    expect(glancing).toBe(true);
    // The very same frame the setting flips, even with the clock stopped.
    expect(face.update(0, base, true).gaze).toEqual([0, 0]);
  });
  it('looks straight at the camera on the result screen although its clock is stopped', () => {
    const face = new FaceState('francepan'); face.update(0, base);
    expect(face.update(0, { ...base, ending: 'win', look: [.4, .6] }).gaze).toEqual([.4, .6]);
    // Even when the match ended on a counter, whose stare otherwise centres the pupils.
    const counter = new FaceState('francepan'); counter.update(0, base); counter.react('counter');
    expect(counter.update(0, { ...base, ending: 'win', look: [.4, .6] }).gaze).toEqual([.4, .6]);
  });
  it('shapes a blink as close, hold and reopen', () => {
    expect(blinkCurve(0)).toBe(1); expect(blinkCurve(BLINK.close)).toBe(0); expect(blinkCurve(BLINK.close + BLINK.hold / 2)).toBe(0);
    expect(blinkCurve(BLINK.close + BLINK.hold + BLINK.open / 2)).toBeCloseTo(.5); expect(blinkCurve(1)).toBe(1);
  });
  it('follows the opponent in about 100 ms, clamped to the pupil travel', () => {
    const face = new FaceState('croissant', 3); face.update(0, base);
    const look = { ...base, look: [3, -.5] as [number, number] };
    expect(face.update(1 / 60, look).gaze[0]).toBeLessThan(.5);
    const settled = run(face, .1, look);
    expect(settled.gaze[0]).toBeGreaterThan(.9); expect(settled.gaze[0]).toBeLessThanOrEqual(1); expect(settled.gaze[1]).toBeCloseTo(-.5, 1);
  });
  it('holds still while paused (dt 0) and starts over on reset', () => {
    const face = new FaceState('shokupan'); face.update(0, base); face.react('ouch');
    for (let i = 0; i < 100; i++) expect(face.update(0, base).mouth).toBe('ouch');
    face.reset(); expect(face.update(0, base).mouth).toBe('calm');
  });
  it('copies frames so a stored replay face never changes afterwards', () => {
    const face = new FaceState('shokupan'), frame = face.update(0, base), copy = copyFace(frame);
    frame.open[0] = 0; frame.gaze[0] = 1;
    expect(copy.open[0]).toBe(FACES.shokupan.open[0]); expect(copy.gaze[0]).toBe(0);
    expect(decalKey(copy)).toBe(decalKey({ ...copy }));
  });
});
