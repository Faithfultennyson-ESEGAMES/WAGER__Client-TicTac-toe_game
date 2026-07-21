import GameClient from "./gameClient.js";
import { initViewportScaler } from "./viewportScaler.js";

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
  // Start fitting the design to the frame immediately, before the game logic.
  const refit = initViewportScaler('game-container');
  window.__refitGame = refit;

  setTimeout(() => {
    const client = new GameClient();
    client.init();
    // Overlay/board content changes can alter height; re-fit afterwards.
    refit();
  }, 100); // 100ms delay
});
