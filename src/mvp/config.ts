export const BREADS = {
  shokupan: { name: '食パン', note: '広い面で当てやすい。リーチは標準。', hp: 100, damage: 18, windup: .20, active: .19, recovery: .47, reach: 2.03, width: .50, height: .55, depth: .175, lean: .48 },
  francepan: { name: 'フランスパン', note: '長いリーチ。振り終わりの隙は大きめ。', hp: 100, damage: 23, windup: .28, active: .23, recovery: .72, reach: 1.98, width: .215, height: .975, depth: .186, lean: .76 },
  croissant: { name: 'クロワッサン', note: 'すばやく戻れる。一撃とリーチは控えめ。', hp: 100, damage: 14, windup: .13, active: .16, recovery: .33, reach: 2.00, width: .67, height: .455, depth: .232, lean: .34 },
} as const;
export type BreadId = keyof typeof BREADS;
export const BREAD_IDS = Object.keys(BREADS) as BreadId[];
export type Mode = 'sensor' | 'touch' | 'keyboard';
export const RULE = 'table-1';
export const LIMIT = 1.15;
export const STEP = 1 / 120;
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
