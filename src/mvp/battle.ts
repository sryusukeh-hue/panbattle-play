import { BREADS, LIMIT, STEP, clamp, type BreadId } from './config';
import { createBattle, startAttack, stepBattle, pose as sharedPose, type Slot, type Fighter, type Pose, type BattleEvent as SharedEvent } from '../shared/battle';
export { phase, touching, emptyScores, type Attack, type Fighter, type Pose, type Metric, type Scores } from '../shared/battle';

export type Side = 'player' | 'cpu';
export type Outcome = 'win' | 'lose' | 'draw';
export type BattleEvent = Omit<SharedEvent, 'side'> & { side: Side };
const slot = (side: Side): Slot => side === 'player' ? 'A' : 'B';
export const pose = (fighter: Fighter, side: Side): Pose => sharedPose(fighter, slot(side));
export interface BattleView { player: Fighter; cpu: Fighter }
export const HIT_STOP_SECONDS = .070;
export const CPU_RECOVER_GAP = .45;
export const CPU_STYLE = {
  shokupan: { interval: 2.9, jitter: .9, pair: .28, pairInterval: 2.7, move: .35, observe: 2.8 },
  francepan: { interval: 3.5, jitter: 1.2, pair: .18, pairInterval: 3.0, move: .25, observe: 3.4 },
  croissant: { interval: 3.0, jitter: 1.3, pair: .45, pairInterval: 2.7, move: .5, observe: 2.1 },
} as const;
export type Difficulty = 'gentle' | 'normal' | 'hard';
export const DIFFICULTIES: readonly Difficulty[] = ['gentle', 'normal', 'hard'];
// windup/recovery pad the CPU swing; pace scales attack intervals.
// The CPU reads a player swing only after `react` seconds and only if it would connect; `dodge` is the base
// sidestep chance and `spam` is added when the swing follows the previous one closely (button mashing).
// gap is the minimum rest after a CPU swing; damage scales CPU hits; grace extends the CPU's counter window.
export const DIFFICULTY = {
  gentle: { label: 'やさしい', windup: .65, recovery: .55, pace: 1, dodge: 0, spam: 0, react: 0, punish: false, gap: .45, damage: 1, grace: 0 },
  normal: { label: 'ふつう', windup: .36, recovery: .3, pace: .5, dodge: .2, spam: .4, react: .12, punish: false, gap: .3, damage: 1.2, grace: 0 },
  hard: { label: 'つよい', windup: .2, recovery: .15, pace: .3, dodge: .3, spam: .6, react: .07, punish: true, gap: .15, damage: 1.4, grace: .3 },
} as const satisfies Record<Difficulty, { label: string; windup: number; recovery: number; pace: number; dodge: number; spam: number; react: number; punish: boolean; gap: number; damage: number; grace: number }>;
export const MASH_GAP = .6;

