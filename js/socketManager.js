import ConnectionManager from "./connectionManager.js";

class SocketManager {
  constructor({ url, authToken, connectionCallbacks = {} }) {
    this.url = url;
    this.authToken = authToken;
    this.socket = null;
    this.registeredHandlers = new Map();
    this.connectionManager = new ConnectionManager(connectionCallbacks);
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

  emit(event, payload = {}, callback = () => {}) {
    if (!this.socket) throw new Error('Socket not connected yet');
    this.socket.emit(event, payload, callback);
  }

  makeMove(payload) {
    this.emit('make-move', payload);
    return Promise.resolve();
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
