import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FaceRig, anchorAt, buildFaceTemplate } from './face-rig';
import { FaceState } from './face-state';
import { FACES, EYE_LIFT } from './face-config';
import { damageGeometry } from './renderer';
import { DAMAGE_DENT } from './feedback';

// A toast-sized slab: front face at z = .175 with a dense grid, like the loaded shokupan.
const slab = () => new THREE.BoxGeometry(1, 1.1, .35, 24, 26, 2);
const neutral = (bread: 'shokupan' | 'francepan' | 'croissant' = 'shokupan') => new FaceState(bread).update(0, { phase: 'ready', special: false, charging: false, stage: 0, ending: null, look: [0, 0] });
const eyeCentre = (rig: FaceRig, i: number) => {
  const eyes = rig.group.children[0] as THREE.InstancedMesh, m = new THREE.Matrix4(); eyes.getMatrixAt(i, m);
  return new THREE.Vector3().setFromMatrixPosition(m);
};

describe('face anchors', () => {
  it('finds the front-most surface under a point and rebuilds it from barycentrics', () => {
    const geometry = slab(), anchor = anchorAt(geometry, .1, .2)!, pos = geometry.attributes.position!;
    const point = new THREE.Vector3();
    for (const [v, k] of [[anchor.a, anchor.u], [anchor.b, anchor.v], [anchor.c, anchor.w]] as const) point.add(new THREE.Vector3().fromBufferAttribute(pos, v).multiplyScalar(k));
    expect(point.x).toBeCloseTo(.1); expect(point.y).toBeCloseTo(.2); expect(point.z).toBeCloseTo(.175);
    expect(anchorAt(geometry, 3, 3)).toBeNull();
  });
  it('cuts the decal from front-facing triangles inside the face region only', () => {
    const geometry = slab(), template = buildFaceTemplate('shokupan', geometry), d = template.decal!, pos = geometry.attributes.position!, normal = geometry.attributes.normal!;
    const { x0, x1, y0, y1 } = FACES.shokupan.region;
    expect(template.eyes.every(Boolean)).toBe(true); expect(d.index.length).toBeGreaterThan(0);
    for (const v of d.source) {
      expect(pos.getX(v)).toBeGreaterThanOrEqual(x0); expect(pos.getX(v)).toBeLessThanOrEqual(x1);
      expect(pos.getY(v)).toBeGreaterThanOrEqual(y0); expect(pos.getY(v)).toBeLessThanOrEqual(y1);
      expect(normal.getZ(v)).toBeGreaterThan(.35);
    }
    for (const value of d.uv) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
  });
});

describe('face rig', () => {
  it('glues each eye to the deformed surface and leaves the template untouched', () => {
    const source = slab(), template = buildFaceTemplate('shokupan', source), before = new Float32Array(source.attributes.position!.array);
    const rig = new FaceRig(template), face = neutral();
    rig.update(face, source.attributes.position!, source.attributes.normal!);
    const rest = eyeCentre(rig, 0);
    expect(rest.x).toBeCloseTo(FACES.shokupan.eyes[0].x); expect(rest.y).toBeCloseTo(FACES.shokupan.eyes[0].y); expect(rest.z).toBeCloseTo(.175 + EYE_LIFT);
    // Dent the bread right under the eye (as the damage stages do) and push the whole front forward (as the bend does).
    const worn = source.clone(), positions = new Float32Array(source.attributes.position!.array), normals = new Float32Array(source.attributes.normal!.array);
    worn.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(positions.length).fill(1), 3));
    const dent = new THREE.Vector3(rest.x, rest.y, .175);
    damageGeometry(worn, positions, normals, new Float32Array(positions.length).fill(1), 3, [dent, dent, dent]);
    const bent = worn.attributes.position!;
    for (let i = 0; i < bent.count; i++) bent.setZ(i, bent.getZ(i) + .02);
    rig.update(face, bent, worn.attributes.normal!);
    const moved = eyeCentre(rig, 0);
    expect(moved.z).toBeLessThan(rest.z + .02 - DAMAGE_DENT * .5); expect(moved.z).toBeGreaterThan(rest.z + .02 - DAMAGE_DENT * 1.6);
    expect(Math.hypot(moved.x - rest.x, moved.y - rest.y)).toBeLessThan(.01);
    expect(Array.from(source.attributes.position!.array)).toEqual(Array.from(before));
    rig.dispose(); worn.dispose();
  });
  it('keeps pupils inside the eyeball travel and hides the eyeballs for drawn eyes', () => {
    const geometry = slab(), rig = new FaceRig(buildFaceTemplate('shokupan', geometry)), face = neutral(), eye = FACES.shokupan.eyes[0];
    rig.update({ ...face, gaze: [1, 1] }, geometry.attributes.position!, geometry.attributes.normal!);
    const centre = eyeCentre(rig, 0), pupil = eyeCentre(rig, 2);
    expect(pupil.x - centre.x).toBeLessThanOrEqual(eye.radius[0] * .22 + 1e-6); expect(pupil.x - centre.x).toBeGreaterThan(0);
    expect(pupil.y - centre.y).toBeLessThanOrEqual(eye.radius[1] * .15 + 1e-6);
    rig.update({ ...face, eyes: 'happy' }, geometry.attributes.position!, geometry.attributes.normal!);
    const eyes = rig.group.children[0] as THREE.InstancedMesh, m = new THREE.Matrix4(), s = new THREE.Vector3();
    for (let i = 0; i < 4; i++) { eyes.getMatrixAt(i, m); expect(s.setFromMatrixScale(m).length()).toBe(0); }
    rig.dispose();
  });
  it('moves the lids with each eye alone, so two rigs of the same bread never share an expression', () => {
    const geometry = slab(), template = buildFaceTemplate('shokupan', geometry), a = new FaceRig(template), b = new FaceRig(template);
    const lidMatrix = (rig: FaceRig) => { const m = new THREE.Matrix4(); (rig.group.children[1] as THREE.InstancedMesh).getMatrixAt(0, m); return m.elements.slice(); };
    a.update({ ...neutral(), open: [0, 0] }, geometry.attributes.position!, geometry.attributes.normal!);
    b.update(neutral(), geometry.attributes.position!, geometry.attributes.normal!);
    expect(lidMatrix(a)).not.toEqual(lidMatrix(b));
    a.dispose(); b.dispose();
  });
  it('frees its own materials on dispose and leaves the parent bread', () => {
    const geometry = slab(), rig = new FaceRig(buildFaceTemplate('croissant', geometry)), parent = new THREE.Object3D(); parent.add(rig.group);
    const disposed: string[] = [];
    rig.group.traverse(o => { if (o instanceof THREE.Mesh) (o.material as THREE.Material).addEventListener('dispose', () => disposed.push(o.name)); });
    rig.dispose();
    expect(disposed.length).toBe(2); expect(parent.children).toEqual([]);
  });
});
