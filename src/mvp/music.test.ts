import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUES, LOOP_BARS, STEPS_PER_BAR, notesAt } from './music';
import { BattleAudio } from './audio';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('procedural music', () => {
  it('loops deterministically with bass on the downbeat and finite notes', () => {
    const loop = STEPS_PER_BAR * LOOP_BARS;
    for (let step = 0; step < loop; step++) {
      expect(notesAt(step)).toEqual(notesAt(step + loop));
      for (const note of notesAt(step, true)) { expect(Number.isFinite(note.frequency)).toBe(true); expect(note.duration).toBeGreaterThan(0); expect(note.gain).toBeLessThanOrEqual(.5); }
    }
    expect(notesAt(0).some(n => n.type === 'triangle' && n.frequency < 200)).toBe(true);
    expect(notesAt(1, true).length).toBe(notesAt(1).length + 1);
    for (const cue of Object.values(CUES)) expect(cue.length).toBeGreaterThan(0);
  });
  it('starts once, follows the music setting and survives effect stops', () => {
    vi.useFakeTimers();
    const parameter = () => ({ value: .1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
    const context = { state: 'running', currentTime: 0, destination: {}, resume: async () => {}, decodeAudioData: vi.fn(),
      createOscillator: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: parameter(), type: 'sine' })),
      createGain: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), gain: parameter() })) };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    let music = true; const failed = vi.fn(), audio = new BattleAudio(() => true, failed, () => music);
    audio.unlock(); audio.music(true);
    const started = context.createOscillator.mock.calls.length; expect(started).toBeGreaterThan(0);
    audio.music(true); audio.stop(); expect(context.createOscillator.mock.calls.length).toBe(started);
    context.currentTime = 1; vi.advanceTimersByTime(100); expect(context.createOscillator.mock.calls.length).toBeGreaterThan(started);
    music = false; audio.music(true); const stopped = context.createOscillator.mock.calls.length;
    context.currentTime = 3; vi.advanceTimersByTime(500); expect(context.createOscillator.mock.calls.length).toBe(stopped);
    audio.cue('go'); expect(context.createOscillator.mock.calls.length).toBe(stopped + CUES.go.length);
    const cueNodes = context.createOscillator.mock.results.slice(-CUES.go.length).map(r => r.value);
    audio.silence(); for (const node of cueNodes) expect(node.stop).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });
});
