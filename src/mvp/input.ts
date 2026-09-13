import { LIMIT, type Mode } from './config';
import { MotionFilter, finite, gravityRoll } from './motion';

type SensorConstructor = { requestPermission?: () => Promise<string> };
export class GameInput {
  mode: Mode = 'touch'; sensor = new MotionFilter(); enabled = false; pending = false;
  detectedAt = -Infinity; private left = false; private right = false;
  private pointerDirections = new Map<number, number>(); private held = new Set<string>();
  private attached = false;
  private lastGravityAt = -Infinity;
  constructor(controls: HTMLElement, private pause: () => void) {
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape') { e.preventDefault(); this.pause(); return; }
      if (!this.enabled || this.mode !== 'keyboard' || (e.target instanceof HTMLElement && /INPUT|SELECT|BUTTON/.test(e.target.tagName))) return;
      if (['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'KeyZ'].includes(e.code)) e.preventDefault();
      if (e.repeat || this.held.has(e.code)) return;
      this.held.add(e.code); this.keys();
      if (e.code === 'Space' || e.code === 'KeyZ') this.trigger();
    });
    window.addEventListener('keyup', e => { this.held.delete(e.code); this.keys(); });
    controls.addEventListener('pointerdown', e => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-control]');
      if (!button || !this.enabled || this.mode !== 'touch') return;
      e.preventDefault(); button.setPointerCapture(e.pointerId);
      const control = button.dataset.control;
      if (control === 'attack') this.trigger();
      else this.pointerDirections.set(e.pointerId, control === 'left' ? -1 : 1);
    });
    const release = (e: PointerEvent): void => { this.pointerDirections.delete(e.pointerId); };
    controls.addEventListener('pointerup', release); controls.addEventListener('pointercancel', release); controls.addEventListener('lostpointercapture', release);
    controls.addEventListener('click', e => { if ((e as MouseEvent).detail === 0 && this.enabled && this.mode === 'touch' && (e.target as HTMLElement).closest('[data-control="attack"]')) this.trigger(); });
    window.addEventListener('blur', () => this.clear());
  }
  private keys(): void { this.left = this.held.has('ArrowLeft') || this.held.has('KeyA'); this.right = this.held.has('ArrowRight') || this.held.has('KeyD'); }
  private trigger(): void { if (!this.enabled) return; this.pending = true; this.detectedAt = performance.now(); }
  consume(): boolean {
    if (this.sensor.poll(performance.now(), this.enabled && this.mode === 'sensor')) this.trigger();
    const value = this.pending; this.pending = false; return value;
  }
  target(): number {
    if (this.mode === 'sensor') return this.sensor.tilt;
    if (this.mode === 'keyboard') return ((this.right ? 1 : 0) - (this.left ? 1 : 0)) * LIMIT;
    return Math.max(-1, Math.min(1, [...this.pointerDirections.values()].reduce((a, b) => a + b, 0))) * LIMIT;
  }
  clear(): void { this.pending = false; this.held.clear(); this.keys(); this.pointerDirections.clear(); this.sensor.reset(); }
  setEnabled(enabled: boolean): void { if (this.enabled !== enabled) this.clear(); this.enabled = enabled; }
  async request(): Promise<void> {
    this.clear(); this.sensor.baseline = null; this.lastGravityAt = -Infinity;
    if (!window.isSecureContext) throw new Error('動きの操作にはHTTPSが必要です。HTTPSで開き直すか、補助操作を選んでください。');
    if (!('DeviceMotionEvent' in window) || !('DeviceOrientationEvent' in window)) throw new Error('このブラウザーは動きの取得に対応していません。補助操作を選んでください。');
    // Listen before requesting permission so the first valid samples are retained.
    this.sensor.lastMotion = this.sensor.lastOrientation = -Infinity;
    if (!this.attached) {
      window.addEventListener('devicemotion', e => {
        const a = e.acceleration, now = performance.now();
        const g = e.accelerationIncludingGravity;
        if (finite(g?.x) && finite(g?.y) && finite(a?.x) && finite(a?.y)) {
          const roll = gravityRoll(g.x - a.x, g.y - a.y);
          if (roll !== null) { this.sensor.orientation(roll, now); this.lastGravityAt = now; }
        }
        this.sensor.motion({ time: now, x: a?.x ?? null, y: a?.y ?? null, z: a?.z ?? null }, this.enabled && this.mode === 'sensor');
      });
      window.addEventListener('deviceorientation', e => {
        const now = performance.now();
        // A flat pose or a missing gravity component must not disable valid gamma forever.
        if (now - this.lastGravityAt > 250) this.sensor.orientation(e.gamma, now);
      });
      this.attached = true;
    }
    const motion = DeviceMotionEvent as unknown as SensorConstructor, orientation = DeviceOrientationEvent as unknown as SensorConstructor;
    // Both calls occur before the first await, within the click's transient user activation.
    const requests = [motion.requestPermission?.() ?? Promise.resolve('granted'), orientation.requestPermission?.() ?? Promise.resolve('granted')];
    const answers = await Promise.all(requests);
    if (answers.some(answer => answer !== 'granted')) throw new Error('動きの利用が許可されませんでした。Safariで許可を確認して再試行するか、タッチ操作を選べます。');
    const start = performance.now();
    await new Promise<void>((resolve, reject) => {
      const check = (): void => {
        if (this.sensor.fresh(performance.now())) resolve();
        else if (performance.now() - start > 3500) {
          const now = performance.now();
          const received = `動き：${now - this.sensor.lastMotion < 800 ? '受信' : '未受信'} / 傾き：${now - this.sensor.lastOrientation < 800 ? '受信' : '未受信'}`;
          reject(new Error(`許可は確認できましたが、動き・傾きの値が届きません。${received}。Safariで再確認するか、補助操作を選んでください。`));
        }
        else setTimeout(check, 80);
      }; check();
    });
  }
}
