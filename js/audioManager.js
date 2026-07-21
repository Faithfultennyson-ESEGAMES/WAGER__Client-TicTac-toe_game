const MUTE_STORAGE_KEY = 'ttt.muted';

// All sound assets. Everything here is preloaded and decoded up front so a
// sound can never fail because it "wasn't downloaded yet" when it's needed.
const MANIFEST = {
  bgMusic: './assets/sounds/bg_music.mp3',
  xPlace: './assets/sounds/x_place.mp3',
  oPlace: './assets/sounds/o_place.mp3',
  timerWarning: './assets/sounds/timer_warning.mp3',
  gameWon: './assets/sounds/GameWon.mp3',
  gameLost: './assets/sounds/GameLost.mp3',
};

// Per-sound volumes so nothing drowns anything else. Applied as a gain node
// per playback, on top of the category gains.
const VOLUMES = {
  bgMusic: 0.18,
  xPlace: 0.9,
  oPlace: 0.9,
  gameWon: 0.9,
  gameLost: 0.9,
  timerWarning: 0.8,
};

const LOOPING = new Set(['bgMusic', 'timerWarning']);

// Gesture events that can unlock audio in an Android/iOS webview.
const UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown'];

/**
 * AudioManager — reliability-first audio for app/website webviews.
 *
 * Design goals (why users were missing sounds before):
 *  1. PRELOAD + DECODE EVERYTHING at page load into WebAudio buffers, so a
 *     sound is always in memory and ready — no network hiccup at play time.
 *  2. PLAY VIA WEBAUDIO buffers through one unlocked AudioContext. Once the
 *     context is unlocked by the first gesture, EVERY later sound plays —
 *     including ones triggered by network events (a move arriving over the
 *     socket), which is exactly what iOS/Android block for plain <audio>.
 *  3. PERSISTENT UNLOCK: keep listening across many gesture types until the
 *     context is actually running, and prime the <audio> fallbacks too.
 *  4. MUTE via a master gain node (instant, and music stays in sync) with a
 *     graceful <audio> fallback when WebAudio is unavailable.
 */
class AudioManager {
  constructor() {
    this.enabled = true;
    this.initialized = false;
    this.muted = this.loadMutedPreference();

    this.audioContext = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;

    this.buffers = {};   // name -> decoded AudioBuffer (primary path)
    this.elements = {};  // name -> HTMLAudioElement (fallback path)

    this.musicSource = null;
    this.musicElement = null;
    this.musicWanted = false;

    this.timerSource = null;
    this.timerElement = null;
    this.timerWarningActive = false;

    this.unlocked = false;
    this._unlockHandler = null;

    // Resolves once every asset has been fetched + (attempted) decoded.
    this.ready = Promise.resolve();
  }

  /* ------------------------------------------------------------------ prefs */

