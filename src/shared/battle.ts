import { BREADS, LIMIT, STEP, PVP_WINDUP_EXTRA, PVP_RECOVERY_EXTRA, clamp, mix, type BreadId, type Ruleset } from './rules';
import { SPECIALS, METER_MAX, METER_GAIN, motionTime, motionTick, liveStage, specialFrame, type SpecialFrame } from './specials';

export const SLOTS = ['A', 'B'] as const;
export type Slot = typeof SLOTS[number];
export const otherSlot = (slot: Slot): Slot => slot === 'A' ? 'B' : 'A';
export interface Metric { success: number; opportunities: number }
export interface Scores { dodge: Metric; counter: Metric }
export interface Counter { until: number; available: boolean }
// A special move locks its aim at activation; mask records which hit stages already landed.
export interface SpecialMove { from: number; extra: number; mask: number; landed: boolean }
export interface Attack {
  age: number; windup: number; recovery: number; spent: boolean; aim: number; origin: number;
  threatened: boolean; resolved: boolean; id: number;
  impact?: { progress: number; age: number };
  // Present only when specials are enabled (CPU battles); PvP state keeps its original shape.
  near?: boolean; special?: SpecialMove;
}
export interface Fighter { bread: BreadId; hp: number; x: number; attack: Attack | null; recoil: number; hit: number; meter?: number }
export interface Pose { x: number; y: number; z: number; lean: number; rx: number; rz: number; progress: number; special?: SpecialFrame & { t: number } }
export interface BattleEvent {
  id: number; kind: 'hit' | 'clash' | 'miss' | 'dodge' | 'counter' | 'attack' | 'special' | 'special-hit'; side: Slot; x: number; z: number;
  // special-hit: stage index; special: the miss/dodge belongs to a special move.
  stage?: number; special?: boolean;
}
export interface Command { target: number; attack: boolean; special?: boolean }
export type Commands = Record<Slot, Command>;
export interface BattleState {
  fighters: Record<Slot, Fighter>; scores: Record<Slot, Scores>; counters: Record<Slot, Counter>;
  elapsed: number; tick: number; winner: Slot | 'draw' | null; rules: Ruleset; practice: boolean;
  attackSerial: number; eventSerial: number;
  // CPU-only anticipation/recovery padding for slot B, and whether the CPU earns dodge/counter windows too. PvP ignores it.
  // damage scales CPU hits and grace extends the CPU's own counter window; both default to the neutral values.
  cpuExtra?: { windup: number; recovery: number; counters?: boolean; damage?: number; grace?: number };
  // Special meter and moves. Only CPU battles opt in; PvP rejects them in the core.
  specials?: boolean;
}
export const emptyScores = (): Scores => ({ dodge: { success: 0, opportunities: 0 }, counter: { success: 0, opportunities: 0 } });
export function createBattle(a: BreadId, b: BreadId, rules: Ruleset = 'pvp', practice = false): BattleState {
  const fighter = (bread: BreadId): Fighter => ({ bread, hp: BREADS[bread].hp, x: 0, attack: null, recoil: 0, hit: 0 });
  return { fighters: { A: fighter(a), B: fighter(b) }, scores: { A: emptyScores(), B: emptyScores() },
    counters: { A: { until: 0, available: false }, B: { until: 0, available: false } },
    elapsed: 0, tick: 0, winner: null, rules, practice, attackSerial: 0, eventSerial: 0 };
}
const activeOf = (f: Fighter): number => f.attack?.special ? SPECIALS[f.bread].active : BREADS[f.bread].active;
export function phase(f: Fighter): 'ready' | 'windup' | 'active' | 'recovery' {
  const a = f.attack;
  return !a ? 'ready' : a.age < a.windup ? 'windup' : a.age < a.windup + activeOf(f) ? 'active' : 'recovery';
}
// Side-step is allowed in recovery, except for the first `lock` seconds after a special move.
export function movable(f: Fighter): boolean {
  const p = phase(f), a = f.attack;
  return p === 'ready' || (p === 'recovery' && (!a?.special || a.age >= a.windup + activeOf(f) + SPECIALS[f.bread].lock));
}
function specialPose(f: Fighter, slot: Slot): Pose {
  const b = BREADS[f.bread], a = f.attack!, sign = slot === 'A' ? 1 : -1, t = motionTime(f.bread, a.age, a.special!.extra), frame = specialFrame(f.bread, t);
  const lean = -sign * frame.lean;
  return { x: mix(f.x, a.aim, frame.alpha), y: 1.43 + frame.lift, z: sign * (1.2 - frame.travel), lean, rx: b.width,
    rz: Math.sqrt((b.height * Math.sin(lean)) ** 2 + (b.depth * Math.cos(lean)) ** 2), progress: clamp(frame.travel / 1.92, 0, 1), special: { ...frame, t } };
}
export function pose(f: Fighter, slot: Slot): Pose {
  if (f.attack?.special) return specialPose(f, slot);
  const b = BREADS[f.bread], a = f.attack, sign = slot === 'A' ? 1 : -1;
  let progress = 0;
  if (a) {
    if (a.age < a.windup) progress = -.055 * Math.sin(Math.PI * a.age / a.windup);
    else if (a.age < a.windup + b.active) progress = Math.sin(clamp((a.age - a.windup) / b.active * 1.4, 0, 1) * Math.PI / 2);
    else progress = Math.max(0, 1 - (a.age - a.windup - b.active) / a.recovery);
    if (a.impact) progress = a.impact.progress * Math.max(0, 1 - (a.age - a.impact.age) / (a.windup + b.active + a.recovery - a.impact.age));
  }
  const lean = -sign * b.lean * progress;
  return { x: a ? mix(f.x, a.aim, Math.max(0, progress)) : f.x,
    y: 1.43, z: sign * (1.2 + .42 * Math.sin(Math.PI * f.recoil / .38) - b.reach * progress),
    lean, rx: b.width, rz: Math.sqrt((b.height * Math.sin(lean)) ** 2 + (b.depth * Math.cos(lean)) ** 2), progress };
}
export function touching(a: Pose, b: Pose): boolean {
  return ((a.x - b.x) / (a.rx + b.rx)) ** 2 + ((a.z - b.z) / (a.rz + b.rz)) ** 2 <= 1;
}
// A special move's own attack ellipse against the defender's normal hurt ellipse.
export function specialTouching(bread: BreadId, attack: Pose, hurt: Pose): boolean {
  const s = SPECIALS[bread];
  return ((attack.x - hurt.x) / (s.rx + hurt.rx)) ** 2 + ((attack.z - hurt.z) / (s.rz + hurt.rz)) ** 2 <= 1;
}
// Stage index that lands on this tick, or -1.
function specialStage(s: BattleState, slot: Slot, poses: Record<Slot, Pose>): number {
  const f = s.fighters[slot], a = f.attack;
  if (!a?.special || phase(f) !== 'active') return -1;
  const stage = liveStage(f.bread, motionTick(f.bread, a.age, a.special.extra));
  return stage >= 0 && !(a.special.mask & 1 << stage) && specialTouching(f.bread, poses[slot], poses[otherSlot(slot)]) ? stage : -1;
}
function emit(s: BattleState, events: BattleEvent[], kind: BattleEvent['kind'], side: Slot, x: number, z: number, extra: Pick<BattleEvent, 'stage' | 'special'> = {}): void {
  events.push({ id: ++s.eventSerial, kind, side, x, z, ...extra });
}
function gain(s: BattleState, slot: Slot, amount: number): void {
  if (!s.specials) return;
  const f = s.fighters[slot]; f.meter = Math.min(METER_MAX, (f.meter ?? 0) + amount);
}
export function startAttack(s: BattleState, slot: Slot, events: BattleEvent[]): boolean {
  if (s.winner) return false;
  const f = s.fighters[slot], other = s.fighters[otherSlot(slot)], b = BREADS[f.bread];
  if (f.attack || f.recoil > 0) return false;
  const aim = clamp(other.x, f.x - .85, f.x + .85);
  f.attack = { age: 0, windup: b.windup + (s.rules === 'pvp' ? PVP_WINDUP_EXTRA : slot === 'B' ? s.cpuExtra?.windup ?? .65 : 0),
    recovery: b.recovery + (s.rules === 'pvp' ? PVP_RECOVERY_EXTRA : slot === 'B' ? s.cpuExtra?.recovery ?? .55 : 0),
    aim, origin: other.x, spent: false, resolved: false, id: ++s.attackSerial,
    threatened: (s.rules === 'pvp' || slot === 'B' || !!s.cpuExtra?.counters) && Math.abs(aim - other.x) < b.width + BREADS[other.bread].width };
  // Meter-only dodge credit for swings that would have connected, independent of counter windows.
  if (s.specials) f.attack.near = Math.abs(aim - other.x) < b.width + BREADS[other.bread].width;
  emit(s, events, 'attack', slot, f.x, slot === 'A' ? 1.2 : -1.2);
  return true;
}
export function canSpecial(s: BattleState, slot: Slot): boolean {
  const f = s.fighters[slot];
  return !s.winner && !!s.specials && s.rules !== 'pvp' && !f.attack && f.recoil <= 0 && (f.meter ?? 0) >= METER_MAX;
}
// Spends a full meter on the fighter's special move. extra stretches only the wind-up (CPU difficulty).
export function startSpecial(s: BattleState, slot: Slot, events: BattleEvent[], extra = 0): boolean {
  if (!canSpecial(s, slot)) return false;
  const f = s.fighters[slot], other = s.fighters[otherSlot(slot)], spec = SPECIALS[f.bread];
  f.meter = 0; s.counters[slot].available = false;
  f.attack = { age: 0, windup: spec.windup + extra, recovery: spec.recovery, aim: clamp(other.x, -LIMIT, LIMIT), origin: other.x,
    spent: false, resolved: false, id: ++s.attackSerial, threatened: true, special: { from: f.x, extra, mask: 0, landed: false } };
  emit(s, events, 'special', slot, f.x, slot === 'A' ? 1.2 : -1.2);
  return true;
}

