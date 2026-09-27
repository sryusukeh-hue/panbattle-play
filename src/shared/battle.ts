import { BREADS, LIMIT, STEP, PVP_WINDUP_EXTRA, PVP_RECOVERY_EXTRA, clamp, mix, type BreadId, type Ruleset } from './rules';

export const SLOTS = ['A', 'B'] as const;
export type Slot = typeof SLOTS[number];
export const otherSlot = (slot: Slot): Slot => slot === 'A' ? 'B' : 'A';
export interface Metric { success: number; opportunities: number }
export interface Scores { dodge: Metric; counter: Metric }
export interface Counter { until: number; available: boolean }
export interface Attack {
  age: number; windup: number; recovery: number; spent: boolean; aim: number; origin: number;
  threatened: boolean; resolved: boolean; id: number;
  impact?: { progress: number; age: number };
}
export interface Fighter { bread: BreadId; hp: number; x: number; attack: Attack | null; recoil: number; hit: number }
export interface Pose { x: number; y: number; z: number; lean: number; rx: number; rz: number; progress: number }
export interface BattleEvent { id: number; kind: 'hit' | 'clash' | 'miss' | 'dodge' | 'counter' | 'attack'; side: Slot; x: number; z: number }
export interface Command { target: number; attack: boolean }
export type Commands = Record<Slot, Command>;
export interface BattleState {
  fighters: Record<Slot, Fighter>; scores: Record<Slot, Scores>; counters: Record<Slot, Counter>;
  elapsed: number; tick: number; winner: Slot | 'draw' | null; rules: Ruleset; practice: boolean;
  attackSerial: number; eventSerial: number;
  // CPU-only anticipation/recovery padding for slot B, and whether the CPU earns dodge/counter windows too. PvP ignores it.
  // damage scales CPU hits and grace extends the CPU's own counter window; both default to the neutral values.
  cpuExtra?: { windup: number; recovery: number; counters?: boolean; damage?: number; grace?: number };
}
export const emptyScores = (): Scores => ({ dodge: { success: 0, opportunities: 0 }, counter: { success: 0, opportunities: 0 } });
export function createBattle(a: BreadId, b: BreadId, rules: Ruleset = 'pvp', practice = false): BattleState {
  const fighter = (bread: BreadId): Fighter => ({ bread, hp: BREADS[bread].hp, x: 0, attack: null, recoil: 0, hit: 0 });
  return { fighters: { A: fighter(a), B: fighter(b) }, scores: { A: emptyScores(), B: emptyScores() },
    counters: { A: { until: 0, available: false }, B: { until: 0, available: false } },
    elapsed: 0, tick: 0, winner: null, rules, practice, attackSerial: 0, eventSerial: 0 };
}
export function phase(f: Fighter): 'ready' | 'windup' | 'active' | 'recovery' {
  const a = f.attack;
  return !a ? 'ready' : a.age < a.windup ? 'windup' : a.age < a.windup + BREADS[f.bread].active ? 'active' : 'recovery';
}
export function pose(f: Fighter, slot: Slot): Pose {
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
function emit(s: BattleState, events: BattleEvent[], kind: BattleEvent['kind'], side: Slot, x: number, z: number): void {
  events.push({ id: ++s.eventSerial, kind, side, x, z });
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
  emit(s, events, 'attack', slot, f.x, slot === 'A' ? 1.2 : -1.2);
  return true;
}

// One fixed simulation step. Scheduling, buffering and pauses belong to the caller.
export function stepBattle(s: BattleState, commands: Commands, events: BattleEvent[]): void {
  if (s.winner) return;
  for (const slot of SLOTS) if (commands[slot].attack) startAttack(s, slot, events);
  s.tick++;
  s.elapsed = s.practice ? s.elapsed + STEP : Math.min(60, s.elapsed + STEP);
  for (const slot of SLOTS) {
    const f = s.fighters[slot], target = commands[slot].target;
    const desired = Number.isFinite(target) ? clamp(target, -LIMIT, LIMIT) : f.x;
    if (phase(f) === 'ready' || phase(f) === 'recovery') f.x += clamp(desired - f.x, -STEP * 4.8, STEP * 4.8);
    f.recoil = Math.max(0, f.recoil - STEP); f.hit = Math.max(0, f.hit - STEP);
    if (f.attack) f.attack.age += STEP;
  }
  const poses = { A: pose(s.fighters.A, 'A'), B: pose(s.fighters.B, 'B') };
  const contact = touching(poses.A, poses.B);
  const hits = { A: contact && phase(s.fighters.A) === 'active' && !s.fighters.A.attack!.spent,
    B: contact && phase(s.fighters.B) === 'active' && !s.fighters.B.attack!.spent };
  // Compute both hit flags before any HP, recoil or attack mutations.
  for (const slot of SLOTS) {
    if (!hits[slot]) continue;
    const opposite = otherSlot(slot), f = s.fighters[slot], other = s.fighters[opposite], a = f.attack!;
    a.spent = true; a.impact = { progress: poses[slot].progress, age: a.age };
    const counter = !hits[opposite] && s.counters[slot].available && s.elapsed <= s.counters[slot].until;
    const scale = slot === 'B' && s.rules !== 'pvp' ? s.cpuExtra?.damage ?? 1 : 1;
    if (!s.practice) other.hp = Math.max(0, other.hp - BREADS[f.bread].damage * (counter ? 1.25 : 1) * scale);
    other.hit = .3;
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
  for (const slot of SLOTS) {
    const f = s.fighters[slot], a = f.attack, b = BREADS[f.bread], opposite = otherSlot(slot);
    if (!a) continue;
    if (a.age >= a.windup + b.active && !a.resolved) {
      a.resolved = true;
      if (!a.spent) emit(s, events, 'miss', slot, f.x, 0);
      if (a.threatened) {
        s.scores[opposite].dodge.opportunities++;
        if (!a.spent && Math.abs(s.fighters[opposite].x - a.origin) >= .25) {
          s.scores[opposite].dodge.success++; s.scores[opposite].counter.opportunities++;
          const grace = opposite === 'B' && s.rules !== 'pvp' ? s.cpuExtra?.grace ?? 0 : 0;
          s.counters[opposite] = { until: s.elapsed + a.recovery + grace, available: true };
          emit(s, events, 'dodge', opposite, s.fighters[opposite].x, opposite === 'A' ? 1.2 : -1.2);
        }
      }
    }
    if (a.age >= a.windup + b.active + a.recovery) f.attack = null;
  }
  if (!s.practice && (s.fighters.A.hp <= 0 || s.fighters.B.hp <= 0 || s.elapsed >= 60 - 1e-8)) {
    const diff = s.fighters.A.hp / BREADS[s.fighters.A.bread].hp - s.fighters.B.hp / BREADS[s.fighters.B.bread].hp;
    s.winner = Math.abs(diff) < 1e-9 ? 'draw' : diff > 0 ? 'A' : 'B';
  }
}
