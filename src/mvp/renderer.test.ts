import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { damageGeometry } from './renderer';
import { DAMAGE_DENT } from './feedback';

describe('cloned bread damage', () => {
  it('darkens vertex colors and dents only near contact, preserving and restoring the original mesh', () => {
    const source = new THREE.BoxGeometry(1, 1, .3, 8, 8, 2), geometry = source.clone();
    const positions = new Float32Array(source.attributes.position!.array), normals = new Float32Array(source.attributes.normal!.array);
    const colors = new Float32Array(positions.length).fill(1); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors.slice(), 3));
    const contact = new THREE.Vector3(.5, .5, .15);
    damageGeometry(geometry, positions, normals, colors, 3, [contact, contact, contact]);
    const changed = geometry.attributes.position!;
    let dented = 0, unchanged = 0;
    for (let i = 0; i < changed.count; i++) {
      const delta = new THREE.Vector3().fromBufferAttribute(changed, i).sub(new THREE.Vector3().fromArray(positions, i * 3));
      expect(delta.length()).toBeLessThanOrEqual(DAMAGE_DENT + 1e-7);
      expect(delta.dot(new THREE.Vector3().fromArray(normals, i * 3))).toBeLessThanOrEqual(1e-8);
      if (delta.length() > 1e-8) dented++; else unchanged++;
    }
    expect(dented).toBeGreaterThan(0); expect(unchanged).toBeGreaterThan(0);
    expect(geometry.attributes.color!.getY(0)).toBeCloseTo(.87 ** 3);
    expect(source.attributes.position!.array).toEqual(positions); expect(colors.every(v => v === 1)).toBe(true);
    damageGeometry(geometry, positions, normals, colors, 0, []);
    expect(geometry.attributes.position!.array).toEqual(positions); expect(geometry.attributes.normal!.array).toEqual(normals); expect(geometry.attributes.color!.array).toEqual(colors);
    source.dispose(); geometry.dispose();
  });
});