  loadMutedPreference() {
    try {
      return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  persistMutedPreference() {
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, this.muted ? '1' : '0');
    } catch (error) {
      // storage may be unavailable in some webviews; ignore
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  async init() {
    if (this.initialized || !this.enabled) {
      return this.ready;
    }
    this.initialized = true;

    // Build the WebAudio graph first (context may start suspended — fine;
    // decoding works while suspended, and the unlock listeners resume it).
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      try {
        this.audioContext = new Ctx();
        this.masterGain = this.audioContext.createGain();
        this.masterGain.gain.value = this.muted ? 0 : 1;
        this.masterGain.connect(this.audioContext.destination);

        this.musicGain = this.audioContext.createGain();
        this.musicGain.gain.value = VOLUMES.bgMusic; // music bus level
        this.musicGain.connect(this.masterGain);

        this.sfxGain = this.audioContext.createGain();
        this.sfxGain.gain.value = 1;
        this.sfxGain.connect(this.masterGain);
      } catch (error) {
        this.audioContext = null;
      }
    }

    this.setupUnlock();

    // Preload + decode every asset in parallel. Resolves even if some fail.
    this.ready = Promise.all(
      Object.entries(MANIFEST).map(([name, src]) => this.preload(name, src)),
    ).then(() => undefined);

    await this.ready;
    return this.ready;
  }

  async preload(name, src) {
    // 1) Always create an <audio> fallback element.
    try {
      const el = new Audio();
      el.preload = 'auto';
      el.src = src;
      if (LOOPING.has(name)) el.loop = true;
      if (typeof VOLUMES[name] === 'number') el.volume = VOLUMES[name];
      el.load();
      this.elements[name] = el;
      if (name === 'bgMusic') this.musicElement = el;
      if (name === 'timerWarning') this.timerElement = el;
    } catch (error) {
      // ignore — buffer path may still work
    }

    // 2) Fetch + decode into a WebAudio buffer (primary path). Audio assets
    //    are static, so we let them be cached for fast reloads. (Game DATA is
    //    fetched no-store elsewhere; that's a separate concern.)
    if (!this.audioContext) return;
    try {
      const response = await fetch(src, { cache: 'force-cache' });
      const arrayBuffer = await response.arrayBuffer();
      this.buffers[name] = await this.decodeAudio(arrayBuffer);
    } catch (error) {
      // Leave undefined; the <audio> element fallback covers this sound.
    }
  }

  // Promise + legacy-callback compatible decode (older Safari uses callbacks).
  decodeAudio(arrayBuffer) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (buf) => { if (!settled) { settled = true; resolve(buf); } };
      const fail = (err) => { if (!settled) { settled = true; reject(err); } };
      try {
        const maybePromise = this.audioContext.decodeAudioData(arrayBuffer, ok, fail);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(ok, fail);
        }
      } catch (error) {
        fail(error);
      }
    });
  }

  /* ------------------------------------------------------------------ unlock */

  // Keep trying to unlock on ANY gesture until the context is actually
  // running, then prime the <audio> fallbacks and detach.
  setupUnlock() {
    if (this._unlockHandler) return;

    this._unlockHandler = () => {
      this.resume();
      if (this.audioContext && this.audioContext.state === 'running') {
        this.finishUnlock();
      } else if (!this.audioContext) {
        // No WebAudio: a gesture is still our cue to prime <audio> playback.
        this.finishUnlock();
      }
      // Otherwise resume() is still pending — the statechange handler below
      // will finish the unlock the moment the context actually starts. This
      // avoids the race where the first gesture fires but state hasn't
      // flipped to 'running' yet (a cause of music not starting on mobile).
    };

    UNLOCK_EVENTS.forEach((evt) =>
      window.addEventListener(evt, this._unlockHandler, { passive: true }));

    if (this.audioContext) {
      this.audioContext.addEventListener('statechange', () => {
        if (this.audioContext.state === 'running') this.finishUnlock();
      });
    }
  }

  finishUnlock() {
    if (this.unlocked) return;
    this.unlocked = true;

    // Prime every <audio> fallback so later programmatic play() (e.g. a move
    // arriving over the socket) is allowed on iOS/Android.
    Object.entries(this.elements).forEach(([name, el]) => {
      if (name === 'bgMusic' || name === 'timerWarning') return; // handled on demand
      try {
        const prevMuted = el.muted;
        el.muted = true;
        const p = el.play();
        const restore = () => { try { el.pause(); el.currentTime = 0; el.muted = prevMuted; } catch (e) {} };
        if (p && typeof p.then === 'function') p.then(restore, () => { el.muted = prevMuted; });
        else restore();
      } catch (error) {
        // ignore
      }
    });

    // Start background music now that we're allowed to. This game always wants
    // it, so start unconditionally (startMusic is a no-op if already playing).
    this.startMusic();

    UNLOCK_EVENTS.forEach((evt) =>
      window.removeEventListener(evt, this._unlockHandler, { passive: true }));
    this._unlockHandler = null;
  }

  resume() {
    if (this.audioContext && this.audioContext.state !== 'running') {
      return this.audioContext.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  // Back-compat: callers still invoke this before playing.
  ensureContextReady() {
    return this.resume();
  }

  /* -------------------------------------------------------------------- mute */

  setMuted(muted) {
    this.muted = muted;
    this.persistMutedPreference();

    if (this.masterGain) {
      // Master-gain mute: instant, and background music keeps running in sync
      // so unmuting is seamless.
      this.masterGain.gain.value = muted ? 0 : 1;
      // Safety net: if music was wanted but its source was somehow lost, bring
      // it back on unmute so BG audio never silently dies.
      if (!muted && this.musicWanted && !this.musicSource) {
        this.startMusic();
      }
    }

    // <audio> fallback path: actually pause/resume streams.
    if (!this.audioContext) {
      Object.values(this.elements).forEach((el) => { el.muted = muted; });
      if (muted) {
        this.stopMusic();
        this.stopTimerWarning();
      } else if (this.musicWanted) {
        this.startMusic();
      }
    }

    return this.muted;
  }

  toggleMuted() {
    return this.setMuted(!this.muted);
  }

  isMuted() {
    return this.muted;
  }

  /* -------------------------------------------------------------- one-shots */

  play(name) {
    if (!this.enabled) return;
    // With master-gain mute the sound would be silent anyway, but skip the
    // work when muted.
    if (this.muted) return;

    // Primary: WebAudio buffer (reliable for network-triggered sounds).
    if (this.audioContext && this.buffers[name]) {
      this.resume();
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffers[name];
        const gain = this.audioContext.createGain();
        gain.gain.value = typeof VOLUMES[name] === 'number' ? VOLUMES[name] : 0.9;
        source.connect(gain);
        gain.connect(this.sfxGain);
        source.start(0);
        return;
      } catch (error) {
        // fall through to element fallback
      }
    }

    // Fallback: <audio> element (clone so overlapping plays don't cut off).
    const el = this.elements[name];
    if (!el) return;
    try {
      const node = el.cloneNode(true);
      node.volume = typeof VOLUMES[name] === 'number' ? VOLUMES[name] : 0.9;
      const p = node.play();
      if (p && p.catch) p.catch(() => {});
    } catch (error) {
      // ignore
    }
  }

  /* ------------------------------------------------------------------ music */

  startMusic() {
    this.musicWanted = true;
    if (this.muted && !this.audioContext) return; // fallback path stays silent

    // Primary: looping buffer source through the music gain.
    if (this.audioContext && this.buffers.bgMusic) {
      if (this.musicSource) return; // already playing
      this.resume();
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffers.bgMusic;
        source.loop = true;
        source.connect(this.musicGain);
        source.start(0);
        this.musicSource = source;
        return;
      } catch (error) {
        // fall through
      }
    }

    // Fallback: <audio> element.
    const el = this.musicElement;
    if (el) {
      el.loop = true;
      el.muted = this.muted;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  stopMusic() {
    if (this.musicSource) {
      try { this.musicSource.stop(0); } catch (e) {}
      try { this.musicSource.disconnect(); } catch (e) {}
      this.musicSource = null;
    }
    if (this.musicElement) {
      try { this.musicElement.pause(); } catch (e) {}
    }
  }

  /* ---------------------------------------------------------- timer warning */

  startTimerWarning() {
    if (this.muted || this.timerWarningActive) return;
    this.timerWarningActive = true;

    if (this.audioContext && this.buffers.timerWarning) {
      this.resume();
      try {
        const source = this.audioContext.createBufferSource();
        source.buffer = this.buffers.timerWarning;
        source.loop = true;
        const gain = this.audioContext.createGain();
        gain.gain.value = VOLUMES.timerWarning;
        source.connect(gain);
        gain.connect(this.sfxGain);
        source.start(0);
        this.timerSource = source;
        return;
      } catch (error) {
        // fall through
      }
    }

    const el = this.timerElement;
    if (el) {
      el.loop = true;
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    }
  }

  stopTimerWarning() {
    if (this.timerSource) {
      try { this.timerSource.stop(0); } catch (e) {}
      try { this.timerSource.disconnect(); } catch (e) {}
      this.timerSource = null;
    }
    if (this.timerElement) {
      try { this.timerElement.pause(); this.timerElement.currentTime = 0; } catch (e) {}
    }
    this.timerWarningActive = false;
  }

  /* -------------------------------------------------------------- ui click */

  // Synthesized click — zero asset, zero latency, routed through the sfx bus
  // so master mute applies.
  playClick() {
    if (this.muted || !this.audioContext) return;
    try {
      this.resume();
      const ctx = this.audioContext;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.05);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(gain);
      gain.connect(this.sfxGain || ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    } catch (error) {
      // ignore
    }
  }
}

const audioManager = new AudioManager();

export default audioManager;
