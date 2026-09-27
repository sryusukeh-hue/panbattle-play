// Procedural café-style loop: no audio files, so the 5 MiB budget and licensing stay untouched.
export const TEMPO = 116;
export const STEPS_PER_BAR = 8; // eighth notes
export const LOOP_BARS = 8;
const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12);
// Cmaj7 - Am7 - Dm7 - G7, twice; roots and chord tones as MIDI numbers.
const CHORDS = [[48, 64, 67, 71], [45, 64, 67, 72], [50, 65, 69, 72], [43, 65, 67, 71]] as const;
// Melody per eighth for 8 bars (null = rest). A light, repeating hook over the progression.
const MELODY: (number | null)[] = [
  76, null, 79, null, 83, 81, 79, null, 76, null, 72, null, 74, 76, null, null,
  77, null, 76, 74, 72, null, 74, null, 71, null, 74, 77, 76, null, null, null,
  76, null, 79, null, 84, 83, 81, null, 79, null, 76, null, 79, 81, null, null,
  81, 79, 77, null, 76, 74, null, 72, 74, null, 71, null, 72, null, null, null,
];
export interface Note { frequency: number; duration: number; gain: number; type: OscillatorType }
// Notes that start on a given eighth-note step. `intense` adds a hi-hat pulse for the final seconds.
export function notesAt(step: number, intense = false): Note[] {
  const loop = STEPS_PER_BAR * LOOP_BARS, s = ((step % loop) + loop) % loop, bar = Math.floor(s / STEPS_PER_BAR), beat = s % STEPS_PER_BAR;
  const chord = CHORDS[bar % CHORDS.length]!, eighth = 60 / TEMPO / 2, notes: Note[] = [];
  if (beat === 0 || beat === 4) notes.push({ frequency: midi(chord[0]), duration: eighth * 3.2, gain: .5, type: 'triangle' });
  if (beat === 6) notes.push({ frequency: midi(chord[0] + 7), duration: eighth * 1.5, gain: .32, type: 'triangle' });
  if (beat === 2 || beat === 5) for (const tone of chord.slice(1)) notes.push({ frequency: midi(tone), duration: eighth * 1.2, gain: .14, type: 'sine' });
  const lead = MELODY[s];
  if (lead != null) notes.push({ frequency: midi(lead), duration: eighth * 1.6, gain: .22, type: 'sine' });
  if (intense) notes.push({ frequency: 0, duration: .04, gain: beat % 2 ? .1 : .18, type: 'square' });
  return notes;
}
export type Cue = 'count' | 'go' | 'win' | 'lose' | 'draw';
// Short cue melodies as [MIDI note, start offset seconds, duration seconds].
export const CUES: Record<Cue, [number, number, number][]> = {
  count: [[76, 0, .12]],
  go: [[79, 0, .09], [84, .08, .28]],
  win: [[72, 0, .12], [76, .1, .12], [79, .2, .12], [84, .3, .45]],
  lose: [[72, 0, .18], [69, .16, .18], [65, .32, .4]],
  draw: [[72, 0, .15], [72, .18, .3]],
};
export const frequencyOf = midi;
