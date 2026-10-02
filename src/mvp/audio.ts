import type { BattleSound } from './feedback';
import { BREAD_IDS, type BreadId, type FighterId } from './config';
import { CUES, TEMPO, frequencyOf, notesAt, type Cue } from './music';
import type { IntroCue } from './cinematic';

const breadTone: Record<FighterId, readonly [number, number]> = { shokupan: [1, 650], francepan: [.72, 1400], croissant: [1.35, 2300], melonpan: [.92, 1800], currypan: [.82, 3400], creampan: [1.18, 850], ikkin: [.6, 420] };
export async function loadHitSound(audio: Pick<AudioContext, 'decodeAudioData'>, bread: BreadId): Promise<AudioBuffer | null> {
  for (const extension of ['m4a', 'mp3']) {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}assets/sfx/${bread}-hit.${extension}`);
      if (response.ok) return await audio.decodeAudioData(await response.arrayBuffer());
    } catch { /* Optional sample: keep the synthesized voice. */ }
  }
  return null;
}

type SpecialSound = Extract<BattleSound, `special${string}` | 'charged'>;
const SPECIAL_SOUNDS: readonly BattleSound[] = ['special', 'special-hit', 'special-final', 'special-miss', 'charged'];
const tones: Record<Exclude<BattleSound, SpecialSound>, [number, number, number, OscillatorType]> = {
  telegraph: [440, 540, .1, 'sine'], swing: [300, 80, .09, 'triangle'],
  hit: [170, 65, .13, 'triangle'], clash: [105, 45, .17, 'triangle'],
  dodge: [650, 900, .12, 'sine'], counter: [730, 1050, .18, 'sine'], danger: [230, 160, .18, 'sine'],
  heartbeat: [85, 55, .26, 'sine'],
};
// Special voices (EXECPLAN-SPECIAL 5.5): signature rise before the major-triad sparkle, and the landing thud.
const specialRise: Record<FighterId, [number[], number, number]> = {
  ikkin: [[90, 120, 180], .30, 261.63],
  shokupan: [[180, 360], .22, 523.25], francepan: [[500, 1400], .20, 659.25], croissant: [[700, 950, 1200], .21, 783.99],
  melonpan: [[240, 360, 480], .21, 587.33], currypan: [[220, 440, 880], .21, 392.00], creampan: [[440, 660], .20, 698.46],
};
const specialLand: Record<FighterId, [number, number, number, number]> = {
  ikkin: [95, 32, .26, 380],
  shokupan: [120, 45, .18, 650], francepan: [220, 65, .12, 5200], croissant: [160, 60, .16, 2300],
  melonpan: [145, 55, .17, 1800], currypan: [180, 45, .18, 3400], creampan: [190, 75, .14, 850],
};
const MUSIC_LEVEL = .16;
export class BattleAudio {
  private context: AudioContext | undefined;
  private unavailable = false;
  private voices = new Set<AudioScheduledSourceNode>();
  private noise: AudioBuffer | undefined;
  private samples = new Map<BreadId, AudioBuffer>(); private loading: Promise<void> | undefined;
  private musicGain: GainNode | undefined; private musicTimer: ReturnType<typeof setInterval> | undefined;
  private duckUntil = 0; private musicStep = 0; private musicAt = 0; private intense = false;
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
  play = (kind: BattleSound, delay = 0, bread: FighterId = 'shokupan'): void => {
    const audio = this.context;
    if (!this.enabled() || this.unavailable || !audio || audio.state !== 'running') return;
    try {
      const when = audio.currentTime + delay;
      if (SPECIAL_SOUNDS.includes(kind)) { this.special(audio, kind as SpecialSound, when, bread); return; }
      const impact = ['hit', 'clash', 'counter'].includes(kind), sample = impact && bread !== 'ikkin' ? this.samples.get(bread) : undefined;
      if (sample) {
        const source = audio.createBufferSource(), gain = audio.createGain(); source.buffer = sample;
        source.connect(gain); gain.connect(audio.destination); gain.gain.setValueAtTime(.3, when);
        this.voices.add(source); source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + Math.min(sample.duration, .4)); return;
      }
      const [baseFrom, baseTo, duration, type] = tones[kind as Exclude<BattleSound, SpecialSound>], pitch = impact ? breadTone[bread][0] : 1;
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
        const source = audio.createBufferSource(), filter = audio.createBiquadFilter(), noiseGain = audio.createGain();
        source.buffer = this.noiseOf(audio); filter.type = 'bandpass'; filter.frequency.value = kind === 'swing' ? 1600 : breadTone[bread][1]; filter.Q.value = .6;
        source.connect(filter); filter.connect(noiseGain); noiseGain.connect(audio.destination);
        noiseGain.gain.setValueAtTime(.0001, when); noiseGain.gain.exponentialRampToValueAtTime(.055, when + .008);
        noiseGain.gain.exponentialRampToValueAtTime(.001, when + duration);
        this.voices.add(source); source.onended = () => { source.disconnect(); filter.disconnect(); noiseGain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + duration);
      }
    } catch { this.failed(); }
  };
  private noiseOf(audio: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = audio.createBuffer(1, Math.ceil(audio.sampleRate * .2), audio.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }
  // One pitch path (steps, or a glide for two points) tracked with the combat voices so pause/mute stops it.
  private sweep(audio: AudioContext, path: number[], when: number, duration: number, peak: number, type: OscillatorType, glide = path.length === 2): void {
    const oscillator = audio.createOscillator(), gain = audio.createGain();
    oscillator.type = type; oscillator.connect(gain); gain.connect(audio.destination);
    path.forEach((frequency, i) => i && glide ? oscillator.frequency.exponentialRampToValueAtTime(frequency, when + duration)
      : oscillator.frequency.setValueAtTime(frequency, when + i * duration / path.length));
    gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(peak, when + .008); gain.gain.exponentialRampToValueAtTime(.001, when + duration);
    this.voices.add(oscillator); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this.voices.delete(oscillator); };
    oscillator.start(when); oscillator.stop(when + duration);
  }
  // Filtered noise burst (max .2 s, the shared buffer); from -> to glides the filter for whooshes.
  private burst(audio: AudioContext, when: number, duration: number, from: number, to: number, peak: number, type: BiquadFilterType): void {
    const source = audio.createBufferSource(), filter = audio.createBiquadFilter(), gain = audio.createGain();
    source.buffer = this.noiseOf(audio); filter.type = type; filter.Q.value = .8;
    filter.frequency.setValueAtTime(from, when); filter.frequency.exponentialRampToValueAtTime(to, when + duration);
    source.connect(filter); filter.connect(gain); gain.connect(audio.destination);
    gain.gain.setValueAtTime(.0001, when); gain.gain.exponentialRampToValueAtTime(peak, when + .006); gain.gain.exponentialRampToValueAtTime(.001, when + duration);
    this.voices.add(source); source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); this.voices.delete(source); };
    source.start(when); source.stop(when + duration);
  }
  private special(audio: AudioContext, kind: SpecialSound, when: number, bread: FighterId): void {
    if (kind === 'special') {
      const [path, duration, root] = specialRise[bread];
      this.sweep(audio, path, when, duration, .08, 'triangle'); this.burst(audio, when, duration, 900, 6000, .025, 'highpass');
      for (const ratio of [1, 1.26, 1.5, 2]) this.sweep(audio, [root * ratio], when + duration - .03, .24, .03, 'sine');
    } else if (kind === 'special-final') {
      const [from, to, duration, noise] = specialLand[bread], sample = bread === 'ikkin' ? undefined : this.samples.get(bread);
      this.sweep(audio, [from, to], when, duration, .11, 'triangle'); this.sweep(audio, [from / 2, 40], when, duration + .06, .09, 'sine');
      this.burst(audio, when, Math.min(.2, duration + .05), noise, noise * .5, .08, bread === 'francepan' ? 'highpass' : 'bandpass');
      if (sample) {
        const source = audio.createBufferSource(), gain = audio.createGain(); source.buffer = sample;
        source.connect(gain); gain.connect(audio.destination); gain.gain.setValueAtTime(.26, when);
        this.voices.add(source); source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(source); };
        source.start(when); source.stop(when + Math.min(sample.duration, .4));
      }
    } else if (kind === 'special-hit') { this.burst(audio, when, .07, 3200, 1600, .045, 'bandpass'); this.sweep(audio, [900, 520], when, .06, .03, 'triangle'); }
    else if (kind === 'special-miss') { this.burst(audio, when, .2, 2400, 380, .05, 'bandpass'); this.sweep(audio, [700, 180], when, .2, .025, 'sine'); }
    else [1046.5, 1318.5, 1568, 2093].forEach((frequency, i) => this.sweep(audio, [frequency], when + i * .05, .12, .04, 'sine'));
  }
  // Briefly lowers the background loop (e.g. under a special); the restore lives on the gain's own timeline,
  // so stopMusic()/silence() cancel it with the rest of the schedule and never raise a stopped loop.
  duck = (seconds: number): void => {
    const gain = this.musicGain?.gain, audio = this.context;
    // Remembered so a loop restarted mid-duck (resume after a pause) starts low too.
    if (audio) this.duckUntil = audio.currentTime + .06 + Math.max(0, seconds);
    if (!gain || !audio) return;
    try {
      const now = audio.currentTime, low = Math.min(gain.value || .0001, MUSIC_LEVEL * .35), back = now + .06 + Math.max(0, seconds);
      gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value || .0001, now); gain.exponentialRampToValueAtTime(low, now + .06);
      gain.setValueAtTime(low, back); gain.exponentialRampToValueAtTime(MUSIC_LEVEL, back + .3);
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
  // Boss entrance (plans/EXECPLAN-BOSS.md 4): crockery rattle, a falling whoosh, the landing thud, the eye glint, the motif.
  boss = (cue: IntroCue): void => {
    const audio = this.context;
    if (!this.enabled() || this.unavailable || !audio || audio.state !== 'running') return;
    try {
      const when = audio.currentTime;
      if (cue === 'rumble') { this.burst(audio, when, .12, 4200, 3000, .03, 'bandpass'); this.sweep(audio, [70, 55], when, .2, .05, 'sine'); }
      else if (cue === 'whoosh') { this.burst(audio, when, .2, 300, 2400, .04, 'bandpass'); this.sweep(audio, [65, 50], when, .8, .06, 'triangle'); }
      else if (cue === 'thud') { this.sweep(audio, [110, 55], when, .22, .14, 'triangle'); this.sweep(audio, [55, 32], when, .3, .12, 'sine'); this.burst(audio, when, .2, 900, 200, .09, 'lowpass'); }
      else if (cue === 'glint') this.sweep(audio, [1568, 2093], when, .14, .035, 'sine');
      else for (const [note, offset] of [[48, 0], [55, .16], [60, .32]] as const) this.tone(audio, audio.destination, frequencyOf(note), when + offset, .3, .1, 'triangle', this.cues);
    } catch { this.failed(); }
  };
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
      const now = audio!.currentTime, ducked = this.duckUntil > now;
      this.musicGain.gain.setValueAtTime(.0001, now); this.musicGain.gain.exponentialRampToValueAtTime(ducked ? MUSIC_LEVEL * .35 : MUSIC_LEVEL, now + (ducked ? .06 : .6));
      if (ducked) { this.musicGain.gain.setValueAtTime(MUSIC_LEVEL * .35, this.duckUntil); this.musicGain.gain.exponentialRampToValueAtTime(MUSIC_LEVEL, this.duckUntil + .3); }
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
    this.stopMusic(); this.duckUntil = 0;
    for (const cue of this.cues) { try { cue.stop(); } catch { /* Already ended. */ } }
    this.cues.clear(); this.stop();
  };
  // Stops combat effects only; music and cues follow their own lifecycle (see music()).
  stop = (): void => {
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already ended. */ } }
    this.voices.clear();
  };
}
