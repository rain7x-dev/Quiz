'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'admin';
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, 'questions.json');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 1000;
const DEFAULT_TIME = 20;
const GRACE_MS = 600; // accept answers slightly after the timer to absorb network latency
const HOST_UPDATE_MS = 250; // batch lobby / answer-count updates sent to the host screen
const GAME_TTL_MS = 6 * 60 * 60 * 1000;

if (!process.env.HOST_PASSWORD) {
  console.warn('[warn] HOST_PASSWORD is not set, using "admin". Set it before the event!');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 256 * 1024,
});

app.get('/health', (_req, res) => res.send('ok'));

app.get('/qr.svg', async (req, res) => {
  try {
    const data = String(req.query.data || '').slice(0, 300);
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch {
    res.status(400).end();
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- questions ----------

function loadDefaultQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not read questions file:', e.message);
    return [];
  }
}

// Input uses 1-based "answer" (human friendly); internally we store a 0-based index.
function validateQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Questions must be a non-empty JSON array.');
  return raw.map((q, i) => {
    const n = i + 1;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) throw new Error(`Question ${n}: missing "question" text.`);
    if (!Array.isArray(q.options)) throw new Error(`Question ${n}: "options" must be a list.`);
    const options = q.options.map((o) => String(o).trim()).filter(Boolean);
    if (options.length < 2 || options.length > 4) throw new Error(`Question ${n}: needs 2 to 4 options.`);
    const answer = Number(q.answer);
    if (!Number.isInteger(answer) || answer < 1 || answer > options.length) {
      throw new Error(`Question ${n}: "answer" must be 1-${options.length} (position of the correct option).`);
    }
    const time = Math.min(Math.max(Number(q.time) || DEFAULT_TIME, 5), 120);
    return { question: q.question.trim(), options, answer: answer - 1, time };
  });
}

// ---------- game state ----------

const games = new Map(); // pin -> game

const newId = () => crypto.randomBytes(12).toString('hex');
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const publicEntry = (p) => ({ id: p.id, rank: p.rank, name: p.name, score: p.score });
const currentQ = (game) => game.questions[game.qIndex];

function newPin() {
  let pin;
  do pin = String(crypto.randomInt(100000, 1000000));
  while (games.has(pin));
  return pin;
}

function onlineCount(game) {
  let n = 0;
  for (const p of game.players.values()) if (p.socketId) n++;
  return n;
}

function createGame(questions) {
  const game = {
    pin: newPin(),
    hostToken: newId(),
    questions,
    players: new Map(), // playerId -> player
    names: new Set(), // lower-cased nicknames in use
    state: 'lobby', // lobby | question | reveal | leaderboard | ended
    qIndex: -1,
    qStartedAt: 0,
    qEndsAt: 0,
    answers: new Map(), // playerId -> { choice, elapsed }
    counts: [],
    sorted: [],
    timer: null,
    hostTimer: null,
    joinSeq: 0,
  };
  games.set(game.pin, game);
  setTimeout(() => destroyGame(game), GAME_TTL_MS).unref();
  return game;
}

function destroyGame(game) {
  clearTimeout(game.timer);
  clearTimeout(game.hostTimer);
  games.delete(game.pin);
}

