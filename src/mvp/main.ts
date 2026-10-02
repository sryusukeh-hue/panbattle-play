import './style.css';
import { BREADS, BREAD_IDS, BOSS_ID, type BreadId, type FighterId, type Mode } from './config';
import { SPECIAL_RULE } from '../shared/rules';
import { SPECIALS, METER_MAX, CUTIN_SECONDS } from '../shared/specials';
import { Battle, DIFFICULTIES, DIFFICULTY, PRACTICE_SPECIAL_STAGE, movable, phase, type Difficulty, type Scores, type BattleEvent, type Side } from './battle';
import { emptyStats, matchScore, nextTip, rankOf, recordCharged, recordStat, type Rank, type Tip } from './stats';
import { GameInput } from './input';
import { SaveStore, rate } from './save';
import { TableRenderer, type StanceCue } from './renderer';
import { BattleAudio } from './audio';
import { resultImage, shareResult } from './share';
import { ChallengeStore, STAGES, finished, loseStage, newRun, offerAssist, recordClear, stageSeed, stageSetup, summary, winStage, type Run } from './challenge';
import { INTRO_SECONDS, INTRO_SHORT_SECONDS, cuesBetween, introFrame } from './cinematic';

type Screen = 'title' | 'permission' | 'calibrate' | 'select' | 'practice-intro' | 'practice' | 'practice-done' | 'countdown' | 'battle' | 'replay' | 'pause' | 'settings' | 'result' | 'error' | 'finish'
  // 勝ち抜きチャレンジ (plans/EXECPLAN-BOSS.md): bread choice / continue, the ladder, the boss entrance, the champion ending, the run result.
  | 'challenge' | 'ladder' | 'intro' | 'champion' | 'run-result';
