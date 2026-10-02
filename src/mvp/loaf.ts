import * as THREE from 'three';

// The boss "一斤食パン" is built at load time instead of shipping a GLB (no Blender here, and it costs no download).
// Its cut face reuses the toast slice's silhouette (art/bread/generate_breads.py outline()) so it reads as the same
// family, scaled up and extruded into a loaf with a three-crowned top. Front (+z) is the cut face, where the face goes.
type Point = readonly [number, number];
const SPANS: readonly (readonly [Point, Point, Point, Point])[] = [
  [[-.40, .02], [-.50, .02], [-.53, .07], [-.53, .18]],
  [[-.53, .18], [-.53, .43], [-.52, .68], [-.51, .86]],
  [[-.51, .86], [-.66, 1.09], [-.36, 1.24], [0, 1.21]],
  [[0, 1.21], [.36, 1.25], [.66, 1.09], [.51, .86]],
  [[.51, .86], [.52, .68], [.53, .43], [.53, .18]],
  [[.53, .18], [.53, .07], [.50, .02], [.40, .02]],
  [[.40, .02], [.26, .015], [.12, .012], [0, .012]],
  [[0, .012], [-.12, .012], [-.26, .015], [-.40, .02]],
];
const PER_SPAN = 8;
export function loafOutline(): Point[] {
  const points: Point[] = [];
  for (const [a, b, c, d] of SPANS) for (let i = 0; i < PER_SPAN; i++) {
    const t = i / PER_SPAN, s = 1 - t;
    points.push([s ** 3 * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t ** 3 * d[0], s ** 3 * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t ** 3 * d[1]]);
  }
  return points;
}
// Small deterministic value noise so every load bakes the same crust.
function hash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s);
}
function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const corner = (dx: number, dy: number, dz: number): number => hash(ix + dx, iy + dy, iz + dz);
  return lerp(lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v), w);
}
const CRUMB = new THREE.Color('#f6ead0'), CRUMB_DARK = new THREE.Color('#e3cfa4'), CRUST = new THREE.Color('#b8692b'), CRUST_DARK = new THREE.Color('#7a3a14'), HEEL = new THREE.Color('#d39556');
export interface LoafSize { width: number; height: number; length: number; crowns?: number }
// Returns an indexed, closed geometry with vertex colours and UVs, base at y=0, centred in x and z.
export function buildLoaf({ width, height, length, crowns = 3 }: LoafSize): THREE.BufferGeometry {
  const outline = loafOutline(), n = outline.length, sx = width / 1.06, sy = height / 1.235, centre: Point = [0, .59];
  const positions: number[] = [], colors: number[] = [], uvs: number[] = [], index: number[] = [];
  const color = new THREE.Color();
  const crust = (x: number, y: number, z: number, top: number): THREE.Color => {
    const grain = noise(x * 9, y * 9, z * 9), fine = noise(x * 41, y * 41, z * 41);
    color.copy(HEEL).lerp(CRUST, Math.min(1, .35 + top * .9)).lerp(CRUST_DARK, Math.max(0, Math.min(1, Math.max(0, top - .55) * .9 + (grain - .5) * .35)));
    return color.offsetHSL(0, 0, (fine - .5) * .05);
  };
  // Rings along the loaf: rounded heel at both ends, soft crowns on top along the length.
  const rounding = [[.955, 0], [.985, .018], [1, .05]] as const, inner = 14, rings: { z: number; scale: number; lift: number }[] = [];
  const half = length / 2;
  rounding.forEach(([scale, inset]) => rings.push({ z: -half + inset * length, scale, lift: 0 }));
  for (let k = 1; k < inner; k++) rings.push({ z: -half + (.05 + .9 * k / inner) * length, scale: 1, lift: 0 });
  [...rounding].reverse().forEach(([scale, inset]) => rings.push({ z: half - inset * length, scale, lift: 0 }));
  for (const ring of rings) {
    const u = (ring.z + half) / length;
    // Crowns: 0 at the grooves, 1 on each dome; the very ends sit a little lower like a real 山型 loaf.
    ring.lift = (.5 - .5 * Math.cos(u * Math.PI * 2 * crowns)) * .07 * height + Math.sin(u * Math.PI) * .03 * height;
  }
  rings.forEach((ring, r) => {
    for (let j = 0; j < n; j++) {
      const [ox, oy] = outline[j]!, top = Math.max(0, (oy - .8) / .45);
      const x = (centre[0] + (ox - centre[0]) * ring.scale) * sx, y = (centre[1] + (oy - centre[1]) * ring.scale) * sy + ring.lift * top * ring.scale;
      positions.push(x, y, ring.z);
      const c = crust(x, y, ring.z, top * (.75 + ring.lift / (.1 * height) * .4)); colors.push(c.r, c.g, c.b);
      uvs.push(j / n, r / (rings.length - 1));
    }
  });
  for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < n; j++) {
    const a = r * n + j, b = r * n + (j + 1) % n, c = (r + 1) * n + (j + 1) % n, d = (r + 1) * n + j;
    index.push(a, d, c, a, c, b);
  }
  // Cut faces: concentric rings from the crust edge to the crumb centre. The outer ring stays crust, then crumb.
  const caps = [.93, .9, .78, .6, .4, .2];
  for (const front of [true, false]) {
    const edge = front ? rings.length - 1 : 0, ring = rings[edge]!, start = positions.length / 3;
    caps.forEach((scale, k) => {
      for (let j = 0; j < n; j++) {
        const [ox, oy] = outline[j]!, top = Math.max(0, (oy - .8) / .45), s = ring.scale * scale;
        const x = (centre[0] + (ox - centre[0]) * s) * sx, y = (centre[1] + (oy - centre[1]) * s) * sy + ring.lift * top * s;
        // A slight dome on the crumb so the face decal and eyes sit on a gently rounded surface.
        const z = ring.z + (front ? 1 : -1) * (.012 + (1 - scale) * .03);
        positions.push(x, y, z); uvs.push(.5 + x / width * .5, y / height);
        if (k === 0) { const c = crust(x, y, z, top * .8); colors.push(c.r, c.g, c.b); }
        else { const t = noise(x * 23, y * 23, front ? 1 : 7); color.copy(CRUMB).lerp(CRUMB_DARK, k === 1 ? .55 : t * .45); colors.push(color.r, color.g, color.b); }
      }
    });
    const centreIndex = positions.length / 3;
    positions.push(centre[0] * sx, centre[1] * sy, ring.z + (front ? 1 : -1) * .045); colors.push(CRUMB.r, CRUMB.g, CRUMB.b); uvs.push(.5, centre[1] * sy / height);
    const loop = (k: number): number => k < 0 ? edge * n : start + k * n;
    const quad = (a: number, b: number, c: number, d: number): void => { if (front) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d); };
    for (let k = -1; k < caps.length - 1; k++) for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n; quad(loop(k) + j, loop(k) + j2, loop(k + 1) + j2, loop(k + 1) + j);
    }
    const last = loop(caps.length - 1);
    for (let j = 0; j < n; j++) { const j2 = (j + 1) % n; if (front) index.push(last + j2, last + j, centreIndex); else index.push(last + j, last + j2, centreIndex); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index); geometry.computeVertexNormals();
  return geometry;
}
// Fine crumb/crust speckle multiplied over the vertex colours (256², drawn once).
export function loafTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const c = canvas.getContext('2d')!; c.fillStyle = '#ffffff'; c.fillRect(0, 0, 256, 256);
  let seed = 7; const rand = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 1800; i++) {
    const shade = 200 + Math.floor(rand() * 50); c.fillStyle = `rgba(${shade},${shade - 18},${shade - 50},${.25 + rand() * .35})`;
    c.beginPath(); c.ellipse(rand() * 256, rand() * 256, .6 + rand() * 2.2, .5 + rand() * 1.6, rand() * Math.PI, 0, Math.PI * 2); c.fill();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(3, 3);
  return texture;
}
// Generator input for the boss: the renderer scales every model by .92, so this lands on the game size
// 1.50 wide × 1.60 tall (crowns included) (plans/EXECPLAN-BOSS.md 3). The loaf is drawn longer than its 1.30 hit depth so
// it reads as a whole loaf; LOAF_BACK pushes the extra length behind it, keeping the cut face on the hit box's front.
export const LOAF_SIZE: LoafSize = { width: 1.50 / .92, height: 1.47 / .92, length: 1.70 / .92 };
export const LOAF_BACK = -(1.79 / 2 - .65);