// One fixed simulation step. Scheduling, buffering and pauses belong to the caller.
export function stepBattle(s: BattleState, commands: Commands, events: BattleEvent[]): void {
  if (s.winner) return;
  // Both special requests are judged against the state at the start of the tick, so slot order never matters.
  const specials = { A: !!commands.A.special && canSpecial(s, 'A'), B: !!commands.B.special && canSpecial(s, 'B') };
  for (const slot of SLOTS) if (specials[slot]) startSpecial(s, slot, events);
  for (const slot of SLOTS) if (commands[slot].attack && !specials[slot]) startAttack(s, slot, events);
  s.tick++;
  s.elapsed = s.practice ? s.elapsed + STEP : Math.min(60, s.elapsed + STEP);
  for (const slot of SLOTS) {
    const f = s.fighters[slot], target = commands[slot].target;
    const desired = Number.isFinite(target) ? clamp(target, -LIMIT, LIMIT) : f.x;
    if (movable(f)) f.x += clamp(desired - f.x, -STEP * 4.8, STEP * 4.8);
    f.recoil = Math.max(0, f.recoil - STEP); f.hit = Math.max(0, f.hit - STEP);
    if (f.attack) f.attack.age += STEP;
  }
  const poses = { A: pose(s.fighters.A, 'A'), B: pose(s.fighters.B, 'B') };
  const contact = touching(poses.A, poses.B);
  const normal = (slot: Slot): boolean => { const a = s.fighters[slot].attack; return contact && phase(s.fighters[slot]) === 'active' && !a!.spent && !a!.special; };
  const hits = { A: normal('A'), B: normal('B') };
  const stages = { A: specialStage(s, 'A', poses), B: specialStage(s, 'B', poses) };
  // Compute every hit flag before any HP, recoil or attack mutations.
  for (const slot of SLOTS) {
    if (!hits[slot]) continue;
    const opposite = otherSlot(slot), f = s.fighters[slot], other = s.fighters[opposite], a = f.attack!;
    a.spent = true; a.impact = { progress: poses[slot].progress, age: a.age };
    const counter = !hits[opposite] && s.counters[slot].available && s.elapsed <= s.counters[slot].until;
    const scale = slot === 'B' && s.rules !== 'pvp' ? s.cpuExtra?.damage ?? 1 : 1;
    if (!s.practice) other.hp = Math.max(0, other.hp - BREADS[f.bread].damage * (counter ? 1.25 : 1) * scale);
    other.hit = .3;
    gain(s, slot, hits[opposite] || stages[opposite] >= 0 ? METER_GAIN.clash : counter ? METER_GAIN.counter : METER_GAIN.hit);
    if (a.threatened && !a.resolved) { s.scores[opposite].dodge.opportunities++; a.resolved = true; }
    if (counter) {
      s.scores[slot].counter.success++; s.counters[slot].available = false;
      emit(s, events, 'counter', slot, poses[opposite].x, poses[opposite].z);
    }
  }
  if (hits.A || hits.B) {
    emit(s, events, hits.A && hits.B ? 'clash' : 'hit', hits.A ? 'A' : 'B', (poses.A.x + poses.B.x) / 2, (poses.A.z + poses.B.z) / 2);
    s.fighters.A.recoil = .38; s.fighters.B.recoil = .38;
  }
  // Special stages: fixed damage (no counter or CPU scaling), no meter, and they never bend the attacker's path.
  for (const slot of SLOTS) {
    const stage = stages[slot];
    if (stage < 0) continue;
    const opposite = otherSlot(slot), f = s.fighters[slot], other = s.fighters[opposite], a = f.attack!, data = SPECIALS[f.bread].stages[stage]!;
    a.special!.mask |= 1 << stage; a.special!.landed = true; a.spent = true;
    if (!s.practice) other.hp = Math.max(0, other.hp - data.damage);
    other.hit = .3;
    if (data.recoil) other.recoil = .38;
    if (!a.resolved) { s.scores[opposite].dodge.opportunities++; a.resolved = true; }
    emit(s, events, 'special-hit', slot, poses[opposite].x, (poses.A.z + poses.B.z) / 2, { stage });
  }
  for (const slot of SLOTS) {
    const f = s.fighters[slot], a = f.attack, opposite = otherSlot(slot);
    if (!a) continue;
    const active = activeOf(f), special = !!a.special;
    if (a.age >= a.windup + active && !a.resolved) {
      a.resolved = true;
      const moved = Math.abs(s.fighters[opposite].x - a.origin) >= .25;
      if (!a.spent) emit(s, events, 'miss', slot, f.x, 0, special ? { special } : {});
      if (a.threatened) {
        s.scores[opposite].dodge.opportunities++;
        if (!a.spent && moved) {
          s.scores[opposite].dodge.success++; s.scores[opposite].counter.opportunities++;
          const grace = opposite === 'B' && s.rules !== 'pvp' ? s.cpuExtra?.grace ?? 0 : 0;
          s.counters[opposite] = { until: s.elapsed + a.recovery + grace, available: true };
          gain(s, opposite, METER_GAIN.dodge);
          emit(s, events, 'dodge', opposite, s.fighters[opposite].x, opposite === 'A' ? 1.2 : -1.2, special ? { special } : {});
        }
      } else if (a.near && !a.spent && moved) gain(s, opposite, METER_GAIN.dodge);
    }
    if (a.age >= a.windup + active + a.recovery) f.attack = null;
  }
  if (!s.practice && (s.fighters.A.hp <= 0 || s.fighters.B.hp <= 0 || s.elapsed >= 60 - 1e-8)) {
    const diff = s.fighters.A.hp / BREADS[s.fighters.A.bread].hp - s.fighters.B.hp / BREADS[s.fighters.B.bread].hp;
    s.winner = Math.abs(diff) < 1e-9 ? 'draw' : diff > 0 ? 'A' : 'B';
  }
}
