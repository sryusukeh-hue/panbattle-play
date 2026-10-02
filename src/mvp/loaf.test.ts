import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildLoaf, loafOutline, LOAF_SIZE, LOAF_BACK } from './loaf';
import { buildFaceTemplate } from './face-rig';
import { FACES } from './face-config';

describe('procedural boss loaf', () => {
  const size = { width: 1.5, height: 1.6, length: 1.7 };
  const geometry = buildLoaf(size);
  it('is a closed, consistently wound mesh (every edge shared by exactly two triangles in opposite directions)', () => {
    const index = geometry.index!.array, edges = new Map<string, number>();
    for (let i = 0; i < index.length; i += 3) for (let k = 0; k < 3; k++) {
      const a = index[i + k]!, b = index[i + (k + 1) % 3]!, key = `${a}>${b}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    for (const [key, count] of edges) { expect(count).toBe(1); const [a, b] = key.split('>'); expect(edges.get(`${b}>${a}`)).toBe(1); }
  });
  it('fits the requested size with its base on y=0', () => {
    geometry.computeBoundingBox(); const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(size.width, 1); expect(box.min.y).toBeGreaterThanOrEqual(0); expect(box.min.y).toBeLessThan(.03);
    expect(box.max.y).toBeGreaterThan(size.height * .98); expect(box.max.y).toBeLessThan(size.height * 1.12);
    expect(box.max.z - box.min.z).toBeGreaterThan(size.length); expect(box.max.z - box.min.z).toBeLessThan(size.length + .12);
  });
  it('faces its cut end toward +z (outward normals) and stays light enough to deform every frame', () => {
    const pos = geometry.attributes.position!, normal = geometry.attributes.normal!;
    let front = 0; for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > size.length / 2 && Math.abs(pos.getX(i)) < .3 && Math.abs(pos.getY(i) - .75) < .3) { front++; expect(normal.getZ(i)).toBeGreaterThan(.8); }
    expect(front).toBeGreaterThan(4);
    expect(pos.count).toBeLessThan(3500); expect(geometry.index!.count / 3).toBeLessThan(7000);
    expect(geometry.attributes.color!.count).toBe(pos.count); expect(geometry.attributes.uv!.count).toBe(pos.count);
  });
  it('reuses the toast slice silhouette', () => {
    const outline = loafOutline(), xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(.56, 1); expect(Math.max(...ys)).toBeCloseTo(1.235, 1);
    expect(new THREE.Box3().setFromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute).isEmpty()).toBe(false);
  });
  it('carries the boss face: both eyes find the cut face and the decal covers mouth, brows and sweat', () => {
    // Same preparation as renderer.load(): ×0.92, centred, then pushed back so the cut face is the hit box's front.
    const g = buildLoaf(LOAF_SIZE).scale(.92, .92, .92); g.computeBoundingBox();
    const c = g.boundingBox!.getCenter(new THREE.Vector3()); g.translate(-c.x, -c.y, -c.z).translate(0, 0, LOAF_BACK); g.computeBoundingBox();
    expect(g.boundingBox!.max.x).toBeCloseTo(.75, 1); expect(g.boundingBox!.max.y).toBeGreaterThan(.75); expect(g.boundingBox!.max.y).toBeLessThan(.85);
    expect(g.boundingBox!.max.z).toBeGreaterThan(.6); expect(g.boundingBox!.max.z).toBeLessThan(.72);
    const face = buildFaceTemplate('ikkin', g), spec = FACES.ikkin;
    expect(face.eyes.every(Boolean)).toBe(true);
    expect(face.decal!.index.length / 3).toBeGreaterThan(200);
    const pos = g.attributes.position!, xs = [...face.decal!.source].map(i => pos.getX(i)), ys = [...face.decal!.source].map(i => pos.getY(i));
    expect(Math.min(...ys)).toBeLessThan(spec.mouth.y - spec.mouth.h); expect(Math.max(...ys)).toBeGreaterThan(spec.eyes[0].y + spec.eyes[0].radius[1]);
    expect(Math.max(...xs)).toBeGreaterThan(spec.sweat.x);
  });
});
