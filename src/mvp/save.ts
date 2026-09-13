import { BREAD_IDS, RULE, type BreadId, type Mode } from './config';
import { type Battle, type Metric, type Scores } from './battle';
export const SAVE_KEY = 'panbattle.3d.v1';
export interface Saved { version: 1; sound: boolean; sensitivity: number; attackSensitivity: number; tiltSensitivity: number; bread: BreadId; cpu: BreadId; practiced: boolean; best: Record<string, Partial<Scores>> }
export const defaults = (): Saved => ({ version: 1, sound: false, sensitivity: 1, attackSensitivity: 1, tiltSensitivity: 1, bread: 'shokupan', cpu: 'shokupan', practiced: false, best: {} });
export const condition = (player: BreadId, cpu: BreadId, mode: Mode): string => `${RULE}/${player}/${cpu}/gentle/${mode}`;
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
        if (!/^table-1\/(shokupan|francepan|croissant)\/(shokupan|francepan|croissant)\/gentle\/(sensor|touch|keyboard)$/.test(key) || !scores || typeof scores !== 'object' || (scores.dodge !== undefined && !validMetric(scores.dodge)) || (scores.counter !== undefined && !validMetric(scores.counter))) throw new Error('invalid');
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
  record(battle: Battle, mode: Mode): Partial<Scores> {
    const key = condition(battle.player.bread, battle.cpu.bread, mode);
    const previous = structuredClone(this.data.best[key] ?? {});
    if (battle.practice || battle.outcome === null) return previous;
    const next = structuredClone(previous);
    for (const field of ['dodge', 'counter'] as const) {
      const score = battle.scores[field], value = rate(score), best = rate(next[field]);
      if (value !== null && (best === null || value > best)) next[field] = { ...score };
    }
    this.data.best[key] = next; this.persist(); return previous;
  }
}
