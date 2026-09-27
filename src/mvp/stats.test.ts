import { describe, expect, it } from 'vitest';
import { emptyScores, type BattleEvent } from './battle';
import { emptyStats, matchScore, nextTip, rankOf, recordStat } from './stats';

const event = (kind: BattleEvent['kind'], side: BattleEvent['side']): BattleEvent => ({ id: 1, kind, side, x: 0, z: 0 });
describe('match statistics and rank', () => {
  it('counts attacks, hits, clashes and counters per side', () => {
    const stats = emptyStats();
    for (const e of [event('attack', 'player'), event('attack', 'cpu'), event('hit', 'player'), event('clash', 'player'), event('counter', 'player'), event('miss', 'cpu'), event('dodge', 'player')]) recordStat(stats, e);
    expect(stats).toEqual({ player: { attacks: 1, hits: 2, counters: 1 }, cpu: { attacks: 1, hits: 1, counters: 0 } });
  });
  it('scores a flawless win as S and a scoreless loss as D', () => {
    const perfect = emptyStats(); perfect.player = { attacks: 5, hits: 5, counters: 3 };
    const scores = emptyScores(); scores.dodge = { success: 4, opportunities: 4 };
    expect(matchScore({ outcome: 'win', hpRatio: 1, scores, stats: perfect })).toBe(100);
    expect(matchScore({ outcome: 'lose', hpRatio: 0, scores: { dodge: { success: 0, opportunities: 3 }, counter: { success: 0, opportunities: 0 } }, stats: emptyStats() })).toBe(0);
    expect(rankOf(100)).toBe('S'); expect(rankOf(70)).toBe('A'); expect(rankOf(55)).toBe('B'); expect(rankOf(40)).toBe('C'); expect(rankOf(39)).toBe('D');
  });
  it('requires a counter for S and caps losses at B', () => {
    const noCounter = emptyStats(); noCounter.player = { attacks: 1, hits: 1, counters: 0 };
    const scores = emptyScores(); scores.dodge = { success: 5, opportunities: 5 };
    // One hit then pure dodging (the case Codex found scoring S before).
    const score = matchScore({ outcome: 'win', hpRatio: 1, scores, stats: noCounter });
    expect(score).toBe(80); expect(rankOf(score, { outcome: 'win', stats: noCounter })).toBe('A');
    const countered = emptyStats(); countered.player = { attacks: 4, hits: 4, counters: 2 };
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
    stats.player = { attacks: 6, hits: 1, counters: 1 };
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats }).text).toContain('隙');
    stats.player = { attacks: 3, hits: 3, counters: 1 };
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats })).toEqual({ text: expect.stringContaining('一段上') });
    expect(nextTip({ outcome: 'win', hpRatio: 1, scores, stats }, true).text).toContain('別のパン');
  });
});
