import debug from './debug.js';

const parseQueryParams = () => {
  const params = new URLSearchParams(window.location.search);

  const join_url = params.get('join_url');
  const player_id = params.get('player_id');
  const player_name = params.get('player_name');

  let sessionId = null;
  if (join_url) {
    try {
      const path = new URL(join_url).pathname;
      // Extracts the session ID (any characters except '/') from /session/some-id/...
      const match = path.match(/\/session\/([^\/]+)/);
      if (match && match[1]) {
        sessionId = match[1];
      }
    } catch (e) {
      debug.error('[urlParser] Invalid join_url:', join_url, e);
    }
  }

  const parsed = {
    join_url,
    sessionId,
    playerId: player_id,
    playerName: player_name,
    raw: params,
  };

  debug.log('[urlParser] Parsed query params:', parsed);
  return parsed;
};

// This function is not strictly needed for the new flow but is kept for potential future use.
const buildRejoinPayload = (sessionData) => ({
  session_id: sessionData.sessionId,
  playerId: sessionData.playerId,
});

export { parseQueryParams, buildRejoinPayload };
