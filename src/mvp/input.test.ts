import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameInput } from './input';

let input: GameInput;
let events: EventTarget;
let permission: ReturnType<typeof vi.fn>;
function motion(sign = -1): void {
  const event = new Event('devicemotion');
  Object.defineProperties(event, {
    acceleration: { value: { x: 0, y: 0, z: 0 } },
    accelerationIncludingGravity: { value: { x: 0, y: sign * 9.8, z: 0 } },
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
