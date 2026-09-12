import { LIMIT, clamp } from './config';
export interface MotionSample { time: number; x: number | null; y: number | null; z: number | null }
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// accelerationIncludingGravity - acceleration is the upward specific-force vector.
// Use its screen-plane roll to avoid Euler gamma's ambiguity with a near-upright phone.
export function gravityRoll(x: number, y: number): number | null {
  if (!finite(x) || !finite(y) || Math.hypot(x, y) < 3) return null;
  return Math.atan2(-x, y) * 180 / Math.PI;
}
export class MotionFilter {
  sensitivity = 1; baseline: number | null = null; tilt = 0; rawTilt: number | null = null;
  lastMotion = -Infinity; lastOrientation = -Infinity; attacks = 0; detectedAt = -Infinity;
  private lastSample = -Infinity; private quietSince = -Infinity; private armed = false; private inhibitUntil = 0;
  motion(s: MotionSample, enabled: boolean): boolean {
    if (![s.time, s.x, s.y, s.z].every(finite)) { this.armed = false; this.quietSince = -Infinity; return false; }
    const gap = s.time - this.lastSample;
    this.lastSample = s.time; this.lastMotion = s.time;
    const magnitude = Math.hypot(s.x!, s.y!, s.z!);
    if (gap <= 0 || gap > 250) { this.armed = false; this.quietSince = -Infinity; return false; }
    const high = 7 / this.sensitivity, low = high * .32;
    if (magnitude < low) {
      if (!Number.isFinite(this.quietSince)) this.quietSince = s.time;
      if (s.time - this.quietSince >= 180 && s.time >= this.inhibitUntil) this.armed = true;
    } else this.quietSince = -Infinity;
    if (magnitude >= high && this.armed) {
      this.armed = false; this.inhibitUntil = s.time + 450;
      if (enabled) { this.detectedAt = s.time; this.attacks++; return true; }
    }
    return false;
  }
  orientation(gamma: number | null, time: number): void {
    if (!finite(gamma) || !finite(time) || Math.abs(gamma) > 90) return;
    const dt = clamp((time - this.lastOrientation) / 1000, 0, .1);
    this.lastOrientation = time; this.rawTilt = gamma;
    if (this.baseline === null || time < this.inhibitUntil) return;
    const delta = gamma - this.baseline;
    const target = clamp(Math.sign(delta) * Math.max(0, Math.abs(delta) - 4) / (24 / this.sensitivity), -1, 1) * LIMIT;
    this.tilt += (target - this.tilt) * (1 - Math.exp(-dt * 14));
  }
  fresh(now: number): boolean { return now - this.lastMotion < 800 && now - this.lastOrientation < 800; }
  calibrate(now: number): boolean {
    if (!this.fresh(now) || this.rawTilt === null) return false;
    this.baseline = this.rawTilt; this.tilt = 0; this.reset(); return true;
  }
  reset(): void { this.armed = false; this.quietSince = -Infinity; this.lastSample = -Infinity; this.inhibitUntil = 0; }
}
