const SESSION_KEY = 'treasure-grid-session';

const elements = {
  home: document.querySelector('#home-view'),
  lobby: document.querySelector('#lobby-view'),
  game: document.querySelector('#game-view'),
  results: document.querySelector('#results-view'),
  createForm: document.querySelector('#create-form'),
  joinForm: document.querySelector('#join-form'),
  homeError: document.querySelector('#home-error'),
  lobbyRoomCode: document.querySelector('#lobby-room-code'),
  shareRoomCode: document.querySelector('#share-room-code'),
  lobbyPlayers: document.querySelector('#lobby-players'),
  waitingMessage: document.querySelector('#waiting-message'),
  copyCode: document.querySelector('#copy-code-button'),
  copyLink: document.querySelector('#copy-link-button'),
  gameRoomCode: document.querySelector('#game-room-code'),
  scoreboard: document.querySelector('#scoreboard'),
  turnNumber: document.querySelector('#turn-number'),
  turnTrack: document.querySelector('#turn-track'),
  turnCompass: document.querySelector('#turn-compass'),
  turnMessage: document.querySelector('#turn-message'),
  turnClock: document.querySelector('#turn-clock'),
  board: document.querySelector('#treasure-board'),
  countdown: document.querySelector('#countdown-overlay'),
  countdownNumber: document.querySelector('#countdown-number'),
  countdownCaption: document.querySelector('#countdown-caption'),
  lastAction: document.querySelector('#last-action'),
  resultsRoomCode: document.querySelector('#results-room-code'),
  resultsHeading: document.querySelector('#results-heading'),
  resultsSubtitle: document.querySelector('#results-subtitle'),
  finalScores: document.querySelector('#final-scores'),
  playAgain: document.querySelector('#play-again-button'),
  rematchStatus: document.querySelector('#rematch-status'),
  newGame: document.querySelector('#new-game-button'),
  resultsNewRoom: document.querySelector('#results-new-room'),
  connection: document.querySelector('#connection-status'),
  connectionLabel: document.querySelector('#connection-label'),
  toast: document.querySelector('#toast'),
};

const TILE_LOOK = {
  coin: { icon: '🪙', label: 'Coin', className: 'tile-coin' },
  chest: { icon: '💎', label: 'Treasure chest', className: 'tile-chest' },
  trap: { icon: '🪤', label: 'Trap', className: 'tile-trap' },
  empty: { icon: '·', label: 'Empty', className: 'tile-empty' },
};

let session = null;
let gameState = null;
let eventSource = null;
let countdownInterval = null;
let toastTimeout = null;
let visibleView = 'home';

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function saveSession(nextSession) {
  session = nextSession;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function setHomeError(message) {
  elements.homeError.textContent = message;
  elements.homeError.hidden = !message;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { elements.toast.hidden = true; }, 2600);
}

function setConnection(online) {
  elements.connection.hidden = false;
  elements.connection.classList.toggle('offline', !online);
  elements.connectionLabel.textContent = online ? 'Live connection' : 'Reconnecting…';
}

async function postJson(endpoint, values) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function setBusy(form, busy) {
  form.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

async function enterGame(result) {
  saveSession({ roomCode: result.roomCode, playerId: result.playerId });
  connectToRoom();
  renderState(result.state);
}

elements.createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setHomeError('');
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const result = await postJson('/api/create-room', { name: form.elements.name.value });
    await enterGame(result);
  } catch (error) {
    setHomeError(error.message);
  } finally {
    setBusy(form, false);
  }
});

elements.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setHomeError('');
  const form = event.currentTarget;
  setBusy(form, true);
  try {
    const result = await postJson('/api/join-room', {
      name: form.elements.name.value,
      roomCode: form.elements.roomCode.value,
    });
    await enterGame(result);
  } catch (error) {
    setHomeError(error.message);
  } finally {
    setBusy(form, false);
  }
});

document.querySelector('#room-code').addEventListener('input', (event) => {
  event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});

function connectToRoom() {
  if (!session) return;
  eventSource?.close();
  const query = new URLSearchParams(session);
  eventSource = new EventSource(`/events?${query}`);
  eventSource.addEventListener('open', () => setConnection(true));
  eventSource.addEventListener('state', (event) => {
    try { renderState(JSON.parse(event.data)); } catch { showToast('We could not read the latest game update.'); }
  });
  eventSource.addEventListener('error', () => setConnection(false));
}

function showView(name) {
  if (visibleView !== name) window.scrollTo(0, 0);
  visibleView = name;
  elements.home.hidden = name !== 'home';
  elements.lobby.hidden = name !== 'lobby';
  elements.game.hidden = name !== 'game';
  elements.results.hidden = name !== 'results';
  elements.newGame.hidden = name === 'home';
}

