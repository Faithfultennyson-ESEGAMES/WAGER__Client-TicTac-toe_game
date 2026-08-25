import ConnectionManager from "./connectionManager.js";

class SocketManager {
  constructor({ url, authToken, connectionCallbacks = {} }) {
    this.url = url;
    this.authToken = authToken;
    this.socket = null;
    this.registeredHandlers = new Map();
    this.connectionManager = new ConnectionManager(connectionCallbacks);
    // Offset (ms) to add to this device's Date.now() to approximate the
    // server's clock. Measured via syncClock(); stays 0 (no correction)
    // until the first sync round trip completes.
    this.clockOffsetMs = 0;
  }

  async connect() {
    if (this.socket?.connected) {
      return this.socket;
    }

    // Wait for the socket.io script to be loaded.
    await this._waitForSocketIo();

    this.connectionManager.setStatus('connecting');

    return new Promise((resolve, reject) => {
      if (this.socket) {
        // If a socket instance already exists but is disconnected, just reconnect it.
        this.socket.once('connect', () => resolve(this.socket));
        this.socket.connect();
        return;
      }

      this.socket = window.io(this.url, {
        path: '/socket.io',
        transports: ['websocket', 'polling'],
        upgrade: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        withCredentials: false,
        auth: this.authToken ? { token: this.authToken } : undefined,
      });

      this._setupCoreListeners();

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Connection timeout'));
      }, 8000);

      const onConnect = () => {
        this.connectionManager.resetBackoff();
        this.connectionManager.setStatus('connected');
        cleanup();
        resolve(this.socket);
      };

      const onError = (error) => {
        this.connectionManager.setStatus('error', { error });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off('connect', onConnect);
        this.socket.off('connect_error', onError);
        this.socket.off('error', onError);
      };

      this.socket.on('connect_error', onError);
      this.socket.on('error', onError);
      this.socket.once('connect', onConnect);
    });
  }

  // Polls to check if the main socket.io script has loaded.
  async _waitForSocketIo(maxWaitMs = 10000) {
    return new Promise((resolve, reject) => {
      if (typeof window.io === 'function') {
        return resolve();
      }
      const interval = 100;
      let elapsedTime = 0;
      const handle = setInterval(() => {
        if (typeof window.io === 'function') {
          clearInterval(handle);
          return resolve();
        }
        elapsedTime += interval;
        if (elapsedTime >= maxWaitMs) {
          clearInterval(handle);
          reject(new Error('Socket.IO client library not loaded.'));
        }
      }, interval);
    });
  }


  _setupCoreListeners() {
    if (!this.socket) return;

    this.socket.on('connect', () => {
      this.connectionManager.setStatus('connected');
      // Re-measure on every (re)connect: the network path, and therefore
      // the RTT/offset estimate, can change across reconnects.
      this.syncClock();
    });

    this.socket.on('disconnect', (reason) => {
      this.connectionManager.setStatus('disconnected', { reason });
    });

    this.socket.io.on('reconnect_attempt', (attempt) => {
      this.connectionManager.setStatus('reconnecting', { attempt });
    });

    this.socket.io.on('reconnect_failed', () => {
        this.connectionManager.setStatus('error', { error: 'reconnect_failed' });
    });

    this.socket.on('connect_error', (error) => {
      this.connectionManager.setStatus('error', { error });
    });
  }

  // Measures the offset between this device's clock and the server's clock
  // by round-tripping a 'time-sync' event a few times and keeping the
  // sample with the lowest RTT (least jitter). The result is applied via
  // now() so countdowns rendered against server timestamps aren't thrown
  // off by a wrong/unsynced device clock.
  syncClock(samples = 3) {
    if (!this.socket) return;
    let bestRtt = Infinity;
    let completed = 0;

    const runSample = () => {
      const sentAt = Date.now();
      this.socket.emit('time-sync', sentAt, (serverTime) => {
        const receivedAt = Date.now();
        const rtt = receivedAt - sentAt;
        if (rtt < bestRtt) {
          bestRtt = rtt;
          this.clockOffsetMs = serverTime + (rtt / 2) - receivedAt;
        }
        completed += 1;
        if (completed < samples) runSample();
      });
    };

    runSample();
  }

  // Current time corrected by the measured server clock offset. Use this
  // instead of raw Date.now() whenever comparing against a server-issued
  // absolute timestamp (e.g. turn expiry).
  now() {
    return Date.now() + this.clockOffsetMs;
  }

  on(event, handler) {
    if (!this.socket) throw new Error('Socket not initialized yet');
    this.socket.on(event, handler);
    this.registeredHandlers.set(event, this.registeredHandlers.get(event)?.add(handler) || new Set([handler]));
  }

  off(event, handler) {
    if (!this.socket) return;
    this.socket.off(event, handler);
    this.registeredHandlers.get(event)?.delete(handler);
  }

  // Returns a Promise so callers can .catch() dispatch failures instead of
  // relying on a server-side ack: none of this server's handlers
  // (join/make-move/relocate-move) ever invoke the Socket.IO ack callback —
  // they report outcomes via separate broadcast events (move-applied /
  // move-error) instead. So this resolves once the event has been handed
  // off to the socket successfully, and rejects if that dispatch couldn't
  // happen at all (no socket, or socket.emit throwing synchronously). The
  // optional callback is still wired through as the ack listener in case a
  // future event does start acking.
  emit(event, payload = {}, callback = () => {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected yet'));
        return;
      }
      try {
        this.socket.emit(event, payload, callback);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  makeMove(payload) {
    return this.emit('make-move', payload);
  }

  disconnect() {
    if (!this.socket) return;
    this.registeredHandlers.forEach((handlers, event) => {
      handlers.forEach((handler) => this.socket.off(event, handler));
    });
    this.socket.disconnect();
    this.socket = null;
    this.registeredHandlers.clear();
  }
}

export default SocketManager;
