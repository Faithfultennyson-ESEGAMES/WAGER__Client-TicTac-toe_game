class ConnectionManager {
  constructor({ onStatusChange, onReconnectNeeded }) {
    this.onStatusChange = onStatusChange;
    this.onReconnectNeeded = onReconnectNeeded;
    this.status = 'connecting';
    this.reconnectDelay = 1000;
    this.retryTimer = null;
  }

  setStatus(status, meta = {}) {
    this.status = status;
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(status, meta);
    }
  }

  scheduleReconnect(callback) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (typeof callback === 'function') {
        callback();
      }
      if (typeof this.onReconnectNeeded === 'function') {
        this.onReconnectNeeded();
      }
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
  }

  resetBackoff() {
    this.reconnectDelay = 1000;
    clearTimeout(this.retryTimer);
  }
}

export default ConnectionManager;
