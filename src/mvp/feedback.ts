import { phase, type BattleEvent, type BattleView, type Side } from './battle';

export const VISUAL_LIMITS = { deformation: .03, squash: .018, shake: .012, zoom: .09, crumbs: 48, crumbSeconds: 3.5 } as const;
export const DAMAGE_DENT = .012;
export function damageStage(hp: number, maximum = 100): number {
  if (!Number.isFinite(hp) || !Number.isFinite(maximum) || maximum <= 0) return 0;
  const ratio = hp / maximum; return ratio <= .25 ? 3 : ratio <= .5 ? 2 : ratio <= .75 ? 1 : 0;
}
export function deformVertex(x: number, y: number, z: number, bend: number, direction: readonly number[], impact: number, output: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const projection = x * direction[0]! + y * direction[1]! + z * direction[2]!;
  const squeeze = Math.max(-VISUAL_LIMITS.squash, Math.min(VISUAL_LIMITS.squash, projection * .08)) * impact;
  const dx = -direction[0]! * squeeze, dy = -direction[1]! * squeeze, dz = bend - direction[2]! * squeeze;
  const scale = Math.min(1, VISUAL_LIMITS.deformation / (Math.hypot(dx, dy, dz) || 1));
  output[0] = x + dx * scale; output[1] = y + dy * scale; output[2] = z + dz * scale; return output;
}

export type BattleSound = 'telegraph' | 'swing' | 'hit' | 'clash' | 'dodge' | 'counter' | 'danger' | 'heartbeat';
const priority: Record<BattleSound, number> = { heartbeat: -1, danger: 0, telegraph: 1, swing: 2, dodge: 3, hit: 4, clash: 5, counter: 6 };

export class ReplayBuffer<T> {
  private frames: ({ time: number; value: T } | undefined)[] = Array(240);
  private head = 0; private count = 0; private clock = 0; private cursor = 0; private short = false; private window = Infinity;
  record(dt: number, value: T): void {
    this.clock += Math.max(0, dt);
    this.frames[this.head] = { time: this.clock, value }; this.head = (this.head + 1) % this.frames.length; this.count = Math.min(this.count + 1, this.frames.length);
    while (this.count > 1 && this.first()!.time < this.clock - 2) this.count--;
  }
  private first() { return this.frames[(this.head - this.count + this.frames.length) % this.frames.length]; }
  // window limits playback to the last N recorded seconds (the decisive moment).
  start(short = false, window = Infinity): boolean { this.cursor = 0; this.short = short; this.window = window; return this.count > 0; }
  next(dt: number, reduced = this.short): { value: T; done: boolean } | null {
    if (!this.count) return null;
    this.cursor += Math.max(0, dt); this.short ||= reduced;
    const start = Math.max(this.first()!.time, this.clock - this.window), duration = this.short ? .35 : (this.clock - start) * 2 + .2;
    const at = this.short ? this.clock : Math.min(this.clock, start + this.cursor * .5);
    let frame = this.first()!;
    for (let i = 1; i < this.count; i++) {
      const next = this.frames[(this.head - this.count + i + this.frames.length) % this.frames.length]!;
      if (next.time > at) break; frame = next;
    }
    return { value: frame.value, done: this.cursor >= duration };
  }
  reset(): void { this.frames.fill(undefined); this.head = this.count = this.clock = this.cursor = 0; this.short = false; this.window = Infinity; }
}

// Presentation only: never changes combat time, poses, HP or network messages.
export class BattleFeedback {
  private seen = new Set<number>();
  private windups = new Set<string>();
  private swings = new Set<string>();
  private pending: BattleEvent[] = [];
  private danger = false;
  private lastSecond = 11;
  enqueue(event: BattleEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id); this.pending.push(event);
  }
  update(view: BattleView, active: boolean, remaining?: number): { events: BattleEvent[]; sound: BattleSound | null; alert: boolean } {
    if (!active) { this.pending = []; return { events: [], sound: null, alert: false }; }
    const events = this.pending; this.pending = [];
    const sounds: BattleSound[] = [];
    const second = remaining === undefined ? 11 : Math.ceil(remaining);
    if (second > 0 && second < this.lastSecond && second <= 10) { sounds.push('heartbeat'); this.lastSecond = second; }
    for (const event of events) {
      if (['hit', 'clash', 'dodge', 'counter'].includes(event.kind)) sounds.push(event.kind as BattleSound);
    }
    for (const side of ['player', 'cpu'] as Side[]) {
      const fighter = view[side], attack = fighter.attack;
      if (!attack) continue;
      const key = `${side}/${attack.id}`, current = phase(fighter);
      if (!this.windups.has(key)) {
        this.windups.add(key);
        if (side === 'cpu' && current === 'windup') sounds.push('telegraph');
      }
      if (current === 'active' && !this.swings.has(key)) { this.swings.add(key); sounds.push('swing'); }
    }
    const danger = view.player.hp > 0 && view.player.hp <= 25;
    const enteredDanger = danger && !this.danger;
    if (enteredDanger) sounds.push('danger');
    this.danger = danger;
    const sound = sounds.sort((a, b) => priority[b] - priority[a])[0] ?? null;
    return { events, sound, alert: enteredDanger && sound !== 'danger' };
  }
  reset(newMatch = false): void {
    this.pending = [];
    // Preserve consumed IDs across pause/reconnect; a new match restarts serials.
    if (newMatch) { this.seen.clear(); this.windups.clear(); this.swings.clear(); this.danger = false; this.lastSecond = 11; }
  }
}
