const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomInt, randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_SIZE = 5;
const TOTAL_TURNS = 12;
const COUNTDOWN_MS = Math.max(1, Number(process.env.COUNTDOWN_MS) || 3000);
const TURN_TIMEOUT_MS = Math.max(1000, Number(process.env.TURN_TIMEOUT_MS) || 20000);
const BODY_LIMIT = 8 * 1024;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const eventStreams = new Map();

function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function playerFor(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function publicState(room) {
  return {
    roomCode: room.code,
    phase: room.phase,
    players: room.players.map(({ id, name, score }) => ({ id, name, score })),
    tiles: room.layout.map((tile, index) => room.revealed.has(index)
      ? { index, revealed: true, type: tile.type, points: tile.points }
      : { index, revealed: false, type: null, points: null }),
    turnNumber: room.turnNumber,
    totalTurns: TOTAL_TURNS,
    currentPlayerId: room.currentPlayerId,
    countdownEndsAt: room.countdownEndsAt,
    turnEndsAt: room.turnEndsAt,
    lastAction: room.lastAction,
    winnerId: room.winnerId,
    rematchVotes: [...room.rematchVotes],
  };
}

function streamKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function sendEvent(response, state) {
  response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
}

function broadcast(room) {
  const state = publicState(room);
  for (const player of room.players) {
    const streams = eventStreams.get(streamKey(room.code, player.id));
    if (!streams) continue;
    for (const response of [...streams]) {
      try {
        sendEvent(response, state);
      } catch {
        streams.delete(response);
      }
    }
  }
}

function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 18 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

function makeRoom() {
  return {
    code: makeRoomCode(),
    players: [],
    phase: 'lobby',
    layout: [],
    revealed: new Set(),
    turnNumber: 0,
    currentPlayerId: null,
    countdownEndsAt: null,
    turnEndsAt: null,
    lastAction: null,
    winnerId: null,
    rematchVotes: new Set(),
    timer: null,
  };
}

function addPlayer(room, name) {
  const player = { id: randomUUID(), name, score: 0 };
  room.players.push(player);
  return player;
}

function makeTreasureMap() {
  const contents = [
    ...Array.from({ length: 12 }, () => ({ type: 'coin', points: 1 })),
    ...Array.from({ length: 5 }, () => ({ type: 'chest', points: 2 })),
    ...Array.from({ length: 4 }, () => ({ type: 'trap', points: -1 })),
    ...Array.from({ length: 4 }, () => ({ type: 'empty', points: 0 })),
  ];
  for (let index = contents.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInt(index + 1);
    [contents[index], contents[otherIndex]] = [contents[otherIndex], contents[index]];
  }
  return contents;
}

function beginTurn(room, turnNumber) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  if (turnNumber > TOTAL_TURNS) return finishGame(room);

  room.turnNumber = turnNumber;
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  room.turnEndsAt = null;
  const expectedTurn = turnNumber;
  room.timer = setTimeout(() => {
    if (room.phase !== 'countdown' || room.turnNumber !== expectedTurn) return;
    room.phase = 'active';
    room.countdownEndsAt = null;
    room.turnEndsAt = Date.now() + TURN_TIMEOUT_MS;
    room.timer = setTimeout(() => {
      if (room.phase !== 'active' || room.turnNumber !== expectedTurn) return;
      const player = playerFor(room, room.currentPlayerId);
      room.lastAction = `${player.name} ran out of time. Their turn was skipped.`;
      advanceTurn(room);
    }, TURN_TIMEOUT_MS);
    broadcast(room);
  }, COUNTDOWN_MS);
  broadcast(room);
}

function startMatch(room) {
  room.players.forEach((player) => { player.score = 0; });
  room.layout = makeTreasureMap();
  room.revealed = new Set();
  room.turnNumber = 0;
  room.currentPlayerId = room.players[randomInt(2)].id;
  room.lastAction = 'The map is ready. Keep an eye out for traps!';
  room.winnerId = null;
  room.rematchVotes.clear();
  beginTurn(room, 1);
}

function finishGame(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.phase = 'finished';
  room.countdownEndsAt = null;
  room.turnEndsAt = null;
  const highestScore = Math.max(...room.players.map((player) => player.score));
  const leaders = room.players.filter((player) => player.score === highestScore);
  room.winnerId = leaders.length === 1 ? leaders[0].id : null;
  room.rematchVotes.clear();
  broadcast(room);
}

function advanceTurn(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  if (room.turnNumber >= TOTAL_TURNS) return finishGame(room);
  const nextPlayer = room.players.find((player) => player.id !== room.currentPlayerId);
  room.currentPlayerId = nextPlayer.id;
  beginTurn(room, room.turnNumber + 1);
}

function parseRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > BODY_LIMIT) throw new Error('Request is too large.');
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new Error('Please send valid JSON.'); }
}

function findAuthorizedRoom(roomCode, playerId) {
  const room = rooms.get(parseRoomCode(roomCode));
  if (!room || typeof playerId !== 'string' || !playerFor(room, playerId)) return null;
  return room;
}

