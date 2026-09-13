import { afterEach, describe, expect, it, vi } from 'vitest';
import { BattleAudio } from './audio';

afterEach(() => vi.unstubAllGlobals());
describe('battle audio failures and lifecycle', () => {
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
