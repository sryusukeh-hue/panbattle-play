import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BattleAudio, loadHitSound } from './audio';

beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false })));
afterEach(() => vi.unstubAllGlobals());
describe('battle audio failures and lifecycle', () => {
  it('tries both optional formats and returns synthesis fallback for missing or unreadable audio', async () => {
    const decodeAudioData = vi.fn().mockRejectedValue(new Error('codec'));
    vi.mocked(fetch).mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as Response);
    expect(await loadHitSound({ decodeAudioData }, 'shokupan')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2); expect(decodeAudioData).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect(await loadHitSound({ decodeAudioData }, 'francepan')).toBeNull();
  });
  it('uses one sampled voice without also playing synthesis, and late loading never replays a hit', async () => {
    let release!: (value: AudioBuffer) => void;
    const decoded = new Promise<AudioBuffer>(resolve => { release = resolve; });
    const parameter = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const source = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() });
    const oscillator = { ...source(), frequency: parameter() }, sample = source();
    const context = { state: 'running', currentTime: 0, destination: {}, resume: async () => {}, decodeAudioData: () => decoded,
      sampleRate: 100, createBuffer: () => ({ getChannelData: () => new Float32Array(20) }), createBufferSource: vi.fn(() => sample),
      createBiquadFilter: () => ({ connect: vi.fn(), frequency: { value: 0 }, Q: { value: 0 } }),
      createOscillator: vi.fn(() => oscillator), createGain: () => ({ connect: vi.fn(), gain: parameter() }) };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.mocked(fetch).mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as Response);
    const failed = vi.fn(), audio = new BattleAudio(() => true, failed); audio.unlock(); audio.play('hit', 0, 'croissant');
    expect(context.createOscillator).toHaveBeenCalledOnce(); expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(170 * 1.35, 0);
    release({ duration: .2 } as AudioBuffer); await audio.prepareHits();
    expect(sample.start).toHaveBeenCalledOnce();
    audio.play('hit', 0, 'croissant'); expect(sample.start).toHaveBeenCalledTimes(2); expect(context.createOscillator).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
  });
  it('keeps muted audio uninitialized and reports unavailable audio without throwing', () => {
    const constructor = vi.fn(() => { throw new Error('unavailable'); }); vi.stubGlobal('AudioContext', constructor);
    let enabled = false; const failed = vi.fn(), audio = new BattleAudio(() => enabled, failed);
    audio.unlock(); audio.play('hit'); expect(constructor).not.toHaveBeenCalled();
    enabled = true; audio.unlock(); expect(failed).toHaveBeenCalledOnce();
    audio.play('counter'); expect(failed).toHaveBeenCalledOnce();
  });
  it('stops active voices on pause or mute and handles rejected resume', async () => {
    const parameter = () => ({ setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
    const voice = { connect: vi.fn(), disconnect: vi.fn(), frequency: parameter(), start: vi.fn(), stop: vi.fn(), onended: null };
    const context = { state: 'running', currentTime: 0, destination: {}, resume: vi.fn().mockResolvedValue(undefined),
      sampleRate: 48000, createBuffer: () => ({ getChannelData: () => new Float32Array(9600) }),
      createBufferSource: () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
      createBiquadFilter: () => ({ connect: vi.fn(), disconnect: vi.fn(), frequency: { value: 0 }, Q: { value: 0 } }),
      createOscillator: () => voice, createGain: () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: parameter() }) };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    let enabled = true; const failed = vi.fn(), audio = new BattleAudio(() => enabled, failed);
    audio.unlock(); audio.play('counter', .2); expect(voice.start).toHaveBeenCalledWith(.2);
    enabled = false; audio.unlock(); expect(voice.stop).toHaveBeenCalledTimes(2);
    audio.play('hit'); expect(voice.start).toHaveBeenCalledOnce();
    enabled = true; context.resume.mockRejectedValueOnce(new Error('blocked')); audio.unlock();
    await Promise.resolve(); expect(failed).toHaveBeenCalledOnce();
  });
});

