import type { FighterId } from './config';

// Face layout and personality per bread (plans/EXECPLAN-FACE.md 1-2). Coordinates are the bread's local space after
// renderer.load() scales and centres the GLB; eye z is found by a ray against the surface, not stored here.
export type MouthId = 'calm' | 'tight' | 'attack' | 'slack' | 'ouch' | 'grit' | 'smug' | 'serious' | 'wild' | 'win' | 'lose' | 'huh';
export type BrowId = 'none' | 'worry' | 'angry' | 'up';
export type EyeStyle = 'ball' | 'happy' | 'shut';
export interface EyeSpec { x: number; y: number; radius: readonly [number, number, number] }
export interface FaceSpec {
  eyes: readonly [EyeSpec, EyeSpec];
  pupil: number;
  // Resting lid opening per eye (1 = fully open): the baguette's smug half-lids, the croissant's one narrow eye.
  open: readonly [number, number];
  mouth: { x: number; y: number; w: number; h: number };
  // Face decal area; only front-facing triangles fully inside it are used.
  region: { x0: number; x1: number; y0: number; y1: number };
  lid: string; brow: BrowId; cheek: number;
  // Sweat drop centre and radius; it must sit on a surface the decal covers.
  sweat: { x: number; y: number; r: number };
  // Lid opening multipliers at the lowest HP stage (the second-lowest uses the midpoint).
  tired: readonly [number, number];
}

export const FACE_COLORS = { white: '#fff0dc', pupil: '#281b18', lip: '#ad6661', line: '#3a2418', cheek: '#e8826a', sweat: '#bfe3f2', tooth: '#fffaf0' } as const;

export const FACES: Record<FighterId, FaceSpec> = {
  shokupan: {
    eyes: [{ x: -.215, y: .15, radius: [.106, .117, .058] }, { x: .205, y: .13, radius: [.099, .109, .056] }],
    pupil: .038, open: [1, .96], mouth: { x: 0, y: -.12, w: .21, h: .11 },
    region: { x0: -.44, x1: .44, y0: -.34, y1: .46 }, lid: '#f1dcb4', brow: 'none', cheek: .55,
    sweat: { x: .37, y: .21, r: .032 }, tired: [.56, .52],
  },
  francepan: {
    eyes: [{ x: -.084, y: .441, radius: [.068, .091, .045] }, { x: .085, y: .462, radius: [.067, .084, .045] }],
    pupil: .036, open: [.6, .6], mouth: { x: .011, y: .27, w: .13, h: .08 },
    region: { x0: -.2, x1: .2, y0: .12, y1: .72 }, lid: '#b86a31', brow: 'up', cheek: 0,
    sweat: { x: .13, y: .53, r: .02 }, tired: [.85, .78],
  },
  croissant: {
    eyes: [{ x: -.129, y: .27, radius: [.087, .085, .048] }, { x: .137, y: .247, radius: [.092, .078, .048] }],
    pupil: .04, open: [1, .52], mouth: { x: .01, y: .11, w: .26, h: .1 },
    region: { x0: -.36, x1: .36, y0: 0, y1: .45 }, lid: '#d08a3a', brow: 'none', cheek: .25,
    sweat: { x: .27, y: .3, r: .03 }, tired: [.72, .8],
  },
  // Calm round face, hot-blooded smirk, beaming smile (plans/EXECPLAN-CHARACTERS.md).
  melonpan: {
    eyes: [{ x: -.21, y: .13, radius: [.090, .105, .053] }, { x: .21, y: .13, radius: [.090, .105, .053] }],
    pupil: .035, open: [.82, .82], mouth: { x: 0, y: -.13, w: .20, h: .10 },
    region: { x0: -.41, x1: .41, y0: -.32, y1: .36 }, lid: '#e1bd70', brow: 'none', cheek: .35,
    sweat: { x: .34, y: .18, r: .028 }, tired: [.65, .60],
  },
  currypan: {
    eyes: [{ x: -.17, y: .07, radius: [.083, .090, .045] }, { x: .17, y: .09, radius: [.080, .088, .045] }],
    pupil: .034, open: [.90, .78], mouth: { x: 0, y: -.11, w: .20, h: .08 },
    region: { x0: -.34, x1: .34, y0: -.25, y1: .25 }, lid: '#b87936', brow: 'up', cheek: .15,
    sweat: { x: .29, y: .13, r: .024 }, tired: [.70, .60],
  },
  creampan: {
    eyes: [{ x: -.22, y: .03, radius: [.096, .095, .050] }, { x: .22, y: .04, radius: [.096, .095, .050] }],
    pupil: .038, open: [1, .96], mouth: { x: 0, y: -.17, w: .24, h: .10 },
    region: { x0: -.44, x1: .44, y0: -.32, y1: .25 }, lid: '#e6bd82', brow: 'none', cheek: .65,
    sweat: { x: .36, y: .09, r: .029 }, tired: [.60, .55],
  },
  // The boss loaf's cut face: big, calm, dignified eyes (plans/EXECPLAN-BOSS.md 3).
  ikkin: {
    eyes: [{ x: -.28, y: .22, radius: [.13, .14, .07] }, { x: .28, y: .22, radius: [.13, .14, .07] }],
    pupil: .045, open: [.78, .78], mouth: { x: 0, y: -.19, w: .32, h: .14 },
    region: { x0: -.625, x1: .625, y0: -.40, y1: .56 }, lid: '#f2d09a', brow: 'up', cheek: .15,
    sweat: { x: .49, y: .22, r: .035 }, tired: [.72, .72],
  },
};
// Pupil travel limits as a share of the eyeball's horizontal / vertical radius.
export const GAZE_LIMIT = { x: .22, y: .15 } as const;
// Eyeball centre sits this far out along the surface normal; the decal floats just above the crust.
export const EYE_LIFT = .012, DECAL_LIFT = .003;
// Decal canvas density (px per metre) and size cap.
export const DECAL_DENSITY = 480, DECAL_MAX = 512;
// Drawn lines are this much bolder than their close-up size so they still read at phone size in battle.
export const LINE_BOOST = 1.3;