const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `<div class="game-shell"><canvas id="table" aria-label="食卓で向かい合うパンの3D対戦画面"></canvas><div class="vignette"></div><div id="popups" aria-hidden="true"></div><div id="hud" hidden></div><div id="screen"></div><div id="banner" aria-hidden="true"></div><div id="cutin" aria-hidden="true"></div><div id="toast" role="status" aria-live="polite"></div><div id="controls" hidden><button data-control="left" aria-label="左へ移動">←</button><button data-control="attack">攻撃<span>軽くタップ</span></button><button data-control="right" aria-label="右へ移動">→</button></div><button id="special" type="button" hidden><span class="special-fill"></span><span class="special-text">ひっさつ</span></button><div id="save-warning" role="status"></div><div id="rotate" hidden><span>↻</span><h2>縦に持ってね</h2><p>対戦は止まっています。<br>縦に戻して「再開」を選んでください。</p></div></div>`;
const canvas = document.querySelector<HTMLCanvasElement>('#table')!;
const screenElement = document.querySelector<HTMLElement>('#screen')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const controls = document.querySelector<HTMLElement>('#controls')!;
const toast = document.querySelector<HTMLElement>('#toast')!;
const warning = document.querySelector<HTMLElement>('#save-warning')!;
const rotate = document.querySelector<HTMLElement>('#rotate')!;
const popups = document.querySelector<HTMLElement>('#popups')!, bannerElement = document.querySelector<HTMLElement>('#banner')!;
const cutinElement = document.querySelector<HTMLElement>('#cutin')!, specialButton = document.querySelector<HTMLButtonElement>('#special')!;
const save = new SaveStore();
let screen: Screen = 'title', returnScreen: Screen = 'title', resumeScreen: Screen = 'battle';
let battle = new Battle(save.data.bread, save.data.cpu);
let renderer: TableRenderer | undefined; let ready = false; let fatal = ''; let message = '';
let practiceRequested = false; let calibrationReturn: Screen = 'select'; let permissionToken = 0; let permissionBusy = false;
let countdown = 3; let last = performance.now(); let toastUntil = 0; let previousBest: Partial<Scores> = {};
let practiceStage = 0; let acceptedAt: number | null = null;
let stats = emptyStats(); let finishLeft = 0; let lastCount = 0; let thumbs: Partial<Record<FighterId, string>> = {};
// Challenge state: the store, whether the current battle is a challenge stage, the entrance clock, the ending clock and the last stage's outcome.
const challenge = new ChallengeStore(); let inChallenge = false; let challengeRequested = false; let challengePick: BreadId = 'shokupan';
// Presentation clock for idle motion off the combat clock (breads bobbing, plate wobble): it stops while paused or hidden.
let idleClock = 0;
let introClock = 0; let introShort = false; let championClock = 0; let assistNext = false;
// Champion ending length: the full 5 s storyboard, or a short still version under reduced motion.
const championSeconds = (): number => reduced.matches ? 1.2 : 5;
let stageOutcome: { won: boolean; score: number; timeUp: boolean; boss: boolean; stage: number } | null = null;
let result: { score: number; rank: Rank; previous: number | null; tip: Tip } | null = null; let lastReject = 0;
// A drill trains one skill and ends on it; pendingBegin resumes a match or drill after a forced recalibration.
let drill: 0 | 1 | 2 | 3 = 0; let pendingBegin: { practice: boolean; stage: number; drill: 0 | 1 | 2 | 3; challenge?: boolean } | null = null;
// Special meter presentation: last seen meter per side (for +gain popups and the MAX moment) and the practice goal.
let meterSeen: Record<Side, number> = { player: 0, cpu: 0 }; let specialLanded = false; let cpuCharged = false;
// Attack id whose landed-stage count ("nHIT!") was already shown, per side.
let hitsShown: Record<Side, number> = { player: -1, cpu: -1 };
// The CPU charge flag from the previous frame, so the frame that completes the charge shows no number either.
let chargingSeen = false;
// In the drill's dodge step a full meter is not usable yet, so it must not look ready.
const drillDodge = (): boolean => battle.practice && practiceStage === PRACTICE_SPECIAL_STAGE && battle.specialStep === 'dodge'; let cutinTimer: ReturnType<typeof setTimeout> | undefined;
let shareFile: File | null = null; let sharePreparing = false; let shareFailed = false; let shareGeneration = 0; let sharing = false;
const audio = new BattleAudio(() => save.data.sound, () => say('音を再生できません。画面の合図で遊べます。', 3), () => save.data.music ?? true);
const level = (): Difficulty => save.data.difficulty ?? 'gentle';
// DEV ?test=1 keeps the CPU deterministic for automated checks; real matches vary every time.
const testMode = import.meta.env.DEV && new URLSearchParams(location.search).get('test') === '1';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let notices: BattleEvent[] = [];
let stallPause = true; // DEV test hook can disable it for screenshots taken by a throttled preview.
const input = new GameInput(controls, () => { if (['battle', 'practice', 'countdown', 'replay', 'intro', 'champion'].includes(screen)) pause('一時停止'); });
input.sensor.attackSensitivity = save.data.attackSensitivity;
input.sensor.tiltSensitivity = save.data.tiltSensitivity;
input.bindSpecial(specialButton);
const modes: Record<Mode, string> = { sensor: '振る・傾ける', touch: 'タッチ', keyboard: 'キーボード' };
const emoji: Record<FighterId, string> = { shokupan: '🍞', francepan: '🥖', croissant: '🥐', melonpan: '🍈', currypan: '🍛', creampan: '🧤', ikkin: '👑' };
// One-word role on each selection card, and how to dodge that bread's special (shown for the opponent you pick).
const role: Record<BreadId, string> = { shokupan: 'バランス', francepan: 'ながい', croissant: '出がはやい', melonpan: 'よけてチャージ', currypan: '一発ドカン', creampan: '戻りがはやい' };
// Written so the screen alone tells you what to do: the same line is the practice drill's instruction.
const dodgeTip: Record<FighterId, string> = {
  ikkin: '赤い枠の外へ！ 枠が消えたら反撃のチャンス',
  shokupan: '赤い四角の外へ！ 大きく横へ逃げよう', francepan: '赤い線の外へ！ 横へ逃げよう', croissant: '赤い三日月が消えるまで、横で待とう',
  melonpan: '赤い輪の外へ！ 輪が消えるまで、戻らず待とう', currypan: '赤い輪の外へ！ 丸が2つとも消えるまで、戻らず待とう', creampan: '横にはらうよ！ 矢印だけでなく、赤い輪の外まで逃げよう',
};
const button = (action: string, label: string, secondary = false): string => `<button data-action="${action}" class="${secondary ? 'secondary' : 'primary'}">${label}</button>`;
const header = (eyebrow: string, title: string, description = ''): string => `<div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}`;
const RAGE_TIP = 'CPUのゲージが一気にたまる！ ひっさつに注意';
function say(text: string, seconds = 1.2): void { toast.textContent = text; toastUntil = performance.now() + seconds * 1000; }
function restart(element: HTMLElement, className: string): void { element.classList.remove(className); void element.offsetWidth; element.classList.add(className); }
function banner(text: string, kind: string): void { bannerElement.textContent = text; bannerElement.className = ''; void bannerElement.offsetWidth; bannerElement.className = `show ${kind}`; }
// Floating damage numbers above the bread that took the hit (presentation only).
function popup(side: Side, text: string, kind: 'deal' | 'hurt' | 'counter' | 'special' | 'combo' | 'sfx', lift?: number): void {
  if (!renderer) return;
  const point = renderer.project(battle, side, lift), element = document.createElement('span');
  element.className = `popup ${kind}`; element.textContent = text;
  element.style.left = `${point.x + (Math.random() - .5) * 24}px`; element.style.top = `${point.y}px`;
  while (popups.childElementCount >= 6) popups.firstElementChild!.remove();
  popups.append(element); setTimeout(() => element.remove(), 1100);
}
const drillName = (d: number): string => d === 1 ? '回避' : d === 2 ? '反撃' : 'ひっさつ';
// Cut-in for a special move ('both' = two bands for a simultaneous start). seek (seconds already played) resumes it
// after a pause without restarting. When it ends, the move name stays briefly as a small tag.
function showCutin(who: Side | 'both', seek = 0): void {
  const sides: Side[] = who === 'both' ? ['player', 'cpu'] : [who], left = Math.max(0, CUTIN_SECONDS - seek);
  const band = (side: Side): string => {
    const bread = battle[side].bread, spec = SPECIALS[bread];
    return `<div class="cutin-band ${side}"><div class="cutin-portrait">${thumbs[bread] ? `<img src="${thumbs[bread]}" alt="">` : emoji[bread]}</div><div class="cutin-text"><small>${side === 'player' ? 'YOU' : 'CPU'} · ひっさつ！</small><strong><b>${spec.kicker}</b>${spec.title}</strong>${spec.ruby === spec.name ? '' : `<span>${spec.ruby}</span>`}${side === 'cpu' ? '<em>横へ回避！</em>' : ''}</div></div>`;
  };
  // The move name is the only big notice during the move: the CPU rage banner and its gauge tip end here, so the face stays visible.
  if (bannerElement.classList.contains('rage')) bannerElement.className = '';
  if (toast.textContent === RAGE_TIP) { toast.textContent = ''; toastUntil = 0; }
  cutinElement.className = `show ${who}`; cutinElement.style.setProperty('--seek', `${-seek}s`);
  cutinElement.innerHTML = `<div class="cutin-dim"></div><div class="cutin-lines"></div>${sides.map(band).join('')}`;
  clearTimeout(cutinTimer);
  cutinTimer = setTimeout(() => {
    cutinElement.className = 'tail'; cutinElement.innerHTML = sides.map(side => `<div class="cutin-tail ${side}">${SPECIALS[battle[side].bread].shout}</div>`).join('');
    cutinTimer = setTimeout(hideCutin, 900);
  }, left * 1000);
}
function hideCutin(): void { clearTimeout(cutinTimer); cutinElement.className = ''; cutinElement.replaceChildren(); }
function meterGain(side: Side, amount: number): void {
  const element = document.querySelector<HTMLElement>(`#${side}-meter`)?.closest<HTMLElement>('.health');
  if (!element) return;
  const gain = document.createElement('span'); gain.className = 'meter-gain'; gain.textContent = `+${Math.round(amount)}`;
  element.append(gain); setTimeout(() => gain.remove(), 700);
}
// Tracks meter changes each frame: +gain popups, the one-time MAX moment (announced once) and match stats.
function watchMeters(): void {
  for (const side of ['player', 'cpu'] as const) {
    const meter = battle[side].meter ?? 0, before = meterSeen[side]; meterSeen[side] = meter;
    if (meter <= before) continue;
    // Numbers only for discrete gains (hit/dodge/clash); drill refills and the CPU charge just grow the bar.
    if (meter - before >= 5 && !(battle.practice && practiceStage === PRACTICE_SPECIAL_STAGE) && !(side === 'cpu' && (battle.cpuCharging || chargingSeen))) meterGain(side, meter - before);
    if (meter < METER_MAX) continue;
    if (!battle.practice) recordCharged(stats, side);
    if (side === 'player' && !drillDodge()) { banner('ひっさつ OK!', 'charged'); say(input.mode === 'keyboard' ? 'ゲージMAX！ Xキーで ひっさつ！' : 'ゲージMAX！ 「ひっさつ」をタップ！', 1.6); }
  }
}
function specialReason(): string {
  if (battle.practice && practiceStage === PRACTICE_SPECIAL_STAGE && battle.specialStep === 'dodge') return 'まずはCPUのひっさつを見切ろう';
  if ((battle.player.meter ?? 0) < METER_MAX) return 'ゲージがたりない · 当てる・避けるで たまる';
  return '振り終わってから ひっさつ！';
}
// A single-hit special's only stage, or a multi-hit special's last one.
const finalStage = (event: BattleEvent): boolean => (event.stage ?? 0) === SPECIALS[battle[event.side].bread].stages.length - 1;
function landedStages(side: Side): number { let mask = battle[side].attack?.special?.mask ?? 0, count = 0; while (mask) { count += mask & 1; mask >>= 1; } return count; }
function hurt(side: Side): void {
  const element = document.querySelector<HTMLElement>(`#${side === 'player' ? 'player' : 'cpu'}-health`)?.closest<HTMLElement>('.health');
  if (element) restart(element, 'hurt');
}
function enterResult(): void {
  const champion = inChallenge && !!stageOutcome?.boss && stageOutcome.won;
  renderer?.setEnding(battle.outcome === 'win' ? 'player' : battle.outcome === 'lose' ? 'cpu' : 'draw', !champion);
  if (battle.outcome) audio.cue(battle.outcome);
  // The boss's defeat gets its own ending instead of the ordinary result sheet.
  if (champion) { championClock = 0; renderer?.crownChampion(reduced.matches ? 0 : 1.5); transition('champion'); return; }
  transition('result');
}
function present(event: BattleEvent): void {
  renderer?.effect(event); notices.push(event);
}
// A drill step change must not be covered by that frame's ordinary combat notice.
let stepNotice: [string, number] | null = null;
function flushNotices(active: boolean): void {
  const priority = { attack: 0, miss: 1, dodge: 2, hit: 3, clash: 4, counter: 5, special: 6, 'special-hit': 7 };
  const event = notices.sort((a, b) => priority[b.kind] - priority[a.kind])[0]; notices = [];
  if (active && stepNotice) { say(...stepNotice); stepNotice = null; return; }
  stepNotice = null;
  if (!active || !event) return;
  if (event.kind === 'hit' || event.kind === 'clash') say(event.kind === 'clash' ? '相打ち！' : event.guard ? '耳でガードされた！ よけた後のスキをねらおう' : event.side === 'player' ? 'ヒット！' : '相手の攻撃がヒット', event.guard ? 1.6 : 1.2);
  if (event.kind === 'miss') say(event.special ? event.side === 'player' ? 'かわされた！ 戻るまで気をつけて' : 'ひっさつをかわした！' : event.side === 'player' ? '空振り · 少し中央に戻ろう' : '相手が空振り！');
  if (event.kind === 'dodge') say(event.special ? event.side === 'player' ? 'ひっさつ回避！ 今が反撃のチャンス！' : '相手がひっさつを回避！' : event.side === 'player' ? '回避成功！ 今が反撃の隙' : '相手が回避！', 1.3);
  if (event.kind === 'special') say(event.side === 'player' ? SPECIALS[battle.player.bread].shout : 'CPUのひっさつ！ 横へ回避！', 1.2);
  if (event.kind === 'special-hit' && finalStage(event)) say(event.side === 'player' ? 'ひっさつ命中！' : 'ひっさつを受けた…', 1.2);
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
  if (!['battle', 'practice'].includes(next)) hideCutin();
  battle.setPaused(!['battle', 'practice'].includes(next));
  draw();
  if (next === 'intro') audio.duck(Math.max(0, (introShort ? INTRO_SHORT_SECONDS : INTRO_SECONDS) - introClock));
  // Resuming mid cut-in continues the same overlay from where it stopped.
  if (['battle', 'practice'].includes(next) && battle.cutin) { showCutin(battle.cutin.side, CUTIN_SECONDS - battle.cutin.left); audio.duck(battle.cutin.left + .2); }
  if (!['battle', 'practice', 'countdown'].includes(next)) {
    const focus = screenElement.querySelector<HTMLElement>('h1,h2'); if (focus) { focus.tabIndex = -1; focus.focus({ preventScroll: true }); }
  } else (document.activeElement as HTMLElement | null)?.blur();
}
// Both stores' problems stay on screen until a later write succeeds (a failed challenge save must never look saved).
function showWarning(): void { const text = save.warning || challenge.warning; if (warning.textContent !== text) warning.textContent = text; warning.hidden = !text; }
const keepNote = (): string => challenge.warning ? 'タイトルへ（保存できていません）' : 'タイトルへ（続きは保存されます）';
function draw(): void {
  showWarning();
  app.dataset.mode = input.mode; specialButton.hidden = !['battle', 'practice'].includes(screen);
  if (screen === 'replay') {
    app.dataset.screen = screen; hud.hidden = controls.hidden = true; screenElement.className = 'play-overlay';
    screenElement.innerHTML = `<div class="replay-label"><small>${battle.player.hp <= 0 || battle.cpu.hp <= 0 ? 'K.O.' : 'TIME UP'}</small><h2>ラストプレー</h2><p>決着の瞬間をスローで</p></div><div class="replay-controls">${button('replay-skip', 'リプレイをスキップ →')}</div>`; return;
  }
  if (screen === 'finish') {
    app.dataset.screen = screen; hud.hidden = false; controls.hidden = true; screenElement.className = 'play-overlay';
    const ko = battle.player.hp <= 0 || battle.cpu.hp <= 0, text = ko ? 'K.O.!' : 'TIME UP';
    const status = document.querySelector<HTMLElement>('#battle-status'); if (status) { status.textContent = ''; status.className = 'status-line'; status.hidden = true; }
    const boss = inChallenge && battle.cpu.bread === BOSS_ID, judged = !ko && battle.outcome === 'win';
    const sub = battle.outcome === 'win' ? boss ? 'ボス撃破！' : judged ? '判定勝ち' : 'YOU WIN' : boss && !ko ? '時間切れ…' : battle.outcome === 'lose' ? 'CPU WINS' : 'DRAW';
    screenElement.innerHTML = `<div class="finish-banner ${battle.outcome ?? ''}"><strong>${text}</strong><span>${sub}</span></div><div class="replay-controls">${button('replay-skip', 'リプレイをスキップ →')}</div>`; return;
  }
  const playing = ['battle', 'practice', 'countdown'].includes(screen);
  app.dataset.screen = screen;
  hud.hidden = !playing; controls.hidden = !['battle', 'practice'].includes(screen) || input.mode !== 'touch';
  screenElement.className = playing ? 'play-overlay' : `menu ${screen === 'title' ? 'title-screen' : ''}`;
  if (playing) {
    hud.innerHTML = `<div class="topline"><span class="match-label">${screen === 'practice' ? 'ダメージなしの練習' : inChallenge ? battle.cpu.bread === BOSS_ID ? 'BOSS戦 · 6 / 6' : `勝ち抜き · ${(challenge.data.run?.stage ?? 0) + 1} / ${STAGES}` : '食卓 / CPU戦'}</span><button data-action="pause" aria-label="一時停止">Ⅱ</button></div><div class="health-row"><img class="you-face" id="you-face" alt="" hidden><div class="health"><span>YOU · ${BREADS[battle.player.bread].name}</span><div class="health-track"><s id="player-ghost"></s><i id="player-health"></i></div><div class="meter" id="player-meter" role="img" aria-label="ひっさつゲージ"><i></i></div><b><span id="player-hp">100</span><em class="meter-tag" id="player-meter-tag"></em></b></div><div class="timer" id="timer">${battle.limit}</div><div class="health enemy${battle.cpu.bread === BOSS_ID ? ' boss' : ''}"><span>${battle.cpu.bread === BOSS_ID ? '👑 BOSS' : 'CPU'} · ${BREADS[battle.cpu.bread].name}</span><div class="health-track"><s id="cpu-ghost"></s><i id="cpu-health"></i></div><div class="meter" id="cpu-meter" role="img" aria-label="CPUのひっさつゲージ"><i></i></div><b><em class="meter-tag" id="cpu-meter-tag"></em><span id="cpu-hp">100</span></b></div></div><div class="status-line" id="battle-status"></div>`;
    if (screen === 'countdown') lastCount = 0; // redraw restarts the number from the markup
    if (screen === 'countdown') screenElement.innerHTML = `<div class="countdown"><span>構えて、相手を見よう</span><strong id="count">3</strong><em>${inChallenge ? battle.cpu.bread === BOSS_ID ? `BOSS · ${BREADS[battle.cpu.bread].name} · ${battle.limit}秒` : `ステージ${(challenge.data.run?.stage ?? 0) + 1} · ${BREADS[battle.cpu.bread].name}${battle.assist ? ' · お助け' : ''}` : `${DIFFICULTY[battle.difficulty].label}CPU · ${BREADS[battle.cpu.bread].name}`}</em></div>`;
    else screenElement.innerHTML = `<div class="play-tip" id="play-tip"></div>`;
    updateHud(); return;
  }
  let html = '';
  if (screen === 'title') {
    html = `<button class="sound-toggle" data-action="sound-toggle" aria-pressed="${save.data.sound}" aria-label="音 ${save.data.sound ? 'オン' : 'オフ'}">${save.data.sound ? '♪ ON' : '♪ OFF'}</button><div class="title-top"><div class="eyebrow">A LITTLE BATTLE ON THE TABLE</div><h1>パン<span>バトル</span><em>3D</em></h1><p>ひょいと避けて、<br>こんがり反撃。</p></div><div class="title-bottom"><div class="how"><span>↝ 軽く振って攻撃</span><span>↔ 傾けて回避</span></div>${button('play', ready ? '食卓で勝負する →' : fatal ? '読み込みを再試行' : 'パンを準備しています…')}${button('challenge-entry', '👑 勝ち抜きチャレンジ', true)}<div class="button-pair">${button('practice-entry', '練習する', true)}${button('settings', '設定', true)}</div><small>縦持ち · 1対1 · 1試合60秒</small>${fatal ? `<p class="error-text">3D素材を読み込めませんでした。</p>` : ''}</div>`;
  } else if (screen === 'permission') {
    html = `<section class="sheet">${header('01 / HOW TO PLAY', '手首で、パンを動かす', '軽いひと振りで攻撃。左右に傾けると回避。<br>攻撃を振り切る間は、横に動けません。')}<div class="instruction"><b>① 相手が引いたら、横へ</b><span>赤い狙いの輪と、パンの予備動作が合図。</span><b>② 避けたら、すぐ振る</b><span>相手の隙に当てると反撃ボーナス。</span></div><p class="gentle">小さな動きで十分です。しっかり持って遊ぼう。</p>${button('sensor', permissionBusy ? '許可と入力を確認中…' : '動きの利用を許可する')}<p id="permission-message" class="error-text" role="status"></p><details><summary>補助操作で遊ぶ</summary><div class="button-pair">${button('touch', 'タッチ操作', true)}${button('keyboard', 'キーボード', true)}</div></details>${button('title', 'タイトルへ', true)}</section>`;
  } else if (screen === 'calibrate') {
    html = `<section class="sheet">${header('02 / READY', 'いつもの持ち方で', input.mode === 'sensor' ? 'iPhoneを縦に構え、楽な角度で止めてください。<br>この位置を左右移動の中央にします。' : input.mode === 'keyboard' ? '← → または A Dで横移動。<br>Space / Zで攻撃。Escapeで一時停止。' : '左・右ボタンを押している間、横に移動。<br>中央の攻撃ボタンは、1タップで1回。')}<div class="calibration-icon">↔</div><p id="sensor-status" class="status-box"></p>${button('calibrated', 'この位置で開始')}${button('permission', '操作方式を選び直す', true)}<p class="error-text" id="calibration-message" role="status"></p></section>`;
  } else if (screen === 'select') {
    html = `<section class="sheet selection">${header('03 / CHOOSE YOUR BREAD', '今日のパンは？', '6種類とも、最初から遊べます。')}<div class="bread-grid">${BREAD_IDS.map(id => `<button data-bread="${id}" aria-pressed="${save.data.bread === id}" class="bread-card">${thumbs[id] ? `<img class="bread-thumb" src="${thumbs[id]}" alt="">` : `<span class="bread-emoji">${emoji[id]}</span>`}<b>${BREADS[id].name}</b><small>${role[id]}</small><i>${save.data.bread === id ? '✓' : ''}</i></button>`).join('')}</div><div class="bread-detail" id="bread-detail"><b>${BREADS[save.data.bread].name}</b><small>${BREADS[save.data.bread].note}</small>${abilities(save.data.bread)}<span class="bread-special">ひっさつ<b>${SPECIALS[save.data.bread].name}</b></span></div><label class="opponent">対戦相手<select id="opponent">${BREAD_IDS.map(id => `<option value="${id}" ${save.data.cpu === id ? 'selected' : ''}>${BREADS[id].name}</option>`).join('')}</select></label><p class="minor opponent-tip" id="opponent-tip">相手のひっさつ「${SPECIALS[save.data.cpu].name}」<br>${dodgeTip[save.data.cpu]}</p><div class="difficulty" role="group" aria-label="CPUの強さ"><span>CPUの強さ</span>${DIFFICULTIES.map(d => `<button data-difficulty="${d}" aria-pressed="${level() === d}">${DIFFICULTY[d].label}</button>`).join('')}</div><p class="minor">${DIFFICULTY[level()].label}CPU · ${modes[input.mode]} · 60秒${level() === 'gentle' ? '' : ' · 相手も回避します'}</p>${button('start', practiceRequested || !save.data.practiced ? 'まずは短い練習へ →' : '対戦をはじめる →')}${save.data.practiced && !save.data.practicedSpecial && !practiceRequested ? button('special-practice', 'NEW! ひっさつだけ練習する', true) : ''}<div class="button-pair">${button('calibration', '構えを再調整', true)}${button('title', 'タイトルへ', true)}</div></section>`;
  } else if (screen === 'practice-intro') {
    html = `<section class="sheet">${header('WARM UP', '4つ試せば、準備OK', '練習ではHPが減りません。失敗しても大丈夫。')}<ol class="practice-list"><li>攻撃を当てる</li><li>予告を見て、横に避ける</li><li>避けた後の隙に、反撃を当てる</li><li>ゲージMAXで「ひっさつ」を当てる</li></ol>${button('practice-start', '練習をはじめる')}${button('skip', '練習をスキップして対戦', true)}</section>`;
  } else if (screen === 'practice-done') {
    html = `<section class="sheet">${header('READY TO BATTLE', 'いい構え！', drill ? `${drillName(drill)}のコツをつかめました。<br>次は60秒のCPU戦です。` : '攻撃・回避・反撃・ひっさつを試せました。<br>次は60秒のCPU戦です。')}<p class="status-box">練習の成績は自己ベストに入りません。</p>${button('fight', 'CPUと勝負する →')}${button('practice-start', 'もう一度練習', true)}${button('select', 'パンを選び直す', true)}</section>`;
  } else if (screen === 'pause') {
    html = `<section class="sheet">${header('TAKE A BREATH', 'ちょっと、ひと休み')}<p id="pause-message" class="status-box"></p>${button('resume', '再開する →')}${button('calibration', '構えを再調整', true)}${settingsFields()}${button('permission', '操作方式を選び直す', true)}<p class="minor">操作方式を変えると、この対戦は終了します。</p>${button('title', 'この対戦を終了してタイトルへ', true)}<small>途中終了の成績は保存されません。</small></section>`;
  } else if (screen === 'settings') {
    html = `<section class="sheet">${header('SETTINGS', '遊びやすい構えに')}${settingsFields()}<p class="minor">構え位置は対戦前・一時停止中に調整できます。</p>${button('settings-back', '戻る', true)}<p class="minor">設定・自己ベストはこのブラウザー内に保存。<br>オンラインでは操作と試合状態を対戦サーバーへ送ります。生センサー値は送りません。</p></section>`;
  } else if (screen === 'result' && inChallenge && stageOutcome) {
    html = challengeResult(stageOutcome);
  } else if (screen === 'challenge') {
    html = challengeSelect();
  } else if (screen === 'ladder') {
    html = ladder();
  } else if (screen === 'intro') {
    html = `<div class="intro-overlay" id="intro"><i class="bar top"></i><i class="bar bottom"></i><p class="intro-caption" id="intro-caption"></p><div class="intro-name" id="intro-name"><small>BOSS</small><strong>一斤食パン</strong><span>いっきんしょくパン · 食卓の王</span></div>${button('intro-skip', 'スキップ ›', true)}</div>`;
  } else if (screen === 'champion') {
    html = champion();
  } else if (screen === 'run-result') {
    html = runResult();
  } else if (screen === 'result') {
    const title = battle.outcome === 'win' ? 'こんがり、勝利！' : battle.outcome === 'lose' ? '次は、ひょいと回避。' : 'いい勝負、引き分け。';
    const dealt = Math.round(BREADS[battle.cpu.bread].hp - battle.cpu.hp), taken = Math.round(BREADS[battle.player.bread].hp - battle.player.hp);
    const rank = result ? `<div class="rank-card rank-${result.rank}"><div class="rank-letter" role="img" aria-label="ランク ${result.rank}">${result.rank}</div><div class="rank-score"><small>SCORE</small><b>${result.score}</b><span>${result.previous === null ? '初めての記録' : result.score > result.previous ? `ベスト更新！ 前回 ${result.previous}` : `自己ベスト ${result.previous}`}</span></div></div>` : '';
    html = `<section class="sheet result">${header(battle.outcome === 'win' ? 'YOU WIN' : battle.outcome === 'lose' ? 'CPU WINS' : 'DRAW', title)}${rank}${result ? `<div class="next-tip"><b>次のコツ</b>${result.tip.text}${result.tip.drill ? `<button data-action="drill" class="drill">${drillName(result.tip.drill)}だけ練習する →</button>` : ''}</div>` : ''}${button('rematch', '同じパンで、もう一戦 →')}<p class="result-condition">${BREADS[battle.player.bread].name} vs ${BREADS[battle.cpu.bread].name}<br>${DIFFICULTY[battle.difficulty].label}CPU · ${modes[input.mode]} · ${battle.elapsed.toFixed(1)}秒</p><div class="stat-grid">${stat('与ダメージ', String(dealt))}${stat('被ダメージ', String(taken))}${stat('命中', `${stats.player.hits}<small>/${stats.player.attacks}</small>`)}${stat('反撃', String(stats.player.counters))}${stat('ひっさつ', `${stats.player.specialHits}<small>/${stats.player.specials}</small>`)}</div><div class="scores">${scoreRow('回避', 'dodge')}${scoreRow('回避後の反撃', 'counter')}</div><p class="minor">自己ベストは同じパン・相手・操作・ルールで比較。<br>機会なしの項目は記録を更新しません。</p><div class="button-pair">${button('select', 'パンを選び直す', true)}${button('title', 'タイトルへ', true)}</div><details class="diagnostics"><summary>この試合の動作計測</summary><pre>${metricsText()}</pre></details></section>`;
  } else if (screen === 'error') {
    html = `<section class="sheet">${header('LET’S TRY AGAIN', '準備が止まっています')}<p class="error-text" id="fatal-message" role="alert"></p>${button('reload', '再読み込みして再試行')}${button('title', 'タイトルへ', true)}</section>`;
  }
  screenElement.innerHTML = html;
  // The entrance and the champion ending are drawn over the live 3D table, not on a blurred menu.
  if (screen === 'intro' || screen === 'champion') screenElement.className = 'play-overlay';
  if (screen === 'result' && !(inChallenge && stageOutcome)) {
    const diagnostics = screenElement.querySelector('.diagnostics')!;
    diagnostics.insertAdjacentHTML('beforebegin', `${button('share', '結果を画像で共有・保存', true)}<p class="minor">共有先は端末の画面で選べます。非対応なら画像を保存します。</p>`); updateShareButton();
  }
  const messageElement = document.querySelector('#permission-message,#pause-message,#fatal-message');
  if (messageElement) messageElement.textContent = screen === 'error' ? fatal : message;
  const sensorButton = screenElement.querySelector<HTMLButtonElement>('[data-action="sensor"]'); if (sensorButton) sensorButton.disabled = permissionBusy;
  if (screen === 'title' && !ready && !fatal) screenElement.querySelector<HTMLButtonElement>('[data-action="play"]')!.disabled = true;
  if (screen === 'title' && !ready) for (const name of ['challenge-entry']) screenElement.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.disabled = true;
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
// 1-5 pips derived from the combat table so it never drifts from the rules. The ranges are fixed, so adding a bread
// never changes what the others show.
function abilities(id: BreadId): string {
  const b = BREADS[id], scale = (value: number, lo: number, hi: number, invert = false): number => {
    const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    return 1 + Math.round(4 * (invert ? 1 - t : t));
  };
  // How far the swing's leading edge gets at full lean.
  const forward = b.reach + Math.hypot(b.height * Math.sin(b.lean), b.depth * Math.cos(b.lean));
  const rows: [string, number][] = [['パワー', scale(b.damage, 12, 26)], ['出の速さ', scale(b.windup, .12, .30, true)], ['戻りの速さ', scale(b.recovery, .28, .80, true)], ['横の広さ', scale(b.width, .20, .65)], ['とどく長さ', scale(forward, 2.24, 2.67)]];
  return `<span class="abilities">${rows.map(([name, n]) => `<span><em>${name}</em><span class="pips" role="img" aria-label="${name} ${n}/5">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(5 - n)}</span></span>`).join('')}</span>`;
}
function metricsText(): string {
  const m = renderer?.metrics(), s = input.metrics(), absent = '対象なし（センサー入力なし）';
  const threshold = s.minThreshold === null ? '' : ` / 試合中 ${s.minThreshold.toFixed(1)}〜${s.maxThreshold!.toFixed(1)} m/s²`;
  const sensor = `振りの強さ：${s.maxSwing === null ? absent : `最大 ${s.maxSwing.toFixed(1)} m/s²`}\n攻撃しきい値（設定） ${s.threshold.toFixed(1)} m/s²${threshold}\n左右傾き（構え基準）：${s.minTilt === null ? absent : `${s.minTilt.toFixed(1)}〜${s.maxTilt!.toFixed(1)}度`}`;
  return m ? `平均 ${m.fps.toFixed(1)} fps / p95 ${m.p95FrameMs.toFixed(1)} ms\n33.4ms超 ${m.slowFrames}/${m.frames} frames\n検出→表示 ${m.attackSamples ? `最大 ${m.maxAttackMs.toFixed(1)} ms（${m.attackSamples}回）` : '対象なし（攻撃入力なし）'}\n${sensor}\n${m.triangles} triangles / ${m.drawCalls} draws\n${SPECIAL_RULE} / 攻撃感度 ${save.data.attackSensitivity.toFixed(1)} / 回避感度 ${save.data.tiltSensitivity.toFixed(1)}\n${escapeHtml(navigator.userAgent)}\n※この端末での計測。実機センサー試行は別途必要。` : '計測なし';
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
// Your own bread's face (the camera shows its back in battle). Called right after each render so it never lags a
// frame, including the finish slow-motion; the image only changes when the mood does.
function updateYouFace(): void {
  // Portraits are drawn ahead on menus (preparePortraits); here they are only looked up.
  const face = document.querySelector<HTMLImageElement>('#you-face');
  if (!face || hud.hidden || !renderer) return;
  const src = renderer.portrait(battle.player.bread, renderer.playerMood());
  if (src && face.getAttribute('src') !== src) { face.src = src; face.hidden = false; }
}
function updateHud(): void {
  const p = document.querySelector<HTMLElement>('#player-health'), c = document.querySelector<HTMLElement>('#cpu-health');
  if (!p || !c) return;
  const pct = (side: Side): number => clamp01(battle[side].hp / BREADS[battle[side].bread].hp) * 100;
  p.style.width = `${pct('player')}%`; c.style.width = `${pct('cpu')}%`;
  for (const side of ['player', 'cpu'] as const) {
    const meter = battle[side].meter ?? 0, full = meter >= METER_MAX, element = document.querySelector<HTMLElement>(`#${side}-meter`);
    if (!element) continue;
    element.querySelector<HTMLElement>('i')!.style.width = `${meter}%`; element.classList.toggle('full', full);
    element.setAttribute('aria-label', `${side === 'player' ? '' : 'CPUの'}ひっさつゲージ ${Math.floor(meter)}%`);
    const tag = document.querySelector<HTMLElement>(`#${side}-meter-tag`)!, text = full ? 'MAX' : '';
    if (tag.textContent !== text) tag.textContent = text;
  }
  const meter = battle.player.meter ?? 0, ready = battle.canSpecial('player'), label = ready ? 'ひっさつ！' : drillDodge() ? 'まずは見切ろう' : meter >= METER_MAX ? 'MAX · 戻ったら使える' : `ひっさつ ${Math.floor(meter)}%`;
  specialButton.classList.toggle('ready', ready); specialButton.classList.toggle('busy', meter >= METER_MAX && !ready && !drillDodge());
  specialButton.style.setProperty('--fill', `${meter}%`); specialButton.setAttribute('aria-disabled', String(!ready));
  const specialText = specialButton.querySelector<HTMLElement>('.special-text')!; if (specialText.textContent !== label) specialText.textContent = label;
  document.querySelector<HTMLElement>('#player-ghost')!.style.width = `${pct('player')}%`; document.querySelector<HTMLElement>('#cpu-ghost')!.style.width = `${pct('cpu')}%`;
  c.closest('.health')?.classList.toggle('heated', battle.bossPhase === 2);
  p.closest('.health')?.classList.toggle('critical', battle.player.hp > 0 && battle.player.hp <= 25);
  document.querySelector('#player-hp')!.textContent = String(Math.ceil(battle.player.hp)); document.querySelector('#cpu-hp')!.textContent = String(Math.ceil(battle.cpu.hp));
  document.querySelector('#timer')!.textContent = screen === 'practice' ? '∞' : String(Math.max(0, Math.ceil(battle.limit - battle.elapsed)));
  document.querySelector('#timer')!.classList.toggle('urgent', screen === 'battle' && battle.elapsed >= battle.limit - 10 && !battle.outcome);
  const status = document.querySelector<HTMLElement>('#battle-status')!;
  const threat = phase(battle.cpu) === 'windup', locked = !movable(battle.player);
  const cpuSpecial = !!battle.cpu.attack?.special && ['windup', 'active'].includes(phase(battle.cpu)), mine = !!battle.player.attack?.special && ['windup', 'active'].includes(phase(battle.player));
  status.textContent = battle.cutin ? battle.cutin.side !== 'player' ? '相手のひっさつ！ 赤い範囲から横へ逃げろ！' : 'ひっさつ発動！' : cpuSpecial ? '相手のひっさつ！ 赤い範囲から横へ逃げろ！' : mine ? 'ひっさつ発動中！ いけー！' : locked && phase(battle.player) === 'recovery' ? 'ひっさつの反動 · 少しだけ動けない' : locked ? '振り切るまで、横移動できません' : battle.player.recoil > 0 ? '弾かれた！ 体勢を立て直し中' : threat ? '相手が狙っています → 横へ回避！' : battle.counterAvailable && battle.elapsed < battle.counterUntil ? '今が反撃のチャンス！' : phase(battle.player) === 'recovery' ? '構えに戻しています · 横移動OK' : '攻撃できます · 相手の動きを見よう';
  status.className = `status-line ${threat || (battle.cutin && battle.cutin.side !== 'player') ? 'danger' : ''}`;
  const tip = document.querySelector('#play-tip');
  if (tip) {
    if (screen === 'practice') {
      const key = `${practiceStage}/${input.mode}/${battle.specialStep}`;
      if ((tip as HTMLElement).dataset.stage !== key) {
        (tip as HTMLElement).dataset.stage = key;
        const special = practiceStage === PRACTICE_SPECIAL_STAGE;
        const dodge = special && battle.specialStep === 'dodge';
        tip.innerHTML = `<b>${practiceStage + 1} / 4　${['まずは、攻撃を当てよう', '相手が引いたら、横に避けよう', '避けた隙に、すぐ反撃しよう', dodge ? 'CPUのひっさつを見切ろう！' : 'ゲージMAX！ ひっさつを当てよう'][practiceStage] ?? ''}</b><span>${dodge ? dodgeTip[battle.cpu.bread] : special ? `${input.mode === 'keyboard' ? 'Xキー' : '光る「ひっさつ」ボタン'}で発動 · 練習用に満タン` : input.mode === 'sensor' ? '軽く振る → 攻撃 / 左右に傾ける → 回避' : input.mode === 'touch' ? '左右を押して回避 / 中央ボタンで攻撃' : '← →で回避 / Spaceで攻撃'}</span><button data-action="skip">練習をスキップ</button>`;
      }
    } else {
      const text = input.mode === 'sensor' ? '軽く振って攻撃 · 傾けて回避' : input.mode === 'keyboard' ? '← →：回避　Space：攻撃　X：ひっさつ' : '押して移動 · 離すと中央へ';
      if (tip.textContent !== text) tip.textContent = text;
    }
  }
}
function stanceCue(): StanceCue {
  const p = phase(battle.player);
  // Mirrors startAttack(): no new swing while one is running or while knocked back.
  return p === 'windup' || p === 'active' || !movable(battle.player) || battle.player.recoil > 0 ? 'locked' : battle.canSpecial('player') ? 'charged' : battle.counterAvailable && battle.elapsed < battle.counterUntil ? 'counter' : p === 'recovery' ? 'recovery' : 'ready';
}
function pause(reason: string): void {
  if (!['battle', 'practice', 'countdown', 'replay', 'intro', 'champion'].includes(screen)) return;
  resumeScreen = screen; message = reason; audio.silence(); transition('pause');
}
function fail(reason: string): void { fatal = reason; ready = false; transition('error'); }
function begin(practice: boolean, stage = 0, only: 0 | 1 | 2 | 3 = 0): void {
  if (!ready) { fail('パンの読み込みが完了していません。再試行してください。'); return; }
  if (input.mode === 'sensor' && (!input.sensor.fresh(performance.now()) || input.sensor.baseline === null)) { message = '新しい入力と構え位置を確認してください。'; calibrationReturn = 'select'; pendingBegin = { practice, stage, drill: only }; transition('calibrate'); return; }
  battle = new Battle(save.data.bread, save.data.cpu, { practice, seed: practice || testMode ? 42 : crypto.getRandomValues(new Uint32Array(1))[0]!, difficulty: level() });
  inChallenge = false; freshMatch(stage); drill = practice ? only : 0;
  if (practice && stage === PRACTICE_SPECIAL_STAGE) battle.enterSpecialPractice();
  meterSeen = { player: battle.player.meter ?? 0, cpu: battle.cpu.meter ?? 0 };
  if (practice) transition('practice'); else { countdown = 3; transition('countdown'); }
}
// Per-match resets shared by free battles and challenge stages.
function freshMatch(stage = 0): void {
  stats = emptyStats(); result = null; lastCount = 0; popups.replaceChildren();
  shareGeneration++; shareFile = null; sharePreparing = shareFailed = sharing = false;
  previousBest = {}; input.clear(); input.resetMetrics(); renderer?.resetMetrics(); practiceStage = stage; battle.practiceStage = stage; drill = 0; pendingBegin = null; toast.textContent = '';
  meterSeen = { player: 0, cpu: 0 }; specialLanded = false; cpuCharged = false; hitsShown = { player: -1, cpu: -1 }; phaseSeen = false; hideCutin();
}
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
// The boss's second-form toasting, ramping in over .6 s from the moment it began.
const heat = (): number => battle.phaseShiftAt < 0 ? 0 : clamp01((battle.elapsed - battle.phaseShiftAt) / .6);
let phaseSeen = false;
// --- 勝ち抜きチャレンジ ---
const crown = (id: BreadId): string => { const r = challenge.data.records[id]; return r ? `<em class="crown${r.perfect ? ' perfect' : ''}" aria-label="クリア ${r.clears}回${r.perfect ? '・ノーコンティニュー' : ''}">👑</em>` : ''; };
const face = (id: FighterId, extra = ''): string => thumbs[id] ? `<img class="bread-thumb${extra}" src="${thumbs[id]}" alt="">` : `<span class="bread-emoji${extra}">${emoji[id]}</span>`;
const liveRun = (): Run | null => { const run = challenge.data.run; return run && !finished(run) ? run : null; };
function challengeSelect(): string {
  const run = liveRun();
  const resume = run ? `<div class="run-resume"><b>つづきから</b><span>${face(run.bread)}${BREADS[run.bread].name} · ステージ ${run.stage + 1} / ${STAGES}${run.retries ? ` · 再挑戦 ${run.retries}回` : ''}</span>${button('challenge-continue', 'つづきから遊ぶ →')}</div><p class="minor">下でパンを選んで「はじめから」にすると、この記録は終わります。</p>` : '';
  return `<section class="sheet selection challenge">${header('KACHINUKI CHALLENGE', '勝ち抜きチャレンジ', '5つのパンに勝ち抜いて、<br>最後のボスに挑もう。')}${resume}<div class="bread-grid">${BREAD_IDS.map(id => `<button data-bread="${id}" aria-pressed="${challengePick === id}" class="bread-card">${face(id)}<b>${BREADS[id].name}</b><small>${role[id]}</small><i>${challengePick === id ? '✓' : ''}</i>${crown(id)}</button>`).join('')}</div><p class="minor">勝つたびに相手が強くなります · 負けても同じステージから何度でも · 最後は90秒のボス戦</p>${button('challenge-start', run ? `${BREADS[challengePick].name}で はじめから →` : `${BREADS[challengePick].name}で 挑戦する →`, !!run)}${button('title', 'タイトルへ', true)}</section>`;
}
function ladder(): string {
  const run = liveRun();
  if (!run) return challengeSelect();
  const setup = stageSetup(run, run.stage), next = BREADS[setup.opponent];
  const rows = run.order.map((id, i) => {
    const state = i < run.stage ? 'done' : i === run.stage ? 'next' : 'later', hidden = id === BOSS_ID && i > run.stage;
    return `<li class="rung ${state}${id === BOSS_ID ? ' boss' : ''}"><span class="rung-no">${id === BOSS_ID ? 'BOSS' : i + 1}</span>${face(id, hidden ? ' silhouette' : '')}<b>${hidden ? '？？？' : BREADS[id].name}</b><em>${state === 'done' ? '✓ 勝ち' : state === 'next' ? 'つぎ！' : ''}</em></li>`;
  }).reverse().join('');
  const cheer = run.order.slice(0, run.stage).map(id => face(id, ' cheer')).join('');
  const assist = offerAssist(run) ? `<button class="assist" data-action="assist-toggle" aria-pressed="${assistNext}">お助け：予告をゆっくりにする ${assistNext ? 'ON' : 'OFF'}</button><p class="minor">お助けを使うと、ランクSはつきません。</p>` : '';
  const tip = setup.boss ? `<p class="status-box boss-tip">かたい耳で、ふつうの攻撃はほとんど効かない！<br>${dodgeTip.ikkin}<br>HP${next.hp} · 90秒で倒しきろう</p>` : `<p class="status-box">相手のひっさつ「${SPECIALS[setup.opponent].name}」<br>${dodgeTip[setup.opponent]}</p>`;
  const replayIntro = setup.boss && challenge.data.seenIntro ? button('intro-replay', '登場をもう一度見る', true) : '';
  return `<section class="sheet ladder-sheet">${header(`STAGE ${run.stage + 1} / ${STAGES}`, setup.boss ? 'ついに、ボス戦！' : `つぎは ${next.name}`, `あなた：${BREADS[run.bread].name}${run.retries ? ` · 再挑戦 ${run.retries}回` : ''}`)}<ol class="ladder">${rows}</ol>${cheer ? `<div class="cheer"><small>応援席</small>${cheer}</div>` : ''}${tip}${assist}${button('fight-stage', setup.boss ? 'ボスに挑む →' : 'たたかう →')}${replayIntro}${button('title', keepNote(), true)}</section>`;
}
function challengeResult(o: NonNullable<typeof stageOutcome>): string {
  const run = challenge.data.run, rank = result ? `<div class="rank-card rank-${result.rank}"><div class="rank-letter" role="img" aria-label="ランク ${result.rank}">${result.rank}</div><div class="rank-score"><small>SCORE</small><b>${result.score}</b><span>ステージ${o.stage + 1}</span></div></div>` : '';
  if (o.won) return `<section class="sheet result">${header(`STAGE ${o.stage + 1} CLEAR`, o.timeUp ? '判定勝ち！' : `${BREADS[battle.cpu.bread].name}に勝利！`)}${rank}${button('next-stage', run && run.stage === STAGES - 1 ? 'ボス戦へ →' : '次の相手へ →')}${result ? `<div class="next-tip"><b>次のコツ</b>${result.tip.text}</div>` : ''}${button('title', keepNote(), true)}</section>`;
  const title = o.boss && o.timeUp ? '時間切れ… ボスを倒しきろう' : o.boss ? 'ボスは手ごわい！' : battle.outcome === 'draw' ? '引き分け、もう一回！' : 'もう一回！';
  const assist = run && offerAssist(run) ? `<p class="status-box">何度でも挑戦できます。進行画面で「お助け」も使えます。</p>` : '';
  return `<section class="sheet result">${header('TRY AGAIN', title, '同じステージから、何度でも挑戦できます。')}${result ? `<div class="next-tip"><b>次のコツ</b>${result.tip.text}</div>` : ''}${assist}${button('retry-stage', 'もう一度たたかう →')}${button('next-stage', '進行画面へ', true)}${button('title', keepNote(), true)}</section>`;
}
function champion(): string {
  const run = challenge.data.run, beaten = run ? run.order.filter(id => id !== BOSS_ID) : [];
  return `<div class="champion" id="champion" style="--seek:${(-championClock).toFixed(2)}s"><div class="champion-title"><small>BOSS DEFEATED</small><strong>食卓チャンピオン！</strong><span>${run ? BREADS[run.bread].name : ''}が 一斤食パンに勝った！</span></div><div class="cheer champion-cheer">${beaten.map((id, i) => `<span style="--i:${i}">${face(id, ' cheer')}</span>`).join('')}</div><div class="replay-controls">${button('champion-next', '結果を見る →')}</div></div>`;
}
function runResult(): string {
  const run = challenge.data.run;
  if (!run) return challengeSelect();
  const s = summary(run), record = challenge.data.records[run.bread], minutes = Math.floor(run.playSeconds / 60), seconds = Math.round(run.playSeconds % 60);
  const marks = run.order.map(id => `<span class="mark${id === BOSS_ID ? ' boss' : ''}">${face(id)}</span>`).join('');
  return `<section class="sheet result run-result">${header('CHALLENGE CLEAR', '勝ち抜き、達成！', `${BREADS[run.bread].name}で 6 / 6 クリア`)}<div class="rank-card rank-${s.rank ?? 'D'}"><div class="rank-letter" role="img" aria-label="ランク ${s.rank}">${s.rank}</div><div class="rank-score"><small>TOTAL</small><b>${s.total}</b><span>${record && record.best === s.total ? 'ベスト記録！' : record ? `ベスト ${record.best}` : ''}</span></div></div><div class="clear-marks">${marks}</div><div class="stat-grid">${stat('再挑戦', `${run.retries}<small>回</small>`)}${stat('反撃', String(s.counters))}${stat('回避率', s.dodgeRate === null ? '—' : `${Math.round(s.dodgeRate * 100)}<small>%</small>`)}${stat('時間', `${minutes}:${String(seconds).padStart(2, '0')}`)}</div>${run.retries === 0 && !run.assist ? '<p class="status-box perfect-note">👑 ノーコンティニュー！ 金の王冠をゲット</p>' : '<p class="minor">ノーコンティニューで、金縁の王冠がもらえます。</p>'}${button('challenge-again', 'もう一度チャレンジ →')}${button('title', 'タイトルへ', true)}</section>`;
}
function beginStage(): void {
  const run = liveRun();
  if (!run) { transition('challenge'); return; }
  if (!ready) { fail('パンの読み込みが完了していません。再試行してください。'); return; }
  if (input.mode === 'sensor' && (!input.sensor.fresh(performance.now()) || input.sensor.baseline === null)) { message = '新しい入力と構え位置を確認してください。'; calibrationReturn = 'ladder'; pendingBegin = { practice: false, stage: 0, drill: 0, challenge: true }; transition('calibrate'); return; }
  const setup = stageSetup(run, run.stage);
  if (assistNext && !run.assist) challenge.update(d => ({ ...d, run: { ...run, assist: true } }));
  battle = new Battle(run.bread, setup.opponent, { seed: testMode ? 42 : stageSeed(run), profile: setup.profile, limit: setup.limit, assist: assistNext });
  inChallenge = true; stageOutcome = null; freshMatch(); renderer?.preparePortraits(run.bread);
  if (setup.boss) { introShort = challenge.data.seenIntro || reduced.matches; introClock = 0; transition('intro'); }
  else { countdown = 3; transition('countdown'); }
}
function finishIntro(): void {
  if (!challenge.data.seenIntro) challenge.update(d => ({ ...d, seenIntro: true }));
  countdown = 3; transition('countdown'); say('よけたら、反撃！', 1.5);
}
// One write per stage: the result and the next stage (or the retry count) land together, plus the clear record.
function settleStage(): void {
  const run = liveRun(); if (!run || !battle.outcome) return;
  const won = battle.outcome === 'win', boss = battle.cpu.bread === BOSS_ID;
  const input_ = { outcome: battle.outcome, hpRatio: battle.player.hp / BREADS[battle.player.bread].hp, scores: battle.scores, stats }, score = matchScore(input_);
  result = { score, rank: rankOf(score, input_), previous: null, tip: nextTip(input_, false) };
  stageOutcome = { won, score, timeUp: battle.player.hp > 0 && battle.cpu.hp > 0, boss, stage: run.stage };
  const next = won ? winStage(run, { score, dodge: battle.scores.dodge.success, chances: battle.scores.dodge.opportunities, counters: stats.player.counters, seconds: Math.round(battle.elapsed * 10) / 10 })
    : loseStage(run, battle.elapsed);
  challenge.update(d => ({ ...d, run: next, records: recordClear(d.records, next) }));
  if (won) assistNext = false;
  if (challenge.warning) say(challenge.warning, 3);
  prepareShare(); finishLeft = reduced.matches ? .5 : .9; transition('finish');
}
async function action(actionName: string): Promise<void> {
  audio.unlock();
  if (actionName === 'play' || actionName === 'practice-entry' || actionName === 'challenge-entry') {
    if (!ready) { if (fatal) location.reload(); return; }
    challengeRequested = actionName === 'challenge-entry'; challengePick = liveRun()?.bread ?? save.data.bread;
    practiceRequested = actionName === 'practice-entry'; message = ''; transition('permission');
  } else if (actionName === 'sensor') {
    if (permissionBusy) return;
    const token = ++permissionToken; permissionBusy = true; message = ''; draw();
    try { await input.request(); if (token !== permissionToken || screen !== 'permission') return; input.mode = 'sensor'; calibrationReturn = 'select'; transition('calibrate'); }
    catch (e) { if (token === permissionToken && screen === 'permission') { message = e instanceof Error ? e.message : '許可を確認できませんでした。'; permissionBusy = false; draw(); } }
  } else if (actionName === 'touch' || actionName === 'keyboard') { input.mode = actionName; calibrationReturn = 'select'; transition('calibrate');
  } else if (actionName === 'calibrated' && pendingBegin && input.mode === 'sensor' && input.sensor.calibrate(performance.now())) {
    const resume = pendingBegin; if (resume.challenge) beginStage(); else begin(resume.practice, resume.stage, resume.drill);
  } else if (actionName === 'calibrated') {
    if (input.mode === 'sensor' && !input.sensor.calibrate(performance.now())) { document.querySelector('#calibration-message')!.textContent = '新しい入力が届いていません。もう一度確認するか補助操作を選んでください。'; return; }
    transition(challengeRequested && calibrationReturn === 'select' ? 'challenge' : calibrationReturn);
  } else if (actionName === 'calibration') { calibrationReturn = screen === 'pause' ? 'pause' : 'select'; transition('calibrate');
  } else if (actionName === 'permission') { message = ''; pendingBegin = null; transition('permission');
  } else if (actionName === 'challenge-start') { challenge.update(d => ({ ...d, run: newRun(challengePick, input.mode, testMode ? 7 : crypto.getRandomValues(new Uint32Array(1))[0]!) })); assistNext = false; transition('ladder');
  } else if (actionName === 'challenge-continue') { assistNext = false; transition('ladder');
  } else if (actionName === 'challenge-again') { challengePick = challenge.data.run?.bread ?? challengePick; renderer?.setEnding(null); inChallenge = false; transition('challenge');
  } else if (actionName === 'fight-stage' || actionName === 'retry-stage') { renderer?.setEnding(null); beginStage();
  } else if (actionName === 'next-stage') { renderer?.setEnding(null); inChallenge = false; transition(liveRun() ? 'ladder' : 'challenge');
  } else if (actionName === 'assist-toggle') { assistNext = !assistNext; draw(); screenElement.querySelector<HTMLElement>('[data-action="assist-toggle"]')?.focus();
  } else if (actionName === 'intro-skip' && screen === 'intro') { introClock = introShort ? INTRO_SHORT_SECONDS : INTRO_SECONDS; finishIntro();
  } else if (actionName === 'intro-replay') { challenge.update(d => ({ ...d, seenIntro: false })); beginStage();
  } else if (actionName === 'champion-next' && screen === 'champion') { renderer?.tiltEnding(); transition('run-result');
  } else if (actionName === 'title') { pendingBegin = null; inChallenge = false; challengeRequested = false; renderer?.setEnding(null); battle = new Battle(save.data.bread, save.data.cpu); practiceRequested = false; transition('title');
  } else if (actionName === 'select') { pendingBegin = null; renderer?.setEnding(null); practiceRequested = false; battle = new Battle(save.data.bread, save.data.cpu); transition('select');
  } else if (actionName === 'start') { save.persist(); if (practiceRequested || !save.data.practiced) transition('practice-intro'); else begin(false);
  } else if (actionName === 'practice-start') begin(true);
  else if (actionName === 'special-practice') begin(true, PRACTICE_SPECIAL_STAGE, 3);
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
  if (target?.dataset.bread && screen === 'challenge' && BREAD_IDS.includes(target.dataset.bread as BreadId)) {
    challengePick = target.dataset.bread as BreadId; draw(); screenElement.querySelector<HTMLElement>(`[data-bread="${challengePick}"]`)?.focus(); return;
  }
  if (target?.dataset.bread && screen === 'select') {
    save.data.bread = target.dataset.bread as BreadId; save.persist(); battle = new Battle(save.data.bread, save.data.cpu); renderer?.preparePortraits(save.data.bread); draw();
    screenElement.querySelector<HTMLElement>(`[data-bread="${save.data.bread}"]`)?.focus();
  }
});
app.addEventListener('change', e => {
  const element = e.target as HTMLInputElement;
  if (element.id === 'opponent') { if (!BREAD_IDS.includes(element.value as BreadId)) return; save.data.cpu = element.value as BreadId; battle = new Battle(save.data.bread, save.data.cpu);
    const tip = document.querySelector('#opponent-tip'); if (tip) tip.innerHTML = `相手のひっさつ「${SPECIALS[save.data.cpu].name}」<br>${dodgeTip[save.data.cpu]}`; }
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
  audio.music(['countdown', 'battle', 'practice', 'finish', 'intro'].includes(screen) && !document.hidden, screen === 'battle' && battle.elapsed >= battle.limit - 10);
  if (dt > .25) pause('描画が中断したので一時停止しました。');
  if (screen !== 'pause' && !document.hidden) idleClock += Math.min(dt, .1);
  if (!rotate.hidden && !isLandscape()) rotate.hidden = true;
  if (screen === 'finish') {
    if (!document.hidden && renderer) {
      finishLeft -= Math.min(dt, .1);
      try { renderer.render(battle, battle.elapsed, Math.min(dt, .1), true, undefined, .3); updateYouFace(); }
      catch { fail('3D画面を描画できません。再読み込みを試してください。'); return; }
      if (finishLeft <= 0) { if (renderer.startReplay()) transition('replay'); else enterResult(); }
    }
    return;
  }
  if (screen === 'intro') {
    if (!document.hidden && renderer && !isLandscape()) {
      const before = introClock; introClock += Math.min(dt, .1);
      const f = introFrame(introClock, introShort);
      for (const cue of cuesBetween(before, introClock, introShort)) { audio.boss(cue); if (cue === 'thud') renderer.introImpact(); }
      const overlay = document.querySelector<HTMLElement>('#intro');
      if (overlay) {
        overlay.style.setProperty('--bars', String(f.letterbox)); overlay.style.setProperty('--dim', String(f.dim)); overlay.style.setProperty('--title', String(f.title));
        const caption = document.querySelector<HTMLElement>('#intro-caption')!; if (caption.textContent !== f.caption) caption.textContent = f.caption;
      }
      try { renderer.render(battle, idleClock, Math.min(dt, .1), false, { intro: f }); } catch { fail('3D画面を描画できません。再読み込みを試してください。'); return; }
      if (f.done) finishIntro();
    }
    return;
  }
  if (screen === 'champion') {
    if (!document.hidden && renderer) {
      championClock += Math.min(dt, .1); renderer.tickEnding(Math.min(dt, .1));
      try { renderer.render(battle, idleClock, 0, false); } catch { fail('3D画面を描画できません。再読み込みを試してください。'); return; }
      if (championClock >= championSeconds()) { renderer.tiltEnding(); transition('run-result'); }
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
    const attack = input.consume(), special = input.consumeSpecial(), specialOk = special && battle.canSpecial('player');
    if (special && !specialOk && !battle.freezing && now - lastReject > 600) { lastReject = now; say(specialReason(), .9); }
    if (specialOk) acceptedAt = performance.now();
    else if (attack && battle.freezing) { /* Dropped during the cut-in, like every other input. */ }
    else if (attack && !battle.player.attack && battle.player.recoil <= 0) acceptedAt = input.detectedAt;
    else if (attack && now - lastReject > 900) { lastReject = now; say(battle.player.recoil > 0 ? '弾かれ中 · 少し待って振ろう' : '振り切り中 · 戻ってから振ろう', .7); }
    battle.advance(dt, input.target(), attack, special);
    const events = battle.drainEvents(), countered = new Set(events.filter(e => e.kind === 'counter').map(e => e.side));
    const specialHits = new Set(events.filter(e => e.kind === 'special-hit' && finalStage(e)).map(e => e.side));
    const started = events.filter(e => e.kind === 'special').map(e => e.side);
    if (started.length) { showCutin(started.length > 1 ? 'both' : started[0]!); audio.duck(CUTIN_SECONDS + .2); }
    for (const [side, before] of [['player', hpBefore[0]], ['cpu', hpBefore[1]]] as const) {
      const lost = before - battle[side].hp, by = side === 'player' ? 'cpu' : 'player';
      if (lost > 0) { popup(side, `-${Math.round(lost)}`, specialHits.has(by) ? 'special' : countered.has(by) ? 'counter' : side === 'player' ? 'hurt' : 'deal'); hurt(side); }
    }
    for (const event of events) {
      if (!battle.practice) recordStat(stats, event);
      else if (event.kind === 'hit' || event.kind === 'clash') { for (const side of ['player', 'cpu'] as const) if (event.kind === 'clash' || side !== event.side) popup(side, 'HIT!', side === 'player' ? 'hurt' : 'deal'); }
      else if (event.kind === 'special-hit') popup(event.side === 'player' ? 'cpu' : 'player', 'HIT!', finalStage(event) ? 'special' : 'combo');
      // Multi-hit moves: light marks on the early stages, then the landed count and the big finish on the last one.
      if (event.kind === 'special-hit') popup(event.side === 'player' ? 'cpu' : 'player', SPECIALS[battle[event.side].bread].sfx[event.stage ?? 0] ?? '', finalStage(event) ? 'sfx' : 'combo', finalStage(event) ? 1.75 : 1.5);
      if (screen === 'practice' && practiceStage === PRACTICE_SPECIAL_STAGE && battle.specialStep === 'dodge' && event.kind === 'dodge' && event.side === 'player' && event.special) {
        battle.specialFire(); meterSeen.player = battle.player.meter ?? 0; specialLanded = false; banner('見切った！', 'charged'); stepNotice = ['次はきみの番！ ひっさつを当てよう', 2];
      }
      // Only a special fired in the drill's "fire" step completes stage 4.
      if (event.kind === 'special-hit' && event.side === 'player' && practiceStage === PRACTICE_SPECIAL_STAGE && battle.specialStep === 'fire') specialLanded = true;
      present(event);
      if (event.kind === 'hit' && event.guard) popup('cpu', 'カキン！', 'combo', 1.3);
      // Against the boss, a clean dodge is the moment to strike: say it right on the loaf.
      if (battle.cpu.bread === BOSS_ID && event.kind === 'dodge' && event.side === 'player') popup('cpu', 'いま！', 'counter', 1.2);
      if (screen === 'practice') {
        if (practiceStage === 0 && event.kind === 'hit' && event.side === 'player') { practiceStage = 1; battle.practiceStage = 1; say('攻撃できました！ 次は横に回避', 2); }
        else if (practiceStage === 1 && event.kind === 'dodge' && event.side === 'player') { if (drill === 1) transition('practice-done'); else { practiceStage = 2; battle.practiceStage = 2; } }
        else if (practiceStage === 2 && event.kind === 'counter') {
          save.data.practiced = true; save.persist();
          if (drill === 2) transition('practice-done');
          else {
            practiceStage = PRACTICE_SPECIAL_STAGE; battle.enterSpecialPractice(); specialLanded = false;
            meterSeen = { player: battle.player.meter ?? 0, cpu: battle.cpu.meter ?? 0 }; banner('ひっさつ！', 'rage'); stepNotice = ['最後はひっさつ！ まずはCPUのひっさつを見切ろう', 2];
          }
        }
      }
    }
    watchMeters(); chargingSeen = battle.cpuCharging;
    // Multi-hit moves report how many stages actually landed once their hit window closes (or the match ends mid-move).
    for (const side of ['player', 'cpu'] as const) {
      const fighter = battle[side], attack = fighter.attack;
      if (!attack?.special?.landed || hitsShown[side] === attack.id || SPECIALS[fighter.bread].stages.length < 2) continue;
      if (phase(fighter) !== 'recovery' && !battle.outcome) continue;
      hitsShown[side] = attack.id; popup(side === 'player' ? 'cpu' : 'player', `${landedStages(side)}HIT!`, 'combo', 1.25);
    }
    if (battle.cpuCharging && !cpuCharged) { cpuCharged = true; banner(battle.bossPhase ? 'プレスが来る！' : 'CPUが本気だ！', 'rage'); say(RAGE_TIP, 1.8); }
    // The boss charges more than once; each new charge is announced again.
    if (!battle.cpuCharging && cpuCharged && battle.bossPhase) cpuCharged = false;
    if (battle.bossPhase === 2 && !phaseSeen) { phaseSeen = true; banner('焼きたてモード！', 'rage'); say('ボスが熱くなった！ 攻撃の間かくが短くなるよ', 2); }
    // The special drill ends once a special has landed and finished, so the whole move plays out.
    if (screen === 'practice' && practiceStage === PRACTICE_SPECIAL_STAGE && battle.specialStep === 'fire' && specialLanded && !battle.player.attack?.special) {
      save.data.practicedSpecial = true; save.persist(); transition('practice-done');
    }
    if (battle.paused && ['battle', 'practice'].includes(screen)) pause('更新が中断したので一時停止しました。');
    updateHud();
  }
  flushNotices(screen === 'battle' || screen === 'practice');
  if (ready && renderer && !document.hidden) {
    try {
      // A paused entrance keeps showing its current frame; result screens advance the ending pose clock.
      if (['result', 'run-result'].includes(screen)) renderer.tickEnding(Math.min(dt, .1));
      const heldIntro = screen === 'pause' && resumeScreen === 'intro' ? introFrame(introClock, introShort) : null;
      renderer.render(battle, active ? battle.elapsed : idleClock, active ? Math.min(dt, .1) : 0, active && !battle.paused, { ...(battle.practice ? {} : { remaining: battle.limit - battle.elapsed }), cue: stanceCue(), frozen: battle.freezing, charging: battle.cpuCharging, heat: heat(), intro: heldIntro });
      if (acceptedAt !== null) { renderer.noteLatency(performance.now() - acceptedAt); acceptedAt = null; }
      updateYouFace();
      if (battle.outcome && screen === 'battle' && inChallenge) settleStage();
      else if (battle.outcome && screen === 'battle') {
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
  void Promise.race([renderer.load(), timeout]).then(() => { ready = true; thumbs = renderer!.thumbnails(); renderer!.preparePortraits(save.data.bread); if (screen === 'title' || screen === 'select') draw(); }).catch(() => fail('パンの3D素材を読み込めませんでした。通信状態を確認して再試行してください。'));
} catch { fail('この環境では3D描画（WebGL2）を開始できません。Safariを更新するか、対応端末で開いてください。'); }

// Read-only diagnostics for device QA. Sensor raw values are never persisted or transmitted.
Object.defineProperty(window, '__panDiagnostics', { value: () => ({ screen, mode: input.mode, ready, elapsed: battle.elapsed, hp: [battle.player.hp, battle.cpu.hp], scores: structuredClone(battle.scores), metrics: renderer?.metrics(), sensorMetrics: input.metrics(), sensorAttacks: input.sensor.attacks, attackSensitivity: input.sensor.attackSensitivity, tiltSensitivity: input.sensor.tiltSensitivity }) });
if (import.meta.env.DEV && new URLSearchParams(location.search).get('test') === '1') {
  Object.defineProperty(window, '__panTest', { value: { get battle() { return battle; }, get input() { return input; }, get screen() { return screen; }, get save() { return save; }, get challenge() { return challenge; }, set introClock(value: number) { introClock = value; }, get renderer() { return renderer; }, action, transition, pause, set stallPause(value: boolean) { stallPause = value; } } });
}
