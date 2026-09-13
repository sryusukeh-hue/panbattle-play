import { phase, type BattleEvent, type BattleView, type Side } from './battle';

export type BattleSound = 'telegraph' | 'swing' | 'hit' | 'clash' | 'dodge' | 'counter' | 'danger';
const priority: Record<BattleSound, number> = { danger: 0, telegraph: 1, swing: 2, dodge: 3, hit: 4, clash: 5, counter: 6 };

// Presentation only: never changes combat time, poses, HP or network messages.
export class BattleFeedback {
  private seen = new Set<number>();
  private windups = new Set<string>();
  private swings = new Set<string>();
  private pending: BattleEvent[] = [];
  private danger = false;
  enqueue(event: BattleEvent): void {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id); this.pending.push(event);
  }
  update(view: BattleView, active: boolean): { events: BattleEvent[]; sound: BattleSound | null; alert: boolean } {
    if (!active) { this.pending = []; return { events: [], sound: null, alert: false }; }
    const events = this.pending; this.pending = [];
    const sounds: BattleSound[] = [];
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
    if (newMatch) { this.seen.clear(); this.windups.clear(); this.swings.clear(); this.danger = false; }
  }
}
