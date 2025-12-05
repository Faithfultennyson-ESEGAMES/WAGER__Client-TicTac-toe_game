import debug from './debug.js';
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
    this.playerSymbol = null;
    this.gameState = 'created'; // created | waiting | playing | ended
    this.turnTick = null;
    this.endScreenTimer = null;
    this.moveLock = false;
    this.handlersAttached = false;

    let socketUrl;
    try {
      socketUrl = new URL(this.params.join_url).origin;
    } catch (e) {
      socketUrl = null;
    }
    // Force https for the hosted server to avoid redirects/CORS issues.
    if (socketUrl && socketUrl.includes('tictac-toegame-server-production.up.railway.app')) {
      socketUrl = socketUrl.replace('http://', 'https://');
    }
    this.socketUrl = socketUrl;
    this.apiBase = this.socketUrl ? `${this.socketUrl}/api` : '';
    debug.log('[GameClient] Target server:', this.socketUrl);

    this.socketManager = new SocketManager({
      url: this.socketUrl,
      connectionCallbacks: {
        onStatusChange: (status) => this.handleConnectionStatus(status),
        onReconnectNeeded: () => this.attemptRejoin(),
      },
    });
  }

  async init() {
    await audioManager.init();
    this.bindUIEvents();

    if (!this.params.join_url || !this.params.sessionId || !this.localPlayer.id || !this.localPlayer.name) {
      debug.error('[GameClient] Invalid join parameters. All are required.', this.params);
      this.ui.showOverlay({
        title: 'Invalid Link',
        message: 'This game link is incomplete. Please ensure you have a valid join_url, player_id, and player_name.',
        showSpinner: false,
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
        session_id: this.params.sessionId,
        playerId: this.localPlayer.id,
        playerName: this.localPlayer.name,
      };

      debug.log('[GameClient] Emitting join event with payload:', joinPayload);
      this.socketManager.emit('join', joinPayload);

    } catch (error) {
      debug.error('[GameClient] Initialization failed:', error);
      const reason = error?.message || 'Unknown error';
      this.ui.showOverlay({
        title: 'Connection Failed',
        message: `Could not connect to the game server (${reason}). Please check the link and try again.`,
        showSpinner: false,
      });
    }
  }

  bindUIEvents() {
    this.ui.bindBoardHandlers((index) => this.handleCellSelection(index));
    document.getElementById('result-close-btn').addEventListener('click', () => this.ui.hideResult());
  }

  attachSocketHandlers() {
    if (this.handlersAttached) return;
    this.handlersAttached = true;
    debug.log('[GameClient] Attaching socket event handlers.');

    this.socketManager.on('game-found', (payload) => this.handleGameFound(payload));
    this.socketManager.on('turn-started', (payload) => this.handleTurnStarted(payload));
    this.socketManager.on('move-applied', (payload) => this.handleMoveApplied(payload));
    this.socketManager.on('move-error', (payload) => this.handleMoveError(payload));
    this.socketManager.on('game-ended', (payload) => this.handleGameEnded(payload));
    this.socketManager.on('player-disconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'disconnected'));
    this.socketManager.on('player-reconnected', (payload) => this.handlePlayerStatusUpdate(payload, 'reconnected'));
  }

  handleGameFound(session) {
    debug.log('[GameClient] Game found. Session state:', session);
    if (session.status === 'ended') {
      this.handleGameEnded({ session_id: session.session_id });
      return;
    }

    const normalizedPlayers = this.normalizePlayers(session.players);
    this.gameState = 'playing';
    this.session = {
      session_id: session.session_id || session.sessionId,
      players: normalizedPlayers,
      board: session.board || Array(9).fill(null),
      turn_duration_sec: session.turn_duration_sec,
      current_turn_player_id: session.current_turn_player_id || session.current_turn || null,
      status: 'active',
    };
    this.playerSymbol = this.resolvePlayerSymbol(this.session);
    this.persistSession();

    this.ui.hideOverlay();
    this.ui.markWinningCells([]);
    this.ui.updatePlayers(this.session.players);
    this.ui.setBoardState(this.session.board);
    const turnSymbol = this.getSymbolForPlayerId(this.session.current_turn_player_id);
    this.ui.setCurrentTurn(turnSymbol, { message: 'Game starting!' });

    if (session.turn_expires_at || session.expires_at) {
      this.startTurnTimer(session.turn_expires_at || session.expires_at);
    } else {
      this.ui.updateTimer('--');
    }
  }

  handleTurnStarted({ current_turn_player_id, expires_at }) {
    if (!this.session) return;
    debug.log(`[GameClient] Turn started for ${current_turn_player_id}`);
    this.session.current_turn_player_id = current_turn_player_id;
    this.session.turn_expires_at = expires_at;
    const symbol = this.getSymbolForPlayerId(current_turn_player_id);
    this.ui.setCurrentTurn(symbol, {});
    this.startTurnTimer(expires_at);
  }

  handleMoveApplied({ board, current_turn_player_id }) {
    if (!this.session) return;
    debug.log('[GameClient] Move applied. New board state:', board);
    this.session.board = board;
    this.session.current_turn_player_id = current_turn_player_id;
    this.moveLock = false;
    this.ui.setBoardState(board);
    const symbol = this.getSymbolForPlayerId(current_turn_player_id);
    this.ui.setCurrentTurn(symbol, {});
    this.stopTurnTimer();
    this.ui.updateTimer('--');
  }

  handleGameEnded({ session_id }) {
    if (this.gameState === 'ended') return;
    debug.log('[GameClient] Game ended notification received.');
    this.gameState = 'ended';
    this.moveLock = false;
    this.stopTurnTimer();
    this.ui.stopTimerWarning();

    // Per spec, client shows a neutral end screen, not win/loss.
    this.ui.showEndScreen();
    this.clearPersistedSession();

    // Start a simple timer on the end screen.
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
  }

  handlePlayerStatusUpdate({ player_id, playerId, status }, type) {
    if (!this.session) return;
    const targetId = player_id || playerId;
    debug.log(`[GameClient] Player ${targetId} is now ${type}`);

    const playerEntry = Object.entries(this.session.players).find(([, p]) => p.id === targetId);
    const player = playerEntry ? playerEntry[1] : null;
    if (player) {
      player.connected = (type === 'reconnected');
      this.ui.updatePlayers(this.session.players);
      this.ui.toast(`Player ${player.name} has ${type}.`);
    }
  }

  handleConnectionStatus(status) {
    debug.log(`[GameClient] Connection status changed to: ${status}`);
    this.ui.setConnectionStatus(status, status.charAt(0).toUpperCase() + status.slice(1));

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
    }
  }

  async attemptRejoin() {
    debug.log('[GameClient] Attempting to rejoin session.');
    const cached = this.restoreSession();
    if (!cached) {
        debug.warn('[GameClient] No session found in storage to rejoin.');
        this.ui.showOverlay({
            title: 'Cannot Rejoin',
            message: 'No previous session data found. Please use a valid game link to join.',
            showSpinner: false,
        });
        return;
    }

    this.ui.showOverlay({
      title: 'Rejoining Session',
      message: 'Attempting to reconnect to your previous game...',
      showSpinner: true,
    });

    // Reconnect socket before fetching state
    await this.socketManager.connect();

    // Now fetch the latest state from the server
    const state = await this.fetchSessionState(cached.sessionId);
    if (state && state.status !== 'ended') {
      this.handleGameFound(state);
      this.playerSymbol = this.resolvePlayerSymbol(state);
      this.persistSession(); // Re-persist with the latest data
      this.ui.toast('Successfully rejoined match.');
      debug.log('[GameClient] Rejoin successful.');
    } else {
      this.clearPersistedSession();
      this.ui.showOverlay({
        title: 'Session Unavailable',
        message: 'The previous session has ended or could not be found.',
        showSpinner: false,
      });
      debug.warn('[GameClient] Rejoin failed: Session ended or not found.');
    }
  }

  handleCellSelection(index) {
    if (this.gameState !== 'playing' || !this.session || this.moveLock) {
      return;
    }
    const currentTurnSymbol = this.getSymbolForPlayerId(this.session.current_turn_player_id);
    if (this.playerSymbol !== currentTurnSymbol) {
      this.ui.toast('Not your turn.');
      return;
    }
    if (this.session.board[index]) {
      this.ui.toast('Cell already taken.');
      return;
    }

    this.moveLock = true;
    const movePayload = {
      session_id: this.session.session_id,
      playerId: this.localPlayer.id,
      position: index,
    };
    debug.log('[GameClient] Emitting make-move event:', movePayload);

    this.socketManager.makeMove(movePayload).catch(err => {
      this.moveLock = false;
      debug.error('[GameClient] Failed to submit move:', err);
      this.ui.toast('Move submission failed.');
    });
  }

  handleMoveError(error = {}) {
    this.moveLock = false;
    const message = error?.message || 'Move was rejected.';
    debug.warn('[GameClient] Move rejected by server:', message);
    this.ui.toast(message);
  }

  resolvePlayerSymbol(session) {
    const players = Array.isArray(session.players) ? this.normalizePlayers(session.players) : session.players;
    if (players?.X?.id === this.localPlayer.id) return 'X';
    if (players?.O?.id === this.localPlayer.id) return 'O';
    return null;
  }

  describeMoveError(code) {
    const map = {
      invalid_payload: 'Invalid move data.',
      session_not_found: 'Session not found.',
      session_not_active: 'Session is not active.',
      not_player_turn: "It isn't your turn yet.",
      invalid_position: 'That cell is invalid.',
      cell_occupied: 'That cell is already taken.',
      player_not_in_session: 'You are not in this session.',
    };
    return map[code] || 'Move was rejected.';
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
    this.turnTick = setInterval(() => {
      const remaining = Math.max(0, expiry - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const display = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      this.ui.updateTimer(display, seconds <= 10 ? 'danger' : seconds <= 20 ? 'warning' : 'normal');
      if (remaining <= 0) this.stopTurnTimer();
    }, 500);
  }

  stopTurnTimer() {
    clearInterval(this.turnTick);
    this.turnTick = null;
  }

  persistSession() {
    if (!this.session || !this.localPlayer.id || !this.playerSymbol) return;
    const data = JSON.stringify({
      sessionId: this.session.session_id,
      playerId: this.localPlayer.id,
      symbol: this.playerSymbol,
    });
    sessionStorage.setItem(STORAGE_KEY, data);
    debug.log('[GameClient] Session persisted to storage.');
  }

  restoreSession() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      debug.log('[GameClient] Session restored from storage:', data);
      return data;
    } catch (error) {
      debug.warn('[GameClient] Failed to restore session:', error);
      return null;
    }
  }

  clearPersistedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
    debug.log('[GameClient] Cleared persisted session from storage.');
  }

  async fetchSessionState(sessionId) {
    if (!this.apiBase) return null;
    try {
      const response = await fetch(`${this.apiBase}/session/${sessionId}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      debug.error('[GameClient] Failed to fetch session state:', error);
      return null;
    }
  }
}

export default GameClient;
