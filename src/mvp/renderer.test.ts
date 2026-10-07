import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TableRenderer, damageGeometry, impactStrength } from './renderer';
import { DAMAGE_DENT, deformVertex, ReplayBuffer, VISUAL_LIMITS } from './feedback';
import { Battle, HIT_STOP_KO_SECONDS, type Fighter, type Side } from './battle';
import { STEP } from './config';
import { FaceState } from './face-state';

function actorRenderer(cpu: boolean, reduced = false) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .3), new THREE.MeshStandardMaterial());
  const positions = new Float32Array(mesh.geometry.attributes.position!.array), normals = new Float32Array(mesh.geometry.attributes.normal!.array);
  const colors = new Float32Array(positions.length).fill(1);
  mesh.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors.slice(), 3));
  const model = { mesh, positions, normals, colors, wornPositions: positions, wornNormals: normals, stage: 0, displayStage: 0, displayHeat: 0,
    rig: { update: () => {} }, expression: new FaceState('shokupan'), dents: [] };
  const impact = { life: .18, direction: new THREE.Vector3(0, 0, 1), strength: 1 };
  const reducedMotion = { matches: reduced };
  const renderer = Object.assign(Object.create(TableRenderer.prototype), { actors: { cpu: model }, impacts: { cpu: impact }, hitFlashes: { cpu: .04 }, contacts: {},
    reducedMotion, hitStopEffects: cpu, heat: 0, shadows: [new THREE.Mesh(), new THREE.Mesh()] }) as {
      hitStopEffects: boolean;
      actor(fighter: Fighter, side: Side, time: number, dt: number, other: Fighter): ReturnType<TableRenderer['actor']>;
      drawActor(side: Side, frame: ReturnType<TableRenderer['actor']>): void;
    };
  return { renderer, mesh, impact, reducedMotion };
}