function renderState(state) {
  gameState = state;
  if (!session || state.roomCode !== session.roomCode) return;
  if (state.phase === 'lobby') {
    showView('lobby');
    renderLobby(state);
  } else if (state.phase === 'finished') {
    showView('results');
    renderResults(state);
  } else {
    showView('game');
    renderGame(state);
  }
}

function playerCards(players, includeScore = false) {
  return players.map((player) => {
    const you = player.id === session.playerId;
    const card = document.createElement('div');
    card.className = includeScore ? `score-player${you ? ' is-you' : ''}` : 'player-card';
    const avatar = document.createElement('span');
    avatar.className = 'player-avatar';
    avatar.textContent = player.name.trim().charAt(0).toUpperCase();
    const meta = document.createElement('div');
    meta.className = includeScore ? 'score-meta' : 'player-meta';
    const name = document.createElement('strong');
    name.className = includeScore ? 'score-name' : '';
    name.textContent = `${player.name}${you ? ' (you)' : ''}`;
    meta.append(name);
    if (includeScore) {
      const score = document.createElement('div');
      score.className = 'score-value';
      score.textContent = player.score;
      const resource = document.createElement('span');
      resource.className = 'score-resource';
      resource.textContent = 'gems';
      meta.append(score, resource);
    } else {
      const ready = document.createElement('span');
      ready.textContent = 'Ready to explore';
      meta.append(ready);
    }
    card.append(avatar, meta);
    return card;
  });
}

function renderLobby(state) {
  elements.lobbyRoomCode.textContent = state.roomCode;
  elements.shareRoomCode.textContent = state.roomCode;
  elements.lobbyPlayers.replaceChildren(...playerCards(state.players));
  elements.waitingMessage.innerHTML = '<span class="waiting-pulse"></span> Waiting for player 2 to join…';
}

function renderScoreboard(players) {
  const cards = playerCards(players, true);
  const separator = document.createElement('div');
  separator.className = 'score-vs';
  separator.textContent = 'VS';
  elements.scoreboard.replaceChildren(cards[0], separator, cards[1]);
}

function renderGame(state) {
  elements.gameRoomCode.textContent = state.roomCode;
  elements.turnNumber.textContent = state.turnNumber;
  renderScoreboard(state.players);
  renderTurnTrack(state.turnNumber);
  renderTiles(state.tiles);
  elements.lastAction.textContent = state.lastAction || '';

  const currentPlayer = state.players.find((player) => player.id === state.currentPlayerId);
  const isYourTurn = state.currentPlayerId === session.playerId;
  elements.turnCompass.textContent = isYourTurn ? '🧭' : '🗺️';
  if (state.phase === 'countdown') {
    elements.turnMessage.textContent = isYourTurn ? 'Your turn is coming up!' : `${currentPlayer.name} is up next.`;
    elements.turnClock.textContent = 'Choose a tile when the countdown ends.';
    elements.countdownCaption.textContent = isYourTurn ? 'YOUR TURN' : `${currentPlayer.name.toUpperCase()}’S TURN`;
    elements.countdown.hidden = false;
  } else {
    elements.turnMessage.textContent = isYourTurn ? 'Your turn — pick one covered tile.' : `${currentPlayer.name} is choosing a tile.`;
    elements.countdown.hidden = true;
  }
  updateTimer();
}

function renderTurnTrack(turnNumber) {
  const steps = Array.from({ length: 12 }, (_, index) => {
    const step = document.createElement('span');
    step.className = `turn-step${index + 1 < turnNumber ? ' complete' : ''}${index + 1 === turnNumber ? ' current' : ''}`;
    step.setAttribute('aria-hidden', 'true');
    return step;
  });
  elements.turnTrack.replaceChildren(...steps);
}

function renderTiles(tiles) {
  const buttons = tiles.map((tile, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-tile';
    button.dataset.tileIndex = index;
    if (tile.revealed) {
      const look = TILE_LOOK[tile.type];
      button.classList.add('revealed', look.className);
      button.disabled = true;
      button.setAttribute('aria-label', `Tile ${index + 1}: ${look.label}, ${tile.points > 0 ? `plus ${tile.points}` : tile.points < 0 ? 'minus one' : 'no gems'}`);
      const icon = document.createElement('span');
      icon.className = 'tile-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = look.icon;
      const value = document.createElement('small');
      value.textContent = tile.points > 0 ? `+${tile.points}` : tile.points < 0 ? '−1' : '0';
      button.append(icon, value);
    } else {
      button.disabled = gameState.phase !== 'active' || gameState.currentPlayerId !== session.playerId;
      button.setAttribute('aria-label', `Covered tile ${index + 1}`);
      const mark = document.createElement('span');
      mark.className = 'tile-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = '✦';
      button.append(mark);
    }
    return button;
  });
  elements.board.replaceChildren(...buttons);
  elements.board.setAttribute('aria-label', `${tiles.length} tile treasure map. ${tiles.filter((tile) => tile.revealed).length} tiles explored.`);
}