function apiError(response, status, message) {
  json(response, status, { ok: false, error: message });
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const room = findAuthorizedRoom(url.searchParams.get('roomCode'), url.searchParams.get('playerId'));
    if (!room) return apiError(response, 404, 'That game could not be found. Create or join a room to begin.');
    return json(response, 200, { ok: true, state: publicState(room) });
  }

  if (request.method === 'POST' && url.pathname === '/api/create-room') {
    let body;
    try { body = await readJson(request); } catch (error) { return apiError(response, 400, error.message); }
    const name = cleanName(body.name);
    if (!name) return apiError(response, 400, 'Enter a name between 1 and 18 characters.');
    const room = makeRoom();
    const player = addPlayer(room, name);
    rooms.set(room.code, room);
    return json(response, 201, { ok: true, roomCode: room.code, playerId: player.id, state: publicState(room) });
  }

  if (request.method === 'POST' && url.pathname === '/api/join-room') {
    let body;
    try { body = await readJson(request); } catch (error) { return apiError(response, 400, error.message); }
    const name = cleanName(body.name);
    const roomCode = parseRoomCode(body.roomCode);
    if (!name) return apiError(response, 400, 'Enter a name between 1 and 18 characters.');
    const room = rooms.get(roomCode);
    if (!room) return apiError(response, 404, 'We could not find that room. Check the code and try again.');
    if (room.players.length >= 2) return apiError(response, 409, 'That room already has two players.');
    const player = addPlayer(room, name);
    startMatch(room);
    const state = publicState(room);
    broadcast(room);
    return json(response, 200, { ok: true, roomCode, playerId: player.id, state });
  }

  if (request.method === 'POST' && url.pathname === '/api/reveal') {
    let body;
    try { body = await readJson(request); } catch (error) { return apiError(response, 400, error.message); }
    const room = findAuthorizedRoom(body.roomCode, body.playerId);
    if (!room) return apiError(response, 404, 'Your game session has expired. Join the room again.');
    if (room.phase !== 'active') return apiError(response, 409, 'Wait for the turn countdown to finish.');
    if (body.turnNumber !== room.turnNumber) return apiError(response, 409, 'That turn has already changed.');
    if (body.playerId !== room.currentPlayerId) return apiError(response, 409, 'It is your rival’s turn.');
    if (!Number.isInteger(body.tileIndex) || body.tileIndex < 0 || body.tileIndex >= room.layout.length) {
      return apiError(response, 400, 'Choose a tile on the map.');
    }
    if (room.revealed.has(body.tileIndex)) return apiError(response, 409, 'That tile has already been explored.');

    const player = playerFor(room, body.playerId);
    const tile = room.layout[body.tileIndex];
    room.revealed.add(body.tileIndex);
    const oldScore = player.score;
    player.score = Math.max(0, player.score + tile.points);
    if (tile.type === 'coin') room.lastAction = `${player.name} found a coin (+1 gem).`;
    else if (tile.type === 'chest') room.lastAction = `${player.name} found a treasure chest (+2 gems)!`;
    else if (tile.type === 'trap' && player.score < oldScore) room.lastAction = `${player.name} hit a trap (−1 gem).`;
    else if (tile.type === 'trap') room.lastAction = `${player.name} hit a trap, but had no gems to lose.`;
    else room.lastAction = `${player.name} uncovered an empty tile.`;

    advanceTurn(room);
    return json(response, 200, { ok: true, state: publicState(room) });
  }

  if (request.method === 'POST' && url.pathname === '/api/play-again') {
    let body;
    try { body = await readJson(request); } catch (error) { return apiError(response, 400, error.message); }
    const room = findAuthorizedRoom(body.roomCode, body.playerId);
    if (!room) return apiError(response, 404, 'Your game session has expired.');
    if (room.phase !== 'finished') return apiError(response, 409, 'Finish the current game before starting a rematch.');
    room.rematchVotes.add(body.playerId);
    if (room.rematchVotes.size === 2) startMatch(room);
    else broadcast(room);
    return json(response, 200, { ok: true, state: publicState(room) });
  }

  if (request.method === 'GET' && url.pathname === '/events') {
    const room = findAuthorizedRoom(url.searchParams.get('roomCode'), url.searchParams.get('playerId'));
    if (!room) return apiError(response, 404, 'That game session could not be found.');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();
    response.write('retry: 2000\n\n');
    sendEvent(response, publicState(room));
    const playerId = url.searchParams.get('playerId');
    const key = streamKey(room.code, playerId);
    if (!eventStreams.has(key)) eventStreams.set(key, new Set());
    eventStreams.get(key).add(response);
    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 20000);
    response.on('close', () => {
      clearInterval(heartbeat);
      const streams = eventStreams.get(key);
      streams?.delete(response);
      if (streams?.size === 0) eventStreams.delete(key);
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true });
  return apiError(response, 404, 'That game action is not available.');
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(request, response, pathname) {
  let requestedPath;
  try { requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname); }
  catch {
    response.writeHead(400);
    return response.end('Bad request');
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found');
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return response.end();
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/') || url.pathname === '/events' || url.pathname === '/healthz') {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error('Request failed:', error);
      if (!response.headersSent) apiError(response, 500, 'Something went wrong. Please try again.');
      else response.end();
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  serveStatic(request, response, url.pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Treasure Grid is ready on port ${PORT}`);
});
