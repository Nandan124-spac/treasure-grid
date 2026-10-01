# Treasure Grid

Treasure Grid is a two-player online game. Players open the same public URL on separate devices, join a room, then take turns exploring a shared 5 × 5 map.

## Rules

- There are 12 turns total, so each explorer gets six picks.
- A coin is worth 1 gem; a treasure chest is worth 2.
- A trap removes 1 gem, but a score cannot go below zero. An empty tile has no effect.
- A short countdown starts every turn. The active player has 20 seconds to choose a tile; a missed turn is skipped.
- The explorer with the most gems after turn 12 wins. If scores match, the expedition is a tie.
- Both players can choose **Explore again** to start a rematch with a new map.

## Run it locally

Requires Node.js 20 or newer. There are no third-party packages to install.

```sh
node server.js
```

Open `http://localhost:3000` in two browser tabs or devices that can reach the computer running the server. To choose another port, set the `PORT` environment variable.

## Test multiplayer behavior

Run `npm test`. It starts a temporary server, connects two independent clients, checks that unrevealed tile contents stay hidden, verifies turn ownership, plays all 12 turns, then checks final results and rematch scoring.

## Deploy it

This is a single Node web service. For a public deployment, push the project to a Git repository and create a Node web service on a host such as Render. Use `npm start` as the start command; the host provides the public HTTPS URL and sets `PORT` automatically. The service must allow long-lived HTTP responses for Server-Sent Events.

Room state is held in the running server's memory. Use one service instance for this first version; restarting it clears active rooms. A database and shared state store would be the next step for persistent games or multiple server instances.

## How the online game works

1. `server.js` creates a five-character room code and gives each player a private session ID.
2. Each browser listens for Server-Sent Events. The server sends the current room state to both players after each change.
3. Browsers submit picks to `/api/reveal`. The server checks the session, active player, turn number, and tile before revealing anything or changing a score.
4. Unrevealed tile contents are never sent to the browser. Only the server knows the full map until a tile is picked.
5. The front end is plain HTML, CSS, and browser JavaScript in `public/`, so it is easy to read and deploy.
