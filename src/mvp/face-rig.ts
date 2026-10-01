import * as THREE from 'three';
import type { BreadId } from './config';
import { FACES, FACE_COLORS, GAZE_LIMIT, EYE_LIFT, DECAL_LIFT, DECAL_DENSITY, DECAL_MAX, LINE_BOOST, type FaceSpec } from './face-config';
import { decalKey, type FaceFrame } from './face-state';

// Three.js side of the bread faces (plans/EXECPLAN-FACE.md 2): 3D eyeballs + pupils (one InstancedMesh), lids (one
// InstancedMesh) and a decal cut from the bread's own front triangles, all glued to the deformed surface each frame.
export interface Anchor { a: number; b: number; c: number; u: number; v: number; w: number }
export interface FaceTemplate {
  bread: BreadId; eyes: [Anchor | null, Anchor | null];
  // Decal: source vertex per decal vertex, triangle list, planar UVs.
  decal: { source: Uint32Array; index: number[]; uv: Float32Array } | null;
}
const triangles = (geometry: THREE.BufferGeometry): ArrayLike<number> => geometry.index?.array ?? Array.from({ length: geometry.attributes.position!.count }, (_, i) => i);
// Surface point hit by a ray from +z toward -z at (x, y): the front-most triangle containing it, as indices + barycentrics.
export function anchorAt(geometry: THREE.BufferGeometry, x: number, y: number): Anchor | null {
  const pos = geometry.attributes.position!, index = triangles(geometry);
  let best: Anchor | null = null, bestZ = -Infinity;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i]!, b = index[i + 1]!, c = index[i + 2]!;
    const ax = pos.getX(a), ay = pos.getY(a), bx = pos.getX(b), by = pos.getY(b), cx = pos.getX(c), cy = pos.getY(c);
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const z = u * pos.getZ(a) + v * pos.getZ(b) + w * pos.getZ(c);
    if (z > bestZ) { bestZ = z; best = { a, b, c, u, v, w }; }
  }
  return best;
}
export function buildFaceTemplate(bread: BreadId, geometry: THREE.BufferGeometry): FaceTemplate {
  const spec = FACES[bread], pos = geometry.attributes.position!, normal = geometry.attributes.normal!, index = triangles(geometry);
  const eyes = spec.eyes.map(e => anchorAt(geometry, e.x, e.y)) as [Anchor | null, Anchor | null];
  const { x0, x1, y0, y1 } = spec.region, map = new Map<number, number>(), source: number[] = [], faces: number[] = [];
  const inside = (i: number): boolean => { const x = pos.getX(i), y = pos.getY(i); return x >= x0 && x <= x1 && y >= y0 && y <= y1 && normal.getZ(i) > .35; };
  for (let i = 0; i + 2 < index.length; i += 3) {
    const tri = [index[i]!, index[i + 1]!, index[i + 2]!];
    if (!tri.every(inside)) continue;
    for (const v of tri) { if (!map.has(v)) { map.set(v, source.length); source.push(v); } faces.push(map.get(v)!); }
  }
  const uv = new Float32Array(source.length * 2);
  source.forEach((v, i) => { uv[i * 2] = (pos.getX(v) - x0) / (x1 - x0); uv[i * 2 + 1] = (pos.getY(v) - y0) / (y1 - y0); });
  if (import.meta.env?.DEV) for (const [i, eye] of eyes.entries()) if (!eye) console.warn(`${bread}: face eye ${i} has no surface`);
  return { bread, eyes, decal: faces.length ? { source: new Uint32Array(source), index: faces, uv } : null };
}

// Shared unit shapes: the eyeball / pupil sphere and the upper-hemisphere lid.
let eyeShape: THREE.SphereGeometry | undefined, lidShape: THREE.SphereGeometry | undefined;
const LID_SCALE = 1.14, PUPIL_DEPTH = .25;
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4(),
  _basis = new THREE.Matrix4(), _s = new THREE.Vector3(), _local = new THREE.Vector3(), _lid = new THREE.Matrix4();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

