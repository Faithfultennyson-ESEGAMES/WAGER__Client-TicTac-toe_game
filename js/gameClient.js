
import audioManager from "./audioManager.js";
import UIManager from "./uiManager.js";
import SocketManager from "./socketManager.js";
import { parseQueryParams, buildRejoinPayload } from "./urlParser.js";

const STORAGE_KEY = 'ttt.session';

class GameClient {
  constructor() {
    this.ui = new UIManager();
    this.params = parseQueryParams();
    this.localPlayer = {
      id: this.params.playerId,
      name: this.params.playerName,
    };

    this.session = null;
    this.turnDurationSec = null;
    this.playerSymbol = null;
    this.gameState = 'created'; // created | waiting | playing | ended
    this.turnTick = null;
    this.endScreenTimer = null;
    this.moveLock = false;
    this.handlersAttached = false;
    this.placedSymbols = 0;
    this.selectedSymbolIndex = null; // The index of the piece to be moved

    let socketUrl;
    try {
      const origin = new URL(this.params.joinUrl).origin;
      socketUrl = origin.replace(/^http/, 'ws');
    } catch (e) {
      socketUrl = null;
    }
    this.socketUrl = socketUrl;
    this.apiBase = this.socketUrl ? `${this.socketUrl}/api` : '';

    this.socketManager = new SocketManager({
      url: this.socketUrl,
      connectionCallbacks: {
        onStatusChange: (status, meta) => this.handleConnectionStatus(status, meta),
        onReconnectNeeded: () => this.attemptRejoin(),
      },
    });
  }

