import { BREADS, LIMIT, STEP, clamp, mix, type BreadId } from './config';

export type Side = 'player' | 'cpu';
export type Outcome = 'win' | 'lose' | 'draw';
export interface Metric { success: number; opportunities: number }
export interface Scores { dodge: Metric; counter: Metric }
export interface Attack {
  age: number; windup: number; recovery: number; spent: boolean; aim: number; origin: number;
  threatened: boolean; resolved: boolean; id: number;
  impact?: { progress: number; age: number };
}
export interface Fighter { bread: BreadId; hp: number; x: number; attack: Attack | null; recoil: number; hit: number }
export interface Pose { x: number; y: number; z: number; lean: number; rx: number; rz: number; progress: number }
export interface BattleEvent { kind: 'hit' | 'clash' | 'miss' | 'dodge' | 'counter' | 'attack'; side: Side; x: number; z: number }
export const emptyScores = (): Scores => ({ dodge: { success: 0, opportunities: 0 }, counter: { success: 0, opportunities: 0 } });
export function phase(f: Fighter): 'ready' | 'windup' | 'active' | 'recovery' {
  const a = f.attack;
  if (!a) return 'ready';
  return a.age < a.windup ? 'windup' : a.age < a.windup + BREADS[f.bread].active ? 'active' : 'recovery';
}
export function pose(f: Fighter, side: Side): Pose {
  const b = BREADS[f.bread], a = f.attack, sign = side === 'player' ? 1 : -1;
  let progress = 0;
  if (a) {
    if (a.age < a.windup) progress = -.055 * Math.sin(Math.PI * a.age / a.windup);
    else if (a.age < a.windup + b.active) progress = Math.sin(clamp((a.age - a.windup) / b.active * 1.4, 0, 1) * Math.PI / 2);
    else progress = Math.max(0, 1 - (a.age - a.windup - b.active) / a.recovery);
    if (a.impact) progress = a.impact.progress * Math.max(0, 1 - (a.age - a.impact.age) / (a.windup + b.active + a.recovery - a.impact.age));
  }
  const lean = -sign * b.lean * progress;
  return {
    x: a ? mix(f.x, a.aim, Math.max(0, progress)) : f.x,
    y: 1.43, z: sign * (1.2 + .42 * Math.sin(Math.PI * f.recoil / .38) - b.reach * progress),
    lean, rx: b.width, rz: Math.sqrt((b.height * Math.sin(lean)) ** 2 + (b.depth * Math.cos(lean)) ** 2), progress,
  };
}
export function touching(a: Pose, b: Pose): boolean {
  return ((a.x - b.x) / (a.rx + b.rx)) ** 2 + ((a.z - b.z) / (a.rz + b.rz)) ** 2 <= 1;
}
export class Battle {
  player: Fighter; cpu: Fighter;
  elapsed = 0; outcome: Outcome | null = null; paused = false;
  scores = emptyScores(); events: BattleEvent[] = [];
  counterUntil = 0; counterAvailable = false; cpuEnabled = true;
  practice: boolean; practiceStage = 0;
  private accumulator = 0; private serial = 0; private seed: number;
  private nextCpu = 1.5; private nextMove = 3.2; private cpuTarget = 0;
  constructor(player: BreadId, cpu: BreadId, options: { practice?: boolean; seed?: number } = {}) {
    this.player = this.make(player); this.cpu = this.make(cpu);
    this.practice = options.practice ?? false; this.seed = options.seed ?? 42;
  }
  private make(bread: BreadId): Fighter { return { bread, hp: BREADS[bread].hp, x: 0, attack: null, recoil: 0, hit: 0 }; }
  private random(): number { this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0; return this.seed / 4294967296; }
  attack(side: Side): boolean {
    if (this.paused || this.outcome) return false;
    const f = this[side], other = side === 'player' ? this.cpu : this.player;
    if (f.attack || f.recoil > 0) return false;
    const aim = clamp(other.x, f.x - .85, f.x + .85);
    f.attack = { age: 0, windup: BREADS[f.bread].windup + (side === 'cpu' ? .65 : 0), recovery: BREADS[f.bread].recovery + (side === 'cpu' ? .55 : 0), spent: false, aim, origin: other.x,
      threatened: side === 'cpu' && Math.abs(aim - other.x) < BREADS[f.bread].width + BREADS[other.bread].width,
      resolved: false, id: ++this.serial };
    this.events.push({ kind: 'attack', side, x: f.x, z: side === 'player' ? 1.2 : -1.2 });
    return true;
  }
  advance(dt: number, target: number, attack = false): void {
    if (this.paused || this.outcome || !Number.isFinite(dt) || dt <= 0) return;
    // A suspended frame never simulates a backlog of CPU attacks.
    if (dt > .25) { this.paused = true; this.accumulator = 0; return; }
    if (attack) this.attack('player');
    this.accumulator += dt;
    while (this.accumulator + 1e-9 >= STEP && !this.outcome && !this.paused) {
      this.tick(STEP, Number.isFinite(target) ? clamp(target, -LIMIT, LIMIT) : this.player.x);
      this.accumulator -= STEP;
    }
  }
  setPaused(value: boolean): void { this.paused = value; this.accumulator = 0; }
  private tick(dt: number, target: number): void {
    this.elapsed = this.practice ? this.elapsed + dt : Math.min(60, this.elapsed + dt);
    if (this.cpuEnabled && (!this.practice || this.practiceStage > 0)) {
      if (this.elapsed >= this.nextMove && !this.cpu.attack) {
        this.cpuTarget = this.practice ? 0 : (this.random() - .5) * .9;
        this.nextMove = this.elapsed + 2.8 + this.random() * 2;
      }
      if (this.elapsed >= this.nextCpu && !this.cpu.attack && this.cpu.recoil <= 0) {
        this.attack('cpu'); this.nextCpu = this.elapsed + 2.7 + this.random() * 1.1;
      }
    }
    for (const side of ['player', 'cpu'] as const) {
      const f = this[side], desired = side === 'player' ? target : this.cpuEnabled ? this.cpuTarget : f.x;
      if (phase(f) === 'ready' || phase(f) === 'recovery') f.x += clamp(desired - f.x, -dt * 4.8, dt * 4.8);
      f.recoil = Math.max(0, f.recoil - dt); f.hit = Math.max(0, f.hit - dt);
      if (f.attack) f.attack.age += dt;
    }
    const pp = pose(this.player, 'player'), cp = pose(this.cpu, 'cpu');
    const pa = this.player.attack, ca = this.cpu.attack;
    const pActive = phase(this.player) === 'active' && !!pa && !pa.spent;
    const cActive = phase(this.cpu) === 'active' && !!ca && !ca.spent;
    const contact = touching(pp, cp);
    const pHit = pActive && contact, cHit = cActive && contact;
    // Decide both hits before mutating HP, recoil or attacks (including simultaneous KO).
    if (pHit || cHit) {
      if (pHit && pa) {
        pa.spent = true;
        pa.impact = { progress: pp.progress, age: pa.age };
        const counter = !cHit && this.counterAvailable && this.elapsed <= this.counterUntil;
        if (!this.practice) this.cpu.hp = Math.max(0, this.cpu.hp - BREADS[this.player.bread].damage * (counter ? 1.25 : 1));
        this.cpu.hit = .3;
        if (counter) {
          this.scores.counter.success++; this.counterAvailable = false;
          this.events.push({ kind: 'counter', side: 'player', x: cp.x, z: cp.z });
        }
      }
      if (cHit && ca) {
        ca.spent = true;
        ca.impact = { progress: cp.progress, age: ca.age };
        // A confirmed hit is already a failed dodge opportunity, even if it ends the match.
        if (ca.threatened && !ca.resolved) { this.scores.dodge.opportunities++; ca.resolved = true; }
        if (!this.practice) this.player.hp = Math.max(0, this.player.hp - BREADS[this.cpu.bread].damage);
        this.player.hit = .3;
      }
      this.events.push({ kind: pHit && cHit ? 'clash' : 'hit', side: pHit ? 'player' : 'cpu', x: (pp.x + cp.x) / 2, z: (pp.z + cp.z) / 2 });
      this.player.recoil = .38; this.cpu.recoil = .38;
    }
    for (const side of ['player', 'cpu'] as const) {
      const f = this[side], a = f.attack, b = BREADS[f.bread];
      if (!a) continue;
      if (a.age >= a.windup + b.active && !a.resolved) {
        a.resolved = true;
        if (!a.spent) this.events.push({ kind: 'miss', side, x: f.x, z: 0 });
        if (side === 'cpu' && a.threatened) {
          this.scores.dodge.opportunities++;
          if (!a.spent && Math.abs(this.player.x - a.origin) >= .25) {
            this.scores.dodge.success++; this.scores.counter.opportunities++;
            this.counterUntil = this.elapsed + a.recovery; this.counterAvailable = true;
            this.events.push({ kind: 'dodge', side: 'player', x: this.player.x, z: 1.2 });
          }
        }
      }
      if (a.age >= a.windup + b.active + a.recovery) f.attack = null;
    }
    if (!this.practice && (this.player.hp <= 0 || this.cpu.hp <= 0 || this.elapsed >= 60 - 1e-8)) {
      const diff = this.player.hp / BREADS[this.player.bread].hp - this.cpu.hp / BREADS[this.cpu.bread].hp;
      this.outcome = Math.abs(diff) < 1e-9 ? 'draw' : diff > 0 ? 'win' : 'lose';
    }
  }
  drainEvents(): BattleEvent[] { const events = this.events; this.events = []; return events; }
}
