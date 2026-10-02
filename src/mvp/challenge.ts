import { BOSS_ID, BREAD_IDS, type BreadId, type FighterId, type Mode } from './config';
import { DIFFICULTY, type CpuProfile } from './battle';
import { rankOf, type Rank } from './stats';

// 勝ち抜きチャレンジ (plans/EXECPLAN-BOSS.md 1): five breads in a fixed order (minus your own), then the boss loaf.
// Pure progression, scoring and save validation; main.ts owns the screens.
export const CHALLENGE_ORDER: readonly BreadId[] = ['shokupan', 'creampan', 'melonpan', 'francepan', 'currypan', 'croissant'];
export const CHALLENGE_KEY = 'panbattle.challenge.v1', CHALLENGE_RULE = 'table-challenge-1';
export const STAGES = 6, STAGE_SECONDS = 45, ASSIST_AFTER = 2;
export const lineup = (bread: BreadId): FighterId[] => [...CHALLENGE_ORDER.filter(id => id !== bread), BOSS_ID];
// Stages 3-5 start from ふつう with gentler reactions (so the named "normal" level is never required).
const COURSE_BASE = { dodge: .15, spam: .25, react: .20, punish: false, grace: 0, specialWait: .90, specialWindup: .30, specialDodge: .15, specialReact: .30 } as const;
export const COURSE: readonly CpuProfile[] = [
  { ...DIFFICULTY.gentle, label: 'ステージ1' },
  { ...DIFFICULTY.gentle, label: 'ステージ2', pace: .90 },
  { ...DIFFICULTY.normal, ...COURSE_BASE, label: 'ステージ3', windup: .55, recovery: .40, pace: .65, damage: 1.00 },
  { ...DIFFICULTY.normal, ...COURSE_BASE, label: 'ステージ4', windup: .50, recovery: .35, pace: .60, damage: 1.10 },
  { ...DIFFICULTY.normal, ...COURSE_BASE, label: 'ステージ5', windup: .45, recovery: .30, pace: .55, damage: 1.15 },
];
export interface StageSetup { opponent: FighterId; boss: boolean; profile?: CpuProfile; limit?: number }
export function stageSetup(run: Pick<Run, 'order'>, stage: number): StageSetup {
  const opponent = run.order[stage]!, boss = opponent === BOSS_ID;
  // The boss brings its own AI and 90 s clock (see BOSS in battle.ts).
  return boss ? { opponent, boss } : { opponent, boss, profile: COURSE[stage]!, limit: STAGE_SECONDS };
}
export interface StageResult { score: number; dodge: number; chances: number; counters: number; seconds: number }
export interface Run {
  id: string; bread: BreadId; order: FighterId[]; stage: number; results: StageResult[];
  // Defeats in total and at the current stage, whether the helper was ever used, the run's seed and play time.
  retries: number; failsHere: number; assist: boolean; seed: number; mode: Mode; playSeconds: number;
}
export interface ChallengeRecord { clears: number; best: number; fewestRetries: number; perfect: boolean }
export interface ChallengeSave { version: 1; rule: typeof CHALLENGE_RULE; run: Run | null; seenIntro: boolean; records: Partial<Record<BreadId, ChallengeRecord>> }
export const emptyChallenge = (): ChallengeSave => ({ version: 1, rule: CHALLENGE_RULE, run: null, seenIntro: false, records: {} });
export function newRun(bread: BreadId, mode: Mode, seed: number, id = `${Date.now().toString(36)}-${(seed >>> 0).toString(36)}`): Run {
  return { id, bread, order: lineup(bread), stage: 0, results: [], retries: 0, failsHere: 0, assist: false, seed: seed >>> 0, mode, playSeconds: 0 };
}
// Same opening seed for every retry of a stage, so a retry is a fair second look.
export const stageSeed = (run: Pick<Run, 'seed' | 'stage'>): number => (Math.imul(run.seed ^ 0x9e3779b9, run.stage + 1) + run.stage * 7919) >>> 0 || 1;
export const finished = (run: Pick<Run, 'stage'>): boolean => run.stage >= STAGES;
export function winStage(run: Run, result: StageResult): Run {
  if (finished(run)) return run;
  return { ...run, stage: run.stage + 1, results: [...run.results, result], failsHere: 0, playSeconds: run.playSeconds + result.seconds };
}
export function loseStage(run: Run, seconds: number): Run {
  if (finished(run)) return run;
  return { ...run, retries: run.retries + 1, failsHere: run.failsHere + 1, playSeconds: run.playSeconds + Math.max(0, seconds) };
}
export const offerAssist = (run: Pick<Run, 'failsHere'>): boolean => run.failsHere >= ASSIST_AFTER;
export interface RunSummary { cleared: number; total: number; average: number; rank: Rank | null; dodgeRate: number | null; counters: number; battleSeconds: number }
// Rank only for a cleared run: S needs no retries, no helper and a counter in the boss fight (else at most A).
export function summary(run: Run): RunSummary {
  const total = run.results.reduce((n, r) => n + r.score, 0), average = Math.round(total / STAGES);
  const chances = run.results.reduce((n, r) => n + r.chances, 0), dodges = run.results.reduce((n, r) => n + r.dodge, 0);
  let rank: Rank | null = null;
  if (finished(run)) {
    // Rank from the exact mean (S needs 510 of 600); only the shown average is rounded.
    rank = rankOf(total / STAGES);
    const perfect = run.retries === 0 && !run.assist && (run.results[STAGES - 1]?.counters ?? 0) > 0;
    if (rank === 'S' && !perfect) rank = 'A';
  }
  return { cleared: run.results.length, total, average, rank, dodgeRate: chances ? dodges / chances : null,
    counters: run.results.reduce((n, r) => n + r.counters, 0), battleSeconds: run.results.reduce((n, r) => n + r.seconds, 0) };
}
// Folds a cleared run into the bread's record; returns the new records (unchanged for an unfinished run).
export function recordClear(records: ChallengeSave['records'], run: Run): ChallengeSave['records'] {
  if (!finished(run)) return records;
  const previous = records[run.bread], score = summary(run).total, perfect = run.retries === 0 && !run.assist;
  return { ...records, [run.bread]: previous
    ? { clears: previous.clears + 1, best: Math.max(previous.best, score), fewestRetries: Math.min(previous.fewestRetries, run.retries), perfect: previous.perfect || perfect }
    : { clears: 1, best: score, fewestRetries: run.retries, perfect } };
}

