import './style.css';
import { BREADS, BREAD_IDS, RULE, type BreadId, type Mode } from './config';
import { Battle, DIFFICULTIES, DIFFICULTY, phase, type Difficulty, type Scores, type BattleEvent, type Side } from './battle';
import { emptyStats, matchScore, nextTip, rankOf, recordStat, type Rank, type Tip } from './stats';
import { GameInput } from './input';
import { SaveStore, rate } from './save';
import { TableRenderer, type StanceCue } from './renderer';
import { BattleAudio } from './audio';
import { resultImage, shareResult } from './share';

type Screen = 'title' | 'permission' | 'calibrate' | 'select' | 'practice-intro' | 'practice' | 'practice-done' | 'countdown' | 'battle' | 'replay' | 'pause' | 'settings' | 'result' | 'error' | 'finish';
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `<div class="game-shell"><canvas id="table" aria-label="食卓で向かい合うパンの3D対戦画面"></canvas><div class="vignette"></div><div id="popups" aria-hidden="true"></div><div id="hud" hidden></div><div id="screen"></div><div id="banner" aria-hidden="true"></div><div id="toast" role="status" aria-live="polite"></div><div id="controls" hidden><button data-control="left" aria-label="左へ移動">←</button><button data-control="attack">攻撃<span>軽くタップ</span></button><button data-control="right" aria-label="右へ移動">→</button></div><div id="save-warning" role="status"></div><div id="rotate" hidden><span>↻</span><h2>縦に持ってね</h2><p>対戦は止まっています。<br>縦に戻して「再開」を選んでください。</p></div></div>`;
const canvas = document.querySelector<HTMLCanvasElement>('#table')!;
const screenElement = document.querySelector<HTMLElement>('#screen')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const warning = document.querySelector<HTMLElement>('#save-warning')!;
const rotate = document.querySelector<HTMLElement>('#rotate')!;
const popups = document.querySelector<HTMLElement>('#popups')!, bannerElement = document.querySelector<HTMLElement>('#banner')!;
const save = new SaveStore();
let screen: Screen = 'title', returnScreen: Screen = 'title', resumeScreen: Screen = 'battle';
let battle = new Battle(save.data.bread, save.data.cpu);
let renderer: TableRenderer | undefined; let ready = false; let fatal = ''; let message = '';
let practiceRequested = false; let calibrationReturn: Screen = 'select'; let permissionToken = 0; let permissionBusy = false;
let countdown = 3; let last = performance.now(); let toastUntil = 0; let previousBest: Partial<Scores> = {};
let practiceStage = 0; let acceptedAt: number | null = null;
let stats = emptyStats(); let finishLeft = 0; let lastCount = 0; let thumbs: Partial<Record<BreadId, string>> = {};
let result: { score: number; rank: Rank; previous: number | null; tip: Tip } | null = null; let lastReject = 0;
// A drill trains one skill and ends on it; pendingBegin resumes a match or drill after a forced recalibration.
let drill: 0 | 1 | 2 = 0; let pendingBegin: { practice: boolean; stage: number; drill: 0 | 1 | 2 } | null = null;
let shareFile: File | null = null; let sharePreparing = false; let shareFailed = false; let shareGeneration = 0; let sharing = false;
const audio = new BattleAudio(() => save.data.sound, () => say('音を再生できません。画面の合図で遊べます。', 3), () => save.data.music ?? true);
const level = (): Difficulty => save.data.difficulty ?? 'gentle';
// DEV ?test=1 keeps the CPU deterministic for automated checks; real matches vary every time.
const testMode = import.meta.env.DEV && new URLSearchParams(location.search).get('test') === '1';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let notices: BattleEvent[] = [];
let stallPause = true; // DEV test hook can disable it for screenshots taken by a throttled preview.
const input = new GameInput(controls, () => { if (['battle', 'practice', 'countdown', 'replay'].includes(screen)) pause('一時停止'); });
input.sensor.attackSensitivity = save.data.attackSensitivity;
input.sensor.tiltSensitivity = save.data.tiltSensitivity;
const modes: Record<Mode, string> = { sensor: '振る・傾ける', touch: 'タッチ', keyboard: 'キーボード' };
const emoji: Record<BreadId, string> = { shokupan: '🍞', francepan: '🥖', croissant: '🥐' };
const button = (action: string, label: string, secondary = false): string => `<button data-action="${action}" class="${secondary ? 'secondary' : 'primary'}">${label}</button>`;
const header = (eyebrow: string, title: string, description = ''): string => `<div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}`;
function say(text: string, seconds = 1.2): void { toast.textContent = text; toastUntil = performance.now() + seconds * 1000; }
function restart(element: HTMLElement, className: string): void { element.classList.remove(className); void element.offsetWidth; element.classList.add(className); }
function banner(text: string, kind: string): void { bannerElement.textContent = text; bannerElement.className = ''; void bannerElement.offsetWidth; bannerElement.className = `show ${kind}`; }
// Floating damage numbers above the bread that took the hit (presentation only).
function popup(side: Side, text: string, kind: 'deal' | 'hurt' | 'counter'): void {
  if (!renderer) return;
  const point = renderer.project(battle, side), element = document.createElement('span');
  element.className = `popup ${kind}`; element.textContent = text;
  element.style.left = `${point.x + (Math.random() - .5) * 24}px`; element.style.top = `${point.y}px`;
  while (popups.childElementCount >= 6) popups.firstElementChild!.remove();
  popups.append(element); setTimeout(() => element.remove(), 1100);
}
function hurt(side: Side): void {
  const element = document.querySelector<HTMLElement>(`#${side === 'player' ? 'player' : 'cpu'}-health`)?.closest<HTMLElement>('.health');
  if (element) restart(element, 'hurt');
}
function enterResult(): void {
  renderer?.setEnding(battle.outcome === 'win' ? 'player' : battle.outcome === 'lose' ? 'cpu' : 'draw');
  if (battle.outcome) audio.cue(battle.outcome);
  transition('result');
}
function present(event: BattleEvent): void {
  renderer?.effect(event); notices.push(event);
}
function flushNotices(active: boolean): void {
  const priority = { attack: 0, miss: 1, dodge: 2, hit: 3, clash: 4, counter: 5 };
  const event = notices.sort((a, b) => priority[b.kind] - priority[a.kind])[0]; notices = [];
  if (!active || !event) return;
  if (event.kind === 'hit' || event.kind === 'clash') say(event.kind === 'clash' ? '相打ち！' : event.side === 'player' ? 'ヒット！' : '相手の攻撃がヒット');
  if (event.kind === 'miss') say(event.side === 'player' ? '空振り · 少し中央に戻ろう' : '相手が空振り！');
  if (event.kind === 'dodge') say(event.side === 'player' ? '回避成功！ 今が反撃の隙' : '相手が回避！', 1.3);
  if (event.kind === 'counter') say(event.side === 'player' ? '反撃成功！ ダメージUP' : '相手の反撃！', 1.5);
}
function transition(next: Screen): void {
  if (screen === 'permission' && next !== 'permission') { permissionToken++; permissionBusy = false; }
  screen = next; input.setEnabled(next === 'battle' || next === 'practice'); input.clear();
  // The finishing blow keeps its crumbs, shake and sound into the K.O. freeze.
  if (next !== 'finish') renderer?.resetEffects();
  toast.textContent = ''; notices = []; acceptedAt = null;
  if (!['battle', 'practice', 'finish'].includes(next)) popups.replaceChildren();
  if (next !== 'battle') bannerElement.className = '';
  battle.setPaused(!['battle', 'practice'].includes(next));
  draw();
  if (!['battle', 'practice', 'countdown'].includes(next)) {
    const focus = screenElement.querySelector<HTMLElement>('h1,h2'); if (focus) { focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
  } else (document.activeElement as HTMLElement | null)?.blur();
}
function showWarning(): void { warning.textContent = save.warning; warning.hidden = !save.warning; }
function draw(): void {
  showWarning();
  if (screen === 'replay') {
    app.dataset.screen = screen; hud.hidden = controls.hidden = true; screenElement.className = 'play-overlay';
    screenElement.innerHTML = `<div class="replay-label"><small>${battle.player.hp <= 0 || battle.cpu.hp <= 0 ? 'K.O.' : 'TIME UP'}</small><h2>ラストプレー</h2><p>決着の瞬間をスローで</p></div><div class="replay-controls">${button('replay-skip', 'リプレイをスキップ →')}</div>`; return;
  }
  if (screen === 'finish') {
    app.dataset.screen = screen; hud.hidden = false; controls.hidden = true; screenElement.className = 'play-overlay';
    const ko = battle.player.hp <= 0 || battle.cpu.hp <= 0, text = ko ? 'K.O.!' : 'TIME UP';
    const status = document.querySelector<HTMLElement>('#battle-status'); if (status) { status.textContent = ''; status.className = 'status-line'; status.hidden = true; }
    screenElement.innerHTML = `<div class="finish-banner ${battle.outcome ?? ''}"><strong>${text}</strong><span>${battle.outcome === 'win' ? 'YOU WIN' : battle.outcome === 'lose' ? 'CPU WINS' : 'DRAW'}</span></div><div class="replay-controls">${button('replay-skip', 'リプレイをスキップ →')}</div>`; return;
  }
  const playing = ['battle', 'practice', 'countdown'].includes(screen);
  app.dataset.screen = screen;
  hud.hidden = !playing; controls.hidden = !['battle', 'practice'].includes(screen) || input.mode !== 'touch';
  screenElement.className = playing ? 'play-overlay' : `menu ${screen === 'title' ? 'title-screen' : ''}`;
  if (playing) {
    hud.innerHTML = `<div class="topline"><span class="match-label">${screen === 'practice' ? 'ダメージなしの練習' : '食卓 / CPU戦'}</span><button data-action="pause" aria-label="一時停止">Ⅱ</button></div><div class="health-row"><div class="health"><span>YOU · ${BREADS[battle.player.bread].name}</span><div class="health-track"><s id="player-ghost"></s><i id="player-health"></i></div><b id="player-hp">100</b></div><div class="timer" id="timer">60</div><div class="health enemy"><span>CPU · ${BREADS[battle.cpu.bread].name}</span><div class="health-track"><s id="cpu-ghost"></s><i id="cpu-health"></i></div><b id="cpu-hp">100</b></div></div><div class="status-line" id="battle-status"></div>`;
    if (screen === 'countdown') lastCount = 0; // redraw restarts the number from the markup
    if (screen === 'countdown') screenElement.innerHTML = `<div class="countdown"><span>構えて、相手を見よう</span><strong id="count">3</strong><em>${DIFFICULTY[battle.difficulty].label}CPU · ${BREADS[battle.cpu.bread].name}</em></div>`;
    else screenElement.innerHTML = `<div class="play-tip" id="play-tip"></div>`;
    updateHud(); return;
  }
  let html = '';
  if (screen === 'title') {
    html = `<button class="sound-toggle" data-action="sound-toggle" aria-pressed="${save.data.sound}" aria-label="音 ${save.data.sound ? 'オン' : 'オフ'}">${save.data.sound ? '♪ ON' : '♪ OFF'}</button><div class="title-top"><div class="eyebrow">A LITTLE BATTLE ON THE TABLE</div><h1>パン<span>バトル</span><em>3D</em></h1><p>ひょいと避けて、<br>こんがり反撃。</p></div><div class="title-bottom"><div class="how"><span>↝ 軽く振って攻撃</span><span>↔ 傾けて回避</span></div>${button('play', ready ? '食卓で勝負する →' : fatal ? '読み込みを再試行' : 'パンを準備しています…')}<div class="button-pair">${button('practice-entry', '練習する', true)}${button('settings', '設定', true)}</div><small>縦持ち · 1対1 · 1試合60秒</small>${fatal ? `<p class="error-text">3D素材を読み込めませんでした。</p>` : ''}</div>`;
  } else if (screen === 'permission') {
    html = `<section class="sheet">${header('01 / HOW TO PLAY', '手首で、パンを動かす', '軽いひと振りで攻撃。左右に傾けると回避。<br>攻撃を振り切る間は、横に動けません。')}<div class="instruction"><b>① 相手が引いたら、横へ</b><span>赤い狙いの輪と、パンの予備動作が合図。</span><b>② 避けたら、すぐ振る</b><span>相手の隙に当てると反撃ボーナス。</span></div><p class="gentle">小さな動きで十分です。しっかり持って遊ぼう。</p>${button('sensor', permissionBusy ? '許可と入力を確認中…' : '動きの利用を許可する')}<p id="permission-message" class="error-text" role="status"></p><details><summary>補助操作で遊ぶ</summary><div class="button-pair">${button('touch', 'タッチ操作', true)}${button('keyboard', 'キーボード', true)}</div></details>${button('title', 'タイトルへ', true)}</section>`;
  } else if (screen === 'calibrate') {
    html = `<section class="sheet">${header('02 / READY', 'いつもの持ち方で', input.mode === 'sensor' ? 'iPhoneを縦に構え、楽な角度で止めてください。<br>この位置を左右移動の中央にします。' : input.mode === 'keyboard' ? '← → または A Dで横移動。<br>Space / Zで攻撃。Escapeで一時停止。' : '左・右ボタンを押している間、横に移動。<br>中央の攻撃ボタンは、1タップで1回。')}<div class="calibration-icon">↔</div><p id="sensor-status" class="status-box"></p>${button('calibrated', 'この位置で開始')}${button('permission', '操作方式を選び直す', true)}<p class="error-text" id="calibration-message" role="status"></p></section>`;
  } else if (screen === 'select') {
    html = `<section class="sheet selection">${header('03 / CHOOSE YOUR BREAD', '今日のパンは？', '3種類とも、最初から遊べます。')}<div class="bread-list">${BREAD_IDS.map(id => `<button data-bread="${id}" aria-pressed="${save.data.bread === id}" class="bread-card">${thumbs[id] ? `<img class="bread-thumb" src="${thumbs[id]}" alt="">` : `<span class="bread-emoji">${emoji[id]}</span>`}<span class="bread-info"><b>${BREADS[id].name}</b><small>${BREADS[id].note}</small>${abilities(id)}</span><i>${save.data.bread === id ? '✓' : ''}</i></button>`).join('')}</div><label class="opponent">対戦相手<select id="opponent">${BREAD_IDS.map(id => `<option value="${id}" ${save.data.cpu === id ? 'selected' : ''}>${BREADS[id].name}</option>`).join('')}</select></label><div class="difficulty" role="group" aria-label="CPUの強さ"><span>CPUの強さ</span>${DIFFICULTIES.map(d => `<button data-difficulty="${d}" aria-pressed="${level() === d}">${DIFFICULTY[d].label}</button>`).join('')}</div><p class="minor">${DIFFICULTY[level()].label}CPU · ${modes[input.mode]} · 60秒${level() === 'gentle' ? '' : ' · 相手も回避します'}</p>${button('start', practiceRequested || !save.data.practiced ? 'まずは短い練習へ →' : '対戦をはじめる →')}<div class="button-pair">${button('calibration', '構えを再調整', true)}${button('title', 'タイトルへ', true)}</div></section>`;
  } else if (screen === 'practice-intro') {
    html = `<section class="sheet">${header('WARM UP', '3つ試せば、準備OK', '練習ではHPが減りません。失敗しても大丈夫。')}<ol class="practice-list"><li>攻撃を当てる</li><li>予告を見て、横に避ける</li><li>避けた後の隙に、反撃を当てる</li></ol>${button('practice-start', '練習をはじめる')}${button('skip', '練習をスキップして対戦', true)}</section>`;
  } else if (screen === 'practice-done') {
    html = `<section class="sheet">${header('READY TO BATTLE', 'いい構え！', drill ? `${drill === 1 ? '回避' : '反撃'}のコツをつかめました。<br>次は60秒のCPU戦です。` : '攻撃・回避・反撃を試せました。<br>次は60秒のCPU戦です。')}<p class="status-box">練習の成績は自己ベストに入りません。</p>${button('fight', 'CPUと勝負する →')}${button('practice-start', 'もう一度練習', true)}${button('select', 'パンを選び直す', true)}</section>`;
  } else if (screen === 'pause') {
    html = `<section class="sheet">${header('TAKE A BREATH', 'ちょっと、ひと休み')}<p id="pause-message" class="status-box"></p>${button('resume', '再開する →')}${button('calibration', '構えを再調整', true)}${settingsFields()}${button('permission', '操作方式を選び直す', true)}<p class="minor">操作方式を変えると、この対戦は終了します。</p>${button('title', 'この対戦を終了してタイトルへ', true)}<small>途中終了の成績は保存されません。</small></section>`;
  } else if (screen === 'settings') {
    html = `<section class="sheet">${header('SETTINGS', '遊びやすい構えに')}${settingsFields()}<p class="minor">構え位置は対戦前・一時停止中に調整できます。</p>${button('settings-back', '戻る', true)}<p class="minor">設定・自己ベストはこのブラウザー内に保存。<br>オンラインでは操作と試合状態を対戦サーバーへ送ります。生センサー値は送りません。</p></section>`;
  } else if (screen === 'result') {
    const title = battle.outcome === 'win' ? 'こんがり、勝利！' : battle.outcome === 'lose' ? '次は、ひょいと回避。' : 'いい勝負、引き分け。';
    const dealt = Math.round(BREADS[battle.cpu.bread].hp - battle.cpu.hp), taken = Math.round(BREADS[battle.player.bread].hp - battle.player.hp);
    const rank = result ? `<div class="rank-card rank-${result.rank}"><div class="rank-letter" role="img" aria-label="ランク ${result.rank}">${result.rank}</div><div class="rank-score"><small>SCORE</small><b>${result.score}</b><span>${result.previous === null ? '初めての記録' : result.score > result.previous ? `ベスト更新！ 前回 ${result.previous}` : `自己ベスト ${result.previous}`}</span></div></div>` : '';
    html = `<section class="sheet result">${header(battle.outcome === 'win' ? 'YOU WIN' : battle.outcome === 'lose' ? 'CPU WINS' : 'DRAW', title)}${rank}${result ? `<div class="next-tip"><b>次のコツ</b>${result.tip.text}${result.tip.drill ? `<button data-action="drill" class="drill">${result.tip.drill === 1 ? '回避' : '反撃'}だけ練習する →</button>` : ''}</div>` : ''}${button('rematch', '同じパンで、もう一戦 →')}<p class="result-condition">${BREADS[battle.player.bread].name} vs ${BREADS[battle.cpu.bread].name}<br>${DIFFICULTY[battle.difficulty].label}CPU · ${modes[input.mode]} · ${battle.elapsed.toFixed(1)}秒</p><div class="stat-grid">${stat('与ダメージ', String(dealt))}${stat('被ダメージ', String(taken))}${stat('命中', `${stats.player.hits}<small>/${stats.player.attacks}</small>`)}${stat('反撃', String(stats.player.counters))}</div><div class="scores">${scoreRow('回避', 'dodge')}${scoreRow('回避後の反撃', 'counter')}</div><p class="minor">自己ベストは同じパン・相手・操作・ルールで比較。<br>機会なしの項目は記録を更新しません。</p><div class="button-pair">${button('select', 'パンを選び直す', true)}${button('title', 'タイトルへ', true)}</div><details class="diagnostics"><summary>この試合の動作計測</summary><pre>${metricsText()}</pre></details></section>`;
  } else if (screen === 'error') {
    html = `<section class="sheet">${header('LET’S TRY AGAIN', '準備が止まっています')}<p class="error-text" id="fatal-message" role="alert"></p>${button('reload', '再読み込みして再試行')}${button('title', 'タイトルへ', true)}</section>`;
  }
  screenElement.innerHTML = html;
  if (screen === 'result') {
    const diagnostics = screenElement.querySelector('.diagnostics')!;
    diagnostics.insertAdjacentHTML('beforebegin', `${button('share', '結果を画像で共有・保存', true)}<p class="minor">共有先は端末の画面で選べます。非対応なら画像を保存します。</p>`); updateShareButton();
  }
  const messageElement = document.querySelector('#permission-message,#pause-message,#fatal-message');
  if (messageElement) messageElement.textContent = screen === 'error' ? fatal : message;
  const sensorButton = screenElement.querySelector<HTMLButtonElement>('[data-action="sensor"]'); if (sensorButton) sensorButton.disabled = permissionBusy;
  if (screen === 'title' && !ready && !fatal) screenElement.querySelector<HTMLButtonElement>('[data-action="play"]')!.disabled = true;
}
function settingsFields(): string {
  return `<label class="setting">音を鳴らす<input type="checkbox" id="sound" ${save.data.sound ? 'checked' : ''}></label><label class="setting">BGM（音がオンのとき）<input type="checkbox" id="music" ${save.data.music ?? true ? 'checked' : ''}></label>${([
    ['attackSensitivity', '攻撃の出やすさ', '高めにすると、小さな振りで攻撃できます。'],
    ['tiltSensitivity', '回避のしやすさ', '高めにすると、小さな傾きで横に移動できます。'],
  ] as const).map(([key, label, tip]) => `<label class="setting slider">${label}<output id="${key}-value">${save.data[key].toFixed(1)}</output><input aria-label="${label}" id="${key}" type="range" min="0.6" max="1.6" step="0.1" value="${save.data[key]}" aria-describedby="${key}-tip"></label><p class="minor" id="${key}-tip">${tip}</p>`).join('')}`;
}
function scoreRow(name: string, key: keyof Scores): string {
  const score = battle.scores[key], value = rate(score), past = rate(previousBest[key]);
  return `<div class="score-row"><span>${name}<small>${score.success}成功 / ${score.opportunities}機会</small></span><b class="${value === null ? 'none' : ''}">${value === null ? '機会なし' : `${Math.round(value * 100)}<em>%</em>`}</b><div>前の自己ベスト <strong>${past === null ? '記録なし' : `${Math.round(past * 100)}%`}</strong><span class="record-tag">${value !== null && (past === null || value > past) ? past === null ? '初めての記録' : '自己ベスト更新' : value !== null && value === past ? '自己ベストと同じ' : ''}</span></div></div>`;
}
const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function stat(label: string, value: string): string { return `<div class="stat"><small>${label}</small><b>${value}</b></div>`; }
// 1-5 pips relative to the other breads, derived from the combat table so it never drifts from the rules.
function abilities(id: BreadId): string {
  const scale = (pick: (b: typeof BREADS[BreadId]) => number, invert = false): number => {
    const values = BREAD_IDS.map(key => pick(BREADS[key])), lo = Math.min(...values), hi = Math.max(...values), t = hi === lo ? .5 : (pick(BREADS[id]) - lo) / (hi - lo);
    return 1 + Math.round(4 * (invert ? 1 - t : t));
  };
  const rows: [string, number][] = [['パワー', scale(b => b.damage)], ['出の速さ', scale(b => b.windup, true)], ['戻りの速さ', scale(b => b.recovery, true)], ['当てやすさ', scale(b => b.width)]];
  return `<span class="abilities">${rows.map(([name, n]) => `<span><em>${name}</em><span class="pips" role="img" aria-label="${name} ${n}/5">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(5 - n)}</span></span>`).join('')}</span>`;
}
function metricsText(): string {
  const m = renderer?.metrics(), s = input.metrics(), absent = '対象なし（センサー入力なし）';
  const threshold = s.minThreshold === null ? '' : ` / 試合中 ${s.minThreshold.toFixed(1)}〜${s.maxThreshold!.toFixed(1)} m/s²`;
  const sensor = `振りの強さ：${s.maxSwing === null ? absent : `最大 ${s.maxSwing.toFixed(1)} m/s²`}\n攻撃しきい値（設定） ${s.threshold.toFixed(1)} m/s²${threshold}\n左右傾き（構え基準）：${s.minTilt === null ? absent : `${s.minTilt.toFixed(1)}〜${s.maxTilt!.toFixed(1)}度`}`;
  return m ? `平均 ${m.fps.toFixed(1)} fps / p95 ${m.p95FrameMs.toFixed(1)} ms\n33.4ms超 ${m.slowFrames}/${m.frames} frames\n検出→表示 ${m.attackSamples ? `最大 ${m.maxAttackMs.toFixed(1)} ms（${m.attackSamples}回）` : '対象なし（攻撃入力なし）'}\n${sensor}\n${m.triangles} triangles / ${m.drawCalls} draws\n${RULE} / 攻撃感度 ${save.data.attackSensitivity.toFixed(1)} / 回避感度 ${save.data.tiltSensitivity.toFixed(1)}\n${escapeHtml(navigator.userAgent)}\n※この端末での計測。実機センサー試行は別途必要。` : '計測なし';
}
function updateShareButton(): void {
  const element = screenElement.querySelector<HTMLButtonElement>('[data-action="share"]'); if (!element) return;
  element.disabled = sharePreparing || sharing;
  element.textContent = sharePreparing ? '結果画像を準備しています…' : shareFailed ? '結果画像を作り直す' : '結果を画像で共有・保存';
}
function prepareShare(): void {
  if (!battle.outcome) return;
  const generation = ++shareGeneration; sharePreparing = true; shareFailed = false; shareFile = null; updateShareButton();
  void resultImage(battle.player.bread, battle.cpu.bread, battle.outcome, structuredClone(battle.scores), result ? { rank: result.rank, score: result.score, level: DIFFICULTY[battle.difficulty].label } : undefined).then(file => {
    if (generation === shareGeneration) shareFile = file;
  }).catch(() => { if (generation === shareGeneration) { shareFailed = true; say('結果画像を作成できませんでした。もう一度試せます。', 3); } }).finally(() => {
    if (generation === shareGeneration) { sharePreparing = false; updateShareButton(); }
  });
}
function updateHud(): void {
  const p = document.querySelector<HTMLElement>('#player-health'), c = document.querySelector<HTMLElement>('#cpu-health');
  if (!p || !c) return;
  p.style.width = `${battle.player.hp}%`; c.style.width = `${battle.cpu.hp}%`;
  document.querySelector<HTMLElement>('#player-ghost')!.style.width = `${battle.player.hp}%`; document.querySelector<HTMLElement>('#cpu-ghost')!.style.width = `${battle.cpu.hp}%`;
  p.closest('.health')?.classList.toggle('critical', battle.player.hp > 0 && battle.player.hp <= 25);
  document.querySelector('#player-hp')!.textContent = String(Math.ceil(battle.player.hp)); document.querySelector('#cpu-hp')!.textContent = String(Math.ceil(battle.cpu.hp));
  document.querySelector('#timer')!.textContent = screen === 'practice' ? '∞' : String(Math.max(0, Math.ceil(60 - battle.elapsed)));
  document.querySelector('#timer')!.classList.toggle('urgent', screen === 'battle' && battle.elapsed >= 50 && !battle.outcome);
  const status = document.querySelector<HTMLElement>('#battle-status')!;
  const threat = phase(battle.cpu) === 'windup', locked = ['windup', 'active'].includes(phase(battle.player));
  status.textContent = locked ? '振り切るまで、横移動できません' : battle.player.recoil > 0 ? '弾かれた！ 体勢を立て直し中' : threat ? '相手が狙っています → 横へ回避！' : battle.counterAvailable && battle.elapsed < battle.counterUntil ? '今が反撃のチャンス！' : phase(battle.player) === 'recovery' ? '構えに戻しています · 横移動OK' : '攻撃できます · 相手の動きを見よう';
  status.className = `status-line ${threat ? 'danger' : ''}`;
  const tip = document.querySelector('#play-tip');
  if (tip) {
    if (screen === 'practice') {
      const key = `${practiceStage}/${input.mode}`;
      if ((tip as HTMLElement).dataset.stage !== key) {
        (tip as HTMLElement).dataset.stage = key;
        tip.innerHTML = `<b>${practiceStage + 1} / 3　${['まずは、攻撃を当てよう', '相手が引いたら、横に避けよう', '避けた隙に、すぐ反撃しよう'][practiceStage] ?? ''}</b><span>${input.mode === 'sensor' ? '軽く振る → 攻撃 / 左右に傾ける → 回避' : input.mode === 'touch' ? '左右を押して回避 / 中央ボタンで攻撃' : '← →で回避 / Spaceで攻撃'}</span><button data-action="skip">練習をスキップ</button>`;
      }
    } else {
      const text = input.mode === 'sensor' ? '軽く振って攻撃 · 傾けて回避' : input.mode === 'keyboard' ? '← → / A D：回避　 Space / Z：攻撃' : '押して移動 · 離すと中央へ';
      if (tip.textContent !== text) tip.textContent = text;
    }
  }
}
function stanceCue(): StanceCue {
  const p = phase(battle.player);
  // Mirrors startAttack(): no new swing while one is running or while knocked back.
  return p === 'windup' || p === 'active' || battle.player.recoil > 0 ? 'locked' : battle.counterAvailable && battle.elapsed < battle.counterUntil ? 'counter' : p === 'recovery' ? 'recovery' : 'ready';
}
function pause(reason: string): void {
  if (!['battle', 'practice', 'countdown', 'replay'].includes(screen)) return;
  resumeScreen = screen; message = reason; audio.silence(); transition('pause');
}
function fail(reason: string): void { fatal = reason; ready = false; transition('error'); }
function begin(practice: boolean, stage = 0, only: 0 | 1 | 2 = 0): void {
  if (!ready) { fail('パンの読み込みが完了していません。再試行してください。'); return; }
  if (input.mode === 'sensor' && (!input.sensor.fresh(performance.now()) || input.sensor.baseline === null)) { message = '新しい入力と構え位置を確認してください。'; calibrationReturn = 'select'; pendingBegin = { practice, stage, drill: only }; transition('calibrate'); return; }
  battle = new Battle(save.data.bread, save.data.cpu, { practice, seed: practice || testMode ? 42 : crypto.getRandomValues(new Uint32Array(1))[0]!, difficulty: level() });
  stats = emptyStats(); result = null; lastCount = 0; popups.replaceChildren();
  shareGeneration++; shareFile = null; sharePreparing = shareFailed = sharing = false;
  previousBest = {}; input.clear(); input.resetMetrics(); renderer?.resetMetrics(); practiceStage = stage; battle.practiceStage = stage; drill = practice ? only : 0; pendingBegin = null; toast.textContent = '';
  if (practice) transition('practice'); else { countdown = 3; transition('countdown'); }
}
async function action(actionName: string): Promise<void> {
  audio.unlock();
  if (actionName === 'play' || actionName === 'practice-entry') {
    if (!ready) { if (fatal) location.reload(); return; }
    practiceRequested = actionName === 'practice-entry'; message = ''; transition('permission');
  } else if (actionName === 'sensor') {
    if (permissionBusy) return;
    const token = ++permissionToken; permissionBusy = true; message = ''; draw();
    try { await input.request(); if (token !== permissionToken || screen !== 'permission') return; input.mode = 'sensor'; calibrationReturn = 'select'; transition('calibrate'); }
    catch (e) { if (token === permissionToken && screen === 'permission') { message = e instanceof Error ? e.message : '許可を確認できませんでした。'; permissionBusy = false; draw(); } }
  } else if (actionName === 'touch' || actionName === 'keyboard') { input.mode = actionName; calibrationReturn = 'select'; transition('calibrate');
  } else if (actionName === 'calibrated' && pendingBegin && input.mode === 'sensor' && input.sensor.calibrate(performance.now())) {
    const resume = pendingBegin; begin(resume.practice, resume.stage, resume.drill);
  } else if (actionName === 'calibrated') {
    if (input.mode === 'sensor' && !input.sensor.calibrate(performance.now())) { document.querySelector('#calibration-message')!.textContent = '新しい入力が届いていません。もう一度確認するか補助操作を選んでください。'; return; }
    transition(calibrationReturn);
  } else if (actionName === 'calibration') { calibrationReturn = screen === 'pause' ? 'pause' : 'select'; transition('calibrate');
  } else if (actionName === 'permission') { message = ''; pendingBegin = null; transition('permission');
  } else if (actionName === 'title') { pendingBegin = null; renderer?.setEnding(null); battle = new Battle(save.data.bread, save.data.cpu); practiceRequested = false; transition('title');
  } else if (actionName === 'select') { pendingBegin = null; renderer?.setEnding(null); practiceRequested = false; battle = new Battle(save.data.bread, save.data.cpu); transition('select');
  } else if (actionName === 'start') { save.persist(); if (practiceRequested || !save.data.practiced) transition('practice-intro'); else begin(false);
  } else if (actionName === 'practice-start') begin(true);
  else if (actionName === 'skip' || actionName === 'fight') { save.data.practiced = true; save.persist(); practiceRequested = false; begin(false);
  } else if (actionName === 'rematch') begin(false);
  else if (actionName === 'drill' && result?.tip.drill) {
    // Jump straight to the practice stage that trains the suggested skill.
    begin(true, result.tip.drill, result.tip.drill);
  }
  else if (actionName === 'replay-skip' && (screen === 'replay' || screen === 'finish')) enterResult();
  else if (actionName === 'sound-toggle') { save.data.sound = !save.data.sound; if (!save.data.sound) audio.silence(); save.persist(); audio.unlock(); draw(); screenElement.querySelector<HTMLElement>('.sound-toggle')?.focus(); }
  else if (actionName === 'share' && screen === 'result' && !sharing) {
    if (!shareFile) { if (!sharePreparing) prepareShare(); return; }
    sharing = true; updateShareButton();
    try { const result = await shareResult(shareFile); if (result !== 'cancelled') say(result === 'shared' ? '結果画像を共有しました。' : '結果画像の保存を開始しました。', 2); }
    catch { say('画像を保存できませんでした。もう一度試してください。', 3); }
    finally { sharing = false; updateShareButton(); }
  }
  else if (actionName === 'pause') pause('一時停止中は時間もHPも進みません。');
  else if (actionName === 'resume') {
    if (document.hidden || isLandscape()) { message = '縦向きで、この画面を表示してから再開してください。'; draw(); return; }
    if (input.mode === 'sensor' && !input.sensor.fresh(performance.now())) { message = '動きの値が届いていません。構えの再調整または操作方式の選び直しをしてください。'; draw(); return; }
    last = performance.now(); transition(resumeScreen);
  } else if (actionName === 'settings') { returnScreen = screen; transition('settings');
  } else if (actionName === 'settings-back') transition(returnScreen);
  else if (actionName === 'reload') location.reload();
}
app.addEventListener('click', e => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-bread],[data-difficulty]');
  if (target?.dataset.difficulty && screen === 'select' && DIFFICULTIES.includes(target.dataset.difficulty as Difficulty)) {
    save.data.difficulty = target.dataset.difficulty as Difficulty; save.persist(); draw();
    screenElement.querySelector<HTMLElement>(`[data-difficulty="${save.data.difficulty}"]`)?.focus(); return;
  }
  if (target?.dataset.action) void action(target.dataset.action);
  if (target?.dataset.bread && screen === 'select') {
    save.data.bread = target.dataset.bread as BreadId; save.persist(); battle = new Battle(save.data.bread, save.data.cpu); draw();
    screenElement.querySelector<HTMLElement>(`[data-bread="${save.data.bread}"]`)?.focus();
  }
});
app.addEventListener('change', e => {
  const element = e.target as HTMLInputElement;
  if (element.id === 'opponent') { if (!BREAD_IDS.includes(element.value as BreadId)) return; save.data.cpu = element.value as BreadId; battle = new Battle(save.data.bread, save.data.cpu); }
  else if (element.id === 'sound') { save.data.sound = element.checked; if (!element.checked) audio.silence(); audio.unlock(); }
  else if (element.id === 'music') save.data.music = element.checked;
  else if (element.id === 'attackSensitivity' || element.id === 'tiltSensitivity') {
    const value = Number(element.value); if (!Number.isFinite(value) || value < .6 || value > 1.6) return;
    save.data[element.id] = value; input.sensor[element.id] = value; input.clear();
  }
  else return;
  save.persist(); showWarning();
});
app.addEventListener('input', e => { const element = e.target as HTMLInputElement; if (element.id === 'attackSensitivity' || element.id === 'tiltSensitivity') document.getElementById(`${element.id}-value`)!.textContent = Number(element.value).toFixed(1); });
function isLandscape(): boolean { return Math.min(innerWidth, 520) > innerHeight; }
function environment(): void {
  rotate.hidden = !isLandscape();
  if (document.hidden || isLandscape()) pause(document.hidden ? '画面を離れたので一時停止しました。' : '横向きになったので一時停止しました。');
  input.clear();
}
document.addEventListener('visibilitychange', environment); window.addEventListener('pagehide', () => pause('画面を離れたので一時停止しました。'));
window.addEventListener('resize', environment); window.addEventListener('blur', () => pause('画面の操作が中断されたので一時停止しました。'));
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = stallPause ? (now - last) / 1000 : Math.min(.1, (now - last) / 1000); last = now;
  if (toastUntil < now) toast.textContent = '';
  audio.music(['countdown', 'battle', 'practice', 'finish'].includes(screen) && !document.hidden, screen === 'battle' && battle.elapsed >= 50);
  if (dt > .25) pause('描画が中断したので一時停止しました。');
  if (!rotate.hidden && !isLandscape()) rotate.hidden = true;
  if (screen === 'finish') {
    if (!document.hidden && renderer) {
      finishLeft -= Math.min(dt, .1);
      try { renderer.render(battle, battle.elapsed, Math.min(dt, .1), true, undefined, .3); }
      catch { fail('3D画面を描画できません。再読み込みを試してください。'); return; }
      if (finishLeft <= 0) { if (renderer.startReplay()) transition('replay'); else enterResult(); }
    }
    return;
  }
  if (screen === 'replay') {
    if (!document.hidden && renderer) {
      try { if (renderer.renderReplay(Math.min(dt, .1))) enterResult(); }
      catch { fail('リプレイを描画できません。再読み込みを試してください。'); }
    }
    return;
  }
  if (screen === 'calibrate') {
    const sensorStatus = document.querySelector('#sensor-status');
    if (sensorStatus) sensorStatus.textContent = input.mode === 'sensor' ? input.sensor.fresh(now) ? '動き・傾きの入力を受信しています ✓' : '動き・傾きの入力を待っています…' : `${modes[input.mode]}で準備OK`;
  }
  if (screen === 'countdown' && !document.hidden && !isLandscape()) {
    countdown -= Math.min(dt, .1); const count = document.querySelector<HTMLElement>('#count'), n = Math.max(1, Math.ceil(countdown));
    if (count && n !== lastCount) { lastCount = n; count.textContent = String(n); restart(count, 'pop'); audio.cue('count'); }
    if (countdown <= 0) { transition('battle'); audio.cue('go'); banner('はじめ！', 'go'); }
  }
  const active = screen === 'battle' || screen === 'practice';
  if (active && input.mode === 'sensor' && !input.sensor.fresh(now)) pause('動きの入力が途切れました。入力を確認してから再開してください。');
  if (screen === 'battle' || screen === 'practice') {
    const hpBefore = [battle.player.hp, battle.cpu.hp] as const;
    const attack = input.consume();
    if (attack && !battle.player.attack && battle.player.recoil <= 0) acceptedAt = input.detectedAt;
    else if (attack && now - lastReject > 900) { lastReject = now; say(battle.player.recoil > 0 ? '弾かれ中 · 少し待って振ろう' : '振り切り中 · 戻ってから振ろう', .7); }
    battle.advance(dt, input.target(), attack);
    const events = battle.drainEvents(), countered = new Set(events.filter(e => e.kind === 'counter').map(e => e.side));
    for (const [side, before] of [['player', hpBefore[0]], ['cpu', hpBefore[1]]] as const) {
      const lost = before - battle[side].hp;
      if (lost > 0) { popup(side, `-${Math.round(lost)}`, countered.has(side === 'player' ? 'cpu' : 'player') ? 'counter' : side === 'player' ? 'hurt' : 'deal'); hurt(side); }
    }
    for (const event of events) {
      if (!battle.practice) recordStat(stats, event);
      else if (event.kind === 'hit' || event.kind === 'clash') for (const side of ['player', 'cpu'] as const) if (event.kind === 'clash' || side !== event.side) popup(side, 'HIT!', side === 'player' ? 'hurt' : 'deal');
      present(event);
      if (screen === 'practice') {
        if (practiceStage === 0 && event.kind === 'hit' && event.side === 'player') { practiceStage = 1; battle.practiceStage = 1; say('攻撃できました！ 次は横に回避', 2); }
        else if (practiceStage === 1 && event.kind === 'dodge' && event.side === 'player') { if (drill === 1) transition('practice-done'); else { practiceStage = 2; battle.practiceStage = 2; } }
        else if (practiceStage === 2 && event.kind === 'counter') { save.data.practiced = true; save.persist(); transition('practice-done'); }
      }
    }
    if (battle.paused && ['battle', 'practice'].includes(screen)) pause('更新が中断したので一時停止しました。');
    updateHud();
  }
  flushNotices(screen === 'battle' || screen === 'practice');
  if (ready && renderer && !document.hidden) {
    try {
      renderer.render(battle, active ? battle.elapsed : now / 1000, active ? Math.min(dt, .1) : 0, active && !battle.paused, { ...(battle.practice ? {} : { remaining: 60 - battle.elapsed }), cue: stanceCue() });
      if (acceptedAt !== null) { renderer.noteLatency(performance.now() - acceptedAt); acceptedAt = null; }
      if (battle.outcome && screen === 'battle') {
        previousBest = save.record(battle, input.mode);
        const input_ = { outcome: battle.outcome, hpRatio: battle.player.hp / BREADS[battle.player.bread].hp, scores: battle.scores, stats }, score = matchScore(input_);
        result = { score, rank: rankOf(score, input_), previous: save.recordScore(battle, input.mode, score), tip: nextTip(input_, battle.difficulty === 'hard') };
        prepareShare(); finishLeft = reduced.matches ? .5 : .9; transition('finish');
      }
    } catch { fail('3D画面を描画できません。再読み込みを試してください。'); }
  }
}
draw(); environment(); requestAnimationFrame(frame);
try {
  renderer = new TableRenderer(canvas, fail, audio.play, audio.stop);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
  void Promise.race([renderer.load(), timeout]).then(() => { ready = true; thumbs = renderer!.thumbnails(); if (screen === 'title' || screen === 'select') draw(); }).catch(() => fail('パンの3D素材を読み込めませんでした。通信状態を確認して再試行してください。'));
} catch { fail('この環境では3D描画（WebGL2）を開始できません。Safariを更新するか、対応端末で開いてください。'); }

// Read-only diagnostics for device QA. Sensor raw values are never persisted or transmitted.
Object.defineProperty(window, '__panDiagnostics', { value: () => ({ screen, mode: input.mode, ready, elapsed: battle.elapsed, hp: [battle.player.hp, battle.cpu.hp], scores: structuredClone(battle.scores), metrics: renderer?.metrics(), sensorMetrics: input.metrics(), sensorAttacks: input.sensor.attacks, attackSensitivity: input.sensor.attackSensitivity, tiltSensitivity: input.sensor.tiltSensitivity }) });
if (import.meta.env.DEV && new URLSearchParams(location.search).get('test') === '1') {
  Object.defineProperty(window, '__panTest', { value: { get battle() { return battle; }, get input() { return input; }, get screen() { return screen; }, get save() { return save; }, get renderer() { return renderer; }, action, transition, pause, set stallPause(value: boolean) { stallPause = value; } } });
}
