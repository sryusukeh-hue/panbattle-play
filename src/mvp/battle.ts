import { BREADS, BOSS_ID, LIMIT, STEP, clamp, type FighterId } from './config';
import { createBattle, startAttack, startSpecial, canSpecial, stepBattle, phase, pose as sharedPose, type Slot, type Fighter, type Pose, type BattleEvent as SharedEvent } from '../shared/battle';
import { SPECIALS, METER_MAX, CUTIN_SECONDS, specialDuration, specialSweep } from '../shared/specials';
export { phase, movable, touching, emptyScores, type Attack, type Fighter, type Pose, type Metric, type Scores } from '../shared/battle';

export type Side = 'player' | 'cpu';
export type Outcome = 'win' | 'lose' | 'draw';
export type BattleEvent = Omit<SharedEvent, 'side'> & { side: Side };
const slot = (side: Side): Slot => side === 'player' ? 'A' : 'B';
export const pose = (fighter: Fighter, side: Side): Pose => sharedPose(fighter, slot(side));
export interface BattleView { player: Fighter; cpu: Fighter }
export const HIT_STOP_SECONDS = 12 * STEP;
export const HIT_STOP_COUNTER_SECONDS = 16 * STEP;
export const HIT_STOP_CLASH_SECONDS = 10 * STEP;
export const HIT_STOP_GUARD_SECONDS = 4 * STEP;
export const HIT_STOP_KO_SECONDS = 22 * STEP;
function hitStopForEvents(events: SharedEvent[], state: Battle['state']): number {
  const counters = new Set(events.filter(e => e.kind === 'counter').map(e => e.side));
  return Math.max(0, ...events.map(event => {
    if (!['hit', 'clash', 'special-hit'].includes(event.kind)) return 0;
    if (!state.practice && (state.fighters.A.hp <= 0 || state.fighters.B.hp <= 0)) return HIT_STOP_KO_SECONDS;
    if (event.kind === 'clash') return HIT_STOP_CLASH_SECONDS;
    if (event.kind === 'special-hit') return SPECIALS[state.fighters[event.side].bread].stages[event.stage ?? 0]?.stop ?? 0;
    return event.guard ? HIT_STOP_GUARD_SECONDS : counters.has(event.side) ? HIT_STOP_COUNTER_SECONDS : HIT_STOP_SECONDS;
  }));
}
export const CPU_RECOVER_GAP = .45;
export const CPU_STYLE = {
  shokupan: { interval: 2.9, jitter: .9, pair: .28, pairInterval: 2.7, move: .35, observe: 2.8 },
  francepan: { interval: 3.5, jitter: 1.2, pair: .18, pairInterval: 3.0, move: .25, observe: 3.4 },
  croissant: { interval: 3.0, jitter: 1.3, pair: .45, pairInterval: 2.7, move: .5, observe: 2.1 },
  melonpan: { interval: 3.1, jitter: .8, pair: .20, pairInterval: 2.8, move: .45, observe: 2.5 },
  currypan: { interval: 3.4, jitter: 1.0, pair: .15, pairInterval: 3.0, move: .22, observe: 3.1 },
  creampan: { interval: 3.0, jitter: 1.0, pair: .32, pairInterval: 2.7, move: .48, observe: 2.4 },
  // The boss never pairs swings: one big, readable blow at a time (plans/EXECPLAN-BOSS.md 2).
  ikkin: { interval: 3.10, jitter: .35, pair: 0, pairInterval: 3.10, move: .22, observe: 3.40 },
} as const satisfies Record<FighterId, CpuStyle>;
export interface CpuStyle { interval: number; jitter: number; pair: number; pairInterval: number; move: number; observe: number }
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
} as const satisfies Record<Difficulty, CpuProfile>;
// A CPU difficulty; the challenge course (src/mvp/challenge.ts) and the boss pass their own instead of a named level.
// seize: a full meter may fire on any visible player gap (otherwise it waits for the next planned swing).
export interface CpuProfile { label: string; windup: number; recovery: number; pace: number; dodge: number; spam: number; react: number; punish: boolean; gap: number; damage: number; grace: number;
  specialWait: number; specialWindup: number; specialDodge: number; specialReact: number; seize?: boolean }
