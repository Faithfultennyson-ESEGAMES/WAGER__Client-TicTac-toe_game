import audioManager from "./audioManager.js";

class UIManager {
  constructor() {
    this.boardEl = document.getElementById('game-board');
    this.cells = Array.from(this.boardEl.querySelectorAll('.board-cell'));
    this.playerCards = {
      X: document.getElementById('player-x'),
      O: document.getElementById('player-o'),
    };
    this.playerNames = {
      X: document.getElementById('player-x-name'),
      O: document.getElementById('player-o-name'),
    };
    this.playerStakes = {
      X: document.getElementById('player-x-stake'),
      O: document.getElementById('player-o-stake'),
    };
    this.turnTextEl = document.getElementById('turn-text');
    this.timerEl = document.getElementById('turn-timer');
    this.statusIndicator = document.getElementById('status-indicator');
    this.statusText = document.getElementById('status-text');
    this.overlay = document.getElementById('overlay');
    this.overlayTitle = document.getElementById('overlay-title');
    this.overlayMessage = document.getElementById('overlay-message');
    this.overlayAction = document.getElementById('overlay-action');
    this.overlaySpinner = document.getElementById('overlay-spinner');
    this.resultModal = document.getElementById('result-modal');
    this.resultTitle = document.getElementById('result-title');
    this.resultSummary = document.getElementById('result-summary');
    this.toastEl = null;
    this.lastMoveSoundAt = 0;
  }

  bindBoardHandlers(handler) {
    this.cells.forEach((cell) => {
      cell.addEventListener('click', () => {
        handler(Number(cell.dataset.index));
      });
    });
  }

  setBoardState(board) {
    board.forEach((value, index) => {
      const cell = this.cells[index];
      if (!cell) return;
      if (!value) {
        cell.textContent = '';
        cell.dataset.symbol = '';
        cell.classList.remove('winning');
        return;
      }
      cell.textContent = value;
      cell.dataset.symbol = value;
    });
  }

  setSelectedSymbol(index) {
    this.cells.forEach((cell, i) => {
        cell.classList.toggle('selected', i === index);
    });
  }

  markWinningCells(cells = []) {
    this.cells.forEach((cell, index) => {
      if (cells.includes(index)) {
        cell.classList.add('winning');
      } else {
        cell.classList.remove('winning');
      }
    });
  }

  formatPlayerName(name) {
    if (name === null || name === undefined) {
      return 'Waiting...';
    }
    const text = String(name).trim();
    if (!text) {
      return 'Waiting...';
    }
    if (text.length <= 12) {
      return text;
    }
    return `${text.slice(0, 10)}..`;
  }

  updatePlayers(players = {}) {
    ['X', 'O'].forEach((symbol) => {
      const card = this.playerCards[symbol];
      const info = players[symbol] || {};
      this.playerNames[symbol].textContent = this.formatPlayerName(info.name);
      this.playerStakes[symbol].textContent = info.stake ? `${info.stake} credits` : '';
      card.classList.toggle('disconnected', info.connected === false);
    });
  }

  setCurrentTurn(symbol, options = {}) {
    this.turnTextEl.textContent = symbol ? `${symbol} turn` : options.message || 'Waiting for players...';
    this.playerCards.X.classList.toggle('active', symbol === 'X');
    this.playerCards.O.classList.toggle('active', symbol === 'O');
  }

  updateTimer(label, state = 'normal') {
    this.timerEl.textContent = label;
    this.timerEl.classList.remove('warning', 'danger');
    if (state === 'warning') {
      this.timerEl.classList.add('warning');
    }
    if (state === 'danger') {
      this.timerEl.classList.add('danger');
    }
  }

  setConnectionStatus(status, message) {
    this.statusIndicator.classList.remove('connected', 'connecting', 'disconnected');
    this.statusIndicator.classList.add(status);
    if (message) {
      this.statusText.textContent = message;
    }
  }

  showOverlay({ title, message, actionLabel, actionHandler, showSpinner = true }) {
    this.overlay.classList.remove('banner');
    this.overlay.classList.remove('hidden');
    this.overlayTitle.textContent = title;
    this.overlayMessage.textContent = message;
    this.overlaySpinner.classList.toggle('hidden', !showSpinner);
    if (actionLabel && actionHandler) {
      this.overlayAction.textContent = actionLabel;
      this.overlayAction.onclick = actionHandler;
      this.overlayAction.classList.remove('hidden');
    } else {
      this.overlayAction.classList.add('hidden');
      this.overlayAction.onclick = null;
    }
  }

  hideOverlay() {
    this.overlay.classList.add('hidden');
    this.overlay.classList.remove('banner');
  }

  showResult({ title, summary }) {
    this.resultTitle.textContent = title;
    this.resultSummary.textContent = summary;
    this.resultModal.classList.remove('hidden');
  }

  hideResult() {
    this.resultModal.classList.add('hidden');
  }

  toast(message, duration = 2500) {
    if (!this.toastEl) {
      this.toastEl = document.createElement('div');
      this.toastEl.className = 'toast';
      document.body.appendChild(this.toastEl);
    }
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, duration);
  }

  onMovePlaced(symbol) {
    // Ensure context is resumed before playing.
    audioManager.ensureContextReady()?.catch?.(() => {});
    const now = Date.now();
    if (now - this.lastMoveSoundAt < 150) {
      return; // debounce overlapping plays
    }
    this.lastMoveSoundAt = now;
    audioManager.play(symbol === 'X' ? 'xPlace' : 'oPlace');
  }

  onGameEnded({ outcome, winnerSymbol, isLocalWinner }) {
    audioManager.ensureContextReady()?.catch?.(() => {});
    if (outcome === 'draw') {
      audioManager.play('gameLost');
      return;
    }
    if (isLocalWinner) {
      audioManager.play('gameWon');
    } else {
      audioManager.play('gameLost');
    }
  }

  toggleAudio(muted) {
    audioManager.setMuted(muted);
  }

  stopTimerWarning() {
    audioManager.stopTimerWarning();
  }

  startTimerWarning() {
    audioManager.startTimerWarning();
  }

  // End screen helpers (overlay-driven)
  showEndScreen() {
    this.showOverlay({
      title: 'Game Ended',
      message: 'Session closed. Waiting to finish...',
      showSpinner: false,
    });
    this.overlay.classList.add('banner');
  }

  updateEndScreenTimer(seconds) {
    if (Number.isFinite(seconds)) {
      this.overlayMessage.textContent = `Session closed ${seconds}s ago`;
    }
  }

  updateEndScreenMessage(message) {
    this.overlayMessage.textContent = message;
  }
}

export default UIManager;