const MODES: readonly Mode[] = ['sensor', 'touch', 'keyboard'];
const count = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= max;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function validResult(r: unknown): r is StageResult {
  const v = r as StageResult;
  return !!v && typeof v === 'object' && count(v.score, 100) && count(v.dodge) && count(v.chances) && v.dodge <= v.chances && count(v.counters) && finite(v.seconds);
}
function validRun(r: unknown): r is Run {
  const v = r as Run;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !BREAD_IDS.includes(v.bread) || !MODES.includes(v.mode)) return false;
  const order = lineup(v.bread);
  return Array.isArray(v.order) && v.order.length === STAGES && v.order.every((id, i) => id === order[i]) && count(v.stage, STAGES)
    && Array.isArray(v.results) && v.results.length === v.stage && v.results.every(validResult)
    && count(v.retries) && count(v.failsHere) && v.failsHere <= v.retries && typeof v.assist === 'boolean' && count(v.seed, 0xffffffff) && finite(v.playSeconds);
}
function validRecord(r: unknown): r is ChallengeRecord {
  const v = r as ChallengeRecord;
  return !!v && typeof v === 'object' && count(v.clears) && v.clears > 0 && count(v.best, 600) && count(v.fewestRetries) && typeof v.perfect === 'boolean';
}
export function parseChallenge(raw: string): ChallengeSave {
  const v = JSON.parse(raw) as ChallengeSave;
  if (!v || v.version !== 1 || v.rule !== CHALLENGE_RULE || typeof v.seenIntro !== 'boolean' || !v.records || typeof v.records !== 'object' || Array.isArray(v.records)) throw new Error('invalid');
  if (v.run !== null && !validRun(v.run)) throw new Error('invalid');
  for (const [bread, record] of Object.entries(v.records)) if (!BREAD_IDS.includes(bread as BreadId) || !validRecord(record)) throw new Error('invalid');
  return { version: 1, rule: CHALLENGE_RULE, run: v.run, seenIntro: v.seenIntro, records: v.records };
}
// Stage-granular persistence. Unreadable data is kept untouched (and never overwritten); a failed write keeps playing in memory.
export class ChallengeStore {
  data = emptyChallenge(); warning = ''; private locked = false;
  constructor(private storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {
    try { const raw = this.storage().getItem(CHALLENGE_KEY); if (raw !== null) this.data = parseChallenge(raw); }
    catch { this.locked = true; this.warning = 'チャレンジの記録を読み込めません。この回は保存せずに遊べます。'; }
  }
  persist(): boolean {
    if (this.locked) return false;
    try { this.storage().setItem(CHALLENGE_KEY, JSON.stringify(this.data)); this.warning = ''; return true; }
    catch { this.warning = 'チャレンジの記録を保存できませんでした。この画面を閉じるまでは続きから遊べます。'; return false; }
  }
  // Each step is one write: the stage result and the next stage number land together.
  update(change: (data: ChallengeSave) => ChallengeSave): boolean { this.data = change(this.data); return this.persist(); }
}
