import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareResult } from './share';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('result image sharing', () => {
  it('shares only the prepared local image and does not download on cancellation', async () => {
    const share = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { canShare: () => true, share });
    const file = new File(['image'], 'panbattle-result.png', { type: 'image/png' });
    expect(await shareResult(file)).toBe('shared'); expect(share).toHaveBeenCalledWith({ files: [file], title: 'パンバトルの結果' });
    share.mockRejectedValue(new DOMException('cancel', 'AbortError')); expect(await shareResult(file)).toBe('cancelled');
  });
  it.each([false, true])('saves locally if sharing is unavailable or fails (failure=%s)', async failure => {
    const click = vi.fn(), remove = vi.fn(); vi.stubGlobal('document', { createElement: () => ({ click, remove }), body: { append: vi.fn() } });
    vi.stubGlobal('navigator', failure ? { canShare: () => true, share: async () => { throw new Error('unavailable'); } } : {});
    vi.stubGlobal('setTimeout', (callback: () => void) => { callback(); return 0; });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = new File(['image'], 'result.png', { type: 'image/png' });
    expect(await shareResult(file)).toBe('saved'); expect(create).toHaveBeenCalledWith(file); expect(click).toHaveBeenCalledOnce(); expect(remove).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:local');
  });
});
