import type { BreadId } from './config';
import { FACES, type BrowId, type EyeStyle, type MouthId } from './face-config';

// Expression logic, free of DOM/WebGL (plans/EXECPLAN-FACE.md 3). Layers, highest first:
// result > short reaction > action phase > fatigue. The renderer turns a FaceFrame into eyes, lids and a decal.
export type FacePhase = 'ready' | 'windup' | 'active' | 'recovery';
export type Reaction = 'ouch' | 'grit' | 'dodge' | 'counter';
export interface FaceInput {
  phase: FacePhase; special: boolean; charging: boolean;
  // 0..3, the damageStage() of the bread's HP.
  stage: number;
  ending: 'win' | 'lose' | 'draw' | null;
  // Where the opponent is, as a share of the pupil's travel (-1..1 each axis).
  look: readonly [number, number];
}
export interface FaceFrame {
  open: [number, number]; gaze: [number, number];
  // Eyeball size multiplier (wide-eyed shock) and pupil size multiplier (tiny pupils).
  pop: number; pupil: number;
  eyes: EyeStyle; mouth: MouthId; brow: BrowId; cheek: number; sweat: boolean;
  // Drooping mouth corners from fatigue (0..3).
  droop: number;
}
// Seconds: [full-face override, mouth-only tail].
export const REACTION_TIME: Record<Reaction, readonly [number, number]> = { ouch: [.08, .15], grit: [.12, 0], dodge: [0, .28], counter: [0, .36] };
export const BLINK = { close: .04, hold: .03, open: .07, min: 3, max: 6 } as const;
export const GLANCE = { min: 4, max: 7, length: .15, amount: .8 } as const;
const GAZE_TIME = .035;

// Small deterministic generator so blinks are reproducible in tests and differ between the two sides.
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = s + 0x6d2b79f5 >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
// Lid multiplier for a blink `age` seconds in (1 = open).
export function blinkCurve(age: number): number {
  if (age < 0 || age >= BLINK.close + BLINK.hold + BLINK.open) return 1;
  if (age < BLINK.close) return 1 - age / BLINK.close;
  if (age < BLINK.close + BLINK.hold) return 0;
  return (age - BLINK.close - BLINK.hold) / BLINK.open;
}
const RESULT: Record<BreadId, Record<'win' | 'lose' | 'draw', Partial<FaceFrame>>> = {
  shokupan: { win: { eyes: 'happy', mouth: 'win', cheek: 1, brow: 'worry' }, lose: { eyes: 'shut', mouth: 'lose', brow: 'worry' }, draw: { mouth: 'huh', brow: 'worry' } },
  francepan: { win: { open: [.35, .75], mouth: 'smug', brow: 'up' }, lose: { eyes: 'shut', mouth: 'lose', brow: 'worry' }, draw: { mouth: 'huh', brow: 'up' } },
  croissant: { win: { eyes: 'happy', mouth: 'win', cheek: .8 }, lose: { eyes: 'shut', mouth: 'lose', brow: 'worry' }, draw: { mouth: 'huh' } },
};
const ATTACK_BROW: Record<BreadId, BrowId> = { shokupan: 'worry', francepan: 'angry', croissant: 'angry' };

