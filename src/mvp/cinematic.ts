// Boss entrance timeline (plans/EXECPLAN-BOSS.md 4): a pure function of time so the renderer, the DOM overlay, the
// sound cues and the tests all read the same frame. Nothing here touches combat state.
export type Vec3 = readonly [number, number, number];
export interface Shot { position: Vec3; target: Vec3 }
export const BOSS_CAMERA: Shot = { position: [.9, 6.1, 7.7], target: [0, 1.05, -.15] };
const WAIT: Shot = { position: [1.8, 3.5, 4.8], target: [0, .45, -1.2] };
const LAND: Shot = { position: [1.4, 2.7, 4.1], target: [0, 1, -1.2] };
// Three-quarter close-up so the loaf's length and crowns read, not just its cut face.
const FACE: Shot = { position: [1.45, 2.55, 2.3], target: [-.1, 1.6, -.75] };
export const INTRO_SECONDS = 6, INTRO_SHORT_SECONDS = 1.2;
// The standing height every bread hovers at in battle, and the loaf's centre when it first touches the cloth.
export const STAND_Y = 1.43, LANDED_Y = .82, DROP_FROM_Y = 5.2;
export type IntroCue = 'rumble' | 'whoosh' | 'thud' | 'glint' | 'theme';
export const INTRO_CUES: readonly { at: number; cue: IntroCue }[] = [
  { at: .45, cue: 'rumble' }, { at: .85, cue: 'rumble' }, { at: 1.2, cue: 'whoosh' }, { at: 2.55, cue: 'thud' }, { at: 3.4, cue: 'glint' }, { at: 5.2, cue: 'theme' },
];
export interface IntroFrame {
  camera: Shot;
  // Boss root height (centre), squash scale, and whether it is in the scene yet.
  bossY: number; squash: Vec3; bossVisible: boolean;
  // The challenger stands right between the low cameras and the landing spot, so it steps in only for the last shot.
  challengerVisible: boolean;
  // Loaf-shaped shadow growing on the cloth (0..1), plate wobble amplitude (m), camera jolt (0..1).
  shadow: number; plates: number; jolt: number;
  // Lid opening 0 (asleep) .. 1, letterbox bars 0..1, darkening 0..1, the name plate 0..1, the small caption.
  eyes: number; letterbox: number; dim: number; title: number; caption: '' | '……？';
  done: boolean;
}
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const smooth = (n: number): number => { const u = clamp01(n); return u * u * (3 - 2 * u); };
const span = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from));
const mix3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
const shot = (a: Shot, b: Shot, u: number): Shot => ({ position: mix3(a.position, b.position, smooth(u)), target: mix3(a.target, b.target, smooth(u)) });
// Camera keys: [time, shot]; the camera eases between neighbours.
const CAMERA: readonly [number, Shot][] = [[0, BOSS_CAMERA], [.35, WAIT], [1.2, WAIT], [2.0, LAND], [2.55, LAND], [3.35, FACE], [5.2, FACE], [6.0, BOSS_CAMERA]];
function camera(t: number): Shot {
  for (let i = 1; i < CAMERA.length; i++) { const [b, to] = CAMERA[i]!, [a, from] = CAMERA[i - 1]!; if (t < b) return shot(from, to, span(t, a, b)); }
  return BOSS_CAMERA;
}
// short: the 1.2 s version for repeat visits and reduced motion — fixed battle camera, boss already standing, name only.
export function introFrame(t: number, short = false): IntroFrame {
  const time = Math.max(0, t);
  if (short) {
    const u = time / INTRO_SHORT_SECONDS;
    return { camera: BOSS_CAMERA, bossY: STAND_Y, squash: [1, 1, 1], bossVisible: true, challengerVisible: true, shadow: 1, plates: 0, jolt: 0, eyes: 1,
      letterbox: u < .85 ? 1 : 1 - span(u, .85, 1), dim: 0, title: u < .8 ? 1 : 1 - span(u, .8, 1), caption: '', done: time >= INTRO_SHORT_SECONDS };
  }
  let bossY = DROP_FROM_Y, squash: Vec3 = [1, 1, 1];
  if (time >= 2.0 && time < 2.55) { const u = span(time, 2.0, 2.55); bossY = DROP_FROM_Y + (LANDED_Y - DROP_FROM_Y) * u * u; squash = [.94, 1.1, .94]; }
  else if (time >= 2.55) {
    // One squash on impact, then the loaf rises to its fighting stance.
    const k = Math.sin(span(time, 2.55, 2.75) * Math.PI), rise = span(time, 2.75, 3.35);
    squash = [1 + .14 * k, 1 - .2 * k, 1 + .14 * k];
    bossY = LANDED_Y + (STAND_Y - LANDED_Y) * (1 - (1 - rise) ** 3);
  }
  const pulse = (center: number): number => Math.max(0, 1 - Math.abs(time - center) / .12);
  return {
    camera: camera(time), bossY, squash, bossVisible: time >= 2.0, challengerVisible: time >= 5.2,
    shadow: smooth(span(time, 1.2, 2.55)), plates: .035 * (pulse(.5) + pulse(.9)), jolt: time >= 2.55 ? Math.max(0, 1 - (time - 2.55) / .45) : 0,
    eyes: smooth(span(time, 3.35, 3.6)), letterbox: time < .35 ? smooth(time / .35) : time < 5.2 ? 1 : 1 - smooth(span(time, 5.2, 6.0)),
    dim: time < .35 ? .25 * smooth(time / .35) : time < 2.55 ? .25 : .25 * (1 - smooth(span(time, 2.55, 3.0))),
    title: time < 4.1 ? 0 : time < 5.2 ? smooth(span(time, 4.1, 4.3)) : 1 - smooth(span(time, 5.2, 5.5)),
    caption: time >= .45 && time < 1.2 ? '……？' : '', done: time >= INTRO_SECONDS,
  };
}
// Cues whose time falls in (from, to]: the frame loop calls this with the previous and current intro clocks.
export function cuesBetween(from: number, to: number, short = false): IntroCue[] {
  if (short) return from < .05 && to >= .05 ? ['theme'] : [];
  return INTRO_CUES.filter(c => c.at > from && c.at <= to).map(c => c.cue);
}
