import { LIMIT, clamp } from './config';
export interface MotionSample { time: number; x: number | null; y: number | null; z: number | null }
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
// Initial device-tuning values. No raw sensor samples leave this in-memory window.
export const MOTION_TUNING = { lookbackMs: 80, decisionMs: 50, tiltDegrees: 6, maxSampleGapMs: 80, tiltHoldMs: 80, cooldownMs: 450, quietMs: 180 } as const;
// WebKit/CoreMotion and other implementations can report opposite gravity signs.
// Normalize the portrait axis modulo 180 degrees; both signs give the same roll.
// This also avoids Euler gamma's ambiguity with a near-upright phone.
export function gravityRoll(x: number, y: number): number | null {
  if (!finite(x) || !finite(y) || Math.hypot(x, y) < 3) return null;
  const roll = Math.atan2(-x, y) * 180 / Math.PI;
  return roll > 90 ? roll - 180 : roll < -90 ? roll + 180 : roll;
}
export class MotionFilter {
  attackSensitivity = 1; tiltSensitivity = 1; baseline: number | null = null; tilt = 0; rawTilt: number | null = null;
  lastMotion = -Infinity; lastOrientation = -Infinity; attacks = 0; detectedAt = -Infinity;
  private lastSample = -Infinity; private quietSince = -Infinity; private armed = false; private inhibitUntil = 0;
  private tiltHoldUntil = 0;
  private history: { time: number; angle: number }[] = [];
  private candidate: number | null = null;
  get attackThreshold(): number { return 7 / this.attackSensitivity; }
  motion(s: MotionSample, enabled: boolean): void {
    if (![s.time, s.x, s.y, s.z].every(finite)) { this.reset(); return; }
    const gap = s.time - this.lastSample;
    this.lastSample = s.time; this.lastMotion = s.time;
    const magnitude = Math.hypot(s.x!, s.y!, s.z!);
    if (gap <= 0 || gap > MOTION_TUNING.maxSampleGapMs) { this.armed = false; this.quietSince = -Infinity; this.candidate = null; return; }
    if (!enabled) this.candidate = null;
    const high = this.attackThreshold, low = high * .32;
    if (magnitude < low) {
      if (!Number.isFinite(this.quietSince)) this.quietSince = s.time;
      if (s.time - this.quietSince >= MOTION_TUNING.quietMs && s.time >= this.inhibitUntil) this.armed = true;
    } else this.quietSince = -Infinity;
    if (magnitude >= high && this.armed && this.candidate === null) {
      this.armed = false;
      if (enabled) this.candidate = s.time;
    }
  }
  poll(now: number, enabled: boolean): boolean {
    if (!enabled) { this.candidate = null; return false; }
    const start = this.candidate;
    if (start === null || now < start + MOTION_TUNING.decisionMs) return false;
    this.candidate = null;
    const end = start + MOTION_TUNING.decisionMs, from = start - MOTION_TUNING.lookbackMs;
    const history = this.history.filter(p => p.time >= from - MOTION_TUNING.maxSampleGapMs && p.time <= now);
    let first = -1;
    for (let i = 0; i < history.length; i++) if (history[i]!.time <= from) first = i;
    // Missing/discontinuous channels never turn uncertainty into an attack.
    if (first < 0 || now - end > MOTION_TUNING.maxSampleGapMs || now - this.lastMotion > MOTION_TUNING.maxSampleGapMs ||
        !history.length || end - history[history.length - 1]!.time > MOTION_TUNING.maxSampleGapMs / 2) return false;
    const points = history.slice(first);
    if (points.length < 2) return false;
    const before = points[0]!, after = points[1]!;
    if (after.time - before.time > MOTION_TUNING.maxSampleGapMs) return false;
    points[0] = { time: from, angle: before.angle + (after.angle - before.angle) * (from - before.time) / (after.time - before.time) };
    let rise = 0, fall = 0;
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]!, current = points[i]!;
      if (current.time - previous.time > MOTION_TUNING.maxSampleGapMs) return false;
      const delta = current.angle - previous.angle;
      rise = Math.max(0, rise + delta); fall = Math.max(0, fall - delta);
      if (Math.max(rise, fall) >= MOTION_TUNING.tiltDegrees) return false;
    }
    this.armed = false; this.inhibitUntil = now + MOTION_TUNING.cooldownMs;
    this.tiltHoldUntil = now + MOTION_TUNING.tiltHoldMs;
    this.detectedAt = now; this.attacks++; return true;
  }
  orientation(gamma: number | null, time: number): void {
    if (!finite(gamma) || !finite(time) || Math.abs(gamma) > 90) { this.history = []; this.candidate = null; return; }
    if (time < this.lastOrientation) { this.history = []; this.candidate = null; return; }
    const dt = clamp((time - this.lastOrientation) / 1000, 0, .1);
    this.lastOrientation = time; this.rawTilt = gamma;
    if (this.history.at(-1)?.time === time) this.history.pop();
    this.history.push({ time, angle: gamma });
    this.history = this.history.filter(p => time - p.time <= 350);
    if (this.baseline === null || time < this.tiltHoldUntil) return;
    const delta = gamma - this.baseline;
    const target = clamp(Math.sign(delta) * Math.max(0, Math.abs(delta) - 4) / (24 / this.tiltSensitivity), -1, 1) * LIMIT;
    this.tilt += (target - this.tilt) * (1 - Math.exp(-dt * 14));
  }
  fresh(now: number): boolean { return now - this.lastMotion < 800 && now - this.lastOrientation < 800; }
  calibrate(now: number): boolean {
    if (!this.fresh(now) || this.rawTilt === null) return false;
    this.baseline = this.rawTilt; this.tilt = 0; this.reset(); return true;
  }
  reset(): void { this.armed = false; this.quietSince = -Infinity; this.lastSample = -Infinity; this.inhibitUntil = 0; this.tiltHoldUntil = 0; this.candidate = null; this.history = []; }
}