function updateTimer() {
  clearInterval(countdownInterval);
  if (!gameState) return;
  const tick = () => {
    if (gameState.phase === 'countdown' && gameState.countdownEndsAt) {
      const remaining = Math.max(0, gameState.countdownEndsAt - Date.now());
      elements.countdownNumber.textContent = remaining === 0 ? 'GO!' : Math.ceil(remaining / 1000);
      return;
    }
    if (gameState.phase === 'active' && gameState.turnEndsAt) {
      const remaining = Math.max(0, gameState.turnEndsAt - Date.now());
      elements.turnClock.textContent = `${Math.ceil(remaining / 1000)} seconds to choose`;
    }
  };
  tick();
  countdownInterval = setInterval(tick, 100);
}

function renderResults(state) {
  elements.resultsRoomCode.textContent = state.roomCode;
  const winner = state.players.find((player) => player.id === state.winnerId);
  elements.resultsHeading.textContent = winner ? `${winner.name} found the most treasure!` : "It's a tie!";
  elements.resultsSubtitle.textContent = winner ? 'A fine expedition. Ready to explore again?' : 'A perfectly even haul. One more expedition?';
  elements.finalScores.replaceChildren(...state.players.map((player) => {
    const card = document.createElement('div');
    card.className = `final-score-card${player.id === state.winnerId ? ' winner-card' : ''}`;
    const name = document.createElement('span');
    name.className = 'final-score-name';
    name.textContent = `${player.name}${player.id === session.playerId ? ' (you)' : ''}`;
    const score = document.createElement('strong');
    score.className = 'final-score-value';
    score.textContent = player.score;
    const gems = document.createElement('small');
    gems.textContent = player.score === 1 ? 'gem' : 'gems';
    card.append(name, score, gems);
    return card;
  }));
  const voted = state.rematchVotes.includes(session.playerId);
  const rivalVoted = state.rematchVotes.some((id) => id !== session.playerId);
  elements.playAgain.disabled = voted;
  elements.playAgain.innerHTML = voted ? 'Waiting for your rival…' : 'Explore again <span aria-hidden="true">↻</span>';
  elements.rematchStatus.textContent = voted
    ? 'Your vote is in. The new map starts when your rival is ready.'
    : rivalVoted
      ? 'Your rival is ready to explore again. Join them!'
      : 'Both explorers can choose Explore again to start a rematch.';
}

elements.board.addEventListener('click', async (event) => {
  const tile = event.target.closest('.map-tile');
  if (!tile || tile.disabled || !session || !gameState) return;
  try {
    const result = await postJson('/api/reveal', {
      ...session,
      turnNumber: gameState.turnNumber,
      tileIndex: Number(tile.dataset.tileIndex),
    });
    renderState(result.state);
  } catch (error) {
    showToast(error.message);
  }
});

elements.copyCode.addEventListener('click', () => copyText(session?.roomCode || '', 'Room code copied!'));
elements.copyLink.addEventListener('click', () => {
  const invite = new URL('/', window.location.href);
  if (session) invite.searchParams.set('room', session.roomCode);
  copyText(invite.href, 'Invite link copied!');
});

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage);
  } catch {
    showToast('Copying was blocked by this browser. You can still select the room code.');
  }
}

elements.playAgain.addEventListener('click', async () => {
  if (!session) return;
  elements.playAgain.disabled = true;
  try {
    const result = await postJson('/api/play-again', session);
    renderState(result.state);
  } catch (error) {
    elements.playAgain.disabled = false;
    showToast(error.message);
  }
});

function startNewRoom() {
  eventSource?.close();
  clearInterval(countdownInterval);
  sessionStorage.removeItem(SESSION_KEY);
  session = null;
  gameState = null;
  elements.createForm.reset();
  elements.joinForm.reset();
  setHomeError('');
  window.history.replaceState(null, '', '/');
  elements.connection.hidden = true;
  showView('home');
}

elements.newGame.addEventListener('click', startNewRoom);
elements.resultsNewRoom.addEventListener('click', startNewRoom);

async function restoreSession() {
  const saved = readSession();
  if (!saved?.roomCode || !saved?.playerId) return;
  session = saved;
  try {
    const query = new URLSearchParams(session);
    const response = await fetch(`/api/state?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    connectToRoom();
    renderState(result.state);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    session = null;
    showView('home');
    showToast('Your previous expedition is no longer available. Create or join a room.');
  }
}

const roomFromLink = new URLSearchParams(window.location.search).get('room');
if (roomFromLink) document.querySelector('#room-code').value = roomFromLink.toUpperCase().slice(0, 5);
showView('home');
restoreSession();
