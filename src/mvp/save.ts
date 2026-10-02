import { BREAD_IDS, type BreadId, type FighterId, type Mode } from './config';
import { SPECIAL_RULE } from '../shared/rules';
import { DIFFICULTIES, type Battle, type Difficulty, type Metric, type Scores } from './battle';
export const SAVE_KEY = 'panbattle.3d.v1';
export interface Saved { version: 1; sound: boolean; sensitivity: number; attackSensitivity: number; tiltSensitivity: number; bread: BreadId; cpu: BreadId; practiced: boolean; best: Record<string, Partial<Scores>>;
  // Optional fields added without a version bump; absent means the pre-existing behaviour.
  difficulty?: Difficulty; music?: boolean; practicedSpecial?: boolean;
  // Versioned: the score formula changed on 2026-09-27, so earlier numbers are not comparable.
  bestScoreV2?: Record<string, number> }
export const defaults = (): Saved => ({ version: 1, sound: false, sensitivity: 1, attackSensitivity: 1, tiltSensitivity: 1, bread: 'shokupan', cpu: 'shokupan', practiced: false, best: {} });
export const condition = (player: BreadId, cpu: BreadId, mode: Mode, difficulty: Difficulty = 'gentle'): string => `${SPECIAL_RULE}/${player}/${cpu}/${difficulty}/${mode}`;
// Pre-special table-1 records stay readable and untouched; new matches compare only under SPECIAL_RULE.
const BREAD = `(${BREAD_IDS.join('|')})`;
const KEY = new RegExp(`^table-(?:special-)?1/${BREAD}/${BREAD}/(gentle|normal|hard)/(sensor|touch|keyboard)$`);
export const playable = (id: FighterId): id is BreadId => BREAD_IDS.includes(id as BreadId);
export const rate = (m: Metric | undefined): number | null => m && m.opportunities > 0 ? m.success / m.opportunities : null;
function validMetric(m: unknown): m is Metric {
  if (!m || typeof m !== 'object') return false;
  const v = m as Metric;
  return Number.isSafeInteger(v.success) && Number.isSafeInteger(v.opportunities) && v.success >= 0 && v.opportunities > 0 && v.success <= v.opportunities;
}
export class SaveStore {
  data = defaults(); warning = '';
  constructor(private storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {
    try {
      const raw = this.storage().getItem(SAVE_KEY);
      if (raw === null) return;
      const value = JSON.parse(raw) as Saved;
      if (!value || value.version !== 1 || typeof value.sound !== 'boolean' || typeof value.practiced !== 'boolean' || !BREAD_IDS.includes(value.bread) || !BREAD_IDS.includes(value.cpu) || !Number.isFinite(value.sensitivity) || value.sensitivity < .6 || value.sensitivity > 1.6 || !value.best || typeof value.best !== 'object' || Array.isArray(value.best)) throw new Error('invalid');
      for (const [key, scores] of Object.entries(value.best)) {
        if (!KEY.test(key) || !scores || typeof scores !== 'object' || (scores.dodge !== undefined && !validMetric(scores.dodge)) || (scores.counter !== undefined && !validMetric(scores.counter))) throw new Error('invalid');
      }
      if (value.difficulty !== undefined && !DIFFICULTIES.includes(value.difficulty)) throw new Error('invalid');
      if (value.music !== undefined && typeof value.music !== 'boolean') throw new Error('invalid');
      if (value.practicedSpecial !== undefined && typeof value.practicedSpecial !== 'boolean') throw new Error('invalid');
      if (value.bestScoreV2 !== undefined) {
        if (!value.bestScoreV2 || typeof value.bestScoreV2 !== 'object' || Array.isArray(value.bestScoreV2)) throw new Error('invalid');
        for (const [key, score] of Object.entries(value.bestScoreV2)) if (!KEY.test(key) || !Number.isInteger(score) || score < 0 || score > 100) throw new Error('invalid');
      }
      const sensitivities = { attackSensitivity: value.attackSensitivity === undefined ? value.sensitivity : value.attackSensitivity,
        tiltSensitivity: value.tiltSensitivity === undefined ? value.sensitivity : value.tiltSensitivity };
      if (Object.values(sensitivities).some(v => !Number.isFinite(v) || v < .6 || v > 1.6)) throw new Error('invalid');
      this.data = { ...value, ...sensitivities };
    } catch { this.warning = '保存データを読み込めません。この回は端末に保存せず遊べます。元のデータは保持しています。'; }
  }
  persist(): boolean {
    // Preserve unreadable data rather than silently replacing it.
    if (this.warning.startsWith('保存データを読み込めません')) return false;
    try { this.storage().setItem(SAVE_KEY, JSON.stringify(this.data)); this.warning = ''; return true; }
    catch { this.warning = '端末に保存できませんでした。今回の設定と成績は、この画面を閉じるまで保持します。'; return false; }
  }
  // Free-battle records only: the boss never appears in these keys (an unknown bread would make the whole save invalid).
  record(battle: Battle, mode: Mode): Partial<Scores> {
    const player = battle.player.bread, cpu = battle.cpu.bread;
    if (!playable(player) || !playable(cpu)) return {};
    const key = condition(player, cpu, mode, battle.difficulty);
    const previous = structuredClone(this.data.best[key] ?? {});
    if (battle.practice || battle.outcome === null) return previous;
    const next = structuredClone(previous);
    for (const field of ['dodge', 'counter'] as const) {
      const score = battle.scores[field], value = rate(score), best = rate(next[field]);
      if (value !== null && (best === null || value > best)) next[field] = { ...score };
    }
    this.data.best[key] = next; this.persist(); return previous;
  }
  // Returns the previous best score for the same condition (null when none), then keeps the higher one.
  recordScore(battle: Battle, mode: Mode, score: number): number | null {
    const player = battle.player.bread, cpu = battle.cpu.bread;
    if (!playable(player) || !playable(cpu)) return null;
    const key = condition(player, cpu, mode, battle.difficulty), previous = this.data.bestScoreV2?.[key] ?? null;
    if (battle.practice || battle.outcome === null || !Number.isInteger(score) || score < 0 || score > 100) return previous;
    if (previous === null || score > previous) { this.data.bestScoreV2 = { ...this.data.bestScoreV2, [key]: score }; this.persist(); }
    return previous;
  }
}