export class FaceRig {
  readonly group = new THREE.Group();
  private eyes: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private lids: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private decal: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial> | null = null;
  private canvas: HTMLCanvasElement | null = null; private texture: THREE.CanvasTexture | null = null; private key = '';
  private spec: FaceSpec;
  constructor(readonly template: FaceTemplate) {
    const spec = this.spec = FACES[template.bread];
    eyeShape ??= new THREE.SphereGeometry(1, 14, 8); lidShape ??= new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    // Eyes and lids use identical material settings (colour per instance, no environment map) so they share one
    // shader program: cheap on phones and in software-rendered test browsers alike.
    this.eyes = new THREE.InstancedMesh(eyeShape, new THREE.MeshStandardMaterial({ roughness: .4, metalness: 0 }), 4);
    this.lids = new THREE.InstancedMesh(lidShape, new THREE.MeshStandardMaterial({ roughness: .8, metalness: 0 }), 2);
    const white = new THREE.Color(FACE_COLORS.white), pupil = new THREE.Color(FACE_COLORS.pupil), lid = new THREE.Color(spec.lid);
    for (let i = 0; i < 4; i++) this.eyes.setColorAt(i, i < 2 ? white : pupil);
    for (let i = 0; i < 2; i++) this.lids.setColorAt(i, lid);
    for (const mesh of [this.eyes, this.lids]) { mesh.frustumCulled = false; mesh.name = 'face'; this.group.add(mesh); }
    const d = template.decal;
    if (d && typeof document !== 'undefined') {
      const { x0, x1, y0, y1 } = spec.region, canvas = this.canvas = document.createElement('canvas');
      canvas.width = Math.min(DECAL_MAX, Math.round((x1 - x0) * DECAL_DENSITY)); canvas.height = Math.min(DECAL_MAX, Math.round((y1 - y0) * DECAL_DENSITY));
      const texture = this.texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 2;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(d.source.length * 3), 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2)); geometry.setIndex(d.index);
      // Lambert keeps the drawn face lit like the crust at a fraction of the PBR cost over the large toast face.
      const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      this.decal = new THREE.Mesh(geometry, material); this.decal.frustumCulled = false; this.decal.name = 'face'; this.decal.renderOrder = 1; this.group.add(this.decal);
    }
  }
  // positions/normals: the bread's already-deformed attributes for this frame.
  update(face: FaceFrame, positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, normals: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): void {
    const spec = this.spec, balls = face.eyes === 'ball';
    this.template.eyes.forEach((anchor, i) => {
      if (!anchor || !balls) { this.eyes.setMatrixAt(i, hidden); this.eyes.setMatrixAt(i + 2, hidden); this.lids.setMatrixAt(i, hidden); return; }
      const eye = spec.eyes[i]!, [rx, ry, rz] = eye.radius, pop = face.pop;
      _p.set(0, 0, 0); _n.set(0, 0, 0);
      for (const [v, k] of [[anchor.a, anchor.u], [anchor.b, anchor.v], [anchor.c, anchor.w]] as const) {
        _p.x += positions.getX(v) * k; _p.y += positions.getY(v) * k; _p.z += positions.getZ(v) * k;
        _n.x += normals.getX(v) * k; _n.y += normals.getY(v) * k; _n.z += normals.getZ(v) * k;
      }
      if (_n.lengthSq() < 1e-8) _n.set(0, 0, 1); _n.normalize();
      _p.addScaledVector(_n, EYE_LIFT);
      // Eye basis: z along the surface normal, y as close to the bread's up as possible.
      _x.set(0, 1, 0).cross(_n); if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); _x.normalize(); _y.crossVectors(_n, _x);
      _basis.makeBasis(_x, _y, _n); _q.setFromRotationMatrix(_basis);
      this.eyes.setMatrixAt(i, _m.compose(_p, _q, _s.set(rx * pop, ry * pop, rz * pop)));
      // Pupil rides the eyeball surface toward the gaze.
      const gx = face.gaze[0] * GAZE_LIMIT.x, gy = face.gaze[1] * GAZE_LIMIT.y, r = spec.pupil / 2 * face.pupil;
      _local.set(gx * rx * pop, gy * ry * pop, rz * pop * Math.sqrt(Math.max(0, 1 - gx * gx - gy * gy)) - r * PUPIL_DEPTH * .4).applyQuaternion(_q).add(_p);
      this.eyes.setMatrixAt(i + 2, _m.compose(_local, _q, _s.set(r, r, r * PUPIL_DEPTH)));
      // Lid: a hemisphere rotated from the back (open) over the front (shut) on the unit sphere, then given the
      // eyeball's own ellipsoid shape so the eyeball never pokes through a half-closed lid.
      const open = Math.max(0, Math.min(1, face.open[i]!));
      _m.compose(_p, _q, _s.set(rx * pop, ry * pop, rz * pop)).multiply(_lid.makeRotationX(Math.PI / 2 - open * Math.PI).scale(_s.setScalar(LID_SCALE)));
      this.lids.setMatrixAt(i, _m);
    });
    this.eyes.instanceMatrix.needsUpdate = true; this.lids.instanceMatrix.needsUpdate = true;
    const d = this.template.decal;
    if (this.decal && d) {
      const out = this.decal.geometry.attributes.position!;
      for (let i = 0; i < d.source.length; i++) {
        const v = d.source[i]!;
        out.setXYZ(i, positions.getX(v) + normals.getX(v) * DECAL_LIFT, positions.getY(v) + normals.getY(v) * DECAL_LIFT, positions.getZ(v) + normals.getZ(v) * DECAL_LIFT);
      }
      out.needsUpdate = true;
      const key = decalKey(face);
      if (key !== this.key && this.canvas) { this.key = key; paintFace(this.canvas, this.template.bread, face); this.texture!.needsUpdate = true; }
    }
  }
  dispose(): void {
    this.group.removeFromParent();
    this.eyes.material.dispose(); this.lids.material.dispose(); this.eyes.dispose(); this.lids.dispose();
    if (this.decal) { this.decal.geometry.dispose(); this.decal.material.dispose(); }
    this.texture?.dispose(); this.canvas = null;
  }
}

