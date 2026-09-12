import './style.css';
import { BREADS, BREAD_IDS, RULE, type BreadId, type Mode } from './config';
import { Battle, phase, type Scores } from './battle';
import { GameInput } from './input';
import { SaveStore, rate } from './save';
import { TableRenderer } from './renderer';

type Screen = 'title' | 'permission' | 'calibrate' | 'select' | 'practice-intro' | 'practice' | 'practice-done' | 'countdown' | 'battle' | 'pause' | 'settings' | 'result' | 'error';
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `<div class="game-shell"><canvas id="table" aria-label="食卓で向かい合うパンの3D対戦画面"></canvas><div class="vignette"></div><div id="hud" hidden></div><div id="screen"></div><div id="toast" role="status" aria-live="polite"></div><div id="controls" hidden><button data-control="left" aria-label="左へ移動">←</button><button data-control="attack">攻撃<span>軽くタップ</span></button><button data-control="right" aria-label="右へ移動">→</button></div><div id="save-warning" role="status"></div><div id="rotate" hidden><span>↻</span><h2>縦に持ってね</h2><p>対戦は止まっています。<br>縦に戻して「再開」を選んでください。</p></div></div>`;
const canvas = document.querySelector<HTMLCanvasElement>('#table')!;
const screenElement = document.querySelector<HTMLElement>('#screen')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const warning = document.querySelector<HTMLElement>('#save-warning')!;
const rotate = document.querySelector<HTMLElement>('#rotate')!;
const save = new SaveStore();
let screen: Screen = 'title', returnScreen: Screen = 'title', resumeScreen: Screen = 'battle';
let battle = new Battle(save.data.bread, save.data.cpu);
let renderer: TableRenderer | undefined; let ready = false; let fatal = ''; let message = '';
let practiceRequested = false; let calibrationReturn: Screen = 'select'; let permissionToken = 0; let permissionBusy = false;
let countdown = 3; let last = performance.now(); let toastUntil = 0; let previousBest: Partial<Scores> = {};
let practiceStage = 0; let acceptedAt: number | null = null; let audio: AudioContext | undefined;
let soundUnavailable = false; let lastSound = -Infinity;
const input = new GameInput(controls, () => { if (['battle', 'practice', 'countdown'].includes(screen)) pause('一時停止'); });
input.sensor.sensitivity = save.data.sensitivity;
const modes: Record<Mode, string> = { sensor: '振る・傾ける', touch: 'タッチ', keyboard: 'キーボード' };
const emoji: Record<BreadId, string> = { shokupan: '🍞', francepan: '🥖', croissant: '🥐' };
const button = (action: string, label: string, secondary = false): string => `<button data-action="${action}" class="${secondary ? 'secondary' : 'primary'}">${label}</button>`;
const header = (eyebrow: string, title: string, description = ''): string => `<div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}`;
function say(text: string, seconds = 1.2): void { toast.textContent = text; toastUntil = performance.now() + seconds * 1000; }
function beep(kind: 'hit' | 'attack' | 'counter'): void {
  if (!save.data.sound || soundUnavailable || !audio || audio.state !== 'running' || performance.now() - lastSound < 55) return;
  try {
    const oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.type = kind === 'hit' ? 'triangle' : 'sine'; oscillator.frequency.setValueAtTime(kind === 'counter' ? 730 : kind === 'hit' ? 185 : 320, audio.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(80, audio.currentTime + .12); gain.gain.setValueAtTime(.07, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .14);
    oscillator.start(); oscillator.stop(audio.currentTime + .15); oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); }; lastSound = performance.now();
  } catch { soundUnavailable = true; say('音を再生できません。画面の合図で遊べます。', 3); }
}
function unlockAudio(): void {
  if (!save.data.sound) return;
  try { audio ??= new AudioContext(); void audio.resume().catch(() => { soundUnavailable = true; say('音を再生できません。画面の合図で遊べます。', 3); }); }
  catch { soundUnavailable = true; }
}
function transition(next: Screen): void {
  if (screen === 'permission' && next !== 'permission') { permissionToken++; permissionBusy = false; }
  screen = next; input.setEnabled(next === 'battle' || next === 'practice'); input.clear();
  battle.setPaused(!['battle', 'practice'].includes(next));
  draw();
  if (!['battle', 'practice', 'countdown'].includes(next)) {
    const focus = screenElement.querySelector<HTMLElement>('h1,h2'); if (focus) { focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
  } else (document.activeElement as HTMLElement | null)?.blur();
}
function showWarning(): void { warning.textContent = save.warning; warning.hidden = !save.warning; }
function draw(): void {
  showWarning();
  const playing = ['battle', 'practice', 'countdown'].includes(screen);
  app.dataset.screen = screen;
  hud.hidden = !playing; controls.hidden = !['battle', 'practice'].includes(screen) || input.mode !== 'touch';
  screenElement.className = playing ? 'play-overlay' : `menu ${screen === 'title' ? 'title-screen' : ''}`;
  if (playing) {
    hud.innerHTML = `<div class="topline"><span class="match-label">${screen === 'practice' ? 'ダメージなしの練習' : '食卓 / CPU戦'}</span><button data-action="pause" aria-label="一時停止">Ⅱ</button></div><div class="health-row"><div class="health"><span>YOU · ${BREADS[battle.player.bread].name}</span><div class="health-track"><i id="player-health"></i></div><b id="player-hp">100</b></div><div class="timer" id="timer">60</div><div class="health enemy"><span>CPU · ${BREADS[battle.cpu.bread].name}</span><div class="health-track"><i id="cpu-health"></i></div><b id="cpu-hp">100</b></div></div><div class="status-line" id="battle-status"></div>`;
    if (screen === 'countdown') screenElement.innerHTML = '<div class="countdown"><span>構えて、相手を見よう</span><strong id="count">3</strong></div>';
    else screenElement.innerHTML = `<div class="play-tip" id="play-tip"></div>`;
    updateHud(); return;
  }
  let html = '';
  if (screen === 'title') {
    html = `<div class="title-top"><div class="eyebrow">A LITTLE BATTLE ON THE TABLE</div><h1>パン<span>バトル</span><em>3D</em></h1><p>ひょいと避けて、<br>こんがり反撃。</p></div><div class="title-bottom"><div class="how"><span>↝ 軽く振って攻撃</span><span>↔ 傾けて回避</span></div>${button('play', ready ? '食卓で勝負する →' : fatal ? '読み込みを再試行' : 'パンを準備しています…')}<div class="button-pair">${button('practice-entry', '練習する', true)}${button('settings', '設定', true)}</div><small>縦持ち · CPUと1対1 · 1試合60秒</small>${fatal ? `<p class="error-text">3D素材を読み込めませんでした。</p>` : ''}</div>`;
  } else if (screen === 'permission') {
    html = `<section class="sheet">${header('01 / HOW TO PLAY', '手首で、パンを動かす', '軽いひと振りで攻撃。左右に傾けると回避。<br>攻撃を振り切る間は、横に動けません。')}<div class="instruction"><b>① 相手が引いたら、横へ</b><span>赤い狙いの輪と、パンの予備動作が合図。</span><b>② 避けたら、すぐ振る</b><span>相手の隙に当てると反撃ボーナス。</span></div><p class="gentle">小さな動きで十分です。しっかり持って遊ぼう。</p>${button('sensor', permissionBusy ? '許可と入力を確認中…' : '動きの利用を許可する')}<p id="permission-message" class="error-text" role="status"></p><details><summary>補助操作で遊ぶ</summary><div class="button-pair">${button('touch', 'タッチ操作', true)}${button('keyboard', 'キーボード', true)}</div></details>${button('title', 'タイトルへ', true)}</section>`;
  } else if (screen === 'calibrate') {
    html = `<section class="sheet">${header('02 / READY', 'いつもの持ち方で', input.mode === 'sensor' ? 'iPhoneを縦に構え、楽な角度で止めてください。<br>この位置を左右移動の中央にします。' : input.mode === 'keyboard' ? '← → または A Dで横移動。<br>Space / Zで攻撃。Escapeで一時停止。' : '左・右ボタンを押している間、横に移動。<br>中央の攻撃ボタンは、1タップで1回。')}<div class="calibration-icon">↔</div><p id="sensor-status" class="status-box"></p>${button('calibrated', 'この位置で開始')}${button('permission', '操作方式を選び直す', true)}<p class="error-text" id="calibration-message" role="status"></p></section>`;
  } else if (screen === 'select') {
    html = `<section class="sheet selection">${header('03 / CHOOSE YOUR BREAD', '今日のパンは？', '3種類とも、最初から遊べます。')}<div class="bread-list">${BREAD_IDS.map(id => `<button data-bread="${id}" aria-pressed="${save.data.bread === id}" class="bread-card"><span class="bread-emoji">${emoji[id]}</span><span><b>${BREADS[id].name}</b><small>${BREADS[id].note}</small></span><i>${save.data.bread === id ? '✓' : ''}</i></button>`).join('')}</div><label class="opponent">対戦相手<select id="opponent">${BREAD_IDS.map(id => `<option value="${id}" ${save.data.cpu === id ? 'selected' : ''}>${BREADS[id].name}</option>`).join('')}</select></label><p class="minor">やさしいCPU · ${modes[input.mode]} · 60秒</p>${button('start', practiceRequested || !save.data.practiced ? 'まずは短い練習へ →' : '対戦をはじめる →')}<div class="button-pair">${button('calibration', '構えを再調整', true)}${button('title', 'タイトルへ', true)}</div></section>`;
  } else if (screen === 'practice-intro') {
    html = `<section class="sheet">${header('WARM UP', '3つ試せば、準備OK', '練習ではHPが減りません。失敗しても大丈夫。')}<ol class="practice-list"><li>攻撃を当てる</li><li>予告を見て、横に避ける</li><li>避けた後の隙に、反撃を当てる</li></ol>${button('practice-start', '練習をはじめる')}${button('skip', '練習をスキップして対戦', true)}</section>`;
  } else if (screen === 'practice-done') {
    html = `<section class="sheet">${header('READY TO BATTLE', 'いい構え！', '攻撃・回避・反撃を試せました。<br>次は60秒のCPU戦です。')}<p class="status-box">練習の成績は自己ベストに入りません。</p>${button('fight', 'CPUと勝負する →')}${button('practice-start', 'もう一度練習', true)}${button('select', 'パンを選び直す', true)}</section>`;
  } else if (screen === 'pause') {
    html = `<section class="sheet">${header('TAKE A BREATH', 'ちょっと、ひと休み')}<p id="pause-message" class="status-box"></p>${button('resume', '再開する →')}${button('calibration', '構えを再調整', true)}${settingsFields()}${button('permission', '操作方式を選び直す', true)}<p class="minor">操作方式を変えると、この対戦は終了します。</p>${button('title', 'この対戦を終了してタイトルへ', true)}<small>途中終了の成績は保存されません。</small></section>`;
  } else if (screen === 'settings') {
    html = `<section class="sheet">${header('SETTINGS', '遊びやすい構えに')}${settingsFields()}<p class="minor">構え位置は対戦前・一時停止中に調整できます。</p>${button('settings-back', '戻る', true)}<p class="minor">設定・自己ベストはこのブラウザー内に保存。<br>センサー値や成績を外部へ送信しません。</p></section>`;
  } else if (screen === 'result') {
    const title = battle.outcome === 'win' ? 'こんがり、勝利！' : battle.outcome === 'lose' ? '次は、ひょいと回避。' : 'いい勝負、引き分け。';
    html = `<section class="sheet result">${header(battle.outcome === 'win' ? 'YOU WIN' : battle.outcome === 'lose' ? 'CPU WINS' : 'DRAW', title)}<p class="result-condition">${BREADS[battle.player.bread].name} vs ${BREADS[battle.cpu.bread].name}<br>やさしいCPU · ${modes[input.mode]} · ${battle.elapsed.toFixed(1)}秒</p><div class="scores">${scoreRow('回避', 'dodge')}${scoreRow('回避後の反撃', 'counter')}</div><p class="minor">自己ベストは同じパン・相手・操作・ルールで比較。<br>対象なしの項目は記録を更新しません。</p>${button('rematch', '同じパンで、もう一戦 →')}<div class="button-pair">${button('select', 'パンを選び直す', true)}${button('title', 'タイトルへ', true)}</div><details class="diagnostics"><summary>この試合の動作計測</summary><pre>${metricsText()}</pre></details></section>`;
  } else if (screen === 'error') {
    html = `<section class="sheet">${header('LET’S TRY AGAIN', '準備が止まっています')}<p class="error-text" id="fatal-message" role="alert"></p>${button('reload', '再読み込みして再試行')}${button('title', 'タイトルへ', true)}</section>`;
  }
  screenElement.innerHTML = html;
  const messageElement = document.querySelector('#permission-message,#pause-message,#fatal-message');
  if (messageElement) messageElement.textContent = screen === 'error' ? fatal : message;
  const sensorButton = screenElement.querySelector<HTMLButtonElement>('[data-action="sensor"]'); if (sensorButton) sensorButton.disabled = permissionBusy;
  if (screen === 'title' && !ready && !fatal) screenElement.querySelector<HTMLButtonElement>('[data-action="play"]')!.disabled = true;
}
function settingsFields(): string {
  return `<label class="setting">音を鳴らす<input type="checkbox" id="sound" ${save.data.sound ? 'checked' : ''}></label><label class="setting slider">操作感度 <output id="sensitivity-value">${save.data.sensitivity.toFixed(1)}</output><input id="sensitivity" type="range" min="0.6" max="1.6" step="0.1" value="${save.data.sensitivity}"></label><p class="minor">高めにすると、小さな振り・傾きに反応します。</p>`;
}
function scoreRow(name: string, key: keyof Scores): string {
  const score = battle.scores[key], value = rate(score), past = rate(previousBest[key]);
  return `<div class="score-row"><span>${name}<small>${score.success}成功 / ${score.opportunities}機会</small></span><b>${value === null ? '対象なし' : `${Math.round(value * 100)}<em>%</em>`}</b><div>前の自己ベスト <strong>${past === null ? '記録なし' : `${Math.round(past * 100)}%`}</strong><span class="record-tag">${value !== null && (past === null || value > past) ? past === null ? '初めての記録' : '自己ベスト更新' : value !== null && value === past ? '自己ベストと同じ' : ''}</span></div></div>`;
}
function metricsText(): string {
  const m = renderer?.metrics();
  return m ? `平均 ${m.fps.toFixed(1)} fps / p95 ${m.p95FrameMs.toFixed(1)} ms\n33.4ms超 ${m.slowFrames}/${m.frames} frames\n検出→表示 ${m.attackSamples ? `最大 ${m.maxAttackMs.toFixed(1)} ms（${m.attackSamples}回）` : '対象なし（攻撃入力なし）'}\n${m.triangles} triangles / ${m.drawCalls} draws\n${RULE} / 感度 ${save.data.sensitivity.toFixed(1)}\n${navigator.userAgent}\n※この端末での計測。実機センサー試行は別途必要。` : '計測なし';
}
function updateHud(): void {
  const p = document.querySelector<HTMLElement>('#player-health'), c = document.querySelector<HTMLElement>('#cpu-health');
  if (!p || !c) return;
  p.style.width = `${battle.player.hp}%`; c.style.width = `${battle.cpu.hp}%`;
  document.querySelector('#player-hp')!.textContent = String(Math.ceil(battle.player.hp)); document.querySelector('#cpu-hp')!.textContent = String(Math.ceil(battle.cpu.hp));
  document.querySelector('#timer')!.textContent = screen === 'practice' ? '∞' : String(Math.max(0, Math.ceil(60 - battle.elapsed)));
  const status = document.querySelector<HTMLElement>('#battle-status')!;
  const threat = phase(battle.cpu) === 'windup', locked = ['windup', 'active'].includes(phase(battle.player));
  status.textContent = locked ? '振り切るまで、横移動できません' : threat ? '相手が狙っています → 横へ回避！' : battle.counterAvailable && battle.elapsed < battle.counterUntil ? '今が反撃のチャンス！' : phase(battle.player) === 'recovery' ? '構えに戻しています · 横移動OK' : '攻撃できます · 相手の動きを見よう';
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
function pause(reason: string): void {
  if (!['battle', 'practice', 'countdown'].includes(screen)) return;
  resumeScreen = screen; message = reason; transition('pause');
}
function fail(reason: string): void { fatal = reason; ready = false; transition('error'); }
function begin(practice: boolean): void {
  if (!ready) { fail('パンの読み込みが完了していません。再試行してください。'); return; }
  if (input.mode === 'sensor' && (!input.sensor.fresh(performance.now()) || input.sensor.baseline === null)) { message = '新しい入力と構え位置を確認してください。'; calibrationReturn = 'select'; transition('calibrate'); return; }
  battle = new Battle(save.data.bread, save.data.cpu, { practice, seed: 42 });
  previousBest = {}; input.clear(); renderer?.resetMetrics(); practiceStage = 0; toast.textContent = '';
  if (practice) transition('practice'); else { countdown = 3; transition('countdown'); }
}
async function action(actionName: string): Promise<void> {
  unlockAudio();
  if (actionName === 'play' || actionName === 'practice-entry') {
    if (!ready) { if (fatal) location.reload(); return; }
    practiceRequested = actionName === 'practice-entry'; message = ''; transition('permission');
  } else if (actionName === 'sensor') {
    if (permissionBusy) return;
    const token = ++permissionToken; permissionBusy = true; message = ''; draw();
    try { await input.request(); if (token !== permissionToken || screen !== 'permission') return; input.mode = 'sensor'; calibrationReturn = 'select'; transition('calibrate'); }
    catch (e) { if (token === permissionToken && screen === 'permission') { message = e instanceof Error ? e.message : '許可を確認できませんでした。'; permissionBusy = false; draw(); } }
  } else if (actionName === 'touch' || actionName === 'keyboard') { input.mode = actionName; calibrationReturn = 'select'; transition('calibrate');
  } else if (actionName === 'calibrated') {
    if (input.mode === 'sensor' && !input.sensor.calibrate(performance.now())) { document.querySelector('#calibration-message')!.textContent = '新しい入力が届いていません。もう一度確認するか補助操作を選んでください。'; return; }
    transition(calibrationReturn);
  } else if (actionName === 'calibration') { calibrationReturn = screen === 'pause' ? 'pause' : 'select'; transition('calibrate');
  } else if (actionName === 'permission') { message = ''; transition('permission');
  } else if (actionName === 'title') { battle = new Battle(save.data.bread, save.data.cpu); practiceRequested = false; transition('title');
  } else if (actionName === 'select') { practiceRequested = false; battle = new Battle(save.data.bread, save.data.cpu); transition('select');
  } else if (actionName === 'start') { save.persist(); if (practiceRequested || !save.data.practiced) transition('practice-intro'); else begin(false);
  } else if (actionName === 'practice-start') begin(true);
  else if (actionName === 'skip' || actionName === 'fight') { save.data.practiced = true; save.persist(); practiceRequested = false; begin(false);
  } else if (actionName === 'rematch') begin(false);
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
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-bread]');
  if (target?.dataset.action) void action(target.dataset.action);
  if (target?.dataset.bread && screen === 'select') {
    save.data.bread = target.dataset.bread as BreadId; save.persist(); battle = new Battle(save.data.bread, save.data.cpu); draw();
    screenElement.querySelector<HTMLElement>(`[data-bread="${save.data.bread}"]`)?.focus();
  }
});
app.addEventListener('change', e => {
  const element = e.target as HTMLInputElement;
  if (element.id === 'opponent') { save.data.cpu = element.value as BreadId; battle = new Battle(save.data.bread, save.data.cpu); }
  else if (element.id === 'sound') { save.data.sound = element.checked; soundUnavailable = false; unlockAudio(); }
  else if (element.id === 'sensitivity') { save.data.sensitivity = Number(element.value); input.sensor.sensitivity = save.data.sensitivity; }
  else return;
  save.persist(); showWarning();
});
app.addEventListener('input', e => { const element = e.target as HTMLInputElement; if (element.id === 'sensitivity') document.querySelector('#sensitivity-value')!.textContent = Number(element.value).toFixed(1); });
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
  const dt = (now - last) / 1000; last = now;
  if (dt > .25) pause('描画が中断したので一時停止しました。');
  if (!rotate.hidden && !isLandscape()) rotate.hidden = true;
  if (toastUntil < now) toast.textContent = '';
  if (screen === 'calibrate') {
    const sensorStatus = document.querySelector('#sensor-status');
    if (sensorStatus) sensorStatus.textContent = input.mode === 'sensor' ? input.sensor.fresh(now) ? '動き・傾きの入力を受信しています ✓' : '動き・傾きの入力を待っています…' : `${modes[input.mode]}で準備OK`;
  }
  if (screen === 'countdown' && !document.hidden && !isLandscape()) {
    countdown -= Math.min(dt, .1); const count = document.querySelector('#count'); if (count) count.textContent = String(Math.max(1, Math.ceil(countdown)));
    if (countdown <= 0) transition('battle');
  }
  const active = screen === 'battle' || screen === 'practice';
  if (active && input.mode === 'sensor' && !input.sensor.fresh(now)) pause('動きの入力が途切れました。入力を確認してから再開してください。');
  if (screen === 'battle' || screen === 'practice') {
    const attack = input.consume();
    if (attack && !battle.player.attack && battle.player.recoil <= 0) acceptedAt = input.detectedAt;
    battle.advance(dt, input.target(), attack);
    for (const event of battle.drainEvents()) {
      renderer?.effect(event);
      if (event.kind === 'hit' || event.kind === 'clash') { beep('hit'); say(event.kind === 'clash' ? '相打ち！' : event.side === 'player' ? 'ヒット！' : '相手の攻撃がヒット'); }
      if (event.kind === 'miss') say(event.side === 'player' ? '空振り · 少し中央に戻ろう' : '相手が空振り！');
      if (event.kind === 'dodge') say('回避成功！ 今が反撃の隙', 1.3);
      if (event.kind === 'counter') { beep('counter'); say('反撃成功！ ダメージUP', 1.5); }
      if (event.kind === 'attack') beep('attack');
      if (screen === 'practice') {
        if (practiceStage === 0 && event.kind === 'hit' && event.side === 'player') { practiceStage = 1; battle.practiceStage = 1; say('攻撃できました！ 次は横に回避', 2); }
        else if (practiceStage === 1 && event.kind === 'dodge') { practiceStage = 2; battle.practiceStage = 2; }
        else if (practiceStage === 2 && event.kind === 'counter') { save.data.practiced = true; save.persist(); transition('practice-done'); }
      }
    }
    if (battle.outcome && screen === 'battle') { previousBest = save.record(battle, input.mode); transition('result'); }
    if (battle.paused && ['battle', 'practice'].includes(screen)) pause('更新が中断したので一時停止しました。');
    updateHud();
  }
  if (ready && renderer && !document.hidden) {
    try {
      renderer.render(battle, now / 1000, active ? Math.min(dt, .1) : 0, active && !battle.paused);
      if (acceptedAt !== null) { renderer.noteLatency(performance.now() - acceptedAt); acceptedAt = null; }
    } catch { fail('3D画面を描画できません。再読み込みを試してください。'); }
  }
}
draw(); environment(); requestAnimationFrame(frame);
try {
  renderer = new TableRenderer(canvas, fail);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
  void Promise.race([renderer.load(), timeout]).then(() => { ready = true; if (screen === 'title') draw(); }).catch(() => fail('パンの3D素材を読み込めませんでした。通信状態を確認して再試行してください。'));
} catch { fail('この環境では3D描画（WebGL2）を開始できません。Safariを更新するか、対応端末で開いてください。'); }

// Read-only diagnostics for device QA. Sensor raw values are never persisted or transmitted.
Object.defineProperty(window, '__panDiagnostics', { value: () => ({ screen, mode: input.mode, ready, elapsed: battle.elapsed, hp: [battle.player.hp, battle.cpu.hp], scores: structuredClone(battle.scores), metrics: renderer?.metrics(), sensorAttacks: input.sensor.attacks, sensitivity: input.sensor.sensitivity }) });
if (import.meta.env.DEV && new URLSearchParams(location.search).get('test') === '1') {
  Object.defineProperty(window, '__panTest', { value: { get battle() { return battle; }, get input() { return input; }, get screen() { return screen; }, get save() { return save; }, get renderer() { return renderer; }, action, transition, pause } });
}
