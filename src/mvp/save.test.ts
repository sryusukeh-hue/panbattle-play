import { describe, expect, it } from 'vitest';
import { Battle } from './battle';
import { SaveStore, SAVE_KEY, condition, defaults, rate } from './save';
function memory() {
  const map = new Map<string, string>([['panbattle.save', '{"old":"keep exactly"}']]);
  return { map, getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}
describe('separate 3D save and scores', () => {
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
});
