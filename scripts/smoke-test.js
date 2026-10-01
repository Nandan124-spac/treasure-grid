const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server stopped early (exit ${child.exitCode}).`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch { /* The child may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('The test server did not start within five seconds.');
}

async function postJson(baseUrl, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}

class StateFeed {
  constructor(response) {
    this.reader = response.body.getReader();
    this.buffer = '';
    this.queue = [];
    this.waiters = [];
    this.error = null;
    this.pump();
  }

  async pump() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error('Live update stream closed unexpectedly.');
        this.buffer += new TextDecoder().decode(value, { stream: true });
        let boundary;
        while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
          const event = this.buffer.slice(0, boundary);
          this.buffer = this.buffer.slice(boundary + 2);
          const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
          if (dataLine) this.push(JSON.parse(dataLine.slice(6)));
        }
      }
    } catch (error) {
      this.error = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    }
  }

  push(state) {
    const next = this.waiters.findIndex((waiter) => waiter.predicate(state));
    if (next === -1) this.queue.push(state);
    else {
      const [waiter] = this.waiters.splice(next, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(state);
    }
  }

  waitFor(predicate, timeoutMs = 4000) {
    const queued = this.queue.findIndex(predicate);
    if (queued !== -1) return Promise.resolve(this.queue.splice(queued, 1)[0]);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error('Timed out waiting for a live game update.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close() { return this.reader.cancel(); }
}

async function openFeed(baseUrl, player) {
  const query = new URLSearchParams(player);
  const response = await fetch(`${baseUrl}/events?${query}`);
  assert.equal(response.status, 200, 'A player should receive a live event stream.');
  return new StateFeed(response);
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), COUNTDOWN_MS: '60', TURN_TIMEOUT_MS: '5000' },
    stdio: 'ignore',
  });
  const feeds = [];

  try {
    await waitForServer(baseUrl, child);
    const created = await postJson(baseUrl, '/api/create-room', { name: 'Explorer One' });
    assert.equal(created.status, 201);
    assert.match(created.roomCode, /^[A-Z2-9]{5}$/);

    const joined = await postJson(baseUrl, '/api/join-room', {
      name: 'Explorer Two',
      roomCode: created.roomCode,
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.state.phase, 'countdown', 'The second player should start the first turn countdown.');
    assert.equal(joined.state.tiles.length, 25);
    assert.ok(joined.state.tiles.every((tile) => !tile.revealed && tile.type === null),
      'The room must not send hidden tile contents to browsers.');

    const players = [
      { roomCode: created.roomCode, playerId: created.playerId },
      { roomCode: joined.roomCode, playerId: joined.playerId },
    ];
    feeds.push(await openFeed(baseUrl, players[0]), await openFeed(baseUrl, players[1]));
    let lastState = null;
    const turnsPerPlayer = new Map(players.map((player) => [player.playerId, 0]));

    for (let turn = 1; turn <= 12; turn += 1) {
      const activeStates = await Promise.all(feeds.map((feed) => feed.waitFor((state) => (
        state.turnNumber === turn && state.phase === 'active'
      ))));
      assert.deepEqual(activeStates[0].tiles, activeStates[1].tiles, 'Both clients should see the same map.');
      assert.deepEqual(activeStates[0].players, activeStates[1].players, 'Both clients should see the same scores.');
      const activePlayerId = activeStates[0].currentPlayerId;
      const activePlayer = players.find((player) => player.playerId === activePlayerId);
      const otherPlayer = players.find((player) => player.playerId !== activePlayerId);
      const tileIndex = activeStates[0].tiles.findIndex((tile) => !tile.revealed);
      assert.notEqual(tileIndex, -1, 'There should be an unexplored tile.');

      const outOfTurn = await postJson(baseUrl, '/api/reveal', {
        ...otherPlayer,
        turnNumber: turn,
        tileIndex,
      });
      assert.equal(outOfTurn.status, 409, 'The server should reject a pick from the wrong player.');

      const previousScore = activeStates[0].players.find((player) => player.id === activePlayerId).score;
      const revealed = await postJson(baseUrl, '/api/reveal', {
        ...activePlayer,
        turnNumber: turn,
        tileIndex,
      });
      assert.equal(revealed.status, 200);
      assert.equal(revealed.state.tiles[tileIndex].revealed, true);
      assert.ok(['coin', 'chest', 'trap', 'empty'].includes(revealed.state.tiles[tileIndex].type));
      assert.ok(revealed.state.tiles.some((tile) => !tile.revealed && tile.type === null),
        'Unpicked contents should remain hidden.');
      turnsPerPlayer.set(activePlayerId, turnsPerPlayer.get(activePlayerId) + 1);

      const expectedPhase = turn === 12 ? 'finished' : 'countdown';
      const nextStates = await Promise.all(feeds.map((feed) => feed.waitFor((state) => (
        state.turnNumber === (turn === 12 ? 12 : turn + 1) && state.phase === expectedPhase
      ))));
      assert.deepEqual(nextStates[0].players, nextStates[1].players, 'Both clients should see each score update.');
      const actualScore = nextStates[0].players.find((player) => player.id === activePlayerId).score;
      const points = revealed.state.tiles[tileIndex].points;
      assert.equal(actualScore, Math.max(0, previousScore + points), 'The server should apply the tile score.');
      if (turn < 12) {
        assert.notEqual(nextStates[0].currentPlayerId, activePlayerId, 'Turns should alternate between explorers.');
      }
      lastState = nextStates[0];
    }

    assert.equal(lastState.phase, 'finished');
    assert.deepEqual([...turnsPerPlayer.values()].sort(), [6, 6], 'Each explorer should get six turns.');
    assert.equal(lastState.tiles.filter((tile) => tile.revealed).length, 12);
    assert.ok(lastState.winnerId === null || players.some((player) => player.playerId === lastState.winnerId));

    const rematches = await Promise.all(players.map((player) => postJson(baseUrl, '/api/play-again', player)));
    assert.ok(rematches.every((result) => result.ok), 'Both players should be able to vote for a rematch.');
    const newMatch = rematches.find((result) => result.state.phase === 'countdown')?.state;
    assert.ok(newMatch, 'The second rematch vote should start a new map.');
    assert.equal(newMatch.turnNumber, 1);
    assert.ok(newMatch.players.every((player) => player.score === 0), 'Rematch scores should reset.');
    console.log('PASS: two live clients shared the map, turn rules held for 12 turns, scores matched, and rematch reset.');
  } finally {
    await Promise.all(feeds.map((feed) => feed.close().catch(() => {})));
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
