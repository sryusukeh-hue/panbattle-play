import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BREADS, BREAD_IDS, clamp, type BreadId } from './config';
import { phase, pose, type BattleView, type BattleEvent, type Fighter, type Side } from './battle';
import { BattleFeedback, ReplayBuffer, damageStage, DAMAGE_DENT, deformVertex, VISUAL_LIMITS, type BattleSound } from './feedback';
import { SPECIALS, motionTick } from '../shared/specials';
import { FaceRig, buildFaceTemplate, type FaceTemplate } from './face-rig';
import { FaceState, copyFace, type FaceFrame, type FaceInput, type Reaction } from './face-state';

interface Model { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; positions: Float32Array; normals: Float32Array; colors: Float32Array; face: FaceTemplate }
interface Actor extends Model { stage: number; displayStage: number; dents: THREE.Vector3[]; wornPositions: Float32Array; wornNormals: Float32Array;
  // Face (plans/EXECPLAN-FACE.md): the glued eyes/lids/decal and the expression state.
  rig: FaceRig; expression: FaceState }
interface ActorFrame { position: THREE.Vector3Tuple; rotation: THREE.Vector3Tuple; height: number; bend: number; direction: number[]; impact: number; hit: number; stage: number; positions: Float32Array; normals: Float32Array;
  // Special moves: root scale and a golden wind-up glow (replayed with the pose).
  scale: THREE.Vector3Tuple; glow: number; glowColor: string;
  // Resolved expression, copied so the replay shows the same face.
  face: FaceFrame }