export class FaceState {
  private clock = 0; private next = 0; private blinkAt = -1;
  private idle = 0; private glanceAt = 0; private glanceStart = -1; private glanceSide = 1;
  private reaction: { kind: Reaction; at: number } | null = null;
  private gaze: [number, number] = [0, 0]; private previous: FacePhase = 'ready';
  private rand: () => number;
  constructor(readonly bread: BreadId, private seed = 1) { this.rand = random(seed); this.reset(); }
  reset(): void {
    this.rand = random(this.seed); this.clock = 0; this.reaction = null; this.gaze = [0, 0]; this.previous = 'ready';
    this.next = BLINK.min + this.rand() * (BLINK.max - BLINK.min); this.blinkAt = -1;
    this.idle = 0; this.glanceStart = -1; this.glanceAt = GLANCE.min + this.rand() * (GLANCE.max - GLANCE.min);
  }
  react(kind: Reaction): void {
    // A dodge grin never replaces a fresh shock or a counter's bigger grin.
    const current = this.reaction, live = current && this.clock - current.at < REACTION_TIME[current.kind][0] + REACTION_TIME[current.kind][1];
    if (live && (kind === 'dodge' && current.kind !== 'dodge')) return;
    this.reaction = { kind, at: this.clock };
  }
  // dt already carries the cut-in slow-down; pass 0 while paused. calm = prefers-reduced-motion.
  update(dt: number, input: FaceInput, calm = false): FaceFrame {
    this.clock += Math.max(0, dt);
    const spec = FACES[this.bread], phase = input.phase, t = this.clock;
    // A new swing clears a leftover dodge/counter grin at once.
    if (phase === 'windup' && this.previous !== 'windup' && (this.reaction?.kind === 'dodge' || this.reaction?.kind === 'counter')) this.reaction = null;
    this.previous = phase;
    const frame: FaceFrame = { open: [spec.open[0], spec.open[1]], gaze: [0, 0], pop: 1, pupil: 1, eyes: 'ball', mouth: 'calm', brow: spec.brow, cheek: spec.cheek * .6, sweat: false, droop: 0 };
    // Fatigue (lowest layer).
    const stage = Math.max(0, Math.min(3, Math.round(input.stage)));
    frame.droop = stage; frame.sweat = stage >= 2;
    // Tired eyes droop unevenly, per bread; the blush fades.
    const tired = (i: 0 | 1): number => stage >= 3 ? spec.tired[i] : stage >= 2 ? (1 + spec.tired[i]) / 2 : 1;
    frame.open = [frame.open[0] * tired(0), frame.open[1] * tired(1)];
    if (stage >= 2) frame.cheek *= .5;
    if (stage >= 1 && frame.brow === 'none') frame.brow = 'worry';
    // Action phase.
    if (input.charging) { frame.open = [.8, .8]; frame.mouth = 'tight'; frame.brow = 'angry'; frame.pupil = .85; }
    else if (input.special && (phase === 'windup' || phase === 'active')) {
      if (this.bread === 'shokupan') { frame.open = [.9, .9]; frame.mouth = 'serious'; frame.brow = 'none'; frame.pupil = .6; frame.cheek = 0; }
      else if (this.bread === 'francepan') { frame.open = [1, 1]; frame.pop = 1.15; frame.mouth = 'attack'; frame.brow = 'angry'; frame.pupil = .75; }
      else { frame.open = [1, .85]; frame.mouth = 'wild'; frame.brow = 'angry'; frame.cheek = .8; }
    } else if (phase === 'windup') { frame.open = [Math.max(.6, spec.open[0] * .8), Math.max(.6, spec.open[1] * .8)]; frame.mouth = 'tight'; frame.brow = ATTACK_BROW[this.bread]; }
    else if (phase === 'active') { frame.open = [1, 1]; frame.mouth = 'attack'; frame.brow = ATTACK_BROW[this.bread]; }
    else if (phase === 'recovery') { frame.open = [frame.open[0] * .85, frame.open[1] * .85]; frame.mouth = 'slack'; }
    // Short reactions: full-face shock for a moment, then only the mouth lingers (and only while not attacking).
    const r = this.reaction;
    let shocked = false;
    if (r) {
      const age = t - r.at, [full, tail] = REACTION_TIME[r.kind], attacking = phase === 'windup' || phase === 'active';
      if (age >= full + tail) this.reaction = null;
      else if (r.kind === 'ouch') {
        if (age < full) { shocked = true; frame.open = [1, 1]; frame.pop = 1.12; frame.pupil = .6; frame.mouth = 'ouch'; frame.brow = 'worry'; }
        else if (!attacking) frame.mouth = 'ouch';
      } else if (r.kind === 'grit') { frame.mouth = 'grit'; if (!attacking) frame.brow = 'angry'; }
      else if (!attacking) { frame.mouth = 'smug'; frame.cheek = Math.max(frame.cheek, spec.cheek); }
    }
    // A counter's satisfied stare looks straight ahead.
    const stare = this.reaction?.kind === 'counter';
    // Result (top layer): hold for the whole result screen.
    if (input.ending) Object.assign(frame, { pop: 1, pupil: 1, sweat: input.ending === 'lose' || frame.sweat }, RESULT[this.bread][input.ending]);
    // Gaze follows the opponent in ~100 ms; an idle bread glances away now and then.
    const idle = phase === 'ready' && !input.ending && !input.charging;
    // Switching to reduced motion mid-glance ends the glance at once.
    if (calm && this.glanceStart >= 0) { this.glanceStart = -1; this.idle = 0; }
    this.idle = idle ? this.idle + dt : 0;
    let lookX = input.look[0], lookY = input.look[1];
    if (!calm && idle && this.glanceStart < 0 && this.idle >= this.glanceAt) { this.glanceStart = t; this.glanceSide = this.rand() < .5 ? -1 : 1; }
    if (this.glanceStart >= 0) {
      if (!idle || t - this.glanceStart >= GLANCE.length) { this.glanceStart = -1; this.idle = 0; this.glanceAt = GLANCE.min + this.rand() * (GLANCE.max - GLANCE.min); }
      else { lookX = this.glanceSide * GLANCE.amount; lookY = .3; }
    }
    // Reduced motion and the (clock-stopped) result screen jump straight to the target instead of easing.
    const k = calm || input.ending ? 1 : 1 - Math.exp(-Math.max(0, dt) / GAZE_TIME);
    this.gaze = [this.gaze[0] + (clampUnit(lookX) - this.gaze[0]) * k, this.gaze[1] + (clampUnit(lookY) - this.gaze[1]) * k];
    if (!stare || input.ending) frame.gaze = [this.gaze[0], this.gaze[1]];
    // Natural blinks: only while not swinging and never in reduced motion.
    const blinks = !calm && !input.ending && !shocked && (phase === 'ready' || phase === 'recovery') && !input.charging;
    if (t >= this.next) {
      if (blinks) this.blinkAt = this.next;
      this.next += BLINK.min + this.rand() * (BLINK.max - BLINK.min);
      if (this.next <= t) this.next = t + BLINK.min;
    }
    if (this.blinkAt >= 0) {
      const lid = blinks ? blinkCurve(t - this.blinkAt) : 1;
      if (!blinks || t - this.blinkAt >= BLINK.close + BLINK.hold + BLINK.open) this.blinkAt = -1;
      frame.open = [frame.open[0] * lid, frame.open[1] * lid];
    }
    return frame;
  }
}
const clampUnit = (n: number): number => Math.max(-1, Math.min(1, Number.isFinite(n) ? n : 0));
// Key of everything the decal draws; the canvas is repainted only when it changes.
export function decalKey(f: FaceFrame): string { return `${f.eyes}|${f.mouth}|${f.brow}|${f.cheek.toFixed(2)}|${f.sweat ? 1 : 0}|${f.droop}`; }
export function copyFace(f: FaceFrame): FaceFrame { return { ...f, open: [f.open[0], f.open[1]], gaze: [f.gaze[0], f.gaze[1]] }; }
