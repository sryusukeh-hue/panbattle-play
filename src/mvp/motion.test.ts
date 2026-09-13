import { describe, expect, it } from 'vitest';
import { MotionFilter, gravityRoll } from './motion';
import { LIMIT } from './config';
function sample(f: MotionFilter, time: number, x: number, enabled = true, angle = 0): boolean {
  f.orientation(angle, time); f.motion({ time, x, y: 0, z: 0 }, enabled); return f.poll(time, enabled);
}
function quiet(f: MotionFilter, start: number, duration = 650, angle = 0): void { for (let t = start; t <= start + duration; t += 10) sample(f, t, 0, true, angle); }
function confirm(f: MotionFilter, start: number, angle = 0): boolean {
  let fired = false;
  for (let t = start + 10; t <= start + 50; t += 10) fired = sample(f, t, 0, true, angle) || fired;
  return fired;
}
describe('3D motion discrimination', () => {
  it('upright and leaned-back portrait gravity gives the same left/right direction', () => {
    expect(gravityRoll(0, 9.8)).toBeCloseTo(0); expect(gravityRoll(-4.9, 8.487)).toBeCloseTo(30, 1);
    expect(gravityRoll(3, 5.196)).toBeCloseTo(-30, 1); expect(gravityRoll(0, 1)).toBeNull(); expect(gravityRoll(NaN, 5)).toBeNull();
  });
  it('accepts both gravity signs in portrait without rejecting iOS upright samples', () => {
    for (const angle of [-45, -25, 0, 25, 45]) for (const sign of [-1, 1]) {
      const radians = angle * Math.PI / 180;
      const roll = gravityRoll(-sign * 9.8 * Math.sin(radians), sign * 9.8 * Math.cos(radians));
      expect(roll).toBeCloseTo(angle);
      const f = new MotionFilter(); quiet(f, 0); f.orientation(roll, 650);
      expect(f.fresh(660)).toBe(true); expect(f.calibrate(660)).toBe(true);
    }
  });
  it('detects 20 small gestures exactly once each including return movement', () => {
    const f = new MotionFilter(); let count = 0;
    for (let i = 0; i < 20; i++) {
      const base = i * 1200; quiet(f, base); count += Number(sample(f, base + 660, 8));
      count += Number(confirm(f, base + 660));
      count += Number(sample(f, base + 740, -10)); count += Number(sample(f, base + 780, 8));
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
    f.motion({ time: 660, x: null, y: 0, z: 0 }, true); expect(f.poll(660, true)).toBe(false);
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
    quiet(f, 660, 640, -28);
    expect(sample(f, 1310, 8, true, -28)).toBe(false); expect(confirm(f, 1310, -28)).toBe(true);
    const held = f.tilt; f.orientation(0, 1400); expect(f.tilt).toBe(held);
    f.orientation(0, 1450); expect(f.tilt).toBeGreaterThan(held); // Tilt returns before the 450ms attack cooldown.
    expect(sample(f, 1460, 10)).toBe(false);
    f.reset(); expect(sample(f, 1470, 8)).toBe(false); expect(f.attacks).toBe(1);
  });
  it.each([.6, 1, 1.6])('fast dodges and their return never attack at sensitivity %s', sensitivity => {
    const f = new MotionFilter(); f.attackSensitivity = sensitivity;
    for (const direction of [-1, 1]) for (let i = 0; i < 20; i++) {
      const start = (direction === -1 ? i : 20 + i) * 2000;
      quiet(f, start);
      for (let t = 660; t <= 800; t += 10) expect(sample(f, start + t, t < 720 ? 14 : 0, true, direction * Math.min(24, (t - 650) * .4))).toBe(false);
      quiet(f, start + 810, 390, direction * 24);
      for (let t = 1210; t <= 1350; t += 10) expect(sample(f, start + t, t < 1270 ? -14 : 0, true, direction * Math.max(0, 24 - (t - 1200) * .4))).toBe(false);
    }
    expect(f.attacks).toBe(0);
  });
  it('allows a counter after a rejected dodge without imposing the attack cooldown', () => {
    const f = new MotionFilter(); quiet(f, 0);
    for (let t = 660; t <= 710; t += 10) expect(sample(f, t, 12, true, (t - 650) * .4)).toBe(false);
    quiet(f, 720, 190, 24);
    expect(sample(f, 920, 8, true, 24)).toBe(false);
    expect(confirm(f, 920, 24)).toBe(true);
  });
  it.each([10, 20, 50])('accepts stable-pose attacks with %sms samples and either event order', interval => {
    for (const orientationFirst of [true, false]) {
      const f = new MotionFilter(); let count = 0;
      for (let t = 0; t <= 900; t += interval) {
        if (orientationFirst) f.orientation(20, t);
        f.motion({ time: t, x: t === 700 ? 13 : 0, y: 0, z: 0 }, true);
        if (!orientationFirst) f.orientation(20, t);
        count += Number(f.poll(t, true));
      }
      expect(count).toBe(1);
    }
  });
  it('drops candidates with missing orientation, a gap, disabled input or reset', () => {
    for (const failure of ['orientation', 'motion', 'disabled', 'reset', 'invalid', 'out-of-order']) {
      const f = new MotionFilter(); quiet(f, 0); sample(f, 660, 8);
      if (failure === 'orientation') f.orientation(null, 670);
      if (failure === 'motion') f.motion({ time: 670, x: null, y: 0, z: 0 }, true);
      if (failure === 'disabled') f.poll(670, false);
      if (failure === 'reset') f.reset();
      if (failure === 'invalid') f.orientation(Infinity, 670);
      if (failure === 'out-of-order') f.orientation(0, 600);
      expect(confirm(f, 660)).toBe(false); expect(f.attacks).toBe(0);
    }
    const f = new MotionFilter(); quiet(f, 0); sample(f, 660, 8);
    expect(f.poll(900, true)).toBe(false);
    const missing = new MotionFilter();
    for (let t = 0; t <= 650; t += 10) missing.motion({ time: t, x: 0, y: 0, z: 0 }, true);
    missing.motion({ time: 660, x: 8, y: 0, z: 0 }, true); expect(confirm(missing, 660)).toBe(false);
  });
  it('adjusts attack and tilt independently and accepts all acceleration axes', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const f = new MotionFilter(); f.attackSensitivity = 1.6; f.tiltSensitivity = .6;
      quiet(f, 0); f.calibrate(650); quiet(f, 660, 650, 16);
      expect(f.tilt).toBeCloseTo(LIMIT * .3, 2);
      f.motion({ time: 1320, x: 0, y: 0, z: 0, [axis]: 5 }, true);
      expect(confirm(f, 1320, 16)).toBe(true);
      const low = new MotionFilter(); low.attackSensitivity = .6; low.tiltSensitivity = 1.6;
      quiet(low, 0); sample(low, 660, 8); expect(confirm(low, 660)).toBe(false);
    }
  });
  it('rejects a missing orientation interval even when it straddles the lookback boundary', () => {
    const f = new MotionFilter(); quiet(f, 0, 500);
    for (let t = 510; t <= 710; t += 10) {
      if (t >= 600) f.orientation(0, t);
      f.motion({ time: t, x: t === 660 ? 8 : 0, y: 0, z: 0 }, true);
    }
    expect(f.poll(710, true)).toBe(false); expect(f.attacks).toBe(0);
  });
});
