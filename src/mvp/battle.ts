import { BREADS, LIMIT, STEP, clamp, type BreadId } from './config';
import { createBattle, startAttack, startSpecial, canSpecial, stepBattle, phase, pose as sharedPose, type Slot, type Fighter, type Pose, type BattleEvent as SharedEvent } from '../shared/battle';
import { SPECIALS, METER_MAX, CUTIN_SECONDS, specialDuration } from '../shared/specials';
export { phase, movable, touching, emptyScores, type Attack, type Fighter, type Pose, type Metric, type Scores } from '../shared/battle';

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
// Specials: wait after a full meter before using it, extra wind-up for the CPU's special, and the chance/reaction
// for sidestepping the player's special (decided once, from what is visible on screen).
export const DIFFICULTY = {
  gentle: { label: 'やさしい', windup: .65, recovery: .55, pace: 1, dodge: 0, spam: 0, react: 0, punish: false, gap: .45, damage: 1, grace: 0,
    specialWait: 1.2, specialWindup: .35, specialDodge: 0, specialReact: 0 },
  normal: { label: 'ふつう', windup: .36, recovery: .3, pace: .5, dodge: .2, spam: .4, react: .12, punish: false, gap: .3, damage: 1.2, grace: 0,
    specialWait: .75, specialWindup: .2, specialDodge: .2, specialReact: .25 },
  hard: { label: 'つよい', windup: .2, recovery: .15, pace: .3, dodge: .3, spam: .6, react: .07, punish: true, gap: .15, damage: 1.4, grace: .3,
    specialWait: .45, specialWindup: .1, specialDodge: .35, specialReact: .2 },
} as const satisfies Record<Difficulty, { label: string; windup: number; recovery: number; pace: number; dodge: number; spam: number; react: number; punish: boolean; gap: number; damage: number; grace: number;
  specialWait: number; specialWindup: number; specialDodge: number; specialReact: number }>;
export const PRACTICE_SPECIAL_STAGE = 3;
// CPU-only rule (plans/EXECPLAN-SPECIAL.md 4): once per match, at 60% HP or less, the CPU visibly charges its meter over 1.5 s
// so players also get to see, dodge and punish a CPU special. The player's meter rules are unchanged.
export const CPU_RAGE = { hp: .6, seconds: 1.5 } as const;
export const MASH_GAP = .6;

