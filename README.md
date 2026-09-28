# Live Quiz

A Kahoot-style live quiz. The host screen goes on the projector; players join from their phones by scanning a QR code.

- `/host`: host screen (password protected)
- `/`: player join page (the QR code links here with the PIN filled in)

Tested locally with 500 simulated players: answer acknowledgements took 1–2 ms, and the question reached all players within 21 ms.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000/host (local password: `admin`) and http://localhost:3000 in another tab.

## Deploy on Coolify

1. Push this folder to a GitHub repo.
2. Coolify → **New Resource** → your repo → Build Pack: **Dockerfile**.
3. Ports Exposes: **3000**.
4. Environment variable: **`HOST_PASSWORD`** = a secret only you know.
5. Set a domain (with https), then click **Deploy**.
6. Open `https://<your-domain>/host`.

WebSockets work through Coolify's proxy with no extra setup. Run a **single instance**, because the game state lives in memory.

| Env var | Default | Meaning |
|---|---|---|
| `HOST_PASSWORD` | `admin` | Password for `/host` |
| `PORT` | `3000` | HTTP port |
| `MAX_PLAYERS` | `1000` | Max players per game |

## Questions

Edit `questions.json`, or edit them in the host screen before clicking **Create game**:

```json
{ "question": "…", "options": ["A", "B", "C", "D"], "answer": 2, "time": 20 }
```

`answer` is the **position** (1–4) of the correct option. `time` is in seconds (5–120).

## Running the game

- Press **Space** or **Enter** to move to the next screen (lobby → question → reveal → leaderboard → …).
- Click a name in the lobby to remove that player.
- A question closes automatically when time runs out or when everyone has answered.
- Scoring: a correct answer gets 1000 points if instant, down to 500 at the buzzer. A wrong answer gets 0.
- On the final screen, **Download results (CSV)** saves the results.
- If the host laptop or a phone refreshes or loses its connection, it rejoins automatically with scores kept.

## Load test (before the event)

```bash
npm install
node loadtest.js https://<your-domain> <PIN> 500
```

Start the game from `/host` and watch the stats. **Create a fresh game for the real event** afterwards, because the bots stay in the test game.
