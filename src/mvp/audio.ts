import type { BattleSound } from './feedback';

const tones: Record<BattleSound, [number, number, number, OscillatorType]> = {
  telegraph: [440, 540, .1, 'sine'], swing: [300, 80, .09, 'triangle'],
  hit: [170, 65, .13, 'triangle'], clash: [105, 45, .17, 'triangle'],
  dodge: [650, 900, .12, 'sine'], counter: [730, 1050, .18, 'sine'], danger: [230, 160, .18, 'sine'],
};
export class BattleAudio {
  private context: AudioContext | undefined;
  private unavailable = false;
  private voices = new Set<AudioScheduledSourceNode>();
  private noise: AudioBuffer | undefined;
  constructor(private enabled: () => boolean, private fail: () => void) {}
  unlock(): void {
    if (!this.enabled()) { this.stop(); return; }
    this.unavailable = false;
    try { this.context ??= new AudioContext(); void this.context.resume().catch(() => this.failed()); }
    catch { this.failed(); }
  }
  private failed(): void { if (!this.unavailable) { this.unavailable = true; this.stop(); this.fail(); } }
  play = (kind: BattleSound, delay = 0): void => {
    const audio = this.context;
    if (!this.enabled() || this.unavailable || !audio || audio.state !== 'running') return;
    try {
      const [from, to, duration, type] = tones[kind], oscillator = audio.createOscillator(), gain = audio.createGain();
      const when = audio.currentTime + delay;
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.type = type;
      oscillator.frequency.setValueAtTime(from, when); oscillator.frequency.exponentialRampToValueAtTime(to, when + duration);
      gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(.07, when + .008);
      gain.gain.exponentialRampToValueAtTime(.001, when + duration);
      this.voices.add(oscillator);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(oscillator); };
      oscillator.start(when); oscillator.stop(when + duration);
      if (['swing', 'hit', 'clash', 'counter'].includes(kind)) {
        if (!this.noise) {
          this.noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * .2), audio.sampleRate);
          const data = this.noise.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        }
        const source = audio.createBufferSource(), filter = audio.createBiquadFilter(), noiseGain = audio.createGain();
        source.buffer = this.noise; filter.type = 'bandpass'; filter.frequency.value = kind === 'swing' ? 1600 : kind === 'clash' ? 450 : 800; filter.Q.value = .6;
        source.connect(filter); filter.connect(noiseGain); noiseGain.connect(audio.destination);
        noiseGain.gain.setValueAtTime(.0001, when); noiseGain.gain.exponentialRampToValueAtTime(.055, when + .008);
        noiseGain.gain.exponentialRampToValueAtTime(.001, when + duration);
        this.voices.add(source); source.onended = () => { source.disconnect(); filter.disconnect(); noiseGain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + duration);
      }
    } catch { this.failed(); }
  };
  stop = (): void => {
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already ended. */ } }
    this.voices.clear();
  };
}