function rankPlayers(game) {
  const sorted = [...game.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  let rank = 0;
  let prev = null;
  sorted.forEach((p, i) => {
    if (p.score !== prev) {
      rank = i + 1;
      prev = p.score;
    }
    p.rank = rank;
  });
  game.sorted = sorted;
}

function hostView(game) {
  const base = {
    pin: game.pin,
    total: game.questions.length,
    index: game.qIndex,
    playerCount: game.players.size,
    online: onlineCount(game),
  };
  const q = currentQ(game);
  switch (game.state) {
    case 'lobby':
      return {
        ...base,
        type: 'lobby',
        players: [...game.players.values()].map((p) => ({ id: p.id, name: p.name, online: !!p.socketId })),
      };
    case 'question':
      return {
        ...base,
        type: 'question',
        question: q.question,
        options: q.options,
        time: q.time,
        remainingMs: Math.max(0, game.qEndsAt - Date.now()),
        answered: game.answers.size,
      };
    case 'reveal':
      return {
        ...base,
        type: 'reveal',
        question: q.question,
        options: q.options,
        answer: q.answer,
        counts: game.counts,
        answered: game.answers.size,
      };
    case 'leaderboard':
      return {
        ...base,
        type: 'leaderboard',
        top: game.sorted.slice(0, 10).map(publicEntry),
        isLast: game.qIndex >= game.questions.length - 1,
      };
    case 'ended':
      return { ...base, type: 'ended', results: game.sorted.map(publicEntry) };
  }
}

function playerState(game, p) {
  const base = { name: p.name, score: p.score, total: game.questions.length, index: game.qIndex };
  const q = currentQ(game);
  switch (game.state) {
    case 'lobby':
      return { ...base, type: 'lobby' };
    case 'question': {
      const a = game.answers.get(p.id);
      return {
        ...base,
        type: 'question',
        question: q.question,
        options: q.options,
        remainingMs: Math.max(0, game.qEndsAt - Date.now()),
        answered: a ? a.choice : null,
      };
    }
    case 'reveal':
    case 'leaderboard': {
      const r = p.last && p.last.index === game.qIndex ? p.last : null;
      return {
        ...base,
        type: 'result',
        status: !r ? 'late' : r.correct ? 'correct' : r.choice === null ? 'timeout' : 'wrong',
        points: r ? r.points : 0,
        streak: p.streak,
        rank: p.rank,
        playerCount: game.players.size,
        correctOption: q.options[q.answer],
      };
    }
    case 'ended':
      return { ...base, type: 'end', rank: p.rank, playerCount: game.players.size };
  }
}

function sendHost(game) {
  clearTimeout(game.hostTimer);
  game.hostTimer = null;
  io.to(`h:${game.pin}`).emit('host:state', hostView(game));
}

// Throttled: collapses bursts (500 joins / answers) into one update every HOST_UPDATE_MS.
function touchHost(game) {
  if (!game.hostTimer) game.hostTimer = setTimeout(() => sendHost(game), HOST_UPDATE_MS);
}

function sendPlayer(game, p) {
  if (p.socketId) io.to(p.socketId).emit('state', playerState(game, p));
}

function sendAllPlayers(game) {
  for (const p of game.players.values()) sendPlayer(game, p);
}

// ---------- game flow ----------

function advance(game) {
  if (game.state === 'question') return reveal(game);
  if (game.state === 'reveal') return showLeaderboard(game);
  if (game.state === 'lobby' || game.state === 'leaderboard') {
    if (game.qIndex + 1 >= game.questions.length) return endGame(game);
    return startQuestion(game);
  }
}

function startQuestion(game) {
  game.qIndex++;
  const q = currentQ(game);
  game.state = 'question';
  game.answers = new Map();
  game.qStartedAt = Date.now();
  game.qEndsAt = game.qStartedAt + q.time * 1000;
  clearTimeout(game.timer);
  game.timer = setTimeout(() => reveal(game), q.time * 1000 + GRACE_MS);
  sendAllPlayers(game);
  sendHost(game);
}

function reveal(game) {
  if (game.state !== 'question') return;
  clearTimeout(game.timer);
  const q = currentQ(game);
  const limitMs = q.time * 1000;
  game.state = 'reveal';
  game.counts = q.options.map(() => 0);
  for (const p of game.players.values()) {
    const a = game.answers.get(p.id);
    const correct = !!a && a.choice === q.answer;
    // Kahoot-style: 1000 for an instant correct answer, down to 500 at the buzzer.
    const points = correct ? Math.round(1000 * (1 - Math.min(a.elapsed / limitMs, 1) / 2)) : 0;
    if (a) game.counts[a.choice]++;
    p.streak = correct ? p.streak + 1 : 0;
    p.score += points;
    p.last = { index: game.qIndex, choice: a ? a.choice : null, correct, points };
  }
  rankPlayers(game);
  sendAllPlayers(game);
  sendHost(game);
}

function showLeaderboard(game) {
  game.state = 'leaderboard';
  sendHost(game);
}

function endGame(game) {
  clearTimeout(game.timer);
  game.state = 'ended';
  rankPlayers(game);
  sendAllPlayers(game);
  sendHost(game);
  console.log(`[game ${game.pin}] ended with ${game.players.size} players`);
}

// ---------- sockets ----------

function hostGame(socket) {
  return socket.data.role === 'host' ? games.get(socket.data.pin) : null;
}

function attachHost(socket, game) {
  for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
  socket.data = { role: 'host', pin: game.pin };
  socket.join(`h:${game.pin}`);
}

io.on('connection', (socket) => {
  // ----- host -----
  socket.on('host:auth', (msg, ack) => {
    if (typeof ack !== 'function') return;
    if (!msg || msg.password !== HOST_PASSWORD) return ack({ ok: false, error: 'Wrong password.' });
    ack({ ok: true, questions: loadDefaultQuestions() });
  });

  socket.on('host:create', (msg, ack) => {
    if (typeof ack !== 'function') return;
    if (!msg || msg.password !== HOST_PASSWORD) return ack({ ok: false, error: 'Wrong password.' });
    let questions;
    try {
      questions = validateQuestions(msg.questions);
    } catch (e) {
      return ack({ ok: false, error: e.message });
    }
    const game = createGame(questions);
    attachHost(socket, game);
    ack({ ok: true, pin: game.pin, hostToken: game.hostToken });
    sendHost(game);
    console.log(`[game ${game.pin}] created with ${questions.length} questions`);
  });

  socket.on('host:resume', (msg, ack) => {
    if (typeof ack !== 'function') return;
    const game = msg && games.get(String(msg.pin));
    if (!game || msg.hostToken !== game.hostToken) return ack({ ok: false });
    attachHost(socket, game);
    ack({ ok: true, pin: game.pin });
    socket.emit('host:state', hostView(game));
  });

  socket.on('host:next', () => {
    const game = hostGame(socket);
    if (game) advance(game);
  });

  socket.on('host:end', () => {
    const game = hostGame(socket);
    if (game && game.state !== 'ended') endGame(game);
  });

  socket.on('host:kick', (msg) => {
    const game = hostGame(socket);
    const p = game && msg && game.players.get(msg.playerId);
    if (!p) return;
    game.players.delete(p.id);
    game.names.delete(p.name.toLowerCase());
    game.answers.delete(p.id);
    const s = p.socketId && io.sockets.sockets.get(p.socketId);
    if (s) {
      s.data = {};
      s.emit('kicked');
    }
    if (game.sorted.length) rankPlayers(game);
    sendHost(game);
  });

  socket.on('host:rename', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const game = hostGame(socket);
    const p = game && msg && game.players.get(msg.playerId);
    if (!p) return reply({ ok: false, error: 'Player not found.' });
    const name = cleanName(msg.name);
    if (!name) return reply({ ok: false, error: 'Name cannot be empty.' });
    const lower = name.toLowerCase();
    if (lower !== p.name.toLowerCase() && game.names.has(lower)) return reply({ ok: false, error: 'That name is already taken.' });
    game.names.delete(p.name.toLowerCase());
    game.names.add(lower);
    p.name = name;
    reply({ ok: true });
    if (p.socketId) io.to(p.socketId).emit('renamed', { name });
    sendHost(game);
  });

  // ----- player -----
  socket.on('player:join', (msg, ack) => {
    if (typeof ack !== 'function' || !msg) return;
    const game = games.get(String(msg.pin || '').trim());
    if (!game) return ack({ ok: false, error: 'No game with that PIN. Check the screen and try again.' });

    let p = msg.playerId ? game.players.get(String(msg.playerId)) : null;
    if (!p) {
      if (msg.rejoin) return ack({ ok: false, error: 'Your session expired. Please join again.' });
      if (game.state === 'ended') return ack({ ok: false, error: 'This game has already ended.' });
      if (socket.data.role === 'player' && game.players.has(socket.data.playerId)) {
        return ack({ ok: false, error: 'You have already joined.' });
      }
      if (game.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'The game is full.' });
      const name = cleanName(msg.name);
      if (!name) return ack({ ok: false, error: 'Please enter a nickname.' });
      if (game.names.has(name.toLowerCase())) return ack({ ok: false, error: 'That nickname is taken. Try another one.' });
      p = { id: newId(), name, score: 0, streak: 0, rank: null, last: null, socketId: null, joinedAt: game.joinSeq++ };
      game.players.set(p.id, p);
      game.names.add(name.toLowerCase());
    } else if (p.socketId && p.socketId !== socket.id) {
      // Same player reconnected (or opened a second tab): the old connection stops counting.
      const old = io.sockets.sockets.get(p.socketId);
      if (old) old.data = {};
    }

    p.socketId = socket.id;
    socket.data = { role: 'player', pin: game.pin, playerId: p.id };
    ack({ ok: true, pin: game.pin, playerId: p.id, name: p.name });
    sendPlayer(game, p);
    touchHost(game);
  });

  socket.on('player:answer', (msg, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const game = socket.data.role === 'player' ? games.get(socket.data.pin) : null;
    const p = game && game.players.get(socket.data.playerId);
    if (!p || p.socketId !== socket.id) return reply({ ok: false, error: 'Reconnecting…' });
    if (game.state !== 'question' || !msg || msg.index !== game.qIndex) return reply({ ok: false, error: "Time's up!" });
    if (game.answers.has(p.id)) return reply({ ok: true });

    const q = currentQ(game);
    const choice = Number(msg.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return reply({ ok: false, error: 'Invalid answer.' });
    const elapsed = Date.now() - game.qStartedAt;
    if (elapsed > q.time * 1000 + GRACE_MS) return reply({ ok: false, error: "Time's up!" });

    game.answers.set(p.id, { choice, elapsed });
    reply({ ok: true });
    if (game.answers.size >= onlineCount(game)) reveal(game);
    else touchHost(game);
  });

  socket.on('disconnect', () => {
    const { role, pin, playerId } = socket.data || {};
    const game = role === 'player' && games.get(pin);
    const p = game && game.players.get(playerId);
    if (p && p.socketId === socket.id) {
      p.socketId = null;
      touchHost(game);
    }
  });
});

server.listen(PORT, () => console.log(`Quiz server listening on http://localhost:${PORT} (host screen: /host)`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