// Boss AI by form (plans/EXECPLAN-BOSS.md 2). The second form shortens the rest between blows, never the telegraph.
export const BOSS = {
  hpPhase2: 90, speed: 1.8, limit: 90,
  // First charge: after 4 s or at 70% HP. Later charges: 10 s after the previous special began. Specials start >= 8 s apart.
  firstChargeAt: 4, firstChargeHp: .70, rechargeAfter: 10, specialGap: 8,
  phase1: { label: 'ボス', windup: .40, recovery: .25, pace: 1, dodge: 0, spam: 0, react: .25, punish: false, gap: .45, damage: 1, grace: 0,
    specialWait: 1.0, specialWindup: 0, specialDodge: 0, specialReact: .35, seize: false } as CpuProfile,
  phase2: { label: 'ボス', windup: .40, recovery: .15, pace: 1, dodge: 0, spam: 0, react: .25, punish: false, gap: .35, damage: 1, grace: 0,
    specialWait: .80, specialWindup: 0, specialDodge: 0, specialReact: .35, seize: false } as CpuProfile,
  style2: { interval: 2.75, jitter: .25, pair: 0, pairInterval: 2.75, move: .30, observe: 3.00 } as CpuStyle,
} as const;
// The boss's crust guard (see BattleState.guard): a normal hit outside its recovery deals a quarter. Mashing at it never
// works; dodging its blow and striking back does (plans/EXECPLAN-BOSS.md 2.2).
export const BOSS_GUARD = .25;
// The optional helper offered after two defeats in the challenge: every CPU wind-up (normal and special) is slower.
export const ASSIST_WINDUP = .25;
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
  private effectDt = 0;
  // Real-time freeze while the special cut-in plays; combat time never catches up afterwards.
  private freeze = 0; private fullSince = Infinity; private refillAt = Infinity; private rageUsed = false; private rageFrom = 0; private rageStart = 0;
  cutin: { side: Side | 'both'; left: number } | null = null;
  // Special drill (practice stage 4): first see and dodge the CPU's special, then fire your own.
  specialStep: 'dodge' | 'fire' = 'dodge'; cpuCharging = false;
  private nextCpu = 1.5; private nextMove = 3.2; private cpuTarget = 0;
  private secondAttack = false; private judged = 0; private sidestep = 0; private lastSwingEnd = -Infinity; private seenSwing = 0; private mashed = 0;
  readonly difficulty: Difficulty;
  // Boss form (1, then 2 from BOSS.hpPhase2) and when the second form began (presentation); 0 for other CPUs.
  bossPhase: 0 | 1 | 2 = 0; phaseShiftAt = -1;
  readonly assist: boolean;
  private profile: CpuProfile | undefined; private lastSpecialAt = -Infinity; private chargesUsed = 0;
  constructor(player: FighterId, cpu: FighterId, options: { practice?: boolean; seed?: number; difficulty?: Difficulty; profile?: CpuProfile | undefined; limit?: number | undefined; assist?: boolean } = {}) {
    this.state = createBattle(player, cpu, 'cpu', options.practice ?? false);
    this.difficulty = options.practice ? 'gentle' : options.difficulty ?? 'gentle';
    this.assist = !options.practice && !!options.assist;
    if (cpu === BOSS_ID && !options.practice) {
      this.bossPhase = 1; this.profile = BOSS.phase1;
      Object.assign(this.state, { limit: BOSS.limit, koOnly: true, cpuSpeed: BOSS.speed, guard: BOSS_GUARD });
    } else if (!options.practice) { this.profile = options.profile; if (options.limit) this.state.limit = options.limit; }
    const level = this.level;
    this.state.cpuExtra = { windup: level.windup + (this.assist ? ASSIST_WINDUP : 0), recovery: level.recovery, counters: level.punish, damage: level.damage, grace: level.grace };
    this.state.specials = true; this.state.fighters.A.meter = 0; this.state.fighters.B.meter = 0;
    this.seed = options.seed ?? 42;
  }
  // The CPU's current difficulty: the boss's form, a course profile, or the named level.
  get level(): CpuProfile { return this.profile ?? DIFFICULTY[this.difficulty]; }
  private get style(): CpuStyle { return this.bossPhase === 2 ? BOSS.style2 : CPU_STYLE[this.cpu.bread]; }
  get limit(): number { return this.state.limit ?? 60; }
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
  get hitStopping(): boolean { return this.hitStop > 0; }
  get hitStopRemaining(): number { return this.hitStop; }
  get frameEffectDt(): number { return this.effectDt; }
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
    if (started.includes('cpu')) { this.nextCpu = this.elapsed + specialDuration(this.cpu.bread, cpuExtra ?? 0) + this.level.gap; this.secondAttack = false; this.lastSpecialAt = this.elapsed; }
    this.append(events); return started.length > 0;
  }
  // Whether the CPU would fire its special on the tick ending at nextTime (also used to accept both sides together).
  private cpuSpecialDue(nextTime: number): boolean {
    const level = this.level, full = (this.cpu.meter ?? 0) >= METER_MAX;
    if (!full) this.fullSince = Infinity; else if (!Number.isFinite(this.fullSince)) this.fullSince = nextTime;
    if (!this.cpuEnabled || !full || nextTime - this.fullSince < level.specialWait || !canSpecial(this.state, 'B')) return false;
    if (this.practice) return this.practiceStage === PRACTICE_SPECIAL_STAGE && this.specialStep === 'dodge';
    if (this.bossPhase && nextTime - this.lastSpecialAt < BOSS.specialGap) return false;
    const gap = phase(this.player) === 'recovery' || this.player.recoil > 0;
    return nextTime >= this.nextCpu || ((level.seize ?? this.difficulty !== 'gentle') && gap);
  }
  canSpecial(side: Side): boolean { return !this.paused && !this.outcome && this.hitStop <= 0 && this.freeze <= 0 && this.allowed(side); }
  // In the special drill the player may only fire in the "fire" step, after seeing and dodging the CPU's special.
  private allowed(side: Side): boolean { return canSpecial(this.state, slot(side)) && !(side === 'player' && this.practice && this.practiceStage === PRACTICE_SPECIAL_STAGE && this.specialStep === 'dodge'); }
  advance(dt: number, target: number, attack = false, special = false): void {
    this.effectDt = 0;
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
    // Inputs received during a stop are dropped even if it ends within this frame.
    if (this.hitStopping) attack = special = false;
    const stopped = Math.min(dt, this.hitStop); this.hitStop = Math.max(0, this.hitStop - stopped); dt -= stopped;
    if (this.hitStop < 1e-9) this.hitStop = 0;
    if (dt <= 1e-9) return;
    this.effectDt = dt;
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
        if (this.bossPhase === 1 && this.cpu.hp <= BOSS.hpPhase2 && this.cpu.hp > 0) {
          // Second form from the next action on: the running swing keeps its timings (startAttack read them already).
          this.bossPhase = 2; this.phaseShiftAt = this.elapsed; this.profile = BOSS.phase2;
          this.state.cpuExtra = { ...this.state.cpuExtra!, recovery: BOSS.phase2.recovery };
        }
        // The once-per-match CPU charge (see CPU_RAGE); the boss charges on its own schedule instead.
        const hpMax = BREADS[this.cpu.bread].hp, meter = this.cpu.meter ?? 0;
        const due = this.bossPhase
          ? this.cpu.hp > 0 && meter < METER_MAX && !this.cpu.attack?.special && (this.chargesUsed === 0
            ? this.elapsed >= BOSS.firstChargeAt || this.cpu.hp <= hpMax * BOSS.firstChargeHp
            : this.elapsed - this.lastSpecialAt >= BOSS.rechargeAfter)
          : !this.rageUsed && this.cpu.hp <= hpMax * CPU_RAGE.hp && this.cpu.hp > 0 && meter < METER_MAX;
        if (due && !this.cpuCharging) {
          // Fills whatever is missing over the full charge time, so it always reads as a 1.5 s build-up.
          this.cpuCharging = true; this.rageUsed = true; this.chargesUsed++; this.rageFrom = meter; this.rageStart = this.elapsed;
        }
        if (this.cpuCharging) {
          // Follows the planned 1.5 s ramp; gains earned meanwhile may run ahead of it but cannot finish the charge early.
          const done = (nextTime - this.rageStart) / CPU_RAGE.seconds, planned = this.rageFrom + (METER_MAX - this.rageFrom) * Math.min(1, done);
          this.cpu.meter = done >= 1 ? METER_MAX : Math.min(METER_MAX - 1, Math.max(this.cpu.meter ?? 0, planned));
          if (this.cpu.meter >= METER_MAX) this.cpuCharging = false;
        }
      }
      if (this.cpuEnabled && (!this.practice || (this.practiceStage > 0 && this.practiceStage !== PRACTICE_SPECIAL_STAGE))) {
        const style = this.style, level = this.level;
        const swing = this.player.attack;
        if (swing && swing.id !== this.seenSwing) {
          this.seenSwing = swing.id;
          if (this.elapsed - this.lastSwingEnd < MASH_GAP) this.mashed = swing.id;
        }
        const special = !!swing?.special;
        if (swing && swing.id !== this.judged && (special ? level.specialDodge > 0 && swing.age >= level.specialReact : level.dodge > 0 && swing.age >= level.react)) {
          // Decide once per swing after a human-like reaction delay; only swings that would connect are worth dodging.
          this.judged = swing.id;
          const reach = (special ? SPECIALS[this.player.bread].rx + specialSweep(this.player.bread) : BREADS[this.player.bread].width) + BREADS[this.cpu.bread].width;
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
        // Having chosen to sidestep a special, the CPU stays out until its last hit window has closed: it neither
        // wanders back nor starts a swing into a roller that is still there or a second beat that is still coming.
        const holding = special && this.sidestep === swing!.id && (phase(this.player) === 'windup' || phase(this.player) === 'active');
        if (nextTime >= this.nextMove && !this.cpu.attack && !holding) {
          this.cpuTarget = this.practice ? 0 : (this.random() - .5) * style.move * 2;
          this.nextMove = nextTime + (this.practice ? 2.8 : style.observe) + this.random() * 2;
        }
        // A full meter waits a moment, then replaces the next attack (or, above gentle, jumps on a visible gap).
        if (!this.practice && this.cpuSpecialDue(nextTime) && !holding && this.specials([], this.cpuExtra())) break;
        if (nextTime >= this.nextCpu && !this.cpu.attack && this.cpu.recoil <= 0 && !holding) {
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
      const stop = hitStopForEvents(events, this.state);
      if (stop > 0) {
        // Always draw the contact once before consuming the stop.
        this.hitStop = stop; this.accumulator = 0; this.effectDt = 0; break;
      }
    }
  }
  setPaused(value: boolean): void { this.paused = value; this.accumulator = 0; }
  private cpuExtra(): number { return (this.practice ? DIFFICULTY.gentle.specialWindup : this.level.specialWindup) + (this.assist ? ASSIST_WINDUP : 0); }
  // Practice stage 4: the CPU (in the middle) fires its special for the player to dodge, then the player's meter fills.
  enterSpecialPractice(): void {
    this.practiceStage = PRACTICE_SPECIAL_STAGE; this.specialStep = 'dodge'; this.player.meter = 0; this.cpu.meter = METER_MAX;
    this.fullSince = Infinity; this.refillAt = Infinity; this.cpuTarget = 0;
  }
  specialFire(): void { this.specialStep = 'fire'; this.player.meter = METER_MAX; this.refillAt = Infinity; this.cpuTarget = 0; }
  drainEvents(): BattleEvent[] { const events = this.events; this.events = []; return events; }
}
