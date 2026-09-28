'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const SHAPES = ['▲', '◆', '●', '■'];
const SESSION_KEY = 'quiz-host';
const PW_KEY = 'quiz-host-pw';

let view = null; // latest state from the server
let screen = 'login';
let timerKey = null;
let timerInt = null;
let lastNext = 0;

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function setSession(s) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* ignore */ }
}
function getPassword() {
  try { return sessionStorage.getItem(PW_KEY) || ''; } catch { return ''; }
}
function setPassword(pw) {
  try { if (pw) sessionStorage.setItem(PW_KEY, pw); else sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ }
}

function show(name) {
  screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.id !== 's-' + name));
  const inGame = ['lobby', 'question', 'reveal', 'leaderboard'].includes(name);
  $('endBtn').classList.toggle('hidden', !inGame);
  $('hostInfo').classList.toggle('hidden', !view || name === 'login' || name === 'setup');
  if (name !== 'question') stopTimer();
}

function startTimer(el, ms) {
  stopTimer();
  const end = Date.now() + ms;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    el.textContent = left;
    el.classList.toggle('low', left <= 5);
    if (left === 0) stopTimer();
  };
  tick();
  timerInt = setInterval(tick, 100);
}
function stopTimer() {
  clearInterval(timerInt);
  timerInt = null;
}

function optionEls(options, correct) {
  return options.map((text, i) => {
    const d = document.createElement('div');
    d.className = 'option c' + i;
    if (correct !== undefined) d.classList.add(i === correct ? 'correct' : 'dim');
    const shape = document.createElement('span');
    shape.className = 'shape';
    shape.textContent = SHAPES[i];
    const label = document.createElement('span');
    label.textContent = text;
    d.append(shape, label);
    return d;
  });
}

// ---------- connection / login ----------

socket.on('connect', () => {
  $('offline').classList.add('hidden');
  const s = getSession();
  if (s) {
    socket.emit('host:resume', s, (res) => {
      if (res.ok) return;
      setSession(null);
      view = null;
      toSetup();
    });
  } else if (!view && screen === 'login') {
    toSetup();
  }
});
socket.on('disconnect', () => $('offline').classList.remove('hidden'));

function toSetup() {
  const pw = getPassword();
  if (!pw) return show('login');
  socket.emit('host:auth', { password: pw }, (res) => {
    if (!res.ok) {
      setPassword('');
      $('loginError').textContent = res.error;
      return show('login');
    }
    if (!$('questionsInput').value.trim()) $('questionsInput').value = JSON.stringify(res.questions, null, 2);
    show('setup');
  });
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  setPassword($('password').value);
  toSetup();
});

$('setupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('setupError').textContent = '';
  let questions;
  try {
    questions = JSON.parse($('questionsInput').value);
  } catch (err) {
    $('setupError').textContent = 'The questions are not valid JSON: ' + err.message;
    return;
  }
  $('createBtn').disabled = true;
  socket.emit('host:create', { password: getPassword(), questions }, (res) => {
    $('createBtn').disabled = false;
    if (!res.ok) { $('setupError').textContent = res.error; return; }
    setSession({ pin: res.pin, hostToken: res.hostToken });
  });
});

// ---------- rendering ----------

socket.on('host:state', (v) => {
  view = v;
  $('hostInfo').textContent = `PIN ${v.pin} · ${v.playerCount} players`;
  if (v.type === 'lobby') renderLobby(v);
  else if (v.type === 'question') renderQuestion(v);
  else if (v.type === 'reveal') renderReveal(v);
  else if (v.type === 'leaderboard') renderLeaderboard(v);
  else if (v.type === 'ended') renderEnded(v);
});

function renderLobby(v) {
  const url = `${location.origin}/?pin=${v.pin}`;
  if ($('qr').dataset.url !== url) {
    $('qr').src = '/qr.svg?data=' + encodeURIComponent(url);
    $('qr').dataset.url = url;
  }
  $('joinUrl').textContent = location.host;
  $('pin').textContent = v.pin;
  $('playerCount').textContent = v.playerCount;
  $('startBtn').disabled = v.playerCount === 0;
  $('playerList').replaceChildren(...v.players.slice().reverse().map((p) => {
    const b = document.createElement('button');
    b.className = 'chip' + (p.online ? '' : ' offline-p');
    b.textContent = p.name;
    b.title = 'Rename or remove ' + p.name;
    b.addEventListener('click', () => openPlayerDialog(p));
    return b;
  }));
  show('lobby');
}

function renderQuestion(v) {
  $('qCounter').textContent = `Question ${v.index + 1} of ${v.total}`;
  $('qAnswered').textContent = `${v.answered} / ${v.online} answered`;
  const key = `${v.pin}:${v.index}`;
  if (timerKey !== key || screen !== 'question') {
    timerKey = key;
    $('qText').textContent = v.question;
    $('qOptions').replaceChildren(...optionEls(v.options));
    show('question');
    startTimer($('qTimer'), v.remainingMs);
  }
}

