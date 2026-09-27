import type { BattleSound } from './feedback';
import { BREAD_IDS, type BreadId } from './config';
import { CUES, TEMPO, frequencyOf, notesAt, type Cue } from './music';

const breadTone = { shokupan: [1, 650], francepan: [.72, 1400], croissant: [1.35, 2300] } as const;
export async function loadHitSound(audio: Pick<AudioContext, 'decodeAudioData'>, bread: BreadId): Promise<AudioBuffer | null> {
  for (const extension of ['m4a', 'mp3']) {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}assets/sfx/${bread}-hit.${extension}`);
      if (response.ok) return await audio.decodeAudioData(await response.arrayBuffer());
    } catch { /* Optional sample: keep the synthesized voice. */ }
  }
  return null;
}

const tones: Record<BattleSound, [number, number, number, OscillatorType]> = {
  telegraph: [440, 540, .1, 'sine'], swing: [300, 80, .09, 'triangle'],
  hit: [170, 65, .13, 'triangle'], clash: [105, 45, .17, 'triangle'],
  dodge: [650, 900, .12, 'sine'], counter: [730, 1050, .18, 'sine'], danger: [230, 160, .18, 'sine'],
  heartbeat: [85, 55, .26, 'sine'],
};
export class BattleAudio {
  private context: AudioContext | undefined;
  private unavailable = false;
  private voices = new Set<AudioScheduledSourceNode>();
  private noise: AudioBuffer | undefined;
  private samples = new Map<BreadId, AudioBuffer>(); private loading: Promise<void> | undefined;
  private musicGain: GainNode | undefined; private musicTimer: ReturnType<typeof setInterval> | undefined;
  private musicStep = 0; private musicAt = 0; private intense = false;
  private cues = new Set<OscillatorNode>();
  constructor(private enabled: () => boolean, private fail: () => void, private musicEnabled: () => boolean = () => false) {}
  unlock(): void {
    if (!this.enabled()) { this.stop(); return; }
    this.unavailable = false;
    try { this.context ??= new AudioContext(); void this.context.resume().catch(() => this.failed()); void this.prepareHits(); }
    catch { this.failed(); }
  }
  private failed(): void { if (!this.unavailable) { this.unavailable = true; this.stop(); this.fail(); } }
  prepareHits(): Promise<void> {
    if (!this.context) return Promise.resolve();
    const audio = this.context;
    return this.loading ??= Promise.all(BREAD_IDS.map(async bread => { const sample = await loadHitSound(audio, bread); if (sample) this.samples.set(bread, sample); })).then(() => {});
  }
  play = (kind: BattleSound, delay = 0, bread: BreadId = 'shokupan'): void => {
    const audio = this.context;
    if (!this.enabled() || this.unavailable || !audio || audio.state !== 'running') return;
    try {
      const when = audio.currentTime + delay;
      const impact = ['hit', 'clash', 'counter'].includes(kind), sample = impact ? this.samples.get(bread) : undefined;
      if (sample) {
        const source = audio.createBufferSource(), gain = audio.createGain(); source.buffer = sample;
        source.connect(gain); gain.connect(audio.destination); gain.gain.setValueAtTime(.3, when);
        this.voices.add(source); source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + Math.min(sample.duration, .4)); return;
      }
      const [baseFrom, baseTo, duration, type] = tones[kind], pitch = impact ? breadTone[bread][0] : 1;
      const from = baseFrom * pitch, to = baseTo * pitch, oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.type = type;
      oscillator.frequency.setValueAtTime(from, when); oscillator.frequency.exponentialRampToValueAtTime(to, when + duration);
      gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(.07, when + .008);
      if (kind === 'heartbeat') { gain.gain.exponentialRampToValueAtTime(.001, when + .08); gain.gain.exponentialRampToValueAtTime(.045, when + .14); }
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
        source.buffer = this.noise; filter.type = 'bandpass'; filter.frequency.value = kind === 'swing' ? 1600 : breadTone[bread][1]; filter.Q.value = .6;
        source.connect(filter); filter.connect(noiseGain); noiseGain.connect(audio.destination);
        noiseGain.gain.setValueAtTime(.0001, when); noiseGain.gain.exponentialRampToValueAtTime(.055, when + .008);
        noiseGain.gain.exponentialRampToValueAtTime(.001, when + duration);
        this.voices.add(source); source.onended = () => { source.disconnect(); filter.disconnect(); noiseGain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + duration);
      }
    } catch { this.failed(); }
  };
  private tone(audio: AudioContext, output: AudioNode, frequency: number, when: number, duration: number, peak: number, type: OscillatorType, group?: Set<OscillatorNode>): void {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.connect(gain); gain.connect(output);
    gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(peak, when + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, when + duration);
    group?.add(oscillator); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); group?.delete(oscillator); };
    oscillator.start(when); oscillator.stop(when + duration + .02);
  }
  // Countdown, start and result jingles.
  cue = (kind: Cue): void => {
    const audio = this.context;
    if (!this.enabled() || this.unavailable || !audio || audio.state !== 'running') return;
    try { for (const [note, offset, duration] of CUES[kind]) this.tone(audio, audio.destination, frequencyOf(note), audio.currentTime + offset, duration, .09, 'triangle', this.cues); }
    catch { this.failed(); }
  };
  // Idempotent per-frame call: starts, keeps or fades the background loop.
  music = (playing: boolean, intense = false): void => {
    const audio = this.context, on = playing && this.enabled() && this.musicEnabled() && !this.unavailable && !!audio && audio.state === 'running';
    this.intense = intense;
    if (!on) { this.stopMusic(); return; }
    if (this.musicTimer !== undefined) return;
    try {
      this.musicGain = audio!.createGain(); this.musicGain.connect(audio!.destination);
      this.musicGain.gain.setValueAtTime(.0001, audio!.currentTime); this.musicGain.gain.exponentialRampToValueAtTime(.16, audio!.currentTime + .6);
      this.musicAt = audio!.currentTime + .05; this.musicStep = 0;
      const eighth = 60 / TEMPO / 2;
      const schedule = (): void => {
        const output = this.musicGain; if (!output || !this.context) return;
        try {
          while (this.musicAt < this.context.currentTime + .25) {
            for (const note of notesAt(this.musicStep, this.intense)) {
              if (note.frequency > 0) this.tone(this.context, output, note.frequency, this.musicAt, note.duration, note.gain * .35, note.type);
              else this.tone(this.context, output, 6200 + (this.musicStep % 2) * 800, this.musicAt, note.duration, note.gain * .12, note.type);
            }
            this.musicAt += eighth; this.musicStep++;
          }
        } catch { this.failed(); }
      };
      schedule(); this.musicTimer = setInterval(schedule, 90);
    } catch { this.failed(); }
  };
  private stopMusic(): void {
    if (this.musicTimer !== undefined) { clearInterval(this.musicTimer); this.musicTimer = undefined; }
    const gain = this.musicGain, audio = this.context; this.musicGain = undefined;
    if (!gain || !audio) return;
    try { gain.gain.cancelScheduledValues(audio.currentTime); gain.gain.setValueAtTime(gain.gain.value || .0001, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + .25); }
    catch { /* Context already closed. */ }
    setTimeout(() => { try { gain.disconnect(); } catch { /* Already disconnected. */ } }, 400);
  }
  // Mute or pause: stops music and pending jingles as well as combat effects.
  silence = (): void => {
    this.stopMusic();
    for (const cue of this.cues) { try { cue.stop(); } catch { /* Already ended. */ } }
    this.cues.clear(); this.stop();
  };
  // Stops combat effects only; music and cues follow their own lifecycle (see music()).
  stop = (): void => {
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already ended. */ } }
    this.voices.clear();
  };
}
