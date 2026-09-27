import { rate } from './save';
import type { BattleEvent, Outcome, Scores, Side } from './battle';

// specials: used; specialHits: specials that landed at least one stage; charged: times the meter reached full.
export interface SideStats { attacks: number; hits: number; counters: number; specials: number; specialHits: number; charged: number }
// awaitingSpecialHit is internal bookkeeping (not shown): true from a special until its first landed stage.
export type MatchStats = Record<Side, SideStats> & { awaitingSpecialHit: Record<Side, boolean> };
export type Rank = 'S' | 'A' | 'B' | 'C' | 'D';
const side = (): SideStats => ({ attacks: 0, hits: 0, counters: 0, specials: 0, specialHits: 0, charged: 0 });
export const emptyStats = (): MatchStats => ({ player: side(), cpu: side(), awaitingSpecialHit: { player: false, cpu: false } });

// Presentation statistics only; combat rules and saved dodge/counter metrics stay in the battle core.
// Specials never touch attacks/hits, so normal-swing accuracy is not skewed.
export function recordStat(stats: MatchStats, event: BattleEvent): void {
  if (event.kind === 'attack') stats[event.side].attacks++;
  else if (event.kind === 'counter') stats[event.side].counters++;
  else if (event.kind === 'hit') stats[event.side].hits++;
  else if (event.kind === 'clash') { stats.player.hits++; stats.cpu.hits++; }
  else if (event.kind === 'special') { stats[event.side].specials++; stats.awaitingSpecialHit[event.side] = true; }
  // Multi-stage specials count once, on their first landed stage.
  else if (event.kind === 'special-hit' && stats.awaitingSpecialHit[event.side]) { stats[event.side].specialHits++; stats.awaitingSpecialHit[event.side] = false; }
  else if (event.kind === 'miss' && event.special) stats.awaitingSpecialHit[event.side] = false;
}
// Called when a side's special meter reaches full.
export function recordCharged(stats: MatchStats, side: Side): void { stats[side].charged++; }
export interface ScoreInput { outcome: Outcome; hpRatio: number; scores: Scores; stats: MatchStats }
// Weighted toward the core loop: dodging a telegraph and punishing the recovery.
export function matchScore({ outcome, hpRatio, scores, stats }: ScoreInput): number {
  const dodge = rate(scores.dodge), accuracy = stats.player.attacks ? stats.player.hits / stats.player.attacks : 0;
  const hp = Number.isFinite(hpRatio) ? Math.max(0, Math.min(1, hpRatio)) : 0;
  const total = (outcome === 'win' ? 35 : outcome === 'draw' ? 15 : 0) + hp * 20 + (dodge ?? .5) * 15
    + Math.min(1, accuracy) * 10 + Math.min(stats.player.counters, 3) / 3 * 20;
  return Math.round(Math.max(0, Math.min(100, total)));
}
const RANKS: Rank[] = ['S', 'A', 'B', 'C', 'D'];
// S needs a win with at least one counter; a loss tops out at B.
export function rankOf(score: number, gate?: Pick<ScoreInput, 'outcome' | 'stats'>): Rank {
  let rank: Rank = score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D';
  const cap = !gate ? 'S' : gate.outcome === 'lose' ? 'B' : gate.outcome === 'win' && gate.stats.player.counters > 0 ? 'S' : 'A';
  if (RANKS.indexOf(rank) < RANKS.indexOf(cap)) rank = cap;
  return rank;
}
// One concrete thing to try next, chosen from the weakest part of the match.
// drill is the practice stage that trains it (1 = dodge, 2 = counter, 3 = special).
export interface Tip { text: string; drill?: 1 | 2 | 3 }
export function nextTip({ outcome, scores, stats }: ScoreInput, hard = false): Tip {
  const dodge = rate(scores.dodge), accuracy = stats.player.attacks ? stats.player.hits / stats.player.attacks : null;
  if (dodge !== null && dodge < .5) return { text: '赤い輪が出たら、すぐ横へ。避ければ反撃のチャンス', drill: 1 };
  if (stats.player.specials === 0 && stats.player.charged > 0) return { text: 'ゲージが光ったら「ひっさつ」ボタン！ 大ダメージのチャンス', drill: 3 };
  if (stats.player.counters === 0) return { text: '回避成功の直後に振ると「反撃」でダメージ1.25倍', drill: 2 };
  if (stats.player.specials > 0 && stats.player.specialHits === 0) return { text: 'ひっさつは相手が動けない隙（振り終わり）に撃つと当たりやすい', drill: 3 };
  if (accuracy !== null && stats.player.attacks >= 3 && accuracy < .5) return { text: '相手が振り終わった隙を狙うと当たりやすい', drill: 2 };
  if (outcome !== 'win') return { text: '反撃を重ねて、HPを多く残そう', drill: 2 };
  return { text: hard ? '次は別のパンで「つよい」に挑戦しよう' : '次は一段上のCPUに挑戦しよう' };
}
