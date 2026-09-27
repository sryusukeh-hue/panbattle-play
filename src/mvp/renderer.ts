import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BREADS, BREAD_IDS, clamp, type BreadId } from './config';
import { phase, pose, type BattleView, type BattleEvent, type Fighter, type Side } from './battle';
import { BattleFeedback, ReplayBuffer, damageStage, DAMAGE_DENT, deformVertex, VISUAL_LIMITS, type BattleSound } from './feedback';

interface Model { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; positions: Float32Array; normals: Float32Array; colors: Float32Array }
interface Actor extends Model { stage: number; displayStage: number; dents: THREE.Vector3[]; wornPositions: Float32Array; wornNormals: Float32Array }
interface ActorFrame { position: THREE.Vector3Tuple; rotation: THREE.Vector3Tuple; height: number; bend: number; direction: number[]; impact: number; hit: number; stage: number; positions: Float32Array; normals: Float32Array }
export type StanceCue = 'ready' | 'locked' | 'recovery' | 'counter';
interface Crumb { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number; rests: boolean }
interface Accent { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; life: number; duration: number }
export function damageGeometry(geometry: THREE.BufferGeometry, positions: Float32Array, normals: Float32Array, colors: Float32Array, stage: number, dents: readonly THREE.Vector3[]): void {
  const pos = geometry.attributes.position!, color = geometry.attributes.color!;
  for (let i = 0; i < pos.count; i++) {
    const o = i * 3, x = positions[o]!, y = positions[o + 1]!, z = positions[o + 2]!;
    let depth = 0;
    for (const dent of dents) depth += DAMAGE_DENT / 3 * Math.max(0, 1 - Math.hypot(x - dent.x, y - dent.y, z - dent.z) / .5);
    depth = stage === 0 ? 0 : Math.min(DAMAGE_DENT, depth);
    pos.setXYZ(i, x - normals[o]! * depth, y - normals[o + 1]! * depth, z - normals[o + 2]! * depth);
    color.setXYZ(i, colors[o]! * .94 ** stage, colors[o + 1]! * .87 ** stage, colors[o + 2]! * .79 ** stage);
  }
  pos.needsUpdate = true; color.needsUpdate = true;
  if (stage) geometry.computeVertexNormals();
  else { (geometry.attributes.normal!.array as Float32Array).set(normals); geometry.attributes.normal!.needsUpdate = true; }
}
export class TableRenderer {
  private renderer: THREE.WebGLRenderer; private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(46, 1, .1, 60);
  private templates = new Map<BreadId, Model>();
  private actors: Partial<Record<Side, Actor>> = {}; private ids = '';
  private crumbs: Crumb[] = []; private marker: THREE.Mesh; private shadows: THREE.Mesh[] = [];
  private frames: number[] = []; private latencies: number[] = []; private resize: ResizeObserver;
  private lost = false;
  private feedback = new BattleFeedback();
  private accents: Accent[] = [];
  private impacts: Partial<Record<Side, { life: number; direction: THREE.Vector3 }>> = {};
  private contacts: Partial<Record<Side, THREE.Vector3>> = {};
  private shake = 0; private zoom = 0;
  private replay = new ReplayBuffer<Record<Side, ActorFrame>>();
  private previous: Partial<Record<Side, { id: number; x: number; z: number }>> = {};
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private motionChanged = (): void => { this.clearEffects(); };
  // Winner/loser reaction after a decisive match; presentation only.
  private ending: { winner: Side | 'draw'; start: number } | null = null;
  private envMap: THREE.Texture; private shadowFrame = 0;
  // Player-state ring under the player's bread: ready / locked / recovering / counter chance.
  private stance: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  constructor(private canvas: HTMLCanvasElement, fail: (message: string) => void,
    private playSound: (sound: BattleSound, delay?: number, bread?: BreadId) => void = () => {}, private stopSound: () => void = () => {}) {
    this.reducedMotion.addEventListener('change', this.motionChanged);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color('#e5dbc7');
    this.scene.fog = new THREE.Fog('#e5dbc7', 13, 29);
    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    // Reflections only on the breads; everything else skips the env lookup (see the plan's perf record).
    this.envMap = pmrem.fromScene(room, .04).texture;
    room.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight('#fff7df', '#846b50', 2.1));
    const sun = new THREE.DirectionalLight('#fff3d6', 3.2); sun.position.set(-1.6, 9, 3); this.scene.add(sun, sun.target);
    // Shadow frustum covers only the arena so a 1024 map stays sharp and cheap.
    sun.castShadow = true; sun.shadow.mapSize.set(512, 512); sun.shadow.bias = -.0008; sun.shadow.normalBias = .02; sun.shadow.radius = 3;
    // Only the two breads move, so the shadow map refreshes every other frame (see render()).
    this.renderer.shadowMap.autoUpdate = false;
    Object.assign(sun.shadow.camera, { left: -3.4, right: 3.4, top: 4, bottom: -4, near: 2, far: 16 }); sun.shadow.camera.updateProjectionMatrix();
    const fill = new THREE.DirectionalLight('#d9e9ff', 1.2); fill.position.set(3, 3, -4); this.scene.add(fill);
    this.table();
    this.marker = new THREE.Mesh(new THREE.RingGeometry(.25, .34, 48), new THREE.MeshBasicMaterial({ color: '#d3543d', transparent: true, opacity: .8, side: THREE.DoubleSide }));
    this.marker.rotation.x = -Math.PI / 2; this.marker.position.y = .018; this.scene.add(this.marker);
    this.stance = new THREE.Mesh(new THREE.RingGeometry(.44, .52, 48), new THREE.MeshBasicMaterial({ color: '#6f9a64', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.stance.rotation.x = -Math.PI / 2; this.stance.position.y = .016; this.stance.visible = false; this.stance.userData.added = true; this.scene.add(this.stance);
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
    this.backdrop();
    const mat = new THREE.MeshStandardMaterial({ map: this.gingham(), roughness: .94 });
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(5.2, .012, 9), mat); cloth.position.set(0, -.002, -1.8); cloth.receiveShadow = true; this.scene.add(cloth);
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
    this.props();
    for (let i = 0; i < 2; i++) {
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(.62, 32), new THREE.MeshBasicMaterial({ color: '#5a4030', transparent: true, opacity: .07, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2; shadow.scale.set(.8, .45, 1); shadow.position.y = .02; this.scene.add(shadow); this.shadows.push(shadow);
    }
  }
  // Soft sage gingham for the tablecloth; low contrast so the breads stay the brightest shapes.
  private gingham(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const c = canvas.getContext('2d')!; c.fillStyle = '#f5efdf'; c.fillRect(0, 0, 64, 64);
    c.fillStyle = '#dfe6d266'; c.fillRect(0, 0, 32, 64); c.fillRect(0, 0, 64, 32);
    c.fillStyle = '#cbd8bf55'; c.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(6, 10.4); texture.anisotropy = 4;
    return texture;
  }
  // Kitchen wall and window behind the table: fills the flat horizon with warm depth.
  private backdrop(): void {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const c = canvas.getContext('2d')!, wall = c.createLinearGradient(0, 0, 0, 256);
    wall.addColorStop(0, '#efe3cb'); wall.addColorStop(1, '#e2d0ad'); c.fillStyle = wall; c.fillRect(0, 0, 512, 256);
    for (let x = 0; x < 512; x += 16) { c.fillStyle = x % 32 ? '#e9dbbf55' : '#f6ecd955'; c.fillRect(x, 0, 8, 256); }
    const light = c.createRadialGradient(300, 110, 10, 300, 110, 150); light.addColorStop(0, '#fffaf0'); light.addColorStop(1, '#fff7e600');
    c.fillStyle = light; c.fillRect(120, 0, 360, 256);
    c.fillStyle = '#fbf6e8'; c.fillRect(214, 34, 172, 132);
    const sky = c.createLinearGradient(0, 44, 0, 156); sky.addColorStop(0, '#cfe6f1'); sky.addColorStop(1, '#f5f1df'); c.fillStyle = sky; c.fillRect(224, 44, 152, 112);
    c.fillStyle = '#9fb99b'; for (const [x, r] of [[250, 22], [282, 30], [336, 26], [362, 18]] as const) { c.beginPath(); c.arc(x, 156, r, Math.PI, 0); c.fill(); }
    c.fillStyle = '#fbf6e8'; c.fillRect(296, 44, 8, 112); c.fillRect(224, 96, 152, 7);
    c.fillStyle = '#c9a77a'; c.fillRect(200, 166, 200, 9); c.fillStyle = '#d7c19c'; c.fillRect(0, 214, 512, 42);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(30, 15), new THREE.MeshBasicMaterial({ map: texture, fog: false }));
    plane.position.set(0, 5.2, -12.2); plane.userData.added = true; this.scene.add(plane);
  }
  // Small breakfast props kept outside the lanes the breads and their wind-ups use (|x| > 2.1 or far behind).
  private props(): void {
    const jar = new THREE.Group();
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, .62, 32), new THREE.MeshStandardMaterial({ color: '#8f1d2c', roughness: .12, transparent: true, opacity: .93 }));
    glass.position.y = .31;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(.36, .36, .14, 32), new THREE.MeshStandardMaterial({ color: '#d4a64a', roughness: .35, metalness: .25 }));
    lid.position.y = .69;
    const label = new THREE.Mesh(new THREE.CylinderGeometry(.345, .345, .16, 32, 1, true, -.9, 1.8), new THREE.MeshStandardMaterial({ color: '#f6eddc', roughness: .8 }));
    label.position.y = .3; jar.add(glass, lid, label); jar.position.set(-2.55, 0, -3.9); jar.userData.added = true; this.scene.add(jar);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(.62, .5, .06, 36), new THREE.MeshStandardMaterial({ color: '#f5f2ea', roughness: .3 }));
    dish.position.set(-3.35, .03, .2); dish.userData.added = true;
    const butter = new THREE.Mesh(new THREE.BoxGeometry(.56, .26, .36), new THREE.MeshStandardMaterial({ color: '#f7e08a', roughness: .5 }));
    butter.position.set(-3.35, .19, .2); butter.rotation.y = .35; butter.userData.added = true;
    this.scene.add(dish, butter);
    const knife = new THREE.Group(), steel = new THREE.MeshStandardMaterial({ color: '#d8dcdf', roughness: .3, metalness: .3 });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(.11, .02, .9), steel); blade.position.z = -.45;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(.13, .06, .62), new THREE.MeshStandardMaterial({ color: '#6f4a2f', roughness: .6 })); grip.position.z = .31;
    knife.add(blade, grip); knife.position.set(-1.85, .03, 3.25); knife.rotation.y = -.5; knife.userData.added = true; this.scene.add(knife);
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
      const material = (found.material as THREE.MeshStandardMaterial).clone(); material.envMap = this.envMap; material.envMapIntensity = .4; material.vertexColors = true;
      const colors = new Float32Array(geometry.attributes.position!.count * 3), original = geometry.attributes.color;
      for (let i = 0; i < colors.length / 3; i++) { colors[i * 3] = original?.getX(i) ?? 1; colors[i * 3 + 1] = original?.getY(i) ?? 1; colors[i * 3 + 2] = original?.getZ(i) ?? 1; }
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(geometry, material);
      this.templates.set(id, { mesh, positions: new Float32Array(geometry.attributes.position!.array), normals: new Float32Array(geometry.attributes.normal!.array), colors });
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
  private choose(battle: BattleView): void {
    const ids = `${battle.player.bread}/${battle.cpu.bread}`;
    if (this.ids === ids) return;
    for (const side of ['player', 'cpu'] as const) {
      const old = this.actors[side];
      if (old) { this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
      const t = this.templates.get(battle[side].bread);
      if (!t) throw new Error('モデルの読み込みが完了していません。');
      const mesh = new THREE.Mesh(t.mesh.geometry.clone(), t.mesh.material.clone()); mesh.castShadow = true;
      this.actors[side] = { mesh, positions: t.positions, normals: t.normals, colors: t.colors, stage: 0, displayStage: 0, dents: [], wornPositions: t.positions, wornNormals: t.normals }; this.scene.add(mesh);
    }
    this.ids = ids;
  }
  private actor(f: Fighter, side: Side, time: number): ActorFrame {
    const m = this.actors[side]!, p = pose(f, side), b = BREADS[f.bread];
    m.mesh.position.set(p.x, p.y + Math.sin(time * 2.2 + (side === 'cpu' ? 1 : 0)) * .025, p.z);
    m.mesh.rotation.set(p.lean + Math.sin(f.hit * 75) * f.hit * .12, side === 'player' ? Math.PI + .12 : -.08, Math.sin(f.hit * 55) * f.hit * .1);
    if (side === 'cpu' && phase(f) === 'windup' && !this.reducedMotion.matches) m.mesh.rotation.x -= .06 * Math.sin(Math.PI * f.attack!.age / f.attack!.windup);
    if (this.ending) {
      const t = (performance.now() - this.ending.start) / 1000, calm = this.reducedMotion.matches;
      if (this.ending.winner === side) {
        m.mesh.position.y += calm ? .12 : Math.abs(Math.sin(t * 6.5)) * .32 * (t < 1.6 ? 1 : .45);
        if (!calm) m.mesh.rotation.y += Math.PI * 2 * Math.min(1, t / .8);
      } else if (this.ending.winner !== 'draw') {
        const fall = calm ? 1 : Math.min(1, t / .5), sway = calm ? 0 : Math.sin(t * 3) * .04;
        m.mesh.rotation.z += (side === 'player' ? -1 : 1) * (.62 * fall + sway); m.mesh.position.y -= .52 * fall;
      }
    }
    const stage = damageStage(f.hp, b.hp);
    if (stage !== m.stage) {
      if (stage < m.stage) m.dents = [];
      const point = this.contacts[side]?.clone() ?? new THREE.Vector3(p.x, p.y, p.z + (side === 'cpu' ? b.depth : -b.depth));
      m.mesh.updateMatrixWorld(true); m.mesh.worldToLocal(point);
      while (m.dents.length < stage) m.dents.push(point.clone());
      damageGeometry(m.mesh.geometry, m.positions, m.normals, m.colors, stage, m.dents);
      m.wornPositions = new Float32Array(m.mesh.geometry.attributes.position!.array); m.wornNormals = new Float32Array(m.mesh.geometry.attributes.normal!.array); m.stage = stage;
    }
    const contact = this.impacts[side], direction = contact ? contact.direction.clone().applyQuaternion(m.mesh.quaternion.clone().invert()).toArray() : [0, 0, 1];
    const impact = contact ? Math.sin(Math.PI * clamp(contact.life / .18, 0, 1)) : 0;
    // Visual deformation is <= 3 cm; collision stays tied to the same controlled root pose.
    const bend = Math.sin(Math.max(0, p.progress) * Math.PI) * .03 + Math.sin(f.hit * 60) * f.hit * .025;
    const frame: ActorFrame = { position: m.mesh.position.toArray(), rotation: [m.mesh.rotation.x, m.mesh.rotation.y, m.mesh.rotation.z], height: b.height,
      bend, direction, impact, hit: f.hit, stage, positions: m.wornPositions, normals: m.wornNormals };
    this.drawActor(side, frame); return frame;
  }
  private drawActor(side: Side, frame: ActorFrame): void {
    const m = this.actors[side]!, { bend, direction, impact, height } = frame;
    m.mesh.position.fromArray(frame.position); m.mesh.rotation.set(...frame.rotation);
    const pos = m.mesh.geometry.attributes.position!, normal = m.mesh.geometry.attributes.normal!;
    if (m.displayStage !== frame.stage) {
      const color = m.mesh.geometry.attributes.color!;
      for (let i = 0; i < color.count; i++) color.setXYZ(i, m.colors[i * 3]! * .94 ** frame.stage, m.colors[i * 3 + 1]! * .87 ** frame.stage, m.colors[i * 3 + 2]! * .79 ** frame.stage);
      color.needsUpdate = true; m.displayStage = frame.stage;
    }
    const deformed: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < pos.count; i++) {
      const offset = i * 3, y = m.positions[offset + 1]!, weight = (y + height) / (2 * height);
      deformVertex(frame.positions[offset]!, frame.positions[offset + 1]!, frame.positions[offset + 2]!, bend * weight * weight, direction, impact, deformed);
      const dx = deformed[0] - m.positions[offset]!, dy = deformed[1] - y, dz = deformed[2] - m.positions[offset + 2]!;
      const limit = Math.min(1, VISUAL_LIMITS.deformation / (Math.hypot(dx, dy, dz) || 1));
      pos.setXYZ(i, m.positions[offset]! + dx * limit, y + dy * limit, m.positions[offset + 2]! + dz * limit);
      const nx = frame.normals[offset]!, nz = frame.normals[offset + 2]!, ny = frame.normals[offset + 1]! - bend * weight / height * nz;
      const len = Math.hypot(nx, ny, nz); normal.setXYZ(i, nx / len, ny / len, nz / len);
    }
    pos.needsUpdate = true; normal.needsUpdate = true;
    m.mesh.material.emissive.set(frame.hit > 0 ? '#d95d27' : '#000000'); m.mesh.material.emissiveIntensity = frame.hit * 1.5;
    const shadow = this.shadows[side === 'player' ? 0 : 1]!; shadow.position.x = frame.position[0]; shadow.position.z = frame.position[2];
  }
  effect(event: BattleEvent): void {
    this.feedback.enqueue(event);
  }
  private accent(event: BattleEvent, battle: BattleView): void {
    if (event.kind === 'hit' || event.kind === 'clash') {
      for (const side of ['player', 'cpu'] as const) if (event.kind === 'clash' || side !== event.side) this.contacts[side] = new THREE.Vector3(event.x, 1.43, event.z);
    }
    if (this.reducedMotion.matches) return;
    if (event.kind === 'dodge' || event.kind === 'counter') {
      if (event.kind === 'counter') this.zoom = .24;
      const counter = event.kind === 'counter', duration = counter ? .25 : .2;
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.35, .40, 40, 1, counter ? 0 : .2, counter ? Math.PI * 2 : Math.PI * 1.3),
        new THREE.MeshBasicMaterial({ color: counter ? '#ffcd69' : '#f1fff1', transparent: true, opacity: .9, side: THREE.DoubleSide, depthWrite: false }));
      mesh.name = event.kind; mesh.position.set(event.x, 1.45, event.z); mesh.quaternion.copy(this.camera.quaternion);
      this.scene.add(mesh); this.accents.push({ mesh, life: duration, duration });
    }
    if (event.kind !== 'hit' && event.kind !== 'clash') return;
    this.shake = .14;
    for (const side of ['player', 'cpu'] as const) {
      const own = pose(battle[side], side), other = pose(battle[side === 'player' ? 'cpu' : 'player'], side === 'player' ? 'cpu' : 'player');
      this.impacts[side] = { life: .18, direction: new THREE.Vector3(other.x - own.x, 0, other.z - own.z).normalize() };
    }
    for (let i = 0; i < 12; i++) {
      const side = event.kind === 'clash' ? i % 2 ? 'player' : 'cpu' : event.side === 'player' ? 'cpu' : 'player';
      const bread = battle[side].bread, size = .03 + i % 3 * .012;
      const geometry = bread === 'shokupan' ? new THREE.BoxGeometry(size, size, size * .7) : bread === 'francepan' ? new THREE.TetrahedronGeometry(size) : new THREE.BoxGeometry(size * 1.6, .007, size * .8);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: bread === 'shokupan' ? '#fff5dc' : bread === 'francepan' ? '#995020' : '#df9e48' }));
      mesh.position.set(event.x, 1.45, event.z); this.scene.add(mesh);
      const rests = i % 3 === 0;
      this.crumbs.push({ mesh, vx: Math.cos(i * 2.4) * 1.3, vy: 1 + i % 4 * .2, vz: Math.sin(i * 2.4), life: rests ? VISUAL_LIMITS.crumbSeconds : .55, rests });
      if (this.crumbs.length > VISUAL_LIMITS.crumbs) this.removeCrumb(0);
    }
  }
  private removeCrumb(index: number): void {
    const c = this.crumbs[index]!; this.scene.remove(c.mesh); c.mesh.geometry.dispose(); (c.mesh.material as THREE.Material).dispose(); this.crumbs.splice(index, 1);
  }
  private cameraEffect(dt: number): void {
    this.shake = Math.max(0, this.shake - dt); this.zoom = Math.max(0, this.zoom - dt);
    const shake = this.reducedMotion.matches ? 0 : VISUAL_LIMITS.shake * this.shake / .14 * Math.sin(this.shake * 140);
    const zoom = this.reducedMotion.matches ? 0 : VISUAL_LIMITS.zoom * Math.sin(Math.PI * this.zoom / .24);
    // Result screen: tilt down so the celebrating breads sit above the result sheet.
    const tilt = !this.ending ? 0 : this.reducedMotion.matches ? 1 : 1 - (1 - Math.min(1, (performance.now() - this.ending.start) / 900)) ** 3;
    this.camera.position.set(.9 + shake, 5.8, 7.1 - zoom); this.camera.lookAt(0, 1.05 - 5.1 * tilt, -.15);
  }
  private trail(f: Fighter, side: Side): void {
    const p = pose(f, side), old = this.previous[side], attack = f.attack;
    if (this.reducedMotion.matches || !attack || phase(f) !== 'active') { delete this.previous[side]; return; }
    this.previous[side] = { id: attack.id, x: p.x, z: p.z };
    if (!old || old.id !== attack.id || Math.hypot(p.x - old.x, p.z - old.z) < .005) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      old.x - .10, 1.42, old.z, old.x + .10, 1.42, old.z, p.x + .10, 1.42, p.z,
      old.x - .10, 1.42, old.z, p.x + .10, 1.42, p.z, p.x - .10, 1.42, p.z,
    ], 3));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#fff2cc', transparent: true, opacity: .35, depthWrite: false, side: THREE.DoubleSide }));
    mesh.name = 'trail'; this.scene.add(mesh); this.accents.push({ mesh, life: .12, duration: .12 });
  }
  private clearEffects(): void {
    for (const effect of [...this.crumbs, ...this.accents]) {
      this.scene.remove(effect.mesh); effect.mesh.geometry.dispose(); (effect.mesh.material as THREE.Material).dispose();
    }
    this.crumbs = []; this.accents = []; this.previous = {}; this.impacts = {}; this.shake = this.zoom = 0; this.cameraEffect(0); this.marker.visible = false;
  }
  resetEffects(newMatch = false): void {
    this.clearEffects(); this.feedback.reset(newMatch); this.stopSound();
    if (newMatch) {
      this.contacts = {}; this.replay.reset();
      for (const m of Object.values(this.actors)) { damageGeometry(m.mesh.geometry, m.positions, m.normals, m.colors, 0, []); m.stage = m.displayStage = 0; m.dents = []; m.wornPositions = m.positions; m.wornNormals = m.normals; }
    }
  }
  startReplay(window = 1.2): boolean { this.resetEffects(); return this.replay.start(this.reducedMotion.matches, window); }
  renderReplay(dt: number): boolean {
    const frame = this.replay.next(dt, this.reducedMotion.matches);
    if (!frame || this.lost) return true;
    this.drawActor('player', frame.value.player); this.drawActor('cpu', frame.value.cpu);
    this.renderer.shadowMap.needsUpdate = true; this.renderer.render(this.scene, this.camera); return frame.done;
  }
  // timeScale slows effect animation only (finish slow-motion); frame metrics keep the real dt.
  render(battle: BattleView, time: number, frameDt: number, active: boolean, local?: { remaining?: number; cue?: StanceCue }, timeScale = 1): void {
    if (this.lost) return;
    const dt = frameDt * timeScale;
    const feedback = this.feedback.update(battle, active, local?.remaining);
    if (!active) this.resetEffects();
    else {
      for (const event of feedback.events) this.accent(event, battle);
      const soundEvent = feedback.events.find(event => event.kind === feedback.sound);
      if (feedback.sound) this.playSound(feedback.sound, 0, battle[soundEvent?.side ?? 'player'].bread);
      if (feedback.alert) this.playSound('danger', .20);
    }
    this.choose(battle);
    const player = this.actor(battle.player, 'player', time), cpu = this.actor(battle.cpu, 'cpu', time);
    if (active && local) this.replay.record(dt, { player, cpu });
    this.cameraEffect(dt);
    for (const impact of Object.values(this.impacts)) impact.life = Math.max(0, impact.life - dt);
    this.updateStance(battle, active ? local?.cue : undefined, time);
    const a = battle.cpu.attack;
    this.marker.visible = active && phase(battle.cpu) === 'windup';
    if (a) {
      const progress = clamp(a.age / a.windup, 0, 1);
      this.marker.position.set(a.aim, .025, 1.2);
      this.marker.scale.setScalar(this.reducedMotion.matches ? 1.4 : 1.65 - .45 * progress);
      const material = this.marker.material as THREE.MeshBasicMaterial;
      material.opacity = this.reducedMotion.matches ? .9 : .45 + .5 * progress;
      material.color.set(progress > .7 ? '#b13d2c' : '#d3543d');
    }
    if (active) for (const side of ['player', 'cpu'] as const) this.trail(battle[side], side);
    for (let i = this.accents.length - 1; i >= 0; i--) {
      const c = this.accents[i]!; c.life -= dt;
      c.mesh.material.opacity = (c.mesh.name === 'trail' ? .35 : .9) * Math.max(0, c.life / c.duration);
      if (c.mesh.name !== 'trail') c.mesh.scale.setScalar(1 + .5 * (1 - c.life / c.duration));
      if (c.life <= 0) { this.scene.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); this.accents.splice(i, 1); }
    }
    for (let i = this.crumbs.length - 1; i >= 0; i--) {
      const c = this.crumbs[i]!; c.life -= dt; c.vy -= dt * 4;
      c.mesh.position.addScaledVector(new THREE.Vector3(c.vx, c.vy, c.vz), dt);
      if (c.rests && c.mesh.position.y <= .04) { c.mesh.position.y = .04; c.vx = c.vy = c.vz = 0; }
      else c.mesh.rotation.x += dt * 4;
      if (c.life <= 0) this.removeCrumb(i);
    }
    this.shadowFrame = (this.shadowFrame + 1) % 2; this.renderer.shadowMap.needsUpdate = this.shadowFrame === 0 || !active;
    this.renderer.render(this.scene, this.camera);
    if (active && frameDt > 0 && timeScale === 1) { this.frames.push(frameDt * 1000); if (this.frames.length > 12000) this.frames.shift(); }
  }
  private updateStance(battle: BattleView, cue: StanceCue | undefined, time: number): void {
    this.stance.visible = !!cue && !this.ending;
    if (!cue) return;
    const p = pose(battle.player, 'player'), m = this.stance.material, pulse = this.reducedMotion.matches ? 1 : .5 + .5 * Math.sin(time * 14);
    this.stance.position.x = p.x; this.stance.position.z = p.z;
    this.stance.scale.set(.75 + BREADS[battle.player.bread].width * .8, .75 + BREADS[battle.player.bread].width * .8, 1);
    const [color, opacity, grow] = cue === 'counter' ? ['#f2b53a', .55 + .4 * pulse, .12 * pulse] : cue === 'locked' ? ['#8a8575', .32, 0] : cue === 'recovery' ? ['#b7a98a', .28, 0] : ['#6f9a64', .5, 0];
    m.color.set(color); m.opacity = opacity; this.stance.scale.multiplyScalar(1 + grow);
  }
  setEnding(winner: Side | 'draw' | null): void { this.ending = winner === null ? null : { winner, start: performance.now() }; }
  // Screen position (CSS px within the canvas) of a point above the given side's bread.
  project(battle: BattleView, side: Side, lift = .75): { x: number; y: number } {
    const p = pose(battle[side], side), v = new THREE.Vector3(p.x, p.y + lift, p.z).project(this.camera);
    return { x: (v.x + 1) / 2 * this.canvas.clientWidth, y: (1 - v.y) / 2 * this.canvas.clientHeight };
  }
  // Portrait thumbnails from the loaded GLB templates, rendered once with a throwaway context.
  thumbnails(size = 144): Partial<Record<BreadId, string>> {
    const result: Partial<Record<BreadId, string>> = {};
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, .1, 20);
      scene.add(new THREE.HemisphereLight('#fff7df', '#846b50', 2.6));
      const key = new THREE.DirectionalLight('#fff5df', 3.2); key.position.set(-2, 3, 4); scene.add(key);
      for (const [id, template] of this.templates) {
        const mesh = new THREE.Mesh(template.mesh.geometry, template.mesh.material);
        mesh.rotation.set(-.25, Math.PI + .5, id === 'francepan' ? -.65 : 0); scene.add(mesh);
        const radius = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius;
        camera.position.set(0, 0, radius / Math.sin(THREE.MathUtils.degToRad(15)) * .78); camera.lookAt(0, 0, 0);
        renderer.clear(); renderer.render(scene, camera); result[id] = canvas.toDataURL('image/png'); scene.remove(mesh);
      }
    } catch { /* Thumbnails are optional; the menu falls back to emoji. */ }
    finally { renderer?.dispose(); renderer?.forceContextLoss(); }
    return result;
  }
  noteLatency(ms: number): void { if (Number.isFinite(ms) && ms >= 0) this.latencies.push(ms); }
  resetMetrics(): void { this.frames = []; this.latencies = []; this.ending = null; this.resetEffects(true); }
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
  dispose(): void { this.resetEffects(true); this.reducedMotion.removeEventListener('change', this.motionChanged); this.resize.disconnect(); this.renderer.dispose(); }
}