// Draws brows, cheeks, mouth, sweat and stylised shut/happy eyes onto the decal canvas (face-local metres → pixels).
export function paintFace(canvas: HTMLCanvasElement, bread: BreadId, face: FaceFrame): void {
  const c = canvas.getContext('2d'); if (!c) return;
  const spec = FACES[bread], { x0, x1, y0, y1 } = spec.region, W = canvas.width, H = canvas.height;
  const X = (x: number): number => (x - x0) / (x1 - x0) * W, Y = (y: number): number => (1 - (y - y0) / (y1 - y0)) * H, S = Math.min(W / (x1 - x0), H / (y1 - y0));
  c.clearRect(0, 0, W, H); c.lineCap = 'round'; c.lineJoin = 'round';
  const line = (width: number, color: string = FACE_COLORS.line): void => { c.lineWidth = width * LINE_BOOST * S; c.strokeStyle = color; };
  // Cheeks: soft blush under the outer eye corners.
  if (face.cheek > 0) for (const [i, eye] of spec.eyes.entries()) {
    const cx = X(eye.x + (i ? 1 : -1) * eye.radius[0] * .55), cy = Y(eye.y - eye.radius[1] * 1.45), r = eye.radius[0] * .8 * S;
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, `rgba(232,130,106,${.55 * face.cheek})`); g.addColorStop(1, 'rgba(232,130,106,0)');
    c.fillStyle = g; c.beginPath(); c.ellipse(cx, cy, r, r * .6, 0, 0, Math.PI * 2); c.fill();
  }
  // Brows above each eye (mirrored: i=0 is the bread's left).
  for (const [i, eye] of spec.eyes.entries()) {
    if (face.brow === 'none') break;
    const side = i ? 1 : -1, bx = eye.x, by = eye.y + eye.radius[1] * 1.1 + .016, half = eye.radius[0] * .8;
    const tilt = face.brow === 'worry' ? .035 : face.brow === 'angry' ? -.03 : 0, arch = face.brow === 'up' ? .025 : .006;
    line(bread === 'shokupan' ? .02 : .013);
    c.beginPath(); c.moveTo(X(bx - side * half), Y(by + tilt)); c.quadraticCurveTo(X(bx), Y(by + (tilt > 0 ? tilt * .6 : 0) + arch + (face.brow === 'up' ? .01 : 0)), X(bx + side * half), Y(by - (tilt > 0 ? 0 : tilt * .3))); c.stroke();
  }
  // Stylised eyes when the eyeballs are hidden.
  if (face.eyes !== 'ball') for (const eye of spec.eyes) {
    const ex = X(eye.x), ey = Y(eye.y), rx = eye.radius[0] * S * .8, ry = eye.radius[1] * S * .5;
    line(.014); c.beginPath();
    if (face.eyes === 'happy') { c.moveTo(ex - rx, ey + ry * .4); c.quadraticCurveTo(ex, ey - ry * 1.4, ex + rx, ey + ry * .4); }
    else { c.moveTo(ex - rx, ey - ry * .2); c.quadraticCurveTo(ex, ey + ry * 1.1, ex + rx, ey - ry * .2); }
    c.stroke();
  }
  // Baguette lashes: two short strokes at each outer corner.
  if (bread === 'francepan' && face.eyes === 'ball') for (const [i, eye] of spec.eyes.entries()) {
    const side = i ? 1 : -1; line(.007);
    for (const k of [0, 1]) { const ax = eye.x + side * eye.radius[0] * .92, ay = eye.y + eye.radius[1] * (.35 - k * .35); c.beginPath(); c.moveTo(X(ax), Y(ay)); c.lineTo(X(ax + side * .03), Y(ay + .012 - k * .01)); c.stroke(); }
  }
  paintMouth(c, bread, face, spec, X, Y, S);
  if (face.sweat) {
    const sx = X(spec.sweat.x), sy = Y(spec.sweat.y), r = spec.sweat.r * S;
    c.fillStyle = FACE_COLORS.sweat; c.strokeStyle = '#7fb5cc'; c.lineWidth = .004 * S;
    c.beginPath(); c.moveTo(sx, sy - r * 1.8); c.quadraticCurveTo(sx + r * 1.1, sy, sx, sy + r); c.quadraticCurveTo(sx - r * 1.1, sy, sx, sy - r * 1.8); c.fill(); c.stroke();
    c.fillStyle = '#ffffffcc'; c.beginPath(); c.arc(sx - r * .3, sy - r * .1, r * .25, 0, Math.PI * 2); c.fill();
  }
}
function paintMouth(c: CanvasRenderingContext2D, bread: BreadId, face: FaceFrame, spec: FaceSpec, X: (x: number) => number, Y: (y: number) => number, S: number): void {
  const m = spec.mouth, cx = X(m.x), cy = Y(m.y), w = m.w * S / 2, h = m.h * S / 2, droop = face.droop * .12 * h;
  const lip = (fill: string, stroke: string = '#6e3a34'): void => { c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = .006 * S; c.fill(); c.stroke(); };
  const dark = (): void => lip('#4a1f1d', '#3a1714');
  const teeth = (x: number, y: number, tw: number, th: number): void => { c.beginPath(); c.rect(x, y, tw, th); lip(FACE_COLORS.tooth, '#8a6a5a'); };
  // Oddly human lips: a cupid's-bow upper lip, a fuller glossy lower lip; corners sag with fatigue.
  const lips = (x: number, y: number, lw: number, lh: number, sag = 0): void => {
    c.beginPath(); c.moveTo(x - lw, y + sag);
    c.bezierCurveTo(x - lw * .6, y - lh * .55, x - lw * .28, y - lh * .8, x, y - lh * .42); c.bezierCurveTo(x + lw * .28, y - lh * .8, x + lw * .6, y - lh * .55, x + lw, y + sag);
    c.bezierCurveTo(x + lw * .55, y + lh * 1.05, x - lw * .55, y + lh * 1.05, x - lw, y + sag); lip(FACE_COLORS.lip);
    c.beginPath(); c.moveTo(x - lw * .96, y + sag); c.bezierCurveTo(x - lw * .4, y + lh * .12, x + lw * .4, y + lh * .12, x + lw * .96, y + sag);
    c.strokeStyle = '#5a2b28'; c.lineWidth = .005 * S; c.stroke();
    c.fillStyle = 'rgba(255,240,235,.45)'; c.beginPath(); c.ellipse(x - lw * .18, y + lh * .5, lw * .3, lh * .13, -.1, 0, Math.PI * 2); c.fill();
  };
  c.lineCap = 'round'; c.lineJoin = 'round';
  switch (face.mouth) {
    case 'calm':
      if (bread === 'shokupan') {
        lips(cx, cy, w * .72, h * .7, droop);
      } else if (bread === 'francepan') {
        // Pursed lips.
        c.beginPath(); c.ellipse(cx, cy + droop * .3, w * .42, h * .6, 0, 0, Math.PI * 2); lip(FACE_COLORS.lip);
        c.beginPath(); c.ellipse(cx, cy + droop * .3, w * .13, h * .2, 0, 0, Math.PI * 2); dark();
        c.fillStyle = 'rgba(255,240,235,.45)'; c.beginPath(); c.ellipse(cx - w * .16, cy + h * .3, w * .12, h * .1, -.4, 0, Math.PI * 2); c.fill();
      } else if (bread === 'melonpan' || bread === 'creampan') {
        // A small even smile; the cream pan's is wider and open.
        const open = bread === 'creampan';
        c.beginPath(); c.moveTo(cx - w * (open ? .8 : .5), cy - h * .2 + droop); c.quadraticCurveTo(cx, cy + h * (open ? 1.2 : .7), cx + w * (open ? .8 : .5), cy - h * .2 + droop);
        if (open) { c.quadraticCurveTo(cx, cy + h * .15, cx - w * .8, cy - h * .2 + droop); dark(); }
        else { c.strokeStyle = FACE_COLORS.line; c.lineWidth = .012 * LINE_BOOST * S; c.stroke(); }
      } else if (bread === 'currypan') {
        // Cocky smirk, one corner up.
        c.beginPath(); c.moveTo(cx - w * .6, cy + h * .15 + droop); c.quadraticCurveTo(cx + w * .05, cy + h * .55, cx + w * .7, cy - h * .5 + droop * .4);
        c.strokeStyle = FACE_COLORS.line; c.lineWidth = .013 * LINE_BOOST * S; c.stroke();
      } else {
        // Crooked grin with a single tooth.
        c.beginPath(); c.moveTo(cx - w * .75, cy - h * .25 + droop); c.quadraticCurveTo(cx - w * .1, cy + h * 1.05, cx + w * .8, cy - h * .55 + droop); c.quadraticCurveTo(cx, cy - h * .05, cx - w * .75, cy - h * .25 + droop); dark();
        teeth(cx - w * .06, cy - h * .1, w * .18, h * .36);
      }
      break;
    case 'tight':
      c.beginPath(); c.moveTo(cx - w * .45, cy + droop * .3); c.bezierCurveTo(cx - w * .15, cy - h * .15, cx + w * .15, cy + h * .15, cx + w * .45, cy + droop * .3);
      c.strokeStyle = bread === 'shokupan' ? FACE_COLORS.lip : FACE_COLORS.line; c.lineWidth = (bread === 'shokupan' ? .02 : .011) * LINE_BOOST * S; c.stroke(); break;
    case 'attack':
      // The croissant keeps its single tooth even mid-swing.
      if (bread === 'croissant') { c.beginPath(); c.ellipse(cx, cy, w * .6, h * .6, 0, 0, Math.PI * 2); dark(); teeth(cx - .0175 * S, cy - h * .6, .035 * S, .023 * S); }
      else if (bread === 'francepan') { c.beginPath(); c.ellipse(cx, cy, w * .4, h * .75, 0, 0, Math.PI * 2); lip(FACE_COLORS.lip); c.beginPath(); c.ellipse(cx, cy, w * .2, h * .45, 0, 0, Math.PI * 2); dark(); }
      else if (bread === 'shokupan') lips(cx, cy, w * .45, h * .9, -h * .3);
      else { c.beginPath(); c.ellipse(cx, cy, w * (bread === 'creampan' ? .55 : .45), h * .7, 0, 0, Math.PI * 2); dark(); }
      break;
    case 'slack':
      c.beginPath(); c.ellipse(cx, cy + droop * .5, w * .3, h * .35, .1, 0, Math.PI * 2); dark(); break;
    case 'ouch':
      c.beginPath(); c.moveTo(cx - w * .7, cy + h * .45); c.lineTo(cx - w * .2, cy - h * .35); c.lineTo(cx + w * .25, cy + h * .2); c.lineTo(cx + w * .7, cy - h * .2);
      c.strokeStyle = FACE_COLORS.line; c.lineWidth = .013 * LINE_BOOST * S; c.stroke(); break;
    case 'grit':
      c.beginPath(); c.rect(cx - w * .7, cy - h * .38, w * 1.4, h * .76); lip(FACE_COLORS.tooth, '#3a1714');
      c.beginPath(); c.moveTo(cx - w * .7, cy); c.lineTo(cx + w * .7, cy); for (const k of [-.35, 0, .35]) { c.moveTo(cx + w * k, cy - h * .38); c.lineTo(cx + w * k, cy + h * .38); }
      c.strokeStyle = '#8a6a5a'; c.lineWidth = .004 * S; c.stroke(); break;
    case 'smug':
      c.beginPath(); c.moveTo(cx - w * .5, cy + h * .05); c.quadraticCurveTo(cx + w * .1, cy + h * .45, cx + w * .65, cy - h * .45);
      c.strokeStyle = bread === 'shokupan' ? FACE_COLORS.lip : FACE_COLORS.line; c.lineWidth = (bread === 'shokupan' ? .018 : .012) * LINE_BOOST * S; c.stroke();
      if (bread === 'croissant') teeth(cx + w * .02, cy + h * .02, w * .17, h * .28);
      break;
    case 'serious':
      c.beginPath(); c.moveTo(cx - w * .5, cy); c.lineTo(cx + w * .5, cy); c.strokeStyle = FACE_COLORS.line; c.lineWidth = .008 * LINE_BOOST * S; c.stroke(); break;
    case 'wild': case 'win':
      c.beginPath(); c.moveTo(cx - w * .85, cy - h * .45); c.quadraticCurveTo(cx, cy - h * .6, cx + w * .85, cy - h * .45); c.quadraticCurveTo(cx + w * .6, cy + h * 1.1, cx, cy + h * 1.05); c.quadraticCurveTo(cx - w * .6, cy + h * 1.1, cx - w * .85, cy - h * .45); dark();
      c.save(); c.clip(); c.fillStyle = '#d9707a'; c.beginPath(); c.ellipse(cx, cy + h * .95, w * .42, h * .42, 0, 0, Math.PI * 2); c.fill();
      if (bread === 'croissant') { c.fillStyle = FACE_COLORS.tooth; c.fillRect(cx - w * .05, cy - h * .55, w * .2, h * .42); }
      else if (face.mouth === 'wild') { c.fillStyle = FACE_COLORS.tooth; c.fillRect(cx - w * .7, cy - h * .6, w * 1.4, h * .32); }
      c.restore(); break;
    case 'lose':
      c.beginPath(); c.moveTo(cx - w * .45, cy + h * .3); c.quadraticCurveTo(cx, cy - h * .45, cx + w * .45, cy + h * .3);
      c.strokeStyle = FACE_COLORS.line; c.lineWidth = .011 * LINE_BOOST * S; c.stroke();
      if (bread === 'croissant') teeth(cx - w * .08, cy - h * .12, w * .16, h * .26);
      break;
    case 'huh':
      c.beginPath(); c.ellipse(cx + w * .15, cy, w * .16, h * .22, 0, 0, Math.PI * 2); dark(); break;
  }
}
