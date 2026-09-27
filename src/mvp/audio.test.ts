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