// Records every scheduled voice so pitch paths, timing and stops can be checked without Web Audio.
function recordingContext() {
  const parameter = (value = 0) => ({ value, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null });
  const oscillators: (ReturnType<typeof node> & { type: string; frequency: ReturnType<typeof parameter> })[] = [];
  const sources: ReturnType<typeof node>[] = [], gains: { gain: ReturnType<typeof parameter> }[] = [];
  const context = { state: 'running', currentTime: 0, destination: {}, resume: async () => {}, decodeAudioData: vi.fn(),
    sampleRate: 100, createBuffer: () => ({ getChannelData: () => new Float32Array(20) }),
    createBufferSource: vi.fn(() => { const source = node(); sources.push(source); return source; }),
    createBiquadFilter: () => ({ connect: vi.fn(), disconnect: vi.fn(), type: '', frequency: parameter(), Q: parameter() }),
    createOscillator: vi.fn(() => { const oscillator = { ...node(), type: '', frequency: parameter() }; oscillators.push(oscillator); return oscillator; }),
    createGain: vi.fn(() => { const gain = { connect: vi.fn(), disconnect: vi.fn(), gain: parameter(1) }; gains.push(gain); return gain; }) };
  vi.stubGlobal('AudioContext', class { constructor() { return context; } });
  return { context, oscillators, sources, gains };
}
describe('special move sounds and music ducking', () => {
  it.each([['shokupan', [180], 360, .22], ['francepan', [500], 1400, .2], ['croissant', [700, 950, 1200], undefined, .21]] as const)(
    '%s special rises with its signature, then a bright major chord, all within half a second', (bread, steps, glide, duration) => {
      const { oscillators, sources } = recordingContext(), failed = vi.fn(), audio = new BattleAudio(() => true, failed); audio.unlock();
      audio.play('special', 0, bread);
      const [rise, ...chord] = oscillators;
      expect(rise!.type).toBe('triangle'); expect(rise!.frequency.setValueAtTime.mock.calls.map(call => call[0])).toEqual(steps);
      if (glide) expect(rise!.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(glide, duration);
      const notes = chord.map(voice => voice.frequency.setValueAtTime.mock.calls[0]![0] as number);
      expect(notes).toHaveLength(4); expect(notes[1]! / notes[0]!).toBeCloseTo(1.26, 2); expect(notes[2]! / notes[0]!).toBeCloseTo(1.5, 2);
      const ends = [...oscillators, ...sources].map(voice => voice.stop.mock.calls[0]![0] as number);
      expect(Math.max(...ends)).toBeGreaterThanOrEqual(.35); expect(Math.max(...ends)).toBeLessThanOrEqual(.5); expect(failed).not.toHaveBeenCalled();
    });
  it.each([['shokupan', 120, 45, .18], ['francepan', 220, 65, .12], ['croissant', 160, 60, .16]] as const)(
    '%s finisher lands with a heavy drop plus a noise burst', (bread, from, to, duration) => {
      const { oscillators, sources } = recordingContext(), audio = new BattleAudio(() => true, vi.fn()); audio.unlock();
      audio.play('special-final', .1, bread);
      expect(oscillators[0]!.frequency.setValueAtTime).toHaveBeenCalledWith(from, .1);
      expect(oscillators[0]!.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(to, .1 + duration);
      expect(sources).toHaveLength(1); expect(sources[0]!.start).toHaveBeenCalledWith(.1);
    });
  it('layers a loaded hit sample under the finisher, and keeps middle stages, whiffs and the full chime short', async () => {
    const { context, oscillators, sources } = recordingContext();
    context.decodeAudioData.mockResolvedValue({ duration: .3 }); vi.mocked(fetch).mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) } as Response);
    const audio = new BattleAudio(() => true, vi.fn()); audio.unlock(); await audio.prepareHits();
    audio.play('special-final', 0, 'croissant'); expect(sources).toHaveLength(2); expect(oscillators).toHaveLength(2);
    for (const [kind, limit] of [['special-hit', .08], ['special-miss', .2], ['charged', .3]] as const) {
      oscillators.length = sources.length = 0; audio.play(kind);
      const ends = [...oscillators, ...sources].map(voice => voice.stop.mock.calls[0]![0] as number);
      expect(ends.length).toBeGreaterThan(0); expect(Math.max(...ends)).toBeLessThanOrEqual(limit);
    }
    expect(oscillators.map(voice => voice.frequency.setValueAtTime.mock.calls[0]![0])).toEqual([1046.5, 1318.5, 1568, 2093]);
  });
  it('stops scheduled special voices, including the chord that has not started yet, on pause or mute', () => {
    const { oscillators, sources } = recordingContext(), audio = new BattleAudio(() => true, vi.fn()); audio.unlock();
    audio.play('special', .3, 'croissant'); audio.silence();
    for (const voice of [...oscillators, ...sources]) expect(voice.stop).toHaveBeenCalledTimes(2);
    audio.play('charged'); audio.stop(); expect(oscillators.at(-1)!.stop).toHaveBeenCalledTimes(2);
  });
  it('duck is harmless without music, and lowers then restores the loop on its own timeline', () => {
    vi.useFakeTimers();
    try {
      const { context, gains } = recordingContext(); let music = false;
      const audio = new BattleAudio(() => true, vi.fn(), () => music); audio.duck(1);
      audio.unlock(); audio.duck(1); audio.music(true); expect(gains).toHaveLength(0);
      music = true; audio.music(true); const loop = gains[0]!.gain; loop.value = .16; context.currentTime = 2;
      audio.duck(.6);
      expect(loop.cancelScheduledValues).toHaveBeenCalledWith(2); expect(loop.exponentialRampToValueAtTime).toHaveBeenCalledWith(expect.closeTo(.056, 5), 2.06);
      expect(loop.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(.16, expect.closeTo(2.96, 5));
      audio.silence(); expect(loop.cancelScheduledValues).toHaveBeenCalledTimes(2); expect(loop.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(.0001, 2.25);
      const count = loop.exponentialRampToValueAtTime.mock.calls.length; audio.duck(1); vi.runAllTimers();
      expect(loop.exponentialRampToValueAtTime).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
  });  it('a loop restarted during a duck (resume mid cut-in) starts low and comes back after it', () => {
    vi.useFakeTimers();
    try {
      const { context, gains } = recordingContext(), audio = new BattleAudio(() => true, vi.fn(), () => true); audio.unlock();
      audio.music(true); audio.silence(); context.currentTime = 5;
      audio.duck(.4); const before = gains.length; audio.music(true);
      const loop = gains[before]!.gain; // tones scheduled right after use their own gains
      expect(loop.exponentialRampToValueAtTime).toHaveBeenCalledWith(expect.closeTo(.056, 5), expect.closeTo(5.06, 5));
      expect(loop.exponentialRampToValueAtTime).toHaveBeenLastCalledWith(.16, expect.closeTo(5.76, 5));
    } finally { vi.useRealTimers(); }
  });
});
