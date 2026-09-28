'use strict';

// Simulates many players joining a game and answering every question.
//   node loadtest.js <url> <pin> [players]
//   node loadtest.js https://quiz.example.com 123456 500
// Start the game from the host screen once everyone has joined. Ctrl+C to stop.

const { io } = require('socket.io-client');

const [url, pin, countArg] = process.argv.slice(2);
const COUNT = Number(countArg) || 500;
if (!url || !pin) {
  console.log('Usage: node loadtest.js <url> <pin> [players]\n  e.g. node loadtest.js http://localhost:3000 123456 500');
  process.exit(1);
}

const stats = { connected: 0, joined: 0, failed: 0, answered: 0, rejected: 0, ack: [], firstSeen: {}, lastSeen: {} };
const sockets = [];

function spawn(i) {
  const s = io(url, { transports: ['websocket'], forceNew: true });
  let playerId = null;

  s.on('connect', () => {
    stats.connected++;
    s.emit('player:join', { pin, name: `bot${i + 1}`, playerId, rejoin: !!playerId }, (res) => {
      if (res.ok) {
        if (!playerId) stats.joined++;
        playerId = res.playerId;
      } else {
        stats.failed++;
        if (stats.failed <= 5) console.log(`bot${i + 1} join failed: ${res.error}`);
      }
    });
  });
  s.on('disconnect', () => stats.connected--);

  s.on('state', (st) => {
    if (st.type !== 'question' || st.answered !== null) return;
    const now = Date.now();
    stats.firstSeen[st.index] ??= now;
    stats.lastSeen[st.index] = now;
    // Answer at a random moment, like a real crowd.
    const delay = Math.random() * Math.max(500, Math.min(st.remainingMs - 1500, 10000));
    setTimeout(() => {
      const t = Date.now();
      s.emit('player:answer', { index: st.index, choice: Math.floor(Math.random() * st.options.length) }, (r) => {
        stats.ack.push(Date.now() - t);
        if (r.ok) stats.answered++;
        else stats.rejected++;
      });
    }, delay);
  });

  sockets.push(s);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

// Ramp up ~50 players/second.
for (let i = 0; i < COUNT; i++) setTimeout(() => spawn(i), i * 20);

setInterval(() => {
  const spread = Object.keys(stats.firstSeen)
    .map((k) => `Q${Number(k) + 1}:${stats.lastSeen[k] - stats.firstSeen[k]}ms`)
    .join(' ');
  console.log(
    `connected ${stats.connected}/${COUNT} | joined ${stats.joined} | join failed ${stats.failed} | ` +
      `answers ok ${stats.answered}, rejected ${stats.rejected} | ` +
      `answer ack p50 ${pct(stats.ack, 50)}ms p95 ${pct(stats.ack, 95)}ms max ${pct(stats.ack, 100)}ms` +
      (spread ? ` | question delivery spread ${spread}` : ''),
  );
}, 3000);

process.on('SIGINT', () => {
  sockets.forEach((s) => s.close());
  process.exit(0);
});
