import { BREADS, type BreadId } from './config';
import type { Outcome, Scores } from './battle';
import { rate } from './save';

export interface ResultExtra { rank: string; score: number; level: string }
export async function resultImage(player: BreadId, cpu: BreadId, outcome: Outcome, scores: Scores, extra?: ResultExtra): Promise<File> {
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1080;
  const c = canvas.getContext('2d'); if (!c) throw new Error('canvas unavailable');
  c.fillStyle = '#faf2de'; c.fillRect(0, 0, 1080, 1080);
  c.fillStyle = '#344e40'; c.fillRect(0, 0, 1080, 24); c.fillRect(0, 1056, 1080, 24);
  c.textAlign = 'center'; c.fillStyle = '#66735c'; c.font = '700 30px sans-serif'; c.fillText(`パンバトル / CPU戦 / ${outcome === 'win' ? '勝利' : outcome === 'lose' ? '敗北' : '引き分け'}`, 540, 125);
  c.fillStyle = '#3b3026'; c.font = '800 70px sans-serif'; c.fillText(outcome === 'win' ? 'こんがり、勝利！' : outcome === 'lose' ? '次は、ひょいと回避。' : 'いい勝負、引き分け。', 540, 255, 940);
  c.font = '500 35px sans-serif'; c.fillText(`${BREADS[player].name} vs ${BREADS[cpu].name}${extra ? ` · ${extra.level}CPU` : ''}`, 540, 350);
  if (extra) {
    c.fillStyle = extra.rank === 'S' ? '#d8a02c' : extra.rank === 'A' ? '#4f7152' : extra.rank === 'B' ? '#5f8594' : '#9a7a62';
    c.beginPath(); c.arc(960, 118, 72, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#fff9ea'; c.font = 'italic 900 84px sans-serif'; c.fillText(extra.rank, 960, 148);
    c.fillStyle = '#a65b2b'; c.font = '800 36px sans-serif'; c.fillText(`SCORE ${extra.score}`, 540, 412);
  }
  for (const [i, key] of (['dodge', 'counter'] as const).entries()) {
    const y = 460 + i * 225, score = scores[key], value = rate(score);
    c.fillStyle = '#e8e7d6'; c.fillRect(90, y, 900, 185);
    c.fillStyle = '#3b3026'; c.textAlign = 'left'; c.font = '700 38px sans-serif'; c.fillText(key === 'dodge' ? '回避' : '回避後の反撃', 130, y + 65);
    c.font = '400 30px sans-serif'; c.fillText(`${score.success}成功 / ${score.opportunities}機会`, 130, y + 130);
    c.fillStyle = '#344e40'; c.textAlign = 'right'; c.font = '800 57px sans-serif'; c.fillText(value === null ? '対象なし' : `${Math.round(value * 100)}%`, 945, y + 107);
  }
  c.textAlign = 'center'; c.fillStyle = '#66735c'; c.font = '500 30px sans-serif'; c.fillText('ひょいと避けて、こんがり反撃。', 540, 985);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('image unavailable')), 'image/png'));
  return new File([blob], 'panbattle-result.png', { type: 'image/png' });
}

export async function shareResult(file: File): Promise<'shared' | 'saved' | 'cancelled'> {
  const data = { files: [file], title: 'パンバトルの結果' };
  try {
    if (navigator.share && navigator.canShare?.(data)) { await navigator.share(data); return 'shared'; }
  } catch (error) { if ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError') return 'cancelled'; }
  const url = URL.createObjectURL(file), link = document.createElement('a');
  link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); return 'saved';
}
