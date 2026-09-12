import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BREADS, BREAD_IDS, clamp, type BreadId } from './config';
import { Battle, phase, pose, type BattleEvent, type Fighter, type Side } from './battle';

interface Model { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; positions: Float32Array; normals: Float32Array }
interface Crumb { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number }
export class TableRenderer {
  private renderer: THREE.WebGLRenderer; private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(46, 1, .1, 60);
  private templates = new Map<BreadId, Model>();
  private actors: Partial<Record<Side, Model>> = {}; private ids = '';
  private crumbs: Crumb[] = []; private marker: THREE.Mesh; private shadows: THREE.Mesh[] = [];
  private frames: number[] = []; private latencies: number[] = []; private resize: ResizeObserver;
  private lost = false;
  constructor(private canvas: HTMLCanvasElement, fail: (message: string) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.23;
    this.scene.background = new THREE.Color('#e5dbc7');
    this.scene.fog = new THREE.Fog('#e5dbc7', 13, 29);
    this.scene.add(new THREE.HemisphereLight('#fff7df', '#846b50', 2.8));
    const sun = new THREE.DirectionalLight('#fff5df', 3.4); sun.position.set(-3, 7, 5); this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#d9e9ff', 1.2); fill.position.set(3, 3, -4); this.scene.add(fill);
    this.table();
    this.marker = new THREE.Mesh(new THREE.RingGeometry(.25, .34, 48), new THREE.MeshBasicMaterial({ color: '#d3543d', transparent: true, opacity: .8, side: THREE.DoubleSide }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.position.y = .018; this.scene.add(this.marker);
    this.resize = new ResizeObserver(() => this.fit()); this.resize.observe(canvas); this.fit();
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; fail('3D描画が中断しました。再読み込みして再開してください。'); });
    canvas.addEventListener('webglcontextrestored', () => { fail('3D描画が復帰しました。再読み込みしてパンを読み直してください。'); });
  }
  private table(): void {
    const textureCanvas = document.createElement('canvas'); textureCanvas.width = 256; textureCanvas.height = 256;
    const c = textureCanvas.getContext('2d')!; c.fillStyle = '#bb8c59'; c.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 95; i++) { c.strokeStyle = i % 3 ? '#b3855330' : '#e3b97e45'; c.lineWidth = .8; c.beginPath(); c.moveTo(0, i * 2.71); c.bezierCurveTo(80, i * 2.71 + 4, 130, i * 2.71 - 5, 256, i * 2.71 + 2); c.stroke(); }
    const tex = new THREE.CanvasTexture(textureCanvas); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(3, 5);
    const table = new THREE.Mesh(new THREE.BoxGeometry(20, .22, 24), new THREE.MeshStandardMaterial({ map: tex, roughness: .85 })); table.position.y = -.13; this.scene.add(table);
    const mat = new THREE.MeshStandardMaterial({ color: '#f3ecd9', roughness: .94 });
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(5.2, .012, 9), mat); cloth.position.set(0, -.002, -1.8); this.scene.add(cloth);
    for (const x of [-2.42, 2.42]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(.018, .015, 9), new THREE.MeshStandardMaterial({ color: '#788a76', roughness: 1 })); seam.position.set(x, .007, -1.8); this.scene.add(seam);
    }
    const plateMat = new THREE.MeshStandardMaterial({ color: '#edf3e9', roughness: .3 });
    for (const [x, z, r] of [[-2.05, -2.2, .82], [2.8, 1.3, .9]]) {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(r!, r! * .83, .09, 48), plateMat); plate.position.set(x!, .065, z!); this.scene.add(plate);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(r! * .88, .04, 8, 48), plateMat); rim.rotation.x = Math.PI / 2; rim.position.set(x!, .13, z!); this.scene.add(rim);
    }
    const mugMat = new THREE.MeshStandardMaterial({ color: '#7f9c89', roughness: .45, side: THREE.DoubleSide });
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(.43, .34, .7, 40, 1, true), mugMat); cup.position.set(1.7, .36, -3.4); this.scene.add(cup);
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(.408, 40), new THREE.MeshStandardMaterial({ color: '#4a3025', roughness: .22 })); coffee.rotation.x = -Math.PI / 2; coffee.position.set(1.7, .63, -3.4); this.scene.add(coffee);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(.24, .07, 10, 24), mugMat); handle.position.set(2.13, .39, -3.4); this.scene.add(handle);
    for (let i = 0; i < 2; i++) {
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(.62, 32), new THREE.MeshBasicMaterial({ color: '#5a4030', transparent: true, opacity: .16, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.scale.set(1, .55, 1); shadow.position.y = .02; this.scene.add(shadow); this.shadows.push(shadow);
    }
  }
  async load(): Promise<void> {
    const loader = new GLTFLoader();
    await Promise.all(BREAD_IDS.map(async id => {
      const model = await loader.loadAsync(`${import.meta.env.BASE_URL}assets/models/${id}.glb`);
      model.scene.updateMatrixWorld(true);
      let found: THREE.Mesh | undefined;
      model.scene.traverse(o => { if (o instanceof THREE.Mesh) found = o; });
      if (!found) throw new Error(`${id}: mesh missing`);
      const geometry = found.geometry.clone().applyMatrix4(found.matrixWorld);
      geometry.scale(.92, .92, .92); geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!, center = bounds.getCenter(new THREE.Vector3()); geometry.translate(-center.x, -center.y, -center.z);
      const material = (found.material as THREE.MeshStandardMaterial).clone(); material.envMapIntensity = .7;
      const mesh = new THREE.Mesh(geometry, material);
      this.templates.set(id, { mesh, positions: new Float32Array(geometry.attributes.position!.array), normals: new Float32Array(geometry.attributes.normal!.array) });
    }));
  }
  private fit(): void {
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (width < 1 || height < 1) return;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height;
    // Preserve horizontal room for the widest bread at both dodge limits in portrait.
    this.camera.fov = clamp(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(17.5)) / this.camera.aspect) * 180 / Math.PI, 44, 78);
    this.camera.position.set(.9, 5.8, 7.1); this.camera.lookAt(0, 1.05, -.15); this.camera.updateProjectionMatrix();
  }
  private choose(battle: Battle): void {
    const ids = `${battle.player.bread}/${battle.cpu.bread}`;
    if (this.ids === ids) return;
    for (const side of ['player', 'cpu'] as const) {
      const old = this.actors[side];
      if (old) { this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
      const t = this.templates.get(battle[side].bread);
      if (!t) throw new Error('モデルの読み込みが完了していません。');
      const mesh = new THREE.Mesh(t.mesh.geometry.clone(), t.mesh.material.clone());
      this.actors[side] = { mesh, positions: t.positions, normals: t.normals }; this.scene.add(mesh);
    }
    this.ids = ids;
  }
  private actor(f: Fighter, side: Side, time: number): void {
    const m = this.actors[side]!, p = pose(f, side), b = BREADS[f.bread];
    m.mesh.position.set(p.x, p.y + Math.sin(time * 2.2 + (side === 'cpu' ? 1 : 0)) * .025, p.z);
    m.mesh.rotation.set(p.lean + Math.sin(f.hit * 75) * f.hit * .12, side === 'player' ? Math.PI + .12 : -.08, Math.sin(f.hit * 55) * f.hit * .1);
    // Visual deformation is <= 3 cm; collision stays tied to the same controlled root pose.
    const bend = Math.sin(Math.max(0, p.progress) * Math.PI) * .03 + Math.sin(f.hit * 60) * f.hit * .025;
    const pos = m.mesh.geometry.attributes.position!, normal = m.mesh.geometry.attributes.normal!;
    for (let i = 0; i < pos.count; i++) {
      const offset = i * 3, y = m.positions[offset + 1]!, weight = (y + b.height) / (2 * b.height);
      pos.setZ(i, m.positions[offset + 2]! + bend * weight * weight);
      const nx = m.normals[offset]!, nz = m.normals[offset + 2]!, ny = m.normals[offset + 1]! - bend * weight / b.height * nz;
      const len = Math.hypot(nx, ny, nz); normal.setXYZ(i, nx / len, ny / len, nz / len);
    }
    pos.needsUpdate = true; normal.needsUpdate = true;
    m.mesh.material.emissive.set(f.hit > 0 ? '#d95d27' : '#000000'); m.mesh.material.emissiveIntensity = f.hit * 1.5;
    const shadow = this.shadows[side === 'player' ? 0 : 1]!; shadow.position.x = p.x; shadow.position.z = p.z;
  }
  effect(event: BattleEvent): void {
    if (event.kind !== 'hit' && event.kind !== 'clash') return;
    for (let i = 0; i < 12; i++) {
      const mesh = new THREE.Mesh(new THREE.TetrahedronGeometry(.024 + i % 3 * .012), new THREE.MeshBasicMaterial({ color: i % 2 ? '#ebba6b' : '#fff0c9' }));
      mesh.position.set(event.x, 1.45, event.z); this.scene.add(mesh);
      this.crumbs.push({ mesh, vx: Math.cos(i * 2.4) * 1.3, vy: 1 + i % 4 * .2, vz: Math.sin(i * 2.4), life: .55 });
    }
  }
  render(battle: Battle, time: number, dt: number, active: boolean): void {
    if (this.lost) return;
    this.choose(battle); this.actor(battle.player, 'player', time); this.actor(battle.cpu, 'cpu', time);
    const a = battle.cpu.attack;
    this.marker.visible = active && phase(battle.cpu) === 'windup';
    if (a) { this.marker.position.set(a.aim, .025, 1.2); this.marker.scale.setScalar(1.2 + .08 * Math.sin(time * 12)); }
    for (let i = this.crumbs.length - 1; i >= 0; i--) {
      const c = this.crumbs[i]!; c.life -= dt; c.vy -= dt * 4;
      c.mesh.position.addScaledVector(new THREE.Vector3(c.vx, c.vy, c.vz), dt);
      if (c.life <= 0) { this.scene.remove(c.mesh); c.mesh.geometry.dispose(); (c.mesh.material as THREE.Material).dispose(); this.crumbs.splice(i, 1); }
    }
    this.renderer.render(this.scene, this.camera);
    if (active && dt > 0) { this.frames.push(dt * 1000); if (this.frames.length > 12000) this.frames.shift(); }
  }
  noteLatency(ms: number): void { if (Number.isFinite(ms) && ms >= 0) this.latencies.push(ms); }
  resetMetrics(): void { this.frames = []; this.latencies = []; }
  projectedBounds(): Record<string, { left: number; right: number; top: number; bottom: number }> {
    const result: Record<string, { left: number; right: number; top: number; bottom: number }> = {};
    for (const [side, actor] of Object.entries(this.actors)) {
      const bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }, v = new THREE.Vector3();
      actor.mesh.updateMatrixWorld(true);
      const positions = actor.mesh.geometry.attributes.position!;
      for (let i = 0; i < positions.count; i++) {
        v.fromBufferAttribute(positions, i).applyMatrix4(actor.mesh.matrixWorld).project(this.camera);
        const x = (v.x + 1) / 2, y = (1 - v.y) / 2;
        bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x); bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
      }
      result[side] = bounds;
    }
    return result;
  }
  metrics(): { fps: number; p95FrameMs: number; slowFrames: number; maxAttackMs: number; attackSamples: number; frames: number; drawCalls: number; triangles: number } {
    const values = [...this.frames].sort((a, b) => a - b);
    return { fps: values.length ? 1000 / (values.reduce((a, b) => a + b, 0) / values.length) : 0,
      p95FrameMs: values[Math.floor(values.length * .95)] ?? 0, slowFrames: values.filter(v => v > 33.4).length,
      maxAttackMs: this.latencies.length ? Math.max(...this.latencies) : 0, attackSamples: this.latencies.length, frames: values.length,
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }
  dispose(): void { this.resize.disconnect(); this.renderer.dispose(); }
}