  async init() {
    await audioManager.init();
    this.bindUIEvents();

    if (!this.params.joinUrl || !this.params.sessionId || !this.localPlayer.id || !this.localPlayer.name) {
      this.ui.showOverlay({
        title: 'Invalid Link',
        message: 'This game link is incomplete. Please ensure you have a valid joinUrl, playerId, and playerName.',
        showSpinner: false,
      });
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: this.params.sessionId || null,
        reason: 'invalid_link',
      });
      return;
    }

    this.ui.showOverlay({
      title: 'Connecting to Server',
      message: 'Preparing your game...',
      showSpinner: true,
    });

    try {
      await this.socketManager.connect();
      this.attachSocketHandlers();

      this.gameState = 'waiting';
      this.ui.showOverlay({
        title: 'Joining Game Session',
        message: 'Waiting for the other player to join.',
        showSpinner: true,
      });

      const joinPayload = {
        sessionId: this.params.sessionId,
        playerId: this.localPlayer.id,
        playerName: this.localPlayer.name,
      };

      this.socketManager.emit('join', joinPayload);

    } catch (error) {
      const reason = error?.message || 'Unknown error';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Could not connect to the game server (${reason}). Please check the link and try again.`,
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', { reason, source: 'init' });
    }
  }

  bindUIEvents() {
    this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));
    this.ui.setupMuteButton();
    document.getElementById('result-close-btn').addEventListener('click', () => this.ui.hideResult());

    // Immediate, low-latency click feedback on any interactive control.
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.board-cell, .control-btn, .mute-btn')) {
        this.ui.playClick();
      }
    });

    // First user gesture: unlock audio and start background music (autoplay
    // policies in webviews require a gesture before playback).
    ['pointerdown','click','touchstart','keydown'].forEach(evt => {
      window.addEventListener(evt, () => {
        audioManager.ensureContextReady()?.catch?.(() => {});
        this.ui.startMusic();
      }, { once: true });
    });
  }

  attachSocketHandlers() {
    if (this.handlersAttached) return;
    this.handlersAttached = true;

    this.socketManager.on('join-error', (payload) => this.handleJoinError(payload));
    this.socketManager.on('game-found', (payload) => this.handleGameFound(payload));
    this.socketManager.on('turn-started', (payload) => this.handleTurnStarted(payload));
    this.socketManager.on('move-applied', (payload) => this.handleMoveApplied(payload));
    this.socketManager.on('move-error', (payload) => this.handleMoveError(payload));
    this.socketManager.on('game-ended', (payload) => this.handleGameEnded(payload));
    this.socketManager.on('player-disconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'disconnected'));
    this.socketManager.on('player-reconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'reconnected'));
  }

  handleJoinError(payload) {
    this.ui.showOverlay({
        title: "Could Not Join",
        message: payload.message || "An unknown error occurred.",
        showSpinner: false,
    });
    this.broadcastEvent('INVALID_SESSION', {
      sessionId: this.params.sessionId || null,
      reason: payload?.message || 'join_error',
    });
  }

  handleGameFound(session) {
    if (session.status === 'ended') {
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: session.sessionId || this.params.sessionId || null,
        reason: 'session_ended',
      });
      this.handleGameEnded({ sessionId: session.sessionId });
      return;
    }

    const normalizedPlayers = this.normalizePlayers(session.players);
    this.gameState = 'playing';
    this.session = {
      sessionId: session.sessionId,
      players: normalizedPlayers,
      board: session.board || Array(9).fill(null),
      turnDurationSec: session.turnDurationSec,
      currentTurnPlayerId: session.currentTurnPlayerId || null,
      status: 'active',
    };
    this.turnDurationSec = session.turnDurationSec || null;
    this.playerSymbol = this.resolvePlayerSymbol(this.session);
    this.placedSymbols = this.session.board.filter(s => s === this.playerSymbol).length;
    this.persistSession();

    this.ui.hideOverlay();
    this.ui.markWinningCells([]);
    this.ui.updatePlayers(this.session.players);
    this.ui.setBoardState(this.session.board);
    const turnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
    this.ui.setCurrentTurn(turnSymbol, { message: 'Game starting!' });

    if (session.expiresAt) {
      this.startTurnTimer(session.expiresAt);
    } else {
      this.ui.updateTimer('--');
    }
  }

  handleTurnStarted({ currentTurnPlayerId, expiresAt }) {
    if (!this.session) return;
    this.session.currentTurnPlayerId = currentTurnPlayerId;
    this.session.expiresAt = expiresAt;
    const symbol = this.getSymbolForPlayerId(currentTurnPlayerId);
    this.ui.setCurrentTurn(symbol, {});
    this.startTurnTimer(expiresAt);
  }

  handleMoveApplied({ board, currentTurnPlayerId }) {
    if (!this.session) return;
    const previousBoard = Array.isArray(this.session.board) ? [...this.session.board] : Array(9).fill(null);
    this.session.board = board;
    this.session.currentTurnPlayerId = currentTurnPlayerId;
    this.moveLock = false;
    this.placedSymbols = this.session.board.filter(s => s === this.playerSymbol).length;
    this.selectedSymbolIndex = null; // Reset selection
    this.ui.setSelectedSymbol(null);

    const placedIndex = board.findIndex((cell, idx) => cell && cell !== previousBoard[idx]);
    if (placedIndex >= 0) {
      this.ui.onMovePlaced(board[placedIndex]);
    }
    this.ui.setBoardState(board);
    const symbol = this.getSymbolForPlayerId(currentTurnPlayerId);
    this.ui.setCurrentTurn(symbol, {});
    this.stopTurnTimer();
    this.ui.updateTimer('--');
  }

  handleGameEnded({ sessionId } = {}) {
    if (this.gameState === 'ended') return;
    this.gameState = 'ended';
    this.moveLock = false;
    this.stopTurnTimer();
    this.ui.stopTimerWarning();

    this.clearPersistedSession();
    this.ui.hideOverlay();
    clearInterval(this.endScreenTimer);
    this.endScreenTimer = null;

    setTimeout(() => {
      this.ui.showEndScreen();
      let seconds = 0;
      this.ui.updateEndScreenTimer(seconds);
      this.endScreenTimer = setInterval(() => {
        seconds++;
        this.ui.updateEndScreenTimer(seconds);
        if (seconds >= 60) {
          clearInterval(this.endScreenTimer);
          this.ui.updateEndScreenMessage("Session window expired");
        }
      }, 1000);
    }, 3000);
  }

  handlePlayerStatusUpdate({ playerId, status }, type) {
    if (!this.session) return;
    const targetId = playerId;

    const playerEntry = Object.entries(this.session.players).find(([, p]) => p.id === targetId);
    const player = playerEntry ? playerEntry[1] : null;
    if (player) {
      player.connected = (type === 'reconnected');
      this.ui.updatePlayers(this.session.players);
      this.ui.toast(`Player ${player.name} has ${type}.`);
    }
  }

  handleConnectionStatus(status, meta = {}) {
    this.ui.setConnectionStatus(status, status.charAt(0).toUpperCase() + status.slice(1));

    if (this.gameState === 'ended') {
      return;
    }

    if (status === 'connected') {
      if (this.gameState === 'waiting') {
         this.ui.showOverlay({
            title: 'Joining Game Session',
            message: 'Waiting for the other player to join.',
            showSpinner: true,
         });
      } else {
        this.ui.hideOverlay();
      }
    } else if (status === 'disconnected' || status === 'reconnecting') {
      this.ui.showOverlay({
        title: 'Connection Lost',
        message: 'Attempting to restore connection...',
        showSpinner: true,
      });
    } else if (status === 'error' && meta?.error === 'reconnect_failed') {
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: 'Could not reconnect to the game server. Please try again.',
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', {
        reason: 'reconnect_failed',
        source: 'rejoin',
      });
    }
  }

  async attemptRejoin() {
    const cached = this.restoreSession();
    if (!cached) {
        this.ui.showOverlay({
            title: 'Cannot Rejoin',
            message: 'No previous session data found. Please use a valid game link to join.',
            showSpinner: false,
        });
        this.broadcastEvent('INVALID_SESSION', {
          sessionId: null,
          reason: 'missing_session',
        });
        return;
    }

    this.ui.showOverlay({
      title: 'Rejoining Session',
      message: 'Attempting to reconnect to your previous game...',
      showSpinner: true,
    });

    try {
      await this.socketManager.connect();
    } catch (error) {
      const reason = error?.message || 'Connection failed';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Could not reconnect to the game server (${reason}). Please check the link and try again.`,
        showSpinner: false,
      });
      this.broadcastEvent('CONNECTION_FAILED', { reason, source: 'rejoin' });
      return;
    }

    const state = await this.fetchSessionState(cached.sessionId);
    if (state && state.status !== 'ended') {
      this.handleGameFound(state);
      this.playerSymbol = this.resolvePlayerSymbol(state);
      this.persistSession();
      this.ui.toast('Successfully rejoined match.');
    } else {
      this.clearPersistedSession();
      this.ui.showOverlay({
        title: 'Session Unavailable',
        message: 'The previous session has ended or could not be found.',
        showSpinner: false,
      });
      this.broadcastEvent('INVALID_SESSION', {
        sessionId: cached.sessionId || null,
        reason: 'session_unavailable',
      });
    }
  }

  handleCellSelection(index) {
    if (this.gameState !== 'playing' || !this.session || this.moveLock) {
      return;
    }
    audioManager.ensureContextReady()?.catch?.(() => {});
    const currentTurnSymbol = this.getSymbolForPlayerId(this.session.currentTurnPlayerId);
    if (this.playerSymbol !== currentTurnSymbol) {
      this.ui.toast('Not your turn.');
      return;
    }

    // Stage 1: Placing the first 3 symbols
    if (this.placedSymbols < 3) {
        if (this.session.board[index]) {
            this.ui.toast('Cell already taken.');
            return;
        }

        this.moveLock = true;
        const movePayload = {
            sessionId: this.session.sessionId,
            playerId: this.localPlayer.id,
            position: index,
        };

        this.socketManager.emit('make-move', movePayload).catch(err => {
            this.moveLock = false;
            this.ui.toast('Move submission failed.');
        });
    } else {
      // Stage 2: Relocating symbols
        if (this.selectedSymbolIndex === null) {
            // Step 1: Select a piece to move
            if (this.session.board[index] !== this.playerSymbol) {
                this.ui.toast('Select one of your symbols to move.');
                return;
            }
            this.selectedSymbolIndex = index;
            this.ui.setSelectedSymbol(index);
            this.ui.toast('Select an empty cell to move to.');
        } else {
            // Step 2: Select an empty destination cell
            if (this.session.board[index] !== null) {
                 if (index === this.selectedSymbolIndex) { // Allow deselecting
                    this.selectedSymbolIndex = null;
                    this.ui.setSelectedSymbol(null);
                    return;
                }
                this.ui.toast('Destination cell must be empty.');
                return;
            }

            this.moveLock = true;
            const relocatePayload = {
                sessionId: this.session.sessionId,
                playerId: this.localPlayer.id,
                from: this.selectedSymbolIndex,
                to: index,
            };

            this.socketManager.emit('relocate-move', relocatePayload).catch(err => {
                this.moveLock = false;
                this.ui.toast('Relocation failed.');
            });
        }
    }
  }

  handleMoveError(error = {}) {
    this.moveLock = false;
    const message = error?.message || 'Move was rejected.';
    this.ui.toast(message);
    // If the error was due to a bad selection, reset the UI state
    if (this.selectedSymbolIndex !== null) {
        this.selectedSymbolIndex = null;
        this.ui.setSelectedSymbol(null);
    }
  }

  resolvePlayerSymbol(session) {
    const players = Array.isArray(session.players) ? this.normalizePlayers(session.players) : session.players;
    if (players?.X?.id === this.localPlayer.id) return 'X';
    if (players?.O?.id === this.localPlayer.id) return 'O';
    return null;
  }

  normalizePlayers(players = []) {
    const normalized = { X: {}, O: {} };
    players.forEach((player) => {
      if (!player || !player.symbol) return;
      normalized[player.symbol] = {
        id: player.playerId,
        name: player.playerName,
        symbol: player.symbol,
        connected: true,
      };
    });
    return normalized;
  }

  getSymbolForPlayerId(playerId) {
    if (!playerId || !this.session?.players) return null;
    const entry = Object.entries(this.session.players).find(([, p]) => p.id === playerId);
    return entry ? entry[0] : null;
  }

  startTurnTimer(turnExpiresAt) {
    this.stopTurnTimer();
    if (!turnExpiresAt) {
      this.ui.updateTimer('--');
      return;
    }
    const expiry = new Date(turnExpiresAt).getTime();
    const totalDurationSec = this.computeTurnDurationSec(expiry);
    const cautionThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.5));
    const warnThresholdSec = Math.max(1, Math.ceil(totalDurationSec * 0.3));

    this.turnTick = setInterval(() => {
      const remaining = Math.max(0, expiry - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const display = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      let state = 'normal';
      if (seconds <= warnThresholdSec) {
        state = 'danger';
        this.ui.startTimerWarning();
      } else if (seconds <= cautionThresholdSec) {
        state = 'warning';
        this.ui.stopTimerWarning();
      } else {
        this.ui.stopTimerWarning();
      }
      this.ui.updateTimer(display, state);
      if (remaining <= 0) {
        this.ui.stopTimerWarning();
        this.stopTurnTimer();
      }
    }, 500);
  }

  computeTurnDurationSec(expiryMs) {
    if (this.turnDurationSec) return this.turnDurationSec;
    const guess = Math.ceil((expiryMs - Date.now()) / 1000);
    return Math.max(guess, 1);
  }

  stopTurnTimer() {
    clearInterval(this.turnTick);
    this.turnTick = null;
  }

  persistSession() {
    if (!this.session || !this.localPlayer.id || !this.playerSymbol) return;
    const data = JSON.stringify({
      sessionId: this.session.sessionId,
      playerId: this.localPlayer.id,
      symbol: this.playerSymbol,
    });
    sessionStorage.setItem(STORAGE_KEY, data);
  }

  restoreSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data;
    } catch (error) {
      return null;
    }
  }

  clearPersistedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  async fetchSessionState(sessionId) {
    if (!this.apiBase) return null;
    try {
      // no-store: session state must always be fresh inside app/website webviews.
      const response = await fetch(`${this.apiBase}/session/${sessionId}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  broadcastEvent(type, payload) {
    if (typeof window.broadcastEvent === 'function') {
      window.broadcastEvent(type, payload);
    }
  }
}

export default GameClient;