// CPU/practice policy and browser frame accumulation. The shared core owns the rules.
export class Battle {
  readonly state;
  paused = false; cpuEnabled = true; practiceStage = 0;
  events: BattleEvent[] = [];
  private accumulator = 0; private seed: number;
  private hitStop = 0;
  // Real-time freeze while the special cut-in plays; combat time never catches up afterwards.
  private freeze = 0; private fullSince = Infinity; private refillAt = Infinity; private rageUsed = false; private rageFrom = 0; private rageStart = 0;
  cutin: { side: Side | 'both'; left: number } | null = null;
  // Special drill (practice stage 4): first see and dodge the CPU's special, then fire your own.
  specialStep: 'dodge' | 'fire' = 'dodge'; cpuCharging = false;
  private nextCpu = 1.5; private nextMove = 3.2; private cpuTarget = 0;
  private secondAttack = false; private judged = 0; private sidestep = 0; private lastSwingEnd = -Infinity; private seenSwing = 0; private mashed = 0;
  readonly difficulty: Difficulty;
  constructor(player: BreadId, cpu: BreadId, options: { practice?: boolean; seed?: number; difficulty?: Difficulty } = {}) {
    this.state = createBattle(player, cpu, 'cpu', options.practice ?? false);
    this.difficulty = options.practice ? 'gentle' : options.difficulty ?? 'gentle';
    const level = DIFFICULTY[this.difficulty];
    this.state.cpuExtra = { windup: level.windup, recovery: level.recovery, counters: level.punish, damage: level.damage, grace: level.grace };
    this.state.specials = true; this.state.fighters.A.meter = 0; this.state.fighters.B.meter = 0;
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
      if (event.kind === 'miss' && !event.special && event.side === 'A' && this.sidestep && this.player.attack?.id === this.sidestep && !this.state.cpuExtra?.counters)
        this.events.push({ ...event, id: event.id + .5, kind: 'dodge', side: 'cpu', x: this.cpu.x, z: -1.2 });
    }
  }
  get freezing(): boolean { return this.freeze > 0; }
  attack(side: Side): boolean {
    if (this.paused || this.hitStop > 0 || this.freeze > 0) return false;
    const events: SharedEvent[] = [], accepted = startAttack(this.state, slot(side), events);
    this.append(events); return accepted;
  }
  // Spends the full meter; the combat freezes for one cut-in before the move's first tick. extra stretches the CPU wind-up.
  special(side: Side, extra = 0): boolean { return this.specials(side === 'player' ? [side] : [], side === 'cpu' ? extra : null); }
  private specials(players: Side[], cpuExtra: number | null): boolean {
    if (this.paused || this.hitStop > 0 || this.freeze > 0) return false;
    const events: SharedEvent[] = [], started: Side[] = [];
    if (players.length && this.allowed('player') && startSpecial(this.state, 'A', events)) started.push('player');
    if (cpuExtra !== null && startSpecial(this.state, 'B', events, cpuExtra)) started.push('cpu');
    if (started.length) { this.freeze = CUTIN_SECONDS; this.accumulator = 0; this.cutin = { side: started.length > 1 ? 'both' : started[0]!, left: CUTIN_SECONDS }; }
    if (started.includes('cpu')) { this.nextCpu = this.elapsed + specialDuration(this.cpu.bread, cpuExtra ?? 0) + DIFFICULTY[this.difficulty].gap; this.secondAttack = false; }
    this.append(events); return started.length > 0;
  }
  // Whether the CPU would fire its special on the tick ending at nextTime (also used to accept both sides together).
  private cpuSpecialDue(nextTime: number): boolean {
    const level = DIFFICULTY[this.difficulty], full = (this.cpu.meter ?? 0) >= METER_MAX;
    if (!full) this.fullSince = Infinity; else if (!Number.isFinite(this.fullSince)) this.fullSince = nextTime;
    if (!this.cpuEnabled || !full || nextTime - this.fullSince < level.specialWait || !canSpecial(this.state, 'B')) return false;
    if (this.practice) return this.practiceStage === PRACTICE_SPECIAL_STAGE && this.specialStep === 'dodge';
    const gap = phase(this.player) === 'recovery' || this.player.recoil > 0;
    return nextTime >= this.nextCpu || (this.difficulty !== 'gentle' && gap);
  }
  canSpecial(side: Side): boolean { return !this.paused && !this.outcome && this.freeze <= 0 && this.allowed(side); }
  // In the special drill the player may only fire in the "fire" step, after seeing and dodging the CPU's special.
  private allowed(side: Side): boolean { return canSpecial(this.state, slot(side)) && !(side === 'player' && this.practice && this.practiceStage === PRACTICE_SPECIAL_STAGE && this.specialStep === 'dodge'); }
  advance(dt: number, target: number, attack = false, special = false): void {
    if (this.paused || this.outcome || !Number.isFinite(dt) || dt <= 0) return;
    if (dt > .25) { this.setPaused(true); return; }
    if (this.freeze > 0) {
      // Inputs during the cut-in are dropped rather than queued.
      const used = Math.min(dt, this.freeze); this.freeze -= used; dt -= used;
      if (this.cutin) this.cutin.left = this.freeze;
      if (this.freeze > 1e-9) return;
      this.freeze = 0; this.cutin = null; attack = special = false;
      if (dt <= 1e-9) return;
    }
    const stopped = Math.min(dt, this.hitStop); this.hitStop = Math.max(0, this.hitStop - stopped); dt -= stopped;
    if (dt <= 1e-9) return;
    // A valid special wins over a normal swing pressed in the same frame; a CPU special due on the same tick joins it.
    if (special && this.allowed('player')) {
      const cpu = this.cpuSpecialDue(this.elapsed + STEP);
      if (this.specials(['player'], cpu ? this.cpuExtra() : null)) return;
    }
    if (attack) this.attack('player');
    this.accumulator += dt;
    while (this.accumulator + 1e-9 >= STEP && !this.outcome && !this.paused && this.freeze <= 0) {
      const nextTime = this.elapsed + STEP;
      if (this.practice && this.practiceStage === PRACTICE_SPECIAL_STAGE) {
        // Practice refills the drilled side's meter one second after its special (or anything else) finishes.
        const who = this.specialStep === 'fire' ? this.player : this.cpu;
        if (who.attack || (who.meter ?? 0) >= METER_MAX) this.refillAt = Infinity;
        else if (!Number.isFinite(this.refillAt)) this.refillAt = nextTime + 1;
        else if (nextTime >= this.refillAt) { who.meter = METER_MAX; this.refillAt = Infinity; }
        if (this.cpuSpecialDue(nextTime) && this.specials([], this.cpuExtra())) break;
      }
      if (this.cpuEnabled && !this.practice) {
        // The once-per-match CPU charge (see CPU_RAGE).
        const low = this.cpu.hp <= BREADS[this.cpu.bread].hp * CPU_RAGE.hp && this.cpu.hp > 0;
        if (!this.rageUsed && low && (this.cpu.meter ?? 0) < METER_MAX) {
          // Fills whatever is missing over the full charge time, so it always reads as a 1.5 s build-up.
          this.cpuCharging = true; this.rageUsed = true; this.rageFrom = this.cpu.meter ?? 0; this.rageStart = this.elapsed;
        }
        if (this.cpuCharging) {
          // Follows the planned 1.5 s ramp; gains earned meanwhile may run ahead of it but cannot finish the charge early.
          const done = (nextTime - this.rageStart) / CPU_RAGE.seconds, planned = this.rageFrom + (METER_MAX - this.rageFrom) * Math.min(1, done);
          this.cpu.meter = done >= 1 ? METER_MAX : Math.min(METER_MAX - 1, Math.max(this.cpu.meter ?? 0, planned));
          if (this.cpu.meter >= METER_MAX) this.cpuCharging = false;
        }
      }
      if (this.cpuEnabled && (!this.practice || (this.practiceStage > 0 && this.practiceStage !== PRACTICE_SPECIAL_STAGE))) {
        const style = CPU_STYLE[this.cpu.bread], level = DIFFICULTY[this.difficulty];
        const swing = this.player.attack;
        if (swing && swing.id !== this.seenSwing) {
          this.seenSwing = swing.id;
          if (this.elapsed - this.lastSwingEnd < MASH_GAP) this.mashed = swing.id;
        }
        const special = !!swing?.special;
        if (swing && swing.id !== this.judged && (special ? level.specialDodge > 0 && swing.age >= level.specialReact : level.dodge > 0 && swing.age >= level.react)) {
          // Decide once per swing after a human-like reaction delay; only swings that would connect are worth dodging.
          this.judged = swing.id;
          const reach = (special ? SPECIALS[this.player.bread].rx : BREADS[this.player.bread].width) + BREADS[this.cpu.bread].width;
          const chance = special ? level.specialDodge : level.dodge + (this.mashed === swing.id ? level.spam : 0);
          if (swing.age < swing.windup && Math.abs(swing.aim - this.cpu.x) < reach && !this.cpu.attack && this.random() < chance) {
            // Step away from the fixed aim, choosing the side that leaves more distance after the table edge clamp.
            const away = (direction: number): number => clamp(this.cpu.x + direction * 1.05, -LIMIT, LIMIT);
            const left = away(-1), right = away(1);
            this.cpuTarget = Math.abs(left - swing.aim) >= Math.abs(right - swing.aim) ? left : right;
            this.nextMove = nextTime + 1.1; this.sidestep = swing.id;
            // Strike as the whiff resolves so the blow lands inside the CPU's counter window.
            if (level.punish) this.nextCpu = Math.min(this.nextCpu, nextTime + swing.windup - swing.age + (special ? SPECIALS[this.player.bread].active : BREADS[this.player.bread].active));
          }
        }
        if (nextTime >= this.nextMove && !this.cpu.attack) {
          this.cpuTarget = this.practice ? 0 : (this.random() - .5) * style.move * 2;
          this.nextMove = nextTime + (this.practice ? 2.8 : style.observe) + this.random() * 2;
        }
        // A full meter waits a moment, then replaces the next attack (or, above gentle, jumps on a visible gap).
        if (!this.practice && this.cpuSpecialDue(nextTime) && this.specials([], this.cpuExtra())) break;
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
      // Combat gains during the CPU charge must not complete it early either.
      if (this.cpuCharging) this.cpu.meter = Math.min(METER_MAX - 1, this.cpu.meter ?? 0);
      // Recorded right after the step so a swing that ends and restarts next frame still counts as mashing.
      if (swingBefore !== undefined && this.player.attack?.id !== swingBefore) this.lastSwingEnd = this.elapsed;
      this.append(events); this.accumulator -= STEP;
      const stop = Math.max(0, ...events.map(event => event.kind === 'hit' || event.kind === 'clash' ? HIT_STOP_SECONDS
        : event.kind === 'special-hit' ? SPECIALS[this.state.fighters[event.side].bread].stages[event.stage ?? 0]?.stop ?? 0 : 0));
      if (stop > 0) {
        const consumed = Math.min(Math.max(0, this.accumulator), stop);
        this.hitStop = stop - consumed; this.accumulator = Math.max(0, this.accumulator - consumed);
        if (this.hitStop > 0) break;
      }
    }
  }
  setPaused(value: boolean): void { this.paused = value; this.accumulator = 0; }
  private cpuExtra(): number { return this.practice ? DIFFICULTY.gentle.specialWindup : DIFFICULTY[this.difficulty].specialWindup; }
  // Practice stage 4: the CPU (in the middle) fires its special for the player to dodge, then the player's meter fills.
  enterSpecialPractice(): void {
    this.practiceStage = PRACTICE_SPECIAL_STAGE; this.specialStep = 'dodge'; this.player.meter = 0; this.cpu.meter = METER_MAX;
    this.fullSince = Infinity; this.refillAt = Infinity; this.cpuTarget = 0;
  }
  specialFire(): void { this.specialStep = 'fire'; this.player.meter = METER_MAX; this.refillAt = Infinity; this.cpuTarget = 0; }
  drainEvents(): BattleEvent[] { const events = this.events; this.events = []; return events; }
}
