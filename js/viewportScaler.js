// viewportScaler.js
// Keeps the entire game rendered at its authored "design" size and uniformly
// scales it (up or down) so it always fills the available frame while
// preserving the exact portrait design — no reflow, no split. This is what
// makes the game look correct inside short/narrow webviews (e.g. Samsung Z
// Fold cover screen) and large frames alike.

const MARGIN = 8; // breathing room around the scaled canvas, in CSS px

export function initViewportScaler(containerId = 'game-container', stageId = 'viewport-stage') {
  const container = document.getElementById(containerId);
  const stage = document.getElementById(stageId);
  if (!container) return () => {};

  let frame = null;

  const measure = () => {
    // Reset the transform so we read the true (unscaled) design dimensions.
    container.style.transform = 'none';
    const designW = container.offsetWidth;
    const designH = container.offsetHeight;

    // Measure the actual available area. The stage fills the (safe-area
    // padded) body, so its client box already excludes iOS notches; fall back
    // to visualViewport / window for the raw visible area otherwise.
    let vw = stage ? stage.clientWidth : 0;
    let vh = stage ? stage.clientHeight : 0;
    if (!vw || !vh) {
      vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
      vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    }

    if (!designW || !designH) return;

    const scale = Math.min(
      (vw - MARGIN * 2) / designW,
      (vh - MARGIN * 2) / designH,
    );

    // Never collapse to nothing; otherwise scale freely up or down.
    const safe = Math.max(scale, 0.2);
    container.style.transform = `scale(${safe})`;
  };

  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(measure);
  };

  // React to frame changes, content growth (names/timers), and webview chrome.
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', schedule);
    window.visualViewport.addEventListener('scroll', schedule);
  }

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
  }

  // Re-fit once fonts have settled to avoid a first-paint size jump.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(schedule).catch(() => {});
  }

  measure();
  return schedule;
}
