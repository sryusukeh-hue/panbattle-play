import { describe, expect, it } from 'vitest';
import { MotionFilter, gravityRoll } from './motion';
import { LIMIT } from './config';
function sample(f: MotionFilter, time: number, x: number, enabled = true): boolean { return f.motion({ time, x, y: 0, z: 0 }, enabled); }
function quiet(f: MotionFilter, start: number, duration = 650): void { for (let t = start; t <= start + duration; t += 10) sample(f, t, 0); }
describe('3D motion discrimination', () => {
  it('upright and leaned-back portrait gravity gives the same left/right direction', () => {
    expect(gravityRoll(0, 9.8)).toBeCloseTo(0); expect(gravityRoll(-4.9, 8.487)).toBeCloseTo(30, 1);
    expect(gravityRoll(3, 5.196)).toBeCloseTo(-30, 1); expect(gravityRoll(0, 1)).toBeNull(); expect(gravityRoll(NaN, 5)).toBeNull();
  });
  it('detects 20 small gestures exactly once each including return movement', () => {
    const f = new MotionFilter(); let count = 0;
    for (let i = 0; i < 20; i++) {
      const base = i * 1200; quiet(f, base); count += Number(sample(f, base + 660, 8));
      count += Number(sample(f, base + 700, -10)); count += Number(sample(f, base + 740, 8));
    }
    expect(count).toBe(20); expect(f.attacks).toBe(20);
  });
  it('does not fire during 30 seconds of small noise or 20 slow tilts', () => {
    const f = new MotionFilter();
    for (let t = 0; t < 30000; t += 10) expect(sample(f, t, Math.sin(t) * .3)).toBe(false);
    for (let i = 0; i < 20; i++) for (let t = 0; t < 1000; t += 10) { expect(sample(f, 30000 + i * 1000 + t, .7)).toBe(false); f.orientation(Math.sin(t / 300) * 24, 30000 + i * 1000 + t); }
  });
  it('rejects null/NaN/infinite, discontinuous and disabled samples without queuing', () => {
    const f = new MotionFilter(); quiet(f, 0);
    expect(f.motion({ time: 660, x: null, y: 0, z: 0 }, true)).toBe(false);
    expect(sample(f, 670, NaN)).toBe(false); expect(sample(f, 700, Infinity)).toBe(false); expect(sample(f, 2000, 99)).toBe(false);
    quiet(f, 2100); expect(sample(f, 2760, 9, false)).toBe(false); expect(sample(f, 2770, 9)).toBe(false);
  });
  it('requires fresh motion and orientation before calibrating; centers around current pose', () => {
    const f = new MotionFilter(); expect(f.calibrate(1000)).toBe(false); quiet(f, 0); f.orientation(12, 650); expect(f.calibrate(660)).toBe(true);
    for (let t = 700; t < 1400; t += 10) f.orientation(40, t);
    expect(f.tilt).toBeCloseTo(LIMIT, 2);
    for (let t = 1400; t < 2100; t += 10) f.orientation(12, t);
    expect(f.tilt).toBeCloseTo(0, 2); expect(f.calibrate(2100)).toBe(false);
  });
  it('can attack from a tilted pose without sudden movement and resets after pause', () => {
    const f = new MotionFilter(); quiet(f, 0); f.orientation(0, 650); f.calibrate(650);
    for (let t = 660; t <= 1300; t += 10) { sample(f, t, 0); f.orientation(-28, t); }
    expect(sample(f, 1310, 8)).toBe(true); const held = f.tilt; f.orientation(50, 1330); expect(f.tilt).toBe(held);
    f.reset(); expect(sample(f, 1400, 8)).toBe(false); expect(f.attacks).toBe(1);
  });
});
