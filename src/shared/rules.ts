export const BREADS = {
  shokupan: { name: '食パン', note: '広い面で当てやすい。リーチは標準。', hp: 100, damage: 18, windup: .20, active: .19, recovery: .47, reach: 2.03, width: .50, height: .55, depth: .175, lean: .48 },
  francepan: { name: 'フランスパン', note: '長いリーチ。振り終わりの隙は大きめ。', hp: 100, damage: 23, windup: .28, active: .23, recovery: .72, reach: 1.98, width: .215, height: .975, depth: .186, lean: .76 },
  croissant: { name: 'クロワッサン', note: 'すばやく戻れる。一撃とリーチは控えめ。', hp: 100, damage: 14, windup: .13, active: .16, recovery: .33, reach: 2.00, width: .67, height: .455, depth: .232, lean: .34 },
  melonpan: { name: 'メロンパン', note: 'サクッと回避！ひっさつが早くたまる。', hp: 100, damage: 20, windup: .24, active: .28, recovery: .54, reach: 2.00, width: .552, height: .506, depth: .276, lean: .52 },
  currypan: { name: 'カレーパン', note: '近くでドカン！一撃は強いが戻りは遅い。', hp: 100, damage: 26, windup: .24, active: .14, recovery: .80, reach: 1.97, width: .4508, height: .3588, depth: .230, lean: .62 },
  creampan: { name: 'クリームパン', note: '出だしはゆっくり。空振りしても早く戻る。', hp: 100, damage: 16, windup: .30, active: .15, recovery: .28, reach: 2.00, width: .6256, height: .4324, depth: .2116, lean: .42 },
  // Boss of the CPU challenge (plans/EXECPLAN-BOSS.md). Never selectable and never online: BREAD_IDS below omits it.
  ikkin: { name: '一斤食パン', note: 'どっしり大きい。よけた後が大チャンス。', hp: 180, damage: 24, windup: .50, active: .22, recovery: .90, reach: 1.72, width: .75, height: .80, depth: .65, lean: .48 },
} as const;
export type FighterId = keyof typeof BREADS;
export const BOSS_ID = 'ikkin' as const satisfies FighterId;
export type BreadId = Exclude<FighterId, typeof BOSS_ID>;
// The six playable breads (selection, PvP validation, saves).
export const BREAD_IDS = (Object.keys(BREADS) as FighterId[]).filter((id): id is BreadId => id !== BOSS_ID);
export const FIGHTER_IDS = Object.keys(BREADS) as FighterId[];
export type Mode = 'sensor' | 'touch' | 'keyboard';
export const RULE = 'table-1';
// CPU matches with specials; records under RULE are kept but no longer compared.
export const SPECIAL_RULE = 'table-special-1';
export const ONLINE_RULE = 'table-pvp-1';
export type Ruleset = 'cpu' | 'pvp';
// Initial PvP timings; two-iPhone playtesting is still required.
export const PVP_WINDUP_EXTRA = .30;
export const PVP_RECOVERY_EXTRA = .55;
export const LIMIT = 1.15;
export const STEP = 1 / 120;
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

