import GameClient from "./gameClient.js";

window.broadcastEvent = (type, payload = {}) => {
  if (!type) return;
  const message = { type, payload };
  try {
    const target = window.parent && window.parent !== window ? window.parent : window;
    target.postMessage(message, '*');
  } catch (error) {
    console.warn('[broadcastEvent] Failed to postMessage', error);
  }
};

// A short delay helps prevent race conditions during initial load.
window.addEventListener('load', () => {
  setTimeout(() => {
    const client = new GameClient();
    client.init();
  }, 100); // 100ms delay
});