// CPU/practice policy and browser frame accumulation. The shared core owns the rules.
export class Battle {
  readonly state;
  paused = false; cpuEnabled = true; practiceStage = 0;
  events: BattleEvent[] = [];
  private accumulator = 0; private seed: number;
  private hitStop = 0;
  private nextCpu = 1.5; private nextMove = 3.2; private cpuTarget = 0;
  private secondAttack = false; private judged = 0; private sidestep = 0; private lastSwingEnd = -Infinity; private seenSwing = 0; private mashed = 0;
  readonly difficulty: Difficulty;
  constructor(player: BreadId, cpu: BreadId, options: { practice?: boolean; seed?: number; difficulty?: Difficulty } = {}) {
    this.state = createBattle(player, cpu, 'cpu', options.practice ?? false);
    this.difficulty = options.practice ? 'gentle' : options.difficulty ?? 'gentle';
    const level = DIFFICULTY[this.difficulty];
    this.state.cpuExtra = { windup: level.windup, recovery: level.recovery, counters: level.punish, damage: level.damage, grace: level.grace };
    this.seed = options.seed ?? 42;
  }
  get player() { return this.state.fighters.A; }
  get cpu() { return this.state.fighters.B; }
  get elapsed() { return this.state.elapsed; }
  set elapsed(value: number) { this.state.elapsed = value; }
  get practice() { return this.state.practice; }
  set practice(value: boolean) { this.state.practice = value; }
  get scores() { return this.state.scores.A; }
  set scores(value: import('../shared/battle').Scores) { this.state.scores.A = value; }
  get counterUntil() { return this.state.counters.A.until; }
  get counterAvailable() { return this.state.counters.A.available; }
  get outcome(): Outcome | null { return this.state.winner === null ? null : this.state.winner === 'draw' ? 'draw' : this.state.winner === 'A' ? 'win' : 'lose'; }
  set outcome(value: Outcome | null) { this.state.winner = value === null ? null : value === 'draw' ? 'draw' : value === 'win' ? 'A' : 'B'; }
  private random(): number { this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0; return this.seed / 4294967296; }
  private append(events: SharedEvent[]): void {
    for (const event of events) {
      this.events.push({ ...event, side: event.side === 'A' ? 'player' : 'cpu' });
      // A whiffed player swing that the CPU chose to sidestep reads as a CPU dodge (presentation only; scores unchanged).
      if (event.kind === 'miss' && event.side === 'A' && this.sidestep && this.player.attack?.id === this.sidestep && !this.state.cpuExtra?.counters)
        this.events.push({ ...event, id: event.id + .5, kind: 'dodge', side: 'cpu', x: this.cpu.x, z: -1.2 });
    }
  }
  attack(side: Side): boolean {
    if (this.paused || this.hitStop > 0) return false;
    const events: SharedEvent[] = [], accepted = startAttack(this.state, slot(side), events);
    this.append(events); return accepted;
  }
  advance(dt: number, target: number, attack = false): void {
    if (this.paused || this.outcome || !Number.isFinite(dt) || dt <= 0) return;
    if (dt > .25) { this.setPaused(true); return; }
    const stopped = Math.min(dt, this.hitStop); this.hitStop = Math.max(0, this.hitStop - stopped); dt -= stopped;
    if (dt <= 1e-9) return;
    if (attack) this.attack('player');
    this.accumulator += dt;
    while (this.accumulator + 1e-9 >= STEP && !this.outcome && !this.paused) {
      const nextTime = this.elapsed + STEP;
      if (this.cpuEnabled && (!this.practice || this.practiceStage > 0)) {
        const style = CPU_STYLE[this.cpu.bread], level = DIFFICULTY[this.difficulty];
        const swing = this.player.attack;
        if (swing && swing.id !== this.seenSwing) {
          this.seenSwing = swing.id;
          if (this.elapsed - this.lastSwingEnd < MASH_GAP) this.mashed = swing.id;
        }
        if (swing && swing.id !== this.judged && level.dodge > 0 && swing.age >= level.react) {
          // Decide once per swing after a human-like reaction delay; only swings that would connect are worth dodging.
          this.judged = swing.id;
          const reach = BREADS[this.player.bread].width + BREADS[this.cpu.bread].width;
          const chance = level.dodge + (this.mashed === swing.id ? level.spam : 0);
          if (swing.age < swing.windup && Math.abs(swing.aim - this.cpu.x) < reach && !this.cpu.attack && this.random() < chance) {
            // Step away from the fixed aim, choosing the side that leaves more distance after the table edge clamp.
            const away = (direction: number): number => clamp(this.cpu.x + direction * 1.05, -LIMIT, LIMIT);
            const left = away(-1), right = away(1);
            this.cpuTarget = Math.abs(left - swing.aim) >= Math.abs(right - swing.aim) ? left : right;
            this.nextMove = nextTime + 1.1; this.sidestep = swing.id;
            // Strike as the whiff resolves so the blow lands inside the CPU's counter window.
            if (level.punish) this.nextCpu = Math.min(this.nextCpu, nextTime + swing.windup - swing.age + BREADS[this.player.bread].active);
          }
        }
        if (nextTime >= this.nextMove && !this.cpu.attack) {
          this.cpuTarget = this.practice ? 0 : (this.random() - .5) * style.move * 2;
          this.nextMove = nextTime + (this.practice ? 2.8 : style.observe) + this.random() * 2;
        }
        if (nextTime >= this.nextCpu && !this.cpu.attack && this.cpu.recoil <= 0) {
          this.attack('cpu');
          if (this.practice) this.nextCpu = nextTime + 2.7 + this.random() * 1.1;
          else {
            const pair = !this.secondAttack && this.random() < style.pair;
            const interval = (pair ? style.pairInterval : style.interval + this.random() * style.jitter) * level.pace;
            const bread = BREADS[this.cpu.bread], duration = bread.windup + level.windup + bread.active + bread.recovery + level.recovery;
            this.nextCpu = nextTime + Math.max(interval, duration + level.gap); this.secondAttack = pair;
          }
        }
      }
      const events: SharedEvent[] = [], swingBefore = this.player.attack?.id;
      stepBattle(this.state, { A: { target, attack: false }, B: { target: this.cpuEnabled ? this.cpuTarget : this.cpu.x, attack: false } }, events);
      // Recorded right after the step so a swing that ends and restarts next frame still counts as mashing.
      if (swingBefore !== undefined && this.player.attack?.id !== swingBefore) this.lastSwingEnd = this.elapsed;
      this.append(events); this.accumulator -= STEP;
      if (events.some(event => event.kind === 'hit' || event.kind === 'clash')) {
        const consumed = Math.min(Math.max(0, this.accumulator), HIT_STOP_SECONDS);
        this.hitStop = HIT_STOP_SECONDS - consumed; this.accumulator = Math.max(0, this.accumulator - consumed);
        if (this.hitStop > 0) break;
      }
    }
  }
  setPaused(value: boolean): void { this.paused = value; this.accumulator = 0; }
  drainEvents(): BattleEvent[] { const events = this.events; this.events = []; return events; }
}
