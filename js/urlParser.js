const parseQueryParams = () => {
  const params = new URLSearchParams(window.location.search);

  const joinUrl = params.get('joinUrl');
  const playerId = params.get('playerId');
  const playerName = params.get('playerName');

  let sessionId = null;
  if (joinUrl) {
    try {
      const path = new URL(joinUrl).pathname;
      // Extracts the session ID (any characters except '/') from /session/some-id/...
      const match = path.match(/\/session\/([^\/]+)/);
      if (match && match[1]) {
        sessionId = match[1];
      }
    } catch (e) {
    }
  }

  const parsed = {
    joinUrl,
    sessionId,
    playerId: playerId,
    playerName: playerName,
    raw: params,
  };

  return parsed;
};

// This function is not strictly needed for the new flow but is kept for potential future use.
const buildRejoinPayload = (sessionData) => ({
  sessionId: sessionData.sessionId,
  playerId: sessionData.playerId,
});

export { parseQueryParams, buildRejoinPayload };
