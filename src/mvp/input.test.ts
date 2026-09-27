import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameInput } from './input';

let input: GameInput;
let events: EventTarget;
let permission: ReturnType<typeof vi.fn>;
function motion(sign = -1, roll = 0, acceleration = 0): void {
  const event = new Event('devicemotion');
  const angle = roll * Math.PI / 180;
  Object.defineProperties(event, {
    acceleration: { value: { x: acceleration, y: 0, z: 0 } },
    accelerationIncludingGravity: { value: { x: acceleration - sign * 9.8 * Math.sin(angle), y: sign * 9.8 * Math.cos(angle), z: 0 } },
  });
  events.dispatchEvent(event);
}
function orientation(gamma: number | null): void {
  const event = new Event('deviceorientation');
  Object.defineProperty(event, 'gamma', { value: gamma }); events.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  events = new EventTarget(); permission = vi.fn().mockResolvedValue('granted');
  const constructor = { requestPermission: permission };
  vi.stubGlobal('window', Object.assign(events, { isSecureContext: true, DeviceMotionEvent: constructor, DeviceOrientationEvent: constructor }));
  vi.stubGlobal('DeviceMotionEvent', constructor); vi.stubGlobal('DeviceOrientationEvent', constructor);
  input = new GameInput(new EventTarget() as HTMLElement, () => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sensor permission and actual input reception', () => {
  it('measures only active sensor play, retaining peaks through pause and sensitivity changes', async () => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0); motion(-1, 10, 50); await vi.advanceTimersByTimeAsync(80); await request;
    expect(input.metrics().maxSwing).toBeNull(); input.sensor.calibrate(performance.now()); input.mode = 'sensor'; input.setEnabled(true);
    vi.advanceTimersByTime(10); motion(-1, 20, 12);
    input.sensor.attackSensitivity = 1.4; vi.advanceTimersByTime(10); motion(-1, -5, 8);
    expect(input.metrics()).toMatchObject({ maxSwing: 12, threshold: 5, minThreshold: 5, maxThreshold: 7 });
    expect(input.metrics().minTilt).toBeCloseTo(-15); expect(input.metrics().maxTilt).toBeCloseTo(10);
    const measured = input.metrics(); input.setEnabled(false); vi.advanceTimersByTime(10); motion(-1, 80, 100); expect(input.metrics()).toEqual(measured);
    input.setEnabled(true); motion(-1, 0, NaN); orientation(null); expect(input.metrics()).toEqual(measured);
    input.clear(); expect(input.metrics()).toEqual(measured); input.resetMetrics(); expect(input.metrics().maxSwing).toBeNull(); expect(input.metrics().minTilt).toBeNull();
  });
  it('measures the actual orientation fallback relative to calibration, ignoring invalid angles', async () => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0); motion(); await vi.advanceTimersByTimeAsync(80); await request;
    input.sensor.calibrate(performance.now()); input.mode = 'sensor'; input.setEnabled(true);
    await vi.advanceTimersByTimeAsync(260); orientation(-16); orientation(24); orientation(91); orientation(null);
    expect(input.metrics()).toMatchObject({ minTilt: -16, maxTilt: 24, maxSwing: null });
  });
  it('distinguishes a measured zero from no sample and exposes a detached summary', async () => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0); motion(); await vi.advanceTimersByTimeAsync(80); await request;
    input.sensor.calibrate(performance.now()); input.mode = 'sensor'; input.setEnabled(true); motion();
    expect(input.metrics().maxSwing).toBe(0); const summary = input.metrics(); summary.maxSwing = 999;
    expect(input.metrics().maxSwing).toBe(0); input.mode = 'touch'; motion(-1, 45, 99); expect(input.metrics().maxSwing).toBe(0);
  });
  it('uses same-event gravity to reject a quick dodge and accepts the following counter once', async () => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0);
    motion(); await vi.advanceTimersByTimeAsync(80); await request;
    input.mode = 'sensor'; input.sensor.calibrate(performance.now()); input.setEnabled(true);
    for (let t = 0; t < 650; t += 10) { vi.advanceTimersByTime(10); motion(); expect(input.consume()).toBe(false); }
    for (let t = 10; t <= 100; t += 10) {
      vi.advanceTimersByTime(10); motion(-1, Math.min(24, t * .4), t < 60 ? 12 : 0);
      expect(input.consume()).toBe(false);
    }
    expect(input.target()).toBeGreaterThan(0);
    for (let t = 0; t < 300; t += 10) { vi.advanceTimersByTime(10); motion(-1, 24); expect(input.consume()).toBe(false); }
    vi.advanceTimersByTime(10); motion(-1, 24, 8); expect(input.consume()).toBe(false);
    let count = 0;
    for (let t = 10; t <= 100; t += 10) { vi.advanceTimersByTime(10); motion(-1, 24, t === 60 ? -10 : 0); count += Number(input.consume()); }
    expect(count).toBe(1); expect(input.consume()).toBe(false);
    expect(input.sensor.attacks).toBe(1);
  });
  it.each([-1, 1])('accepts upright gravity sign %s without separate orientation events', async sign => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0);
    motion(sign); await vi.advanceTimersByTimeAsync(80); await request;
    expect(input.sensor.calibrate(performance.now())).toBe(true);
    expect(input.sensor.baseline).toBeCloseTo(0);
  });
  it('keeps valid events delivered while permission is being granted', async () => {
    permission.mockImplementation(() => { motion(); return Promise.resolve('granted'); });
    const request = input.request(); await vi.advanceTimersByTimeAsync(80);
    expect(input.sensor.fresh(performance.now())).toBe(true);
    await request;
  });
  it('returns to orientation events when gravity stops arriving', async () => {
    const request = input.request(); await vi.advanceTimersByTimeAsync(0);
    motion(); await vi.advanceTimersByTimeAsync(80); await request;
    orientation(35); expect(input.sensor.rawTilt).toBeCloseTo(0);
    await vi.advanceTimersByTimeAsync(260); orientation(20);
    expect(input.sensor.rawTilt).toBe(20);
  });
  it('does not treat null events as usable input and reports missing channels', async () => {
    const request = input.request();
    const rejected = expect(request).rejects.toThrow('動き：未受信 / 傾き：未受信');
    await vi.advanceTimersByTimeAsync(0);
    events.dispatchEvent(new Event('devicemotion')); orientation(null);
    await vi.advanceTimersByTimeAsync(3600); await rejected;
    expect(input.sensor.calibrate(performance.now())).toBe(false);
  });
  it('requires new samples on retry and can recover without reloading', async () => {
    const first = input.request(); await vi.advanceTimersByTimeAsync(0);
    motion(); await vi.advanceTimersByTimeAsync(80); await first;
    const retry = input.request(); const rejected = expect(retry).rejects.toThrow('値が届きません');
    await vi.advanceTimersByTimeAsync(3600); await rejected;
    const recovered = input.request(); await vi.advanceTimersByTimeAsync(0);
    motion(); await vi.advanceTimersByTimeAsync(80); await recovered;
    expect(input.sensor.calibrate(performance.now())).toBe(true);
  });
});
