import { describe, expect, it } from 'vitest';
import { emptyScores, type BattleEvent } from './battle';
import { emptyStats, matchScore, nextTip, rankOf, recordCharged, recordStat, type SideStats } from './stats';

const event = (kind: BattleEvent['kind'], side: BattleEvent['side'], extra: Pick<BattleEvent, 'stage' | 'special'> = {}): BattleEvent => ({ id: 1, kind, side, x: 0, z: 0, ...extra });
const side = (s: Partial<SideStats>): SideStats => ({ ...emptyStats().player, ...s });
describe('match statistics and rank', () => {
  it('counts attacks, hits, clashes and counters per side', () => {
    const stats = emptyStats();
    for (const e of [event('attack', 'player'), event('attack', 'cpu'), event('hit', 'player'), event('clash', 'player'), event('counter', 'player'), event('miss', 'cpu'), event('dodge', 'player')]) recordStat(stats, e);
    expect(stats).toEqual({ player: side({ attacks: 1, hits: 2, counters: 1 }), cpu: side({ attacks: 1, hits: 1 }), awaitingSpecialHit: { player: false, cpu: false } });
  });
  it('scores a flawless win as S and a scoreless loss as D', () => {
    const perfect = emptyStats(); perfect.player = side({ attacks: 5, hits: 5, counters: 3 });
    const scores = emptyScores(); scores.dodge = { success: 4, opportunities: 4 };
    expect(matchScore({ outcome: 'win', hpRatio: 1, scores, stats: perfect })).toBe(100);
    expect(matchScore({ outcome: 'lose', hpRatio: 0, scores: { dodge: { success: 0, opportunities: 3 }, counter: { success: 0, opportunities: 0 } }, stats: emptyStats() })).toBe(0);
    expect(rankOf(100)).toBe('S'); expect(rankOf(70)).toBe('A'); expect(rankOf(55)).toBe('B'); expect(rankOf(40)).toBe('C'); expect(rankOf(39)).toBe('D');
  });
  it('requires a counter for S and caps losses at B', () => {
    const noCounter = emptyStats(); noCounter.player = side({ attacks: 1, hits: 1 });
    const scores = emptyScores(); scores.dodge = { success: 5, opportunities: 5 };
    // One hit then pure dodging (the case Codex found scoring S before).
    const score = matchScore({ outcome: 'win', hpRatio: 1, scores, stats: noCounter });
    expect(score).toBe(80); expect(rankOf(score, { outcome: 'win', stats: noCounter })).toBe('A');
    const countered = emptyStats(); countered.player = side({ attacks: 4, hits: 4, counters: 2 });
    expect(rankOf(matchScore({ outcome: 'win', hpRatio: .9, scores, stats: countered }), { outcome: 'win', stats: countered })).toBe('S');
    expect(rankOf(95, { outcome: 'lose', stats: countered })).toBe('B'); expect(rankOf(95, { outcome: 'draw', stats: countered })).toBe('A');
    expect(rankOf(20, { outcome: 'win', stats: countered })).toBe('D');
  });
  it('treats missing dodge chances as neutral and clamps invalid HP', () => {
    const base = { outcome: 'draw' as const, scores: emptyScores(), stats: emptyStats() };
    expect(matchScore({ ...base, hpRatio: .5 })).toBe(Math.round(15 + 10 + 7.5));
    expect(matchScore({ ...base, hpRatio: Number.NaN })).toBe(23);
    expect(matchScore({ ...base, hpRatio: 3 })).toBe(43);
  });
  it('suggests the weakest skill first', () => {
    const stats = emptyStats(), scores = emptyScores();
    expect(nextTip({ outcome: 'lose', hpRatio: 0, scores: { ...scores, dodge: { success: 0, opportunities: 2 } }, stats })).toEqual({ text: expect.stringContaining('横へ'), drill: 1 });
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats })).toEqual({ text: expect.stringContaining('反撃'), drill: 2 });
    stats.player = side({ attacks: 6, hits: 1, counters: 1 });
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats }).text).toContain('隙');
    stats.player = side({ attacks: 3, hits: 3, counters: 1 });
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats })).toEqual({ text: expect.stringContaining('一段上') });
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats }, true).text).toContain('別のパン');
  });
  it('counts each special once however many stages land, without touching normal accuracy', () => {
    const stats = emptyStats();
    // Croissant: three stages of one special, then a second special that whiffs; the CPU's special lands once.
    for (const e of [event('special', 'player'), event('special-hit', 'player', { stage: 0 }), event('special-hit', 'player', { stage: 1 }), event('special-hit', 'player', { stage: 2 }),
      event('special', 'player'), event('miss', 'player', { special: true }), event('special', 'cpu'), event('dodge', 'player', { special: true }), event('special', 'cpu'), event('special-hit', 'cpu', { stage: 0 })]) recordStat(stats, e);
    recordCharged(stats, 'player'); recordCharged(stats, 'player'); recordCharged(stats, 'cpu');
    expect(stats.player).toEqual(side({ specials: 2, specialHits: 1, charged: 2 })); expect(stats.cpu).toEqual(side({ specials: 2, specialHits: 1, charged: 1 }));
    // A stray stage with no open special (or after the first landed) never counts.
    recordStat(stats, event('special-hit', 'player', { stage: 1 })); expect(stats.player.specialHits).toBe(1);
    const scores = emptyScores(), plain = matchScore({ outcome: 'win', hpRatio: 1, scores, stats: emptyStats() });
    expect(matchScore({ outcome: 'win', hpRatio: 1, scores, stats })).toBe(plain);
  });
  it('points to the special drill when the meter was full but unused, or specials never landed', () => {
    const scores = emptyScores(), stats = emptyStats(), tip = (s = scores) => nextTip({ outcome: 'win', hpRatio: 1, scores: s, stats });
    stats.player = side({ attacks: 3, hits: 3, counters: 1, charged: 1 });
    expect(tip()).toEqual({ text: expect.stringContaining('ひっさつ」ボタン'), drill: 3 });
    // Dodging still comes first; an unused meter beats the missing counter.
    expect(tip({ ...scores, dodge: { success: 0, opportunities: 2 } }).drill).toBe(1);
    stats.player.counters = 0; expect(tip().drill).toBe(3);
    stats.player = side({ attacks: 3, hits: 3, counters: 0, charged: 1, specials: 1 }); expect(tip().drill).toBe(2);
    stats.player.counters = 1; expect(tip()).toEqual({ text: expect.stringContaining('振り終わり'), drill: 3 });
    stats.player.specialHits = 1; expect(tip()).toEqual({ text: expect.stringContaining('一段上') });
    stats.player = side({ attacks: 3, hits: 3, counters: 1 }); expect(tip().drill).toBeUndefined();
  });
});
