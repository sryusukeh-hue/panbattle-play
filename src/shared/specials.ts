import { STEP, clamp, mix, type BreadId } from './rules';

// Special-move ("ひっさつ") data shared by the CPU battle core and the renderer.
// Values come from plans/EXECPLAN-SPECIAL.md (designed with Codex gpt-6-astra, 2026-09-27).
export const METER_MAX = 100;
export const METER_GAIN = { hit: 25, counter: 40, dodge: 30, clash: 10 } as const;
// Real-time freeze for the cut-in; combat time does not advance while it plays.
export const CUTIN_SECONDS = .6;

type Vec3 = readonly [number, number, number];
// at = (α toward the locked aim, lift above the stand height, forward travel); rot = (lean, yaw, roll).
interface Key { t: number; at: Vec3; rot: Vec3; scale: Vec3; ease?: 'in' | 'linear' }
// Hit windows in 120 Hz ticks of motion time (after any CPU wind-up stretch is removed).
export interface SpecialStage { from: number; to: number; damage: number; stop: number; recoil: boolean }
export interface SpecialSpec {
  // name = kicker + title; sfx is the onomatopoeia shown on each stage's hit.
  name: string; kicker: string; title: string; ruby: string; shout: string; color: string; sfx: readonly string[];
  windup: number; active: number; recovery: number; lock: number;
  rx: number; rz: number; stages: readonly SpecialStage[]; keys: readonly Key[];
}
const T = (seconds: number): number => Math.round(seconds / STEP);
export const SPECIALS: Record<BreadId, SpecialSpec> = {
  shokupan: {
    name: '爆熱ギガトースト', kicker: '爆熱', title: 'ギガトースト', ruby: 'ばくねつギガトースト', shout: 'ギガトースト！', color: '#ffb63a', sfx: ['ドーン！'],
    windup: .70, active: .15, recovery: .85, lock: .25, rx: .68, rz: .50,
    stages: [{ from: T(.70), to: T(.85), damage: 32, stop: .0833, recoil: true }],
    keys: [
      { t: 0, at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      { t: .15, at: [0, -.10, -.08], rot: [-.16, -.08, .10], scale: [1.06, .90, 1.04] },
      { t: .40, at: [.65, .85, .65], rot: [-.10, .10, -.08], scale: [1.14, 1.14, 1.03] },
      { t: .55, at: [1, 1.10, 1.00], rot: [.25, 0, 0], scale: [1.25, 1.12, 1.04] },
      { t: .70, at: [1, 0, 1.92], rot: [1.25, 0, 0], scale: [1.30, 1.12, 1.06], ease: 'in' },
      { t: .85, at: [1, 0, 1.92], rot: [1.25, 0, 0], scale: [1.30, 1.12, 1.06] },
      { t: 1.10, at: [.65, .10, 1.20], rot: [.65, 0, 0], scale: [1.10, 1.06, 1] },
      { t: 1.70, at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
    ],
  },
  francepan: {
    name: '雷光バゲットブレイカー', kicker: '雷光', title: 'バゲットブレイカー', ruby: 'らいこうバゲットブレイカー', shout: 'バゲットブレイカー！', color: '#9fd8ff', sfx: ['ズバァッ！'],
    windup: .60, active: .10, recovery: 1.00, lock: .35, rx: .24, rz: 1.02,
    stages: [{ from: T(.60), to: T(.70), damage: 36, stop: .0833, recoil: true }],
    keys: [
      { t: 0, at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      { t: .20, at: [0, -.04, -.16], rot: [-.20, -.18, -.12], scale: [1, .97, 1] },
      { t: .50, at: [1, .02, .05], rot: [.90, 0, .04], scale: [.98, 1.04, 1] },
      { t: .60, at: [1, .02, .15], rot: [1.27, 0, 0], scale: [.98, 1.04, 1] },
      { t: .625, at: [1, 0, 1.70], rot: [1.27, 0, 0], scale: [1, 1.08, 1], ease: 'linear' },
      { t: .70, at: [1, 0, 1.70], rot: [1.27, 0, 0], scale: [1, 1.08, 1] },
      { t: 1.05, at: [.65, .03, 1.10], rot: [.95, 0, .08], scale: [1, 1, 1] },
      { t: 1.70, at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
    ],
  },
  croissant: {
    name: '三日月トルネード', kicker: '三日月', title: 'トルネード', ruby: 'みかづきトルネード', shout: '三日月トルネード！', color: '#ffd76a', sfx: ['シュッ', 'シュッ', 'ドン！'],
    windup: .55, active: .40, recovery: .55, lock: .15, rx: .68, rz: .40,
    stages: [
      { from: 66, to: 74, damage: 6, stop: 0, recoil: false },
      { from: 86, to: 94, damage: 6, stop: 0, recoil: false },
      { from: 106, to: 114, damage: 16, stop: .0667, recoil: true },
    ],
    keys: [
      { t: 0, at: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
      { t: .15, at: [0, -.08, -.08], rot: [-.10, 0, -.35], scale: [1.08, .92, 1] },
      { t: .35, at: [.60, .22, .85], rot: [.18, 0, Math.PI / 2], scale: [1.04, 1.04, 1] },
      { t: .55, at: [1, 0, 1.90], rot: [.25, 0, Math.PI * 2], scale: [1.04, 1.04, 1] },
      { t: 86 * STEP, at: [1, 0, 1.90], rot: [.25, 0, Math.PI * 4], scale: [1.04, 1.04, 1], ease: 'linear' },
      { t: 106 * STEP, at: [1, 0, 1.90], rot: [.25, 0, Math.PI * 6], scale: [1.08, 1.02, 1], ease: 'linear' },
      { t: .95, at: [1, 0, 1.90], rot: [.25, 0, Math.PI * 6], scale: [1.04, 1.04, 1] },
      { t: 1.10, at: [.65, .08, 1.05], rot: [.12, 0, Math.PI * 6], scale: [1, 1, 1] },
      { t: 1.50, at: [0, 0, 0], rot: [0, 0, Math.PI * 6], scale: [1, 1, 1] },
    ],
  },
};
export const specialDuration = (bread: BreadId, extra = 0): number => {
  const s = SPECIALS[bread]; return s.windup + extra + s.active + s.recovery;
};
// Motion time: a CPU wind-up stretch slows only the wind-up section; active and recovery keep their timing.
export function motionTime(bread: BreadId, age: number, extra = 0): number {
  const windup = SPECIALS[bread].windup;
  return age < windup + extra ? age * windup / (windup + extra) : age - extra;
}
export const motionTick = (bread: BreadId, age: number, extra = 0): number => Math.round(motionTime(bread, age, extra) / STEP);
// Index of the hit stage that is live at this motion tick, or -1 between stages.
export function liveStage(bread: BreadId, tick: number): number {
  return SPECIALS[bread].stages.findIndex(stage => tick >= stage.from && tick < stage.to);
}
export interface SpecialFrame { alpha: number; lift: number; travel: number; lean: number; yaw: number; roll: number; scale: [number, number, number] }
const smooth = (u: number): number => u * u * (3 - 2 * u);
export function specialFrame(bread: BreadId, t: number): SpecialFrame {
  const keys = SPECIALS[bread].keys, time = clamp(t, 0, keys[keys.length - 1]!.t);
  let i = 1; while (i < keys.length - 1 && keys[i]!.t < time) i++;
  const a = keys[i - 1]!, b = keys[i]!, raw = b.t === a.t ? 1 : clamp((time - a.t) / (b.t - a.t), 0, 1);
  const u = b.ease === 'in' ? raw ** 3 : b.ease === 'linear' ? raw : smooth(raw);
  const at = (n: 0 | 1 | 2): number => mix(a.at[n], b.at[n], u), rot = (n: 0 | 1 | 2): number => mix(a.rot[n], b.rot[n], u);
  return { alpha: at(0), lift: at(1), travel: at(2), lean: rot(0), yaw: rot(1), roll: rot(2) % (Math.PI * 2),
    scale: [mix(a.scale[0], b.scale[0], u), mix(a.scale[1], b.scale[1], u), mix(a.scale[2], b.scale[2], u)] };
}