export type StanceCue = 'ready' | 'locked' | 'recovery' | 'counter' | 'charged';
interface Crumb { mesh: THREE.Mesh; vx: number; vy: number; vz: number; life: number; rests: boolean }
interface Accent { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; life: number; duration: number; grow?: number; rise?: number; peak?: number }
type Mark = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
const sideSign = (side: Side): number => side === 'player' ? 1 : -1;
const CAMERA_HOME = new THREE.Vector3(.9, 5.8, 7.1);
// Face-centred stills: local y of the face and how much closer than the whole-bread framing.
const FACE_FOCUS: Record<BreadId, number> = { shokupan: .02, francepan: .43, croissant: .18 };
const THUMB_CLOSE: Record<BreadId, number> = { shokupan: 1.25, francepan: 1.8, croissant: 1.25 };
const PORTRAIT_CLOSE: Record<BreadId, number> = { shokupan: 1.55, francepan: 2.3, croissant: 1.9 };
export type Mood = 'calm' | 'ouch' | 'dodge' | 'special';
const MOODS: readonly Mood[] = ['calm', 'ouch', 'dodge', 'special'];
const REST: FaceInput = { phase: 'ready', special: false, charging: false, stage: 0, ending: null, look: [.25, .1] };
// Half-width of the lane a special move sweeps at the defender's line, from the move's attack ellipse (see specialTouching).
export function dangerHalfWidth(attacker: BreadId, defender: BreadId): number {
  const spec = SPECIALS[attacker], travel = Math.max(...spec.keys.map(k => k.at[2])), gap = Math.abs(2.4 - travel);
  const reach = spec.rz + BREADS[defender].depth, t = Math.min(1, gap / reach);
  return (spec.rx + BREADS[defender].width) * Math.sqrt(1 - t * t);
}
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
  // Table telegraphs for a special move, one reusable set per side: toast square, baguette lane, three crescents.
  private marks: Record<Side, { shokupan: Mark[]; francepan: Mark[]; croissant: Mark[] }>;
  private focus = 0; private charging = false;
  // Special stages whose strike visual was shown, per side (attack id + stage mask): each plays once, hit or miss,
  // even when a slow frame skips a whole stage window, and a pause never replays it.
  private flashed: Partial<Record<Side, { id: number; mask: number }>> = {};
  private portraits: Partial<Record<BreadId, Record<Mood, string>>> = {}; private mood: Mood = 'calm';
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
    this.marks = { player: this.markSet(), cpu: this.markSet() };
    this.resize = new ResizeObserver(() => this.fit()); this.resize.observe(canvas); this.fit();
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; fail('3D描画が中断しました。再読み込みして再開してください。'); });
    canvas.addEventListener('webglcontextrestored', () => { fail('3D描画が復帰しました。再読み込みしてパンを読み直してください。'); });
  }
  private markSet(): { shokupan: Mark[]; francepan: Mark[]; croissant: Mark[] } {
    const mark = (geometry: THREE.BufferGeometry): Mark => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      mesh.visible = false; mesh.renderOrder = 2; mesh.userData.added = true; this.scene.add(mesh); return mesh;
    };
    // Unit shapes flat on the cloth; per-frame scale fits them to the computed danger lane.
    const square = new THREE.RingGeometry(.84, 1, 4, 1).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2).scale(Math.SQRT2, 1, Math.SQRT2 / 2);
    const fill = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const lane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const tip = new THREE.CircleGeometry(.5, 3).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2);
    const crescent = (): THREE.BufferGeometry => new THREE.RingGeometry(.72, 1, 24, 1, Math.PI * .12, Math.PI * .76).rotateX(-Math.PI / 2);
    return { shokupan: [mark(square), mark(fill)], francepan: [mark(lane), mark(lane.clone()), mark(tip)], croissant: [mark(crescent()), mark(crescent()), mark(crescent())] };
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
      this.templates.set(id, { mesh, positions: new Float32Array(geometry.attributes.position!.array), normals: new Float32Array(geometry.attributes.normal!.array), colors, face: buildFaceTemplate(id, geometry) });
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
      if (old) { this.scene.remove(old.mesh); old.rig.dispose(); old.mesh.geometry.dispose(); old.mesh.material.dispose(); }
      const t = this.templates.get(battle[side].bread);
      if (!t) throw new Error('モデルの読み込みが完了していません。');
      const mesh = new THREE.Mesh(t.mesh.geometry.clone(), t.mesh.material.clone()); mesh.castShadow = true;
      const rig = new FaceRig(t.face); mesh.add(rig.group);
      this.actors[side] = { mesh, positions: t.positions, normals: t.normals, colors: t.colors, face: t.face, stage: 0, displayStage: 0, dents: [], wornPositions: t.positions, wornNormals: t.normals,
        rig, expression: new FaceState(battle[side].bread, side === 'player' ? 11 : 29) }; this.scene.add(mesh);
    }
    this.ids = ids;
  }
  private actor(f: Fighter, side: Side, time: number, dt: number, other: Fighter): ActorFrame {
    // The result screen shows the breads at rest, not frozen mid-move.
    if (this.ending && (f.attack || f.recoil > 0 || f.hit > 0)) f = { ...f, attack: null, recoil: 0, hit: 0 };
    const m = this.actors[side]!, p = pose(f, side), b = BREADS[f.bread], sp = p.special, calm = this.reducedMotion.matches;
    // Special moves drive the whole root; reduced motion keeps the XZ path and hit timing but drops the jump, growth and spin.
    const lift = sp ? calm ? 0 : p.y - 1.43 : Math.sin(time * 2.2 + (side === 'cpu' ? 1 : 0)) * .025;
    m.mesh.position.set(p.x, 1.43 + lift, p.z);
    m.mesh.rotation.set(p.lean + Math.sin(f.hit * 75) * f.hit * .12, (side === 'player' ? Math.PI + .12 : -.08) + (sp ? sideSign(side) * sp.yaw : 0),
      Math.sin(f.hit * 55) * f.hit * .1 + (sp && !calm ? sideSign(side) * sp.roll : 0));
    if (side === 'cpu' && phase(f) === 'windup' && !f.attack!.special && !calm) m.mesh.rotation.x -= .06 * Math.sin(Math.PI * f.attack!.age / f.attack!.windup);
    const scale: THREE.Vector3Tuple = sp && !calm ? [sp.scale[0], sp.scale[1], sp.scale[2]] : [1, 1, 1];
    // Golden glow builds through the wind-up, flashes on the strike and fades out in recovery.
    const spec = SPECIALS[f.bread], a = f.attack, charge = side === 'cpu' && this.charging && !this.ending;
    const glow = charge ? .45 + (calm ? 0 : .3 * Math.sin(time * 18)) : !a?.special ? 0 : phase(f) === 'windup' ? .35 + .45 * clamp(a.age / a.windup, 0, 1) + (calm ? 0 : .12 * Math.sin(time * 40))
      : phase(f) === 'active' ? 1 : Math.max(0, .6 * (1 - (a.age - a.windup - spec.active) / a.recovery * 2.5));
    if (this.ending) {
      const t = (performance.now() - this.ending.start) / 1000, calm = this.reducedMotion.matches;
      // Every bread ends facing the camera, so the player finally sees their own bread's face.
      const base = m.mesh.rotation.y, target = Math.atan2(CAMERA_HOME.x - p.x, CAMERA_HOME.z - p.z), turn = Math.atan2(Math.sin(target - base), Math.cos(target - base));
      if (this.ending.winner === side) {
        m.mesh.position.y += calm ? .12 : Math.abs(Math.sin(t * 6.5)) * .32 * (t < 1.6 ? 1 : .45);
        m.mesh.rotation.y = base + (calm ? turn : (turn + Math.PI * 2) * (1 - (1 - Math.min(1, t)) ** 3));
      } else if (this.ending.winner !== 'draw') {
        const fall = calm ? 1 : clamp((t - .25) / .5, 0, 1), sway = calm ? 0 : Math.sin(t * 3) * .04 * fall;
        m.mesh.rotation.y = base + turn * (calm ? 1 : Math.min(1, t / .35));
        m.mesh.rotation.z += (side === 'player' ? -1 : 1) * (.62 * fall + sway); m.mesh.position.y -= .52 * fall;
      } else m.mesh.rotation.y = base + turn * (calm ? 1 : Math.min(1, t / .5));
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
      bend, direction, impact, hit: f.hit, stage, positions: m.wornPositions, normals: m.wornNormals, scale, glow, glowColor: charge ? '#ff5a36' : spec.color,
      face: copyFace(m.expression.update(dt, this.faceInput(f, side, other, charge, stage), calm)) };
    this.drawActor(side, frame); return frame;
  }
  // What the face reacts to: action phase, fatigue, result, and where to look (the opponent, or the camera on the result screen).
  private faceInput(f: Fighter, side: Side, other: Fighter, charging: boolean, stage: number): FaceInput {
    const m = this.actors[side]!, o = pose(other, side === 'player' ? 'cpu' : 'player'), look = new THREE.Vector3();
    if (this.ending) look.copy(CAMERA_HOME); else look.set(o.x, o.y, o.z);
    look.sub(m.mesh.position).applyQuaternion(m.mesh.quaternion.clone().invert()).normalize();
    const ending = !this.ending ? null : this.ending.winner === 'draw' ? 'draw' : this.ending.winner === side ? 'win' : 'lose';
    return { phase: this.ending ? 'ready' : phase(f), special: !!f.attack?.special, charging, stage, ending, look: [look.x * 2.2, look.y * 2.2] };
  }
  private drawActor(side: Side, frame: ActorFrame): void {
    const m = this.actors[side]!, { bend, direction, impact, height } = frame;
    m.mesh.position.fromArray(frame.position); m.mesh.rotation.set(...frame.rotation); m.mesh.scale.set(...frame.scale);
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
    m.rig.update(frame.face, pos, normal);
    if (frame.hit > 0) { m.mesh.material.emissive.set('#d95d27'); m.mesh.material.emissiveIntensity = frame.hit * 1.5; }
    else { m.mesh.material.emissive.set(frame.glow > 0 ? frame.glowColor : '#000000'); m.mesh.material.emissiveIntensity = frame.glow * .8; }
    const shadow = this.shadows[side === 'player' ? 0 : 1]!; shadow.position.x = frame.position[0]; shadow.position.z = frame.position[2];
  }
  effect(event: BattleEvent): void {
    this.feedback.enqueue(event);
  }
  private accent(event: BattleEvent, battle: BattleView): void {
    this.faceReaction(event);
    if (event.kind === 'hit' || event.kind === 'clash') {
      for (const side of ['player', 'cpu'] as const) if (event.kind === 'clash' || side !== event.side) this.contacts[side] = new THREE.Vector3(event.x, 1.43, event.z);
    }
    if (event.kind === 'special-hit') this.contacts[event.side === 'player' ? 'cpu' : 'player'] = new THREE.Vector3(event.x, 1.43, event.z);
    if (event.kind === 'special' || event.kind === 'special-hit' || (event.kind === 'miss' && event.special)) { this.specialAccent(event, battle); return; }
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
    this.shake = Math.max(this.shake, .14);
    for (const side of ['player', 'cpu'] as const) {
      const own = pose(battle[side], side), other = pose(battle[side === 'player' ? 'cpu' : 'player'], side === 'player' ? 'cpu' : 'player');
      this.impacts[side] = { life: .18, direction: new THREE.Vector3(other.x - own.x, 0, other.z - own.z).normalize() };
    }
    for (let i = 0; i < 12; i++) this.crumb(battle[event.kind === 'clash' ? i % 2 ? 'player' : 'cpu' : event.side === 'player' ? 'cpu' : 'player'].bread, event.x, 1.45, event.z, i);
  }
  // Expressions: the bread that got hit winces (hit/special-hit name the attacker), a clash grits both, dodge/counter grin.
  private faceReaction(event: BattleEvent): void {
    const react = (side: Side, kind: Reaction): void => this.actors[side]?.expression.react(kind);
    if (event.kind === 'hit' || event.kind === 'special-hit') react(event.side === 'player' ? 'cpu' : 'player', 'ouch');
    else if (event.kind === 'clash') { react('player', 'grit'); react('cpu', 'grit'); }
    else if (event.kind === 'dodge' || event.kind === 'counter') react(event.side, event.kind);
  }
  // One crumb of the given bread's material; `power` scales the burst for special moves.
  private crumb(bread: BreadId, x: number, y: number, z: number, i: number, power = 1): void {
    const size = (.03 + i % 3 * .012) * (power > 1 ? 1.25 : 1);
    const geometry = bread === 'shokupan' ? new THREE.BoxGeometry(size, size, size * .7) : bread === 'francepan' ? new THREE.TetrahedronGeometry(size) : new THREE.BoxGeometry(size * 1.6, .007, size * .8);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: bread === 'shokupan' ? '#fff5dc' : bread === 'francepan' ? '#995020' : '#df9e48' }));
    mesh.position.set(x, y, z); this.scene.add(mesh);
    const rests = i % 3 === 0;
    this.crumbs.push({ mesh, vx: Math.cos(i * 2.4) * 1.3 * power, vy: (1 + i % 4 * .2) * Math.sqrt(power), vz: Math.sin(i * 2.4) * power, life: rests ? VISUAL_LIMITS.crumbSeconds : .55 + .15 * (power - 1), rests });
    if (this.crumbs.length > VISUAL_LIMITS.crumbs) this.removeCrumb(0);
  }
  private flash(geometry: THREE.BufferGeometry, color: string, position: THREE.Vector3, duration: number, options: { face?: boolean; grow?: number; rise?: number; peak?: number } = {}): void {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: options.peak ?? .9, side: THREE.DoubleSide, depthWrite: false }));
    mesh.name = 'special'; mesh.position.copy(position); mesh.renderOrder = 3;
    if (options.face) mesh.quaternion.copy(this.camera.quaternion);
    this.scene.add(mesh); this.accents.push({ mesh, life: duration, duration, grow: options.grow ?? .5, rise: options.rise ?? 0, peak: options.peak ?? .9 });
  }
  // Activation aura, hit bursts and whiff wisps for special moves. Reduced motion keeps only static, short shapes.
  private specialAccent(event: BattleEvent, battle: BattleView): void {
    const calm = this.reducedMotion.matches, attacker = event.side, victim: Side = attacker === 'player' ? 'cpu' : 'player';
    const bread = battle[attacker].bread, spec = SPECIALS[bread], point = new THREE.Vector3(event.x, 1.45, event.z);
    if (event.kind === 'special') {
      const base = pose(battle[attacker], attacker);
      for (let i = 0; i < (calm ? 1 : 3); i++)
        this.flash(new THREE.RingGeometry(.55, .64, 40).rotateX(-Math.PI / 2), spec.color, new THREE.Vector3(base.x, .05 + i * .12, base.z), .7 + i * .15, { grow: calm ? 0 : 1.6, rise: calm ? 0 : 1.1 });
      return;
    }
    if (event.kind === 'miss') {
      this.flash(new THREE.RingGeometry(.3, .36, 32).rotateX(-Math.PI / 2), '#f1e6c8', new THREE.Vector3(event.x, .05, sideSign(attacker) * -.3), .35, { grow: calm ? 0 : 1.2, peak: .6 });
      if (!calm && bread === 'shokupan') for (let i = 0; i < 4; i++) this.crumb(bread, event.x, .3, sideSign(attacker) * -.4, i);
      return;
    }
    const stage = event.stage ?? 0, final = stage === spec.stages.length - 1;
    this.impacts[victim] = { life: .18, direction: new THREE.Vector3(0, 0, -sideSign(attacker)) };
    this.flash(new THREE.RingGeometry(final ? .18 : .1, final ? .5 : .28, 10), '#ffffff', point, final ? .24 : .14, { face: true, grow: calm ? 0 : final ? 2.8 : 1.4 });
    if (calm) return;
    const count = bread === 'shokupan' ? 24 : bread === 'francepan' ? 18 : final ? 12 : 4;
    for (let i = 0; i < count; i++) this.crumb(battle[victim].bread, event.x, 1.45, event.z, i, final ? 1.7 : 1.1);
    if (final) { this.shake = Math.max(this.shake, bread === 'croissant' ? .1 : .14); this.zoom = .24; }
  }
  private removeCrumb(index: number): void {
    const c = this.crumbs[index]!; this.scene.remove(c.mesh); c.mesh.geometry.dispose(); (c.mesh.material as THREE.Material).dispose(); this.crumbs.splice(index, 1);
  }
  // The move's signature shape at the moment each stage strikes: toast slam wave, baguette light line, crescent arcs.
  private stageFlash(battle: BattleView, side: Side, stage: number): void {
    const f = battle[side], spec = SPECIALS[f.bread], p = pose(f, side), calm = this.reducedMotion.matches, final = stage === spec.stages.length - 1;
    if (f.bread === 'shokupan') {
      this.flash(new THREE.RingGeometry(.7, .86, 4).rotateZ(Math.PI / 4).rotateX(-Math.PI / 2), '#fff4d6', new THREE.Vector3(p.x, .06, p.z), .45, { grow: calm ? 0 : 3.2 });
      this.flash(new THREE.RingGeometry(.4, .5, 4).rotateZ(Math.PI / 4), spec.color, new THREE.Vector3(p.x, p.y, p.z), .3, { face: true, grow: calm ? 0 : 2.4 });
    } else if (f.bread === 'francepan') {
      this.flash(new THREE.PlaneGeometry(.12, 2.6).rotateX(-Math.PI / 2), '#e8f6ff', new THREE.Vector3(p.x, .9, p.z + sideSign(side) * .9), .25, { grow: calm ? 0 : .6 });
    } else {
      this.flash(new THREE.RingGeometry(.5, .62, 28, 1, Math.PI * .1, Math.PI * .8).rotateZ(stage * 1.1), final ? spec.color : '#fff1c2', new THREE.Vector3(p.x, p.y, p.z), final ? .4 : .22, { face: true, grow: calm ? 0 : final ? 2.6 : 1.2 });
    }
  }
  private cameraEffect(dt: number): void {
    this.shake = Math.max(0, this.shake - dt); this.zoom = Math.max(0, this.zoom - dt);
    const shake = this.reducedMotion.matches ? 0 : VISUAL_LIMITS.shake * Math.min(1, this.shake / .14) * Math.sin(this.shake * 140);
    // The cut-in leans the camera in slightly; combined with hit zoom it never exceeds the shared zoom limit.
    const zoom = this.reducedMotion.matches ? 0 : Math.min(VISUAL_LIMITS.zoom, VISUAL_LIMITS.zoom * Math.sin(Math.PI * this.zoom / .24) + VISUAL_LIMITS.zoom * .8 * this.focus);
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
    this.crumbs = []; this.accents = []; this.previous = {}; this.impacts = {}; this.shake = this.zoom = this.focus = 0; this.cameraEffect(0); this.marker.visible = false;
    for (const set of Object.values(this.marks ?? {})) for (const mark of Object.values(set).flat()) mark.visible = false;
  }
  resetEffects(newMatch = false): void {
    this.clearEffects(); this.feedback.reset(newMatch); this.stopSound();
    if (newMatch) {
      this.contacts = {}; this.flashed = {}; this.replay.reset();
      for (const m of Object.values(this.actors)) { damageGeometry(m.mesh.geometry, m.positions, m.normals, m.colors, 0, []); m.stage = m.displayStage = 0; m.dents = []; m.wornPositions = m.positions; m.wornNormals = m.normals; m.expression.reset(); }
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
  // local.frozen: the special cut-in is playing; nothing is recorded for the replay and effects drift in slow motion.
  // local.charging: the CPU's once-per-match meter charge is running (it glows).
  render(battle: BattleView, time: number, frameDt: number, active: boolean, local?: { remaining?: number; cue?: StanceCue; frozen?: boolean; charging?: boolean }, timeScale = 1): void {
    if (this.lost) return;
    const dt = frameDt * timeScale * (local?.frozen ? .15 : 1);
    this.focus = clamp(this.focus + (local?.frozen ? 1 : -1) * frameDt * 6, 0, 1); this.charging = !!local?.charging;
    const feedback = this.feedback.update(battle, active, local?.remaining);
    if (!active) this.resetEffects();
    else {
      for (const event of feedback.events) this.accent(event, battle);
      const soundEvent = feedback.events.find(event => event.kind === feedback.sound);
      if (feedback.sound) this.playSound(feedback.sound, 0, battle[feedback.soundSide ?? soundEvent?.side ?? 'player'].bread);
      if (feedback.alert) this.playSound('danger', .20);
    }
    this.choose(battle);
    // Faces only age while the match runs (online keeps passing real frame time while paused or on the result).
    const faceDt = active ? dt : 0;
    const player = this.actor(battle.player, 'player', time, faceDt, battle.cpu), cpu = this.actor(battle.cpu, 'cpu', time, faceDt, battle.player);
    const face = player.face;
    this.mood = face.mouth === 'ouch' ? 'ouch' : face.mouth === 'smug' ? 'dodge' : battle.player.attack?.special && !this.ending ? 'special' : 'calm';
    if (active && local && !local.frozen) this.replay.record(dt, { player, cpu });
    this.cameraEffect(dt);
    for (const impact of Object.values(this.impacts)) impact.life = Math.max(0, impact.life - dt);
    this.updateStance(battle, active ? local?.cue : undefined, time);
    const a = battle.cpu.attack;
    this.marker.visible = active && phase(battle.cpu) === 'windup' && !a?.special;
    for (const side of ['player', 'cpu'] as const) {
      this.updateMarks(battle, side, active, time);
      const f = battle[side], attack = f.attack;
      if (!active || !attack?.special || phase(f) === 'windup' || this.ending) continue;
      const tick = motionTick(f.bread, attack.age, attack.special.extra), seen = this.flashed[side]?.id === attack.id ? this.flashed[side]! : { id: attack.id, mask: 0 };
      SPECIALS[f.bread].stages.forEach((stage, i) => { if (tick >= stage.from && !(seen.mask & 1 << i)) { seen.mask |= 1 << i; this.stageFlash(battle, side, i); } });
      this.flashed[side] = seen;
    }
    if (a && !a.special) {
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
      c.mesh.material.opacity = (c.mesh.name === 'trail' ? .35 : c.peak ?? .9) * Math.max(0, c.life / c.duration);
      if (c.mesh.name !== 'trail') c.mesh.scale.setScalar(1 + (c.grow ?? .5) * (1 - c.life / c.duration));
      if (c.rise) c.mesh.position.y += c.rise * dt;
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
  // Telegraphs the locked lane from activation until the last stage resolves. Red for the CPU (dodge!), move colour for the player.
  private updateMarks(battle: BattleView, side: Side, active: boolean, time: number): void {
    const f = battle[side], a = f.attack, set = this.marks[side], p = phase(f), calm = this.reducedMotion.matches;
    for (const [bread, meshes] of Object.entries(set)) {
      const live = active && !!a?.special && f.bread === bread && (p === 'windup' || p === 'active') && !this.ending;
      meshes.forEach(mesh => { mesh.visible = live; });
      if (!live) continue;
      const other = battle[side === 'player' ? 'cpu' : 'player'], sign = sideSign(side), spec = SPECIALS[f.bread];
      const half = dangerHalfWidth(f.bread, other.bread), progress = p === 'active' ? 1 : clamp(a!.age / a!.windup, 0, 1);
      // Outlines always show the final danger lane (for a defender standing still); only the fill tracks the wind-up.
      const pulse = calm ? 1 : .8 + .2 * Math.sin(time * 30);
      const color = side === 'cpu' ? progress > .7 ? '#d42a14' : '#ff4a26' : spec.color, opacity = Math.min(1, (side === 'cpu' ? .5 : .3) + .55 * progress) * pulse;
      const aim = a!.aim, target = -sign * 1.2;
      meshes.forEach(mesh => { mesh.material.color.set(color); mesh.material.opacity = opacity; });
      if (f.bread === 'shokupan') {
        const [frame, fill] = meshes as [Mark, Mark];
        frame.position.set(aim, .024, target); frame.scale.set(half, 1, spec.rz * 2);
        fill.position.set(aim, .022, target); fill.scale.set(half * 2 * progress, 1, spec.rz * 2 * progress); fill.material.opacity = opacity * .35;
      } else if (f.bread === 'francepan') {
        const [lane, fill, tip] = meshes as [Mark, Mark, Mark], near = sign * .9, length = Math.abs(target - near) + .3;
        lane.position.set(aim, .022, (near + target) / 2); lane.scale.set(half * 2, 1, length); lane.material.opacity = opacity * .3;
        // The bright core grows from the baguette toward the target as the thrust nears.
        fill.position.set(aim, .024, near - sign * length * progress / 2); fill.scale.set(half * 2, 1, Math.max(.01, length * progress)); fill.material.opacity = opacity * .55;
        tip.position.set(aim, .026, target - sign * .1); tip.scale.setScalar(.55); tip.rotation.y = side === 'player' ? 0 : Math.PI;
      } else {
        // One crescent per stage; each disappears once its hit window has passed.
        const tick = Math.round(a!.age * 120), extra = Math.round(a!.special!.extra * 120);
        meshes.forEach((mesh, i) => {
          mesh.visible = tick < spec.stages[i]!.to + extra;
          mesh.position.set(aim, .024 + i * .002, target + sign * (i * .22 - .1)); mesh.scale.set(half, 1, half * .8);
          mesh.rotation.y = side === 'player' ? 0 : Math.PI;
        });
      }
    }
  }
  private updateStance(battle: BattleView, cue: StanceCue | undefined, time: number): void {
    this.stance.visible = !!cue && !this.ending;
    if (!cue) return;
    const p = pose(battle.player, 'player'), m = this.stance.material, pulse = this.reducedMotion.matches ? 1 : .5 + .5 * Math.sin(time * 14);
    this.stance.position.x = p.x; this.stance.position.z = p.z;
    this.stance.scale.set(.75 + BREADS[battle.player.bread].width * .8, .75 + BREADS[battle.player.bread].width * .8, 1);
    const [color, opacity, grow] = cue === 'charged' ? [`hsl(${this.reducedMotion.matches ? 42 : 30 + 20 * pulse}, 95%, 58%)`, .6 + .35 * pulse, .08 * pulse] : cue === 'counter' ? ['#f2b53a', .55 + .4 * pulse, .12 * pulse] : cue === 'locked' ? ['#8a8575', .32, 0] : cue === 'recovery' ? ['#b7a98a', .28, 0] : ['#6f9a64', .5, 0];
    m.color.set(color); m.opacity = opacity; this.stance.scale.multiplyScalar(1 + grow);
  }
  setEnding(winner: Side | 'draw' | null): void {
    this.ending = winner === null ? null : { winner, start: performance.now() };
    if (winner !== null) for (const set of Object.values(this.marks)) for (const mark of Object.values(set).flat()) mark.visible = false;
  }
  // Screen position (CSS px within the canvas) of a point above the given side's bread.
  project(battle: BattleView, side: Side, lift = .75): { x: number; y: number } {
    const p = pose(battle[side], side), v = new THREE.Vector3(p.x, p.y + lift, p.z).project(this.camera);
    return { x: (v.x + 1) / 2 * this.canvas.clientWidth, y: (1 - v.y) / 2 * this.canvas.clientHeight };
  }
  // Offscreen stills from the loaded templates, rendered with one throwaway context. Framing centres on the face.
  private stills(jobs: { bread: BreadId; face: FaceFrame; px: number; close: number }[]): (string | undefined)[] {
    const result: (string | undefined)[] = [], canvas = document.createElement('canvas');
    let renderer: THREE.WebGLRenderer | undefined; const rigs: FaceRig[] = [];
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, .1, 20);
      scene.add(new THREE.HemisphereLight('#fff7df', '#846b50', 2.6));
      const key = new THREE.DirectionalLight('#fff5df', 3.2); key.position.set(-2, 3, 4); scene.add(key);
      for (const { bread, face, px, close } of jobs) {
        const template = this.templates.get(bread);
        if (!template) { result.push(undefined); continue; }
        renderer.setSize(px, px, false);
        const mesh = new THREE.Mesh(template.mesh.geometry, template.mesh.material), rig = new FaceRig(template.face), geometry = template.mesh.geometry; mesh.add(rig.group); rigs.push(rig);
        rig.update(face, geometry.attributes.position!, geometry.attributes.normal!);
        mesh.rotation.set(-.12, .18, bread === 'francepan' ? -.28 : 0); scene.add(mesh); mesh.updateMatrixWorld(true);
        const radius = new THREE.Box3().setFromObject(mesh).getBoundingSphere(new THREE.Sphere()).radius, target = mesh.localToWorld(new THREE.Vector3(0, FACE_FOCUS[bread], 0));
        camera.position.set(target.x, target.y, target.z + radius / Math.sin(THREE.MathUtils.degToRad(15)) * .78 / close); camera.lookAt(target);
        renderer.clear(); renderer.render(scene, camera); scene.remove(mesh);
        result.push(canvas.toDataURL('image/png'));
      }
    } catch { /* Stills are optional; the menu falls back to emoji and the HUD hides the portrait. */ }
    finally { for (const rig of rigs) rig.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); }
    return result;
  }
  // Menu / cut-in thumbnails with the resting face.
  thumbnails(size = 144): Partial<Record<BreadId, string>> {
    const ids = [...this.templates.keys()], shots = this.stills(ids.map(bread => ({ bread, face: new FaceState(bread).update(0, REST, true), px: size, close: THUMB_CLOSE[bread] })));
    const result: Partial<Record<BreadId, string>> = {};
    ids.forEach((id, i) => { if (shots[i]) result[id] = shots[i]; });
    return result;
  }
  // Draws the four HUD close-ups for one bread, once. Call it only from menus (after loading, when a bread is picked):
  // it blocks for a moment, which mid-match would trip the long-frame pause.
  preparePortraits(bread: BreadId): void {
    if (!this.portraits[bread] && this.templates.has(bread)) {
      const faces = MOODS.map(mood => {
        const state = new FaceState(bread); state.update(0, REST, true);
        if (mood === 'ouch' || mood === 'dodge') state.react(mood);
        return state.update(.01, mood === 'special' ? { ...REST, phase: 'active', special: true } : REST, true);
      });
      const shots = this.stills(faces.map(face => ({ bread, face, px: 96, close: PORTRAIT_CLOSE[bread] })));
      this.portraits[bread] = Object.fromEntries(MOODS.map((mood, i) => [mood, shots[i] ?? ''])) as Record<Mood, string>;
    }
  }
  // HUD face close-up for the player's current mood; undefined until preparePortraits() drew it (never drawn here).
  portrait(bread: BreadId, mood: Mood): string | undefined { return this.portraits[bread]?.[mood] || undefined; }
  playerMood(): Mood { return this.mood; }
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
  dispose(): void { for (const m of Object.values(this.actors)) { m.rig.dispose(); m.mesh.geometry.dispose(); m.mesh.material.dispose(); } this.actors = {}; this.ids = ''; this.resetEffects(true); this.reducedMotion.removeEventListener('change', this.motionChanged); this.resize.disconnect(); this.renderer.dispose(); }
}