function renderReveal(v) {
  $('rCounter').textContent = `Question ${v.index + 1} of ${v.total}`;
  $('rAnswered').textContent = `${v.answered} answered`;
  $('rText').textContent = v.question;
  const max = Math.max(1, ...v.counts);
  $('rBars').replaceChildren(...v.counts.map((count, i) => {
    const col = document.createElement('div');
    col.className = 'bar-col' + (i === v.answer ? '' : ' dim');
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.textContent = count + (i === v.answer ? ' ✔' : '');
    const bar = document.createElement('div');
    bar.className = 'bar c' + i;
    bar.style.height = (count / max) * 100 + '%';
    const foot = document.createElement('div');
    foot.className = 'bar-foot c' + i;
    foot.textContent = SHAPES[i];
    col.append(label, bar, foot);
    return col;
  }));
  $('rOptions').replaceChildren(...optionEls(v.options, v.answer));
  $('revealNext').textContent = v.index + 1 >= v.total ? 'Final leaderboard ▶' : 'Leaderboard ▶';
  show('reveal');
}

function renderLeaderboard(v) {
  $('board').replaceChildren(...v.top.map((p) => {
    const li = document.createElement('li');
    makeEditable(li, p);
    const rk = document.createElement('span');
    rk.className = 'rk';
    rk.textContent = '#' + p.rank;
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    const sc = document.createElement('span');
    sc.textContent = p.score;
    li.append(rk, nm, sc);
    return li;
  }));
  $('boardNext').textContent = v.isLast ? 'Show winners 🏆' : 'Next question ▶';
  show('leaderboard');
}

function renderEnded(v) {
  const top = v.results.slice(0, 3);
  const order = [top[1], top[0], top[2]].map((p, i) => [p, [2, 1, 3][i]]);
  $('podium').replaceChildren(...order.filter(([p]) => p).map(([p, place]) => {
    const pod = document.createElement('div');
    pod.className = 'pod p' + place;
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name;
    const block = document.createElement('div');
    block.className = 'block';
    block.textContent = place;
    const sc = document.createElement('div');
    sc.className = 'sc';
    sc.textContent = p.score + ' pts';
    block.append(sc);
    pod.append(nm, block);
    return pod;
  }));
  $('resultsBody').replaceChildren(...v.results.map((p) => {
    const tr = document.createElement('tr');
    makeEditable(tr, p);
    for (const val of [p.rank, p.name, p.score]) {
      const td = document.createElement('td');
      td.textContent = val;
      tr.append(td);
    }
    return tr;
  }));
  show('ended');
}

// ---------- rename / remove players ----------

let editing = null;

function makeEditable(el, p) {
  el.classList.add('editable');
  el.title = 'Click to rename or remove';
  el.addEventListener('click', () => openPlayerDialog(p));
}

function openPlayerDialog(p) {
  editing = p;
  $('renameInput').value = p.name;
  $('renameError').textContent = '';
  $('playerDialog').showModal();
  $('renameInput').select();
}

$('renameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!editing) return;
  socket.emit('host:rename', { playerId: editing.id, name: $('renameInput').value }, (res) => {
    if (!res.ok) { $('renameError').textContent = res.error; return; }
    $('playerDialog').close();
  });
});

$('kickBtn').addEventListener('click', () => {
  if (!editing || !confirm(`Remove "${editing.name}" from the game?`)) return;
  socket.emit('host:kick', { playerId: editing.id });
  $('playerDialog').close();
});

$('cancelDialog').addEventListener('click', () => $('playerDialog').close());

// ---------- controls ----------

function next() {
  const now = Date.now();
  if (now - lastNext < 700) return; // guard against double clicks skipping a screen
  lastNext = now;
  socket.emit('host:next');
}

$('startBtn').addEventListener('click', next);
$('skipBtn').addEventListener('click', next);
$('revealNext').addEventListener('click', next);
$('boardNext').addEventListener('click', next);

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea') || !view || $('playerDialog').open) return;
  if (![' ', 'Enter', 'ArrowRight'].includes(e.key)) return;
  const ok = (screen === 'lobby' && view.playerCount > 0) || screen === 'reveal' || screen === 'leaderboard';
  if (!ok) return;
  e.preventDefault();
  next();
});

$('endBtn').addEventListener('click', () => {
  if (confirm('End the game now and show the final results?')) socket.emit('host:end');
});

$('newGameBtn').addEventListener('click', () => {
  if (!confirm('Start a new game? Make sure you downloaded the results first.')) return;
  setSession(null);
  view = null;
  timerKey = null;
  toSetup();
});

$('csvBtn').addEventListener('click', () => {
  if (!view || view.type !== 'ended') return;
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [['Rank', 'Name', 'Score'], ...view.results.map((p) => [p.rank, p.name, p.score])];
  const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `quiz-results-${view.pin}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