describe('contact compression', () => {
  it('draws the CPU victim compressed and weakly white on the first contact frame, retaining the online curve', () => {
    const b = new Battle('shokupan', 'shokupan'); b.cpu.hit = .3;
    const local = actorRenderer(true), online = actorRenderer(false);
    const contact = local.renderer.actor(b.cpu, 'cpu', 0, 0, b.player);
    expect(contact.impact).toBe(1); expect(contact.flash).toBe(1);
    expect(local.mesh.material.emissive.getHexString()).toBe('ffffff'); expect(local.mesh.material.emissiveIntensity).toBe(.30);
    expect(online.renderer.actor(b.cpu, 'cpu', 0, 0, b.player).impact).toBeCloseTo(0);
    expect(online.mesh.material.emissive.getHexString()).toBe('d95d27');
    local.impact.life = .09; expect(local.renderer.actor(b.cpu, 'cpu', .09, .09, b.player).impact).toBeLessThan(contact.impact);
  });
  it.each([0, .09, .18])('preserves legacy online hit rotation and vertices under reduced motion at contact life %s', life => {
    const b = new Battle('shokupan', 'shokupan'); b.cpu.hit = .3;
    const online = actorRenderer(false), reduced = actorRenderer(false, true);
    online.impact.life = reduced.impact.life = life;
    online.renderer.actor(b.cpu, 'cpu', 0, 0, b.player);
    const contact = reduced.renderer.actor(b.cpu, 'cpu', 0, 0, b.player);
    // The pre-hit-stop online pose retains f.hit vibration even under reduced motion.
    expect([reduced.mesh.rotation.x, reduced.mesh.rotation.y, reduced.mesh.rotation.z]).toEqual([
      Math.sin(b.cpu.hit * 75) * b.cpu.hit * .12, -.08, Math.sin(b.cpu.hit * 55) * b.cpu.hit * .1,
    ]);
    expect(reduced.mesh.geometry.attributes.position!.array).toEqual(online.mesh.geometry.attributes.position!.array);
    expect(reduced.mesh.geometry.attributes.position!.array).not.toEqual(contact.positions);
    expect(reduced.mesh.material.emissive.getHexString()).toBe('d95d27');
    expect(reduced.mesh.material.emissiveIntensity).toBe(b.cpu.hit * 1.5);
    // Replaying an online frame retains that presentation even if the renderer now opts into CPU effects.
    const replay = new ReplayBuffer<typeof contact>(); replay.record(.1, contact);
    reduced.renderer.hitStopEffects = true; expect(replay.start(true)).toBe(true);
    reduced.renderer.drawActor('cpu', replay.next(0, true)!.value);
    expect(reduced.mesh.rotation.toArray()).toEqual(online.mesh.rotation.toArray());
    expect(reduced.mesh.geometry.attributes.position!.array).toEqual(online.mesh.geometry.attributes.position!.array);
  });
  it('reduced motion omits the CPU contact deformation, white flash and hit vibration', () => {
    const b = new Battle('shokupan', 'shokupan'); b.cpu.hit = .3;
    const { renderer, mesh } = actorRenderer(true, true);
    const frame = renderer.actor(b.cpu, 'cpu', 0, 0, b.player);
    expect(frame.impact).toBe(0); expect(frame.flash).toBe(0); expect(frame.bend).toBe(0); expect(frame.rotation[0]).toBe(0); expect(frame.rotation[2]).toBe(0);
    expect(mesh.material.emissive.getHexString()).not.toBe('ffffff');
  });
  it('replays a normal-motion K.O. without contact compression, hit vibration or white flash after switching to reduced motion', () => {
    const b = new Battle('shokupan', 'shokupan'); b.cpuEnabled = false; b.cpu.hp = 18; b.attack('player');
    for (let i = 0; i < 4 / STEP && !b.hitStopping; i++) b.advance(STEP, 0);
    expect(b.outcome).toBe('win'); expect(b.hitStopRemaining).toBe(HIT_STOP_KO_SECONDS);
    const { renderer, mesh, reducedMotion } = actorRenderer(true);
    const contact = renderer.actor(b.cpu, 'cpu', b.elapsed, 0, b.player), normalPositions = new Float32Array(mesh.geometry.attributes.position!.array);
    expect(contact.impact).toBe(1); expect(contact.flash).toBe(1); expect(contact.rotation).not.toEqual(contact.rotationWithoutHit);
    expect(contact.bend).not.toBe(contact.bendWithoutHit); expect(contact.bendWithoutHit).toBe(0); expect(contact.stage).toBe(3);
    const replay = new ReplayBuffer<typeof contact>(); replay.record(HIT_STOP_KO_SECONDS, contact);
    // Playback bypasses render(), so the current mode may differ from the recorded mode.
    renderer.hitStopEffects = false;
    reducedMotion.matches = true; expect(replay.start(true)).toBe(true);
    renderer.drawActor('cpu', replay.next(0, true)!.value);
    expect([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z]).toEqual(contact.rotationWithoutHit);
    expect(mesh.geometry.attributes.position!.array).toEqual(contact.positions);
    expect(mesh.material.emissive.getHexString()).toBe('d95d27');
    // Playback never changes the recorded frame, so normal motion can still reproduce the hit.
    reducedMotion.matches = false; expect(replay.start()).toBe(true); renderer.drawActor('cpu', replay.next(0)!.value);
    expect([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z]).toEqual(contact.rotation);
    expect(mesh.geometry.attributes.position!.array).toEqual(normalPositions);
    expect(mesh.material.emissive.getHexString()).toBe('ffffff'); expect(mesh.material.emissiveIntensity).toBe(.30);
  });
  it('keeps attack lean and bend while removing only the recorded hit vibration', () => {
    const b = new Battle('shokupan', 'shokupan'); b.attack('cpu'); b.cpu.attack!.age = b.cpu.attack!.windup + .05; b.cpu.hit = .3;
    const local = actorRenderer(true), calm = actorRenderer(true, true), frame = local.renderer.actor(b.cpu, 'cpu', 0, 0, b.player);
    expect(frame.bendWithoutHit).toBeGreaterThan(0); expect(frame.rotationWithoutHit[0]).not.toBe(0);
    calm.renderer.actor({ ...b.cpu, hit: 0 }, 'cpu', 0, 0, b.player);
    local.reducedMotion.matches = true; local.renderer.drawActor('cpu', frame);
    expect(local.mesh.rotation.toArray()).toEqual(calm.mesh.rotation.toArray());
    expect(local.mesh.geometry.attributes.position!.array).toEqual(calm.mesh.geometry.attributes.position!.array);
  });
  it('starts compressed, holds with zero effect time, then decays to the original shape', () => {
    let life = .18;
    const initial = deformVertex(0, 0, .3, 0, [0, 0, 1], impactStrength(life));
    expect(.3 - initial[2]).toBeCloseTo(VISUAL_LIMITS.squash);
    life -= 0; expect(deformVertex(0, 0, .3, 0, [0, 0, 1], impactStrength(life))).toEqual(initial);
    life -= .09;
    const fading = deformVertex(0, 0, .3, 0, [0, 0, 1], impactStrength(life));
    expect(fading[2]).toBeGreaterThan(initial[2]); expect(fading[2]).toBeLessThan(.3);
    expect(deformVertex(0, 0, .3, 0, [0, 0, 1], impactStrength(0))).toEqual([0, 0, .3]);
  });
  it('bounds immediate contact deformation, including bend, and has no effect after expiry', () => {
    for (const life of [-1, 0, .09, .18, 1]) for (const direction of [[1, 0, 0], [0, 0, 1]]) {
      const point = [.7, .4, .3] as const, deformed = deformVertex(...point, .03, direction, impactStrength(life));
      expect(Math.hypot(...deformed.map((v, i) => v - point[i]!))).toBeLessThanOrEqual(VISUAL_LIMITS.deformation + 1e-9);
    }
    expect(impactStrength(-1)).toBe(0); expect(impactStrength(1)).toBe(1);
  });
});

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
