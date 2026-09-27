import { describe, expect, it } from 'vitest';
import { Battle } from './battle';
import { SaveStore, SAVE_KEY, condition, defaults, rate } from './save';
function memory() {
  const map = new Map<string, string>([['panbattle.save', '{"old":"keep exactly"}']]);
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}
describe('separate 3D save and scores', () => {
  it('migrates old shared sensitivity without changing records, choices or the old field', () => {
    const storage = memory();
    const { attackSensitivity: _attack, tiltSensitivity: _tilt, ...old } = defaults();
    const value = { ...old, sensitivity: 1.3, sound: true, practiced: true, bread: 'francepan', best: {
      [condition('francepan', 'shokupan', 'sensor')]: { dodge: { success: 2, opportunities: 3 } },
    } };
    storage.setItem(SAVE_KEY, JSON.stringify(value));
    const store = new SaveStore(() => storage);
    expect(store.data).toEqual({ ...value, attackSensitivity: 1.3, tiltSensitivity: 1.3 });
    expect(storage.getItem(SAVE_KEY)).toBe(JSON.stringify(value));
    store.data.attackSensitivity = .7; store.persist();
    const reopened = new SaveStore(() => storage);
    expect(reopened.data.attackSensitivity).toBe(.7); expect(reopened.data.tiltSensitivity).toBe(1.3);
    expect(reopened.data.sensitivity).toBe(1.3); expect(reopened.data.best).toEqual(value.best);
  });
  it.each(['attackSensitivity', 'tiltSensitivity'])('preserves invalid %s data', field => {
    for (const value of [null, '1', .5, 1.7]) {
      const storage = memory(), raw = JSON.stringify({ ...defaults(), [field]: value }); storage.setItem(SAVE_KEY, raw);
      const store = new SaveStore(() => storage); expect(store.persist()).toBe(false); expect(storage.getItem(SAVE_KEY)).toBe(raw);
    }
  });
  it('preserves legacy bytes and separates bread/opponent/mode/rule comparisons', () => {
    const storage = memory(), store = new SaveStore(() => storage), b = new Battle('shokupan', 'francepan'); b.outcome = 'win';
    b.scores.dodge = { success: 3, opportunities: 4 };
    expect(store.record(b, 'touch')).toEqual({});
    expect(storage.getItem('panbattle.save')).toBe('{"old":"keep exactly"}');
    expect(store.data.best[condition('shokupan', 'francepan', 'touch')]?.dodge).toEqual({ success: 3, opportunities: 4 });
    expect(store.record(b, 'sensor')).toEqual({}); expect(store.data.best[condition('shokupan', 'shokupan', 'touch')]).toBeUndefined();
    const reopened = new SaveStore(() => storage); expect(reopened.warning).toBe(''); expect(reopened.data.best).toEqual(store.data.best);
  });
  it('keeps best per item and returns the previous record for comparison', () => {
    const storage = memory(), store = new SaveStore(() => storage), b = new Battle('shokupan', 'shokupan'); b.outcome = 'win';
    b.scores = { dodge: { success: 3, opportunities: 4 }, counter: { success: 1, opportunities: 3 } }; store.record(b, 'touch');
    b.scores = { dodge: { success: 1, opportunities: 3 }, counter: { success: 2, opportunities: 2 } }; const previous = store.record(b, 'touch');
    expect(rate(previous.dodge)).toBe(.75); expect(rate(previous.counter)).toBe(1 / 3);
    const best = store.data.best[condition('shokupan', 'shokupan', 'touch')]!; expect(rate(best.dodge)).toBe(.75); expect(rate(best.counter)).toBe(1);
  });
  it('zero opportunities, practice and unfinished matches never update best', () => {
    const storage = memory(), store = new SaveStore(() => storage), b = new Battle('shokupan', 'shokupan');
    b.scores.dodge = { success: 1, opportunities: 1 }; store.record(b, 'touch'); expect(storage.getItem(SAVE_KEY)).toBeNull();
    b.outcome = 'win'; b.practice = true; store.record(b, 'touch'); expect(storage.getItem(SAVE_KEY)).toBeNull();
    b.practice = false; b.scores.dodge = { success: 0, opportunities: 0 }; store.record(b, 'touch'); expect(rate(store.data.best[condition('shokupan', 'shokupan', 'touch')]?.dodge)).toBeNull();
  });
  it('storage access/read/write failures remain visible while in-memory play continues', () => {
    const denied = new SaveStore(() => { throw new Error('blocked'); }); expect(denied.warning).toContain('読み込めません'); expect(denied.persist()).toBe(false);
    const storage = memory(); const full = new SaveStore(() => ({ ...storage, setItem: () => { throw new Error('quota'); } }));
    full.data.sound = true; expect(full.persist()).toBe(false); expect(full.warning).toContain('保存できません'); expect(full.data.sound).toBe(true);
  });
  it.each(['bad json', JSON.stringify({ ...defaults(), sensitivity: 99 }), JSON.stringify({ ...defaults(), best: { invalid: { dodge: { success: 9, opportunities: 1 } } } })])('corrupt data is never silently replaced: %s', raw => {
    const storage = memory(); storage.setItem(SAVE_KEY, raw); const store = new SaveStore(() => storage); expect(store.warning).not.toBe(''); expect(store.persist()).toBe(false); expect(storage.getItem(SAVE_KEY)).toBe(raw);
  });
  it('separates difficulty records and keeps the higher best score', () => {
    const storage = memory(), store = new SaveStore(() => storage), b = new Battle('shokupan', 'shokupan', { difficulty: 'hard' }); b.outcome = 'win';
    b.scores.dodge = { success: 1, opportunities: 2 }; store.record(b, 'touch');
    expect(store.data.best[condition('shokupan', 'shokupan', 'touch', 'hard')]?.dodge).toEqual({ success: 1, opportunities: 2 });
    expect(store.data.best[condition('shokupan', 'shokupan', 'touch')]).toBeUndefined();
    expect(store.recordScore(b, 'touch', 62)).toBeNull(); expect(store.recordScore(b, 'touch', 40)).toBe(62); expect(store.recordScore(b, 'touch', 80)).toBe(62);
    store.data.difficulty = 'normal'; store.data.music = false; store.persist();
    const reopened = new SaveStore(() => storage); expect(reopened.warning).toBe('');
    expect(reopened.data.bestScoreV2).toEqual({ [condition('shokupan', 'shokupan', 'touch', 'hard')]: 80 });
    expect(reopened.data.difficulty).toBe('normal'); expect(reopened.data.music).toBe(false);
    const practice = new Battle('shokupan', 'shokupan', { practice: true }); practice.outcome = 'win';
    expect(store.recordScore(practice, 'touch', 99)).toBeNull(); expect(Object.keys(store.data.bestScoreV2!)).toHaveLength(1);
  });
  it.each([{ difficulty: 'extreme' }, { music: 'yes' }, { bestScoreV2: { 'table-1/shokupan/shokupan/hard/touch': 101 } }, { bestScoreV2: { nope: 5 } }, { bestScoreV2: [] }])('rejects invalid optional field %j without replacing it', extra => {
    const storage = memory(), raw = JSON.stringify({ ...defaults(), ...extra }); storage.setItem(SAVE_KEY, raw);
    const store = new SaveStore(() => storage); expect(store.warning).not.toBe(''); expect(store.persist()).toBe(false); expect(storage.getItem(SAVE_KEY)).toBe(raw);
  });
  it('keeps a legacy bestScore field untouched while comparing only bestScoreV2', () => {
    const storage = memory(), legacy = { ...defaults(), bestScore: { 'table-1/shokupan/shokupan/gentle/touch': 99 } };
    storage.setItem(SAVE_KEY, JSON.stringify(legacy));
    const store = new SaveStore(() => storage), b = new Battle('shokupan', 'shokupan'); b.outcome = 'win';
    expect(store.warning).toBe(''); expect(store.recordScore(b, 'touch', 50)).toBeNull();
    const saved = JSON.parse(storage.getItem(SAVE_KEY)!);
    expect(saved.bestScore).toEqual(legacy.bestScore); expect(saved.bestScoreV2).toEqual({ 'table-1/shokupan/shokupan/gentle/touch': 50 });
  });
});

