'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const SHAPES = ['▲', '◆', '●', '■'];
const SESSION_KEY = 'quiz-player';

let session = loadSession();
let timerInt = null;

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession() {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage unavailable (private mode) - rejoin just won't survive a refresh */ }
}

function show(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 's-' + name));
  if (name !== 'result') document.body.classList.remove('good', 'bad');
}

function startTimer(el, ms) {
  stopTimer();
  const end = Date.now() + ms;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    el.textContent = left;
    if (left === 0) stopTimer();
  };
  tick();
  timerInt = setInterval(tick, 200);
}
function stopTimer() {
  clearInterval(timerInt);
  timerInt = null;
}

// Keep the phone screen awake so the connection doesn't drop mid-game.
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not supported */ }
  if (wakeLock) wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session) keepAwake(); });

// ---------- joining ----------

const urlPin = (new URLSearchParams(location.search).get('pin') || '').replace(/\D/g, '').slice(0, 6);
if (session && urlPin && session.pin !== urlPin) { session = null; saveSession(); }
if (urlPin) $('pinInput').value = urlPin;
if (session) { $('pinInput').value = session.pin; $('nameInput').value = session.name; }
show(session ? 'connecting' : 'join');

socket.on('connect', () => {
  $('offline').classList.add('hidden');
  if (session) rejoin();
});
socket.on('disconnect', () => { if (session) $('offline').classList.remove('hidden'); });

function rejoin() {
  socket.emit('player:join', { pin: session.pin, playerId: session.playerId, rejoin: true }, (res) => {
    if (res.ok) return; // the server follows up with the current state
    session = null;
    saveSession();
    $('me').classList.add('hidden');
    $('joinError').textContent = res.error;
    show('join');
  });
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = $('pinInput').value.trim();
  const name = $('nameInput').value.trim();
  if (!pin || !name) return;
  $('joinBtn').disabled = true;
  $('joinError').textContent = '';
  keepAwake();
  socket.emit('player:join', { pin, name }, (res) => {
    $('joinBtn').disabled = false;
    if (!res.ok) { $('joinError').textContent = res.error; return; }
    session = { pin: res.pin, playerId: res.playerId, name: res.name };
    saveSession();
  });
});

if (urlPin && !session) $('nameInput').focus();

// ---------- game states ----------

socket.on('state', (s) => {
  $('me').textContent = `${s.name} · ${s.score} pts`;
  $('me').classList.remove('hidden');
  stopTimer();

  if (s.type === 'lobby') {
    $('lobbyName').textContent = s.name;
    show('lobby');
  } else if (s.type === 'question') {
    if (s.answered !== null) {
      $('lockedTitle').textContent = 'Answer locked in';
      show('locked');
      return;
    }
    $('pCounter').textContent = `Question ${s.index + 1} / ${s.total}`;
    $('pText').textContent = s.question;
    $('pOptions').replaceChildren(...s.options.map((text, i) => {
      const b = document.createElement('button');
      b.className = 'option c' + i;
      const shape = document.createElement('span');
      shape.className = 'shape';
      shape.textContent = SHAPES[i];
      const label = document.createElement('span');
      label.textContent = text;
      b.append(shape, label);
      b.addEventListener('click', () => answer(s.index, i));
      return b;
    }));
    startTimer($('pTimer'), s.remainingMs);
    show('question');
  } else if (s.type === 'result') {
    renderResult(s);
  } else if (s.type === 'end') {
    renderEnd(s);
  }
});

function answer(index, choice) {
  document.querySelectorAll('#pOptions button').forEach((b) => { b.disabled = true; });
  stopTimer();
  $('lockedTitle').textContent = 'Answer locked in';
  show('locked');
  socket.emit('player:answer', { index, choice }, (res) => {
    if (!res.ok) $('lockedTitle').textContent = res.error;
  });
}

function renderResult(s) {
  const views = {
    correct: ['✔', 'Correct!', 'good'],
    wrong: ['✘', 'Wrong', 'bad'],
    timeout: ['⏱', "Time's up", 'bad'],
    late: ['⏳', 'Get ready for the next one', ''],
  };
  const [icon, title, cls] = views[s.status];
  $('resIcon').textContent = icon;
  $('resTitle').textContent = title;
  $('resPoints').textContent = s.status === 'correct'
    ? `+${s.points} points` + (s.streak > 1 ? ` · 🔥 ${s.streak} in a row` : '')
    : '';
  $('resAnswer').textContent = s.status === 'correct' || s.status === 'late' ? '' : `Correct answer: ${s.correctOption}`;
  $('resRank').textContent = s.rank ? `#${s.rank} of ${s.playerCount} · ${s.score} pts` : '';
  show('result');
  document.body.classList.remove('good', 'bad');
  if (cls) document.body.classList.add(cls);
}

function renderEnd(s) {
  const medals = { 1: ['🏆', 'You won!'], 2: ['🥈', '2nd place!'], 3: ['🥉', '3rd place!'] };
  const [icon, title] = medals[s.rank] || ['🎉', 'Game over'];
  $('endIcon').textContent = icon;
  $('endTitle').textContent = title;
  $('endScore').textContent = `${s.score} points`;
  $('endRank').textContent = s.rank ? `You finished #${s.rank} of ${s.playerCount}` : '';
  show('end');
}

socket.on('kicked', () => {
  session = null;
  saveSession();
  $('me').classList.add('hidden');
  show('kicked');
});

$('rejoinBtn').addEventListener('click', () => {
  $('nameInput').value = '';
  show('join');
});
