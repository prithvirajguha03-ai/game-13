(() => {
  'use strict';

  const CONFIG = {
    START_DELAY_MS: 400,
    LIGHT_ON_MS: 400,
    GAP_MS: 200,
    NEXT_ROUND_DELAY_MS: 550,
    WRONG_FLASH_MS: 400,
    PRESS_MS: 140,
    BEST_KEY: 'simon-says.best-round.v1',
    MUTE_KEY: 'simon-says.muted.v1',
    TONES: [392, 494, 587, 659]
  };

  const STATE = Object.freeze({
    START: 'START',
    SHOWING_SEQUENCE: 'SHOWING_SEQUENCE',
    PLAYER_TURN: 'PLAYER_TURN',
    GAME_OVER: 'GAME_OVER'
  });

  const BADGE = {
    [STATE.START]: { icon: '\u25CF', text: 'READY' },
    [STATE.SHOWING_SEQUENCE]: { icon: '\uD83D\uDC40', text: 'WATCH' },
    [STATE.PLAYER_TURN]: { icon: '\uD83D\uDC46', text: 'YOUR TURN' },
    [STATE.GAME_OVER]: { icon: '\u25A0', text: 'GAME OVER' }
  };

  const STATUS = {
    start: { tone: 'start', icon: '\uD83D\uDC40', text: 'Press Start Game to begin.' },
    watch: { tone: 'watch', icon: '\uD83D\uDC40', text: 'Watch the lights carefully...' },
    watchAgain: { tone: 'watch', icon: '\uD83D\uDC40', text: 'Watch the new pattern...' },
    turn: { tone: 'turn', icon: '\uD83D\uDC46', text: 'Your turn \u2014 repeat the pattern.' },
    good: { tone: 'good', icon: '\u2728', text: 'Great! Next pattern...' },
    over: { tone: 'over', icon: '\uD83C\uDF1F', text: 'Almost! Let\u2019s try again.' }
  };

  const KEY_MAP = {
    ArrowUp: 0,
    ArrowRight: 1,
    ArrowLeft: 2,
    ArrowDown: 3,
    Digit1: 0,
    Digit2: 1,
    Digit3: 2,
    Digit4: 3,
    Numpad1: 0,
    Numpad2: 1,
    Numpad3: 2,
    Numpad4: 3
  };

  const BLOCKED_KEYS = new Set([
    'ArrowUp',
    'ArrowRight',
    'ArrowLeft',
    'ArrowDown',
    'Space',
    'PageUp',
    'PageDown',
    'Home',
    'End'
  ]);

  const $ = (id) => document.getElementById(id);

  const el = {
    badgeIcon: $('stateBadgeIcon'),
    badgeText: $('stateBadgeText'),
    statRound: $('statRound'),
    statLength: $('statLength'),
    statBest: $('statBest'),
    status: $('status'),
    statusIcon: $('statusIcon'),
    statusText: $('statusText'),
    progress: $('progressValue'),
    announcer: $('announcer'),
    overlayStart: $('overlayStart'),
    overlayOver: $('overlayOver'),
    startBest: $('startBest'),
    overMessage: $('overMessage'),
    overReached: $('overReached'),
    overBest: $('overBest'),
    newBest: $('newBestBadge')
  };

  const btn = {
    start: $('btnStart'),
    playAgain: $('btnPlayAgain'),
    mute: $('btnMute'),
    muteIcon: $('btnMuteIcon'),
    muteText: $('btnMuteText')
  };

  const lights = Array.from(document.querySelectorAll('.light-btn'));

  /* ---------------- sound (built-in Web Audio, no libraries) ---------------- */

  const Sound = (() => {
    let ctx = null;
    let muted = readFlag(CONFIG.MUTE_KEY, false);

    function readFlag(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : raw === 'true';
      } catch {
        return fallback;
      }
    }

    function unlock() {
      if (muted) return;
      try {
        if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
      } catch {
        ctx = null;
      }
    }

    function tone(freq, endFreq, duration, type, peak) {
      if (muted || !ctx) return;
      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (endFreq !== freq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    function play(name, index) {
      if (muted || !ctx) return;
      switch (name) {
        case 'tone':
          tone(CONFIG.TONES[index] || 440, CONFIG.TONES[index] || 440, 0.34, 'sine', 0.2);
          break;
        case 'ok':
          tone(659, 988, 0.16, 'triangle', 0.16);
          break;
        case 'start':
          tone(523, 523, 0.1, 'triangle', 0.16);
          window.setTimeout(() => tone(784, 784, 0.12, 'triangle', 0.16), 90);
          break;
        case 'over':
          tone(392, 165, 0.5, 'sawtooth', 0.12);
          break;
        default:
          break;
      }
    }

    function toggle() {
      muted = !muted;
      try {
        localStorage.setItem(CONFIG.MUTE_KEY, String(muted));
      } catch {
        /* storage unavailable */
      }
      if (!muted) unlock();
      return muted;
    }

    return { unlock, play, toggle, get muted() { return muted; } };
  })();

  /* ---------------- game state ---------------- */

  const game = {
    state: STATE.START,
    sequence: [],
    inputIndex: 0,
    best: 0,
    newBestThisRun: false,
    locked: false,
    resumeShow: false,
    playToken: 0,
    playTimer: 0,
    timers: new Set()
  };

  function later(fn, ms) {
    const id = window.setTimeout(() => {
      game.timers.delete(id);
      fn();
    }, ms);
    game.timers.add(id);
    return id;
  }

  function clearTimers() {
    game.timers.forEach((id) => window.clearTimeout(id));
    game.timers.clear();
    window.clearTimeout(game.playTimer);
    game.playTimer = 0;
  }

  function readBest() {
    try {
      const value = Number.parseInt(localStorage.getItem(CONFIG.BEST_KEY), 10);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  function writeBest(value) {
    try {
      localStorage.setItem(CONFIG.BEST_KEY, String(value));
    } catch {
      /* storage unavailable */
    }
  }

  /* ---------------- view helpers ---------------- */

  function setStatus(key) {
    const s = STATUS[key] || STATUS.start;
    el.statusIcon.textContent = s.icon;
    el.statusText.textContent = s.text;
    el.status.dataset.tone = s.tone;
  }

  function updateHud() {
    el.statRound.textContent = String(game.sequence.length);
    el.statLength.textContent = String(game.sequence.length);
    el.statBest.textContent = String(game.best);
    el.progress.textContent = `${game.inputIndex} / ${game.sequence.length}`;
  }

  function clearLightStates() {
    lights.forEach((node) => node.classList.remove('is-lit', 'is-press', 'is-wrong'));
  }

  function setState(next) {
    game.state = next;
    const badge = BADGE[next];
    el.badgeIcon.textContent = badge.icon;
    el.badgeText.textContent = badge.text;
    el.overlayStart.hidden = next !== STATE.START;
    el.overlayOver.hidden = next !== STATE.GAME_OVER;

    if (next === STATE.START) btn.start.focus();
    if (next === STATE.GAME_OVER) btn.playAgain.focus();
  }

  function announce(message) {
    el.announcer.textContent = message;
  }

  /* ---------------- sequence playback ---------------- */

  function flashLight(index) {
    const node = lights[index];
    node.classList.add('is-lit');
    Sound.play('tone', index);
    later(() => node.classList.remove('is-lit'), CONFIG.LIGHT_ON_MS);
  }

  function stopPlayback() {
    game.playToken += 1;
    window.clearTimeout(game.playTimer);
    game.playTimer = 0;
    lights.forEach((node) => node.classList.remove('is-lit'));
  }

  function showSequence(isNewRound) {
    clearTimers();
    stopPlayback();
    game.locked = true;
    game.inputIndex = 0;
    updateHud();
    setState(STATE.SHOWING_SEQUENCE);
    setStatus(isNewRound ? STATUS.watch : STATUS.watchAgain);

    const token = game.playToken;
    let i = 0;

    const step = () => {
      if (token !== game.playToken || game.state !== STATE.SHOWING_SEQUENCE) return;

      if (i >= game.sequence.length) {
        game.playTimer = window.setTimeout(beginPlayerTurn, CONFIG.GAP_MS);
        return;
      }

      flashLight(game.sequence[i]);
      i += 1;
      game.playTimer = window.setTimeout(step, CONFIG.LIGHT_ON_MS + CONFIG.GAP_MS);
    };

    game.playTimer = window.setTimeout(step, CONFIG.START_DELAY_MS);
  }

  function beginPlayerTurn() {
    if (game.state !== STATE.SHOWING_SEQUENCE) return;
    game.locked = false;
    game.inputIndex = 0;
    setState(STATE.PLAYER_TURN);
    setStatus(STATUS.turn);
    updateHud();
    announce('Your turn. Repeat the pattern.');
  }

  /* ---------------- rounds ---------------- */

  function extendSequence() {
    game.sequence.push(Math.floor(Math.random() * 4));
  }

  function startRound(isNewRound) {
    showSequence(isNewRound);
  }

  function roundComplete() {
    game.locked = true;
    stopPlayback();
    const completed = game.sequence.length;
    const isBest = completed > game.best;
    if (isBest) {
      game.best = completed;
      game.newBestThisRun = true;
      writeBest(completed);
    }
    setStatus(STATUS.good);
    Sound.play('ok');
    updateHud();
    announce(`Correct! Round ${completed} complete.`);

    later(() => {
      extendSequence();
      updateHud();
      startRound(false);
    }, CONFIG.NEXT_ROUND_DELAY_MS);
  }

  function wrongInput(index) {
    game.locked = true;
    stopPlayback();
    clearTimers();
    clearLightStates();
    const node = lights[index];
    node.classList.add('is-wrong');
    setStatus(STATUS.over);
    Sound.play('over');

    const reached = game.sequence.length;
    announce(`A different light was pressed. You reached round ${reached}. Best round ${game.best}.`);

    later(() => {
      node.classList.remove('is-wrong');
      showGameOver(reached);
    }, CONFIG.WRONG_FLASH_MS);
  }

  function showGameOver(reached) {
    el.overReached.textContent = String(reached);
    el.overBest.textContent = String(game.best);
    el.overMessage.textContent = `Nice try \u2014 you reached Round ${reached}. Let\u2019s see how far you can go next time.`;
    el.newBest.hidden = !game.newBestThisRun;
    setState(STATE.GAME_OVER);
  }

  /* ---------------- player input ---------------- */

  function pressFeedback(index) {
    const node = lights[index];
    node.classList.remove('is-press');
    void node.offsetWidth;
    node.classList.add('is-press');
    later(() => node.classList.remove('is-press'), CONFIG.PRESS_MS);
  }

  function handleLight(index) {
    if (game.state !== STATE.PLAYER_TURN || game.locked) return;
    if (index < 0 || index >= lights.length) return;

    Sound.unlock();
    pressFeedback(index);
    Sound.play('tone', index);

    const expected = game.sequence[game.inputIndex];
    if (index === expected) {
      game.inputIndex += 1;
      updateHud();
      if (game.inputIndex === game.sequence.length) {
        roundComplete();
      }
      return;
    }

    wrongInput(index);
  }

  /* ---------------- lifecycle ---------------- */

  function resetRun() {
    clearTimers();
    stopPlayback();
    clearLightStates();
    game.sequence = [];
    game.inputIndex = 0;
    game.locked = false;
    game.newBestThisRun = false;
    game.resumeShow = false;
    updateHud();
  }

  function startGame() {
    Sound.unlock();
    resetRun();
    extendSequence();
    updateHud();
    Sound.play('start');
    announce('Watch the lights, then repeat the pattern.');
    startRound(true);
  }

  /* ---------------- input binding ---------------- */

  function onKeyDown(event) {
    if (event.repeat) return;
    const code = event.code;
    const index = KEY_MAP[code];
    const onControl =
      event.target instanceof Element && event.target.closest('button, a[href], input, select, textarea');

    const isArrow = code.startsWith('Arrow');
    if (isArrow || (BLOCKED_KEYS.has(code) && !onControl)) event.preventDefault();

    if (index === undefined) return;

    // Let native activation handle Space/Enter on a focused button.
    if (onControl && (code === 'Space' || code === 'Enter')) return;

    handleLight(index);
  }

  function bindInput() {
    window.addEventListener('keydown', onKeyDown);

    lights.forEach((node) => {
      node.addEventListener('click', () => {
        handleLight(Number(node.dataset.index));
      });
    });

    btn.start.addEventListener('click', startGame);
    btn.playAgain.addEventListener('click', startGame);

    btn.mute.addEventListener('click', () => {
      const muted = Sound.toggle();
      btn.muteIcon.textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
      btn.muteText.textContent = muted ? 'Muted' : 'Sound';
      btn.mute.setAttribute('aria-pressed', String(muted));
      btn.mute.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
      if (!muted) Sound.play('ok');
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (game.state === STATE.SHOWING_SEQUENCE) {
          game.resumeShow = true;
          stopPlayback();
        }
      } else if (game.resumeShow) {
        game.resumeShow = false;
        if (game.state === STATE.SHOWING_SEQUENCE) {
          setStatus(STATUS.watchAgain);
          showSequence(false);
        }
      }
    });
  }

  /* ---------------- boot ---------------- */

  function init() {
    game.best = readBest();
    el.startBest.textContent = String(game.best);
    btn.muteIcon.textContent = Sound.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
    btn.muteText.textContent = Sound.muted ? 'Muted' : 'Sound';
    btn.mute.setAttribute('aria-pressed', String(Sound.muted));
    btn.mute.setAttribute('aria-label', Sound.muted ? 'Unmute sound' : 'Mute sound');

    bindInput();
    resetRun();
    setStatus(STATUS.start);
    setState(STATE.START);
    updateHud();
    announce('Simon Says. Watch the pattern of lights, then repeat it back in the same order.');
  }

  init();
})();
