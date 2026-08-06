"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const storage = require("./storage");

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = String(process.env.SESSION_SECRET || "").trim() || crypto.randomBytes(48).toString("hex");
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingTimeout: 20000,
  pingInterval: 25000
});

app.disable("x-powered-by");
app.use(express.json({ limit: "24kb" }));
app.use(express.static(path.join(__dirname, "public")));

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function signAuthToken(user) {
  const payload = base64Url(JSON.stringify({
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    exp: Date.now() + AUTH_TOKEN_TTL_MS
  }));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  try {
    const [payload, signature] = String(token || "").split(".");
    if (!payload || !signature) return null;
    const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded?.sub || Number(decoded.exp) <= Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function requestToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function requestUser(req) {
  const decoded = verifyAuthToken(requestToken(req));
  if (!decoded) return null;
  return storage.getUserById(decoded.sub);
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const user = await storage.createUser({
      username: req.body?.username,
      displayName: req.body?.displayName,
      password: req.body?.password
    });
    res.status(201).json({ ok: true, token: signAuthToken(user), user });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "Não foi possível criar a conta." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const user = await storage.authenticateUser(req.body?.username, req.body?.password);
    res.json({ ok: true, token: signAuthToken(user), user });
  } catch (error) {
    res.status(401).json({ ok: false, error: error.message || "Usuário ou senha inválidos." });
  }
});

app.get("/api/auth/me", async (req, res) => {
  const user = await requestUser(req);
  if (!user) return res.status(401).json({ ok: false, error: "Sessão inválida ou expirada." });
  const profile = await storage.getProfile(user.id);
  res.json({ ok: true, ...profile });
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const leaderboard = await storage.getLeaderboard(50);
    res.json({ ok: true, leaderboard });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Não foi possível carregar o ranking." });
  }
});

app.get("/health", (_req, res) => res.json({
  ok: true,
  version: "4.4.0",
  hosting: process.env.RENDER === "true" ? "render-free" : "local",
  storage: storage.status()
}));

const SUITS = ["♦", "♥", "♠", "♣"];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const BOT_NAMES = ["Lina Bot", "Mestre Bot", "Dragão Bot", "Panda Bot", "Tigre Bot", "Jade Bot"];
const rooms = new Map();
const onlineUsers = new Map();
const botTimers = new Map();
const turnTimers = new Map();

function normalizeName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function normalizeRoomCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function normalizeMode(value) {
  return value === "points" ? "points" : "single";
}

function normalizeBotDifficulty(value) {
  if (value === "expert") return "expert";
  if (value === "hard") return "hard";
  return "medium";
}

function normalizeTurnDuration(value) {
  return Number(value) === 60 ? 60 : 30;
}


function botDifficultyLabel(value) {
  if (value === "expert") return "Especialista";
  if (value === "hard") return "Difícil";
  return "Médio";
}

function updatePresence(socket, name = null) {
  const existing = onlineUsers.get(socket.id);
  const normalizedName = socket.data.account?.displayName || (name === null ? existing?.name : normalizeName(name));

  if (!normalizedName || normalizedName.length < 2) {
    onlineUsers.delete(socket.id);
    return;
  }

  const room = rooms.get(socket.data.roomCode);
  let status = "available";
  let roomCode = null;
  let publicRoom = false;

  if (room) {
    roomCode = room.code;
    publicRoom = Boolean(room.isPublic);
    if (room.status === "playing") status = "playing";
    else if (["round_finished", "block_finished", "finished"].includes(room.status)) status = "finished";
    else status = "lobby";
  }

  onlineUsers.set(socket.id, {
    id: socket.id,
    name: normalizedName,
    status,
    roomCode,
    publicRoom,
    registered: Boolean(socket.data.account?.id),
    updatedAt: Date.now()
  });
}

function humanCount(room) {
  return room.players.filter(player => !player.isBot).length;
}

function botCount(room) {
  return room.players.filter(player => player.isBot).length;
}

function canHumanJoin(room) {
  return room.status === "lobby" && (room.players.length < 4 || botCount(room) > 0);
}

function directoryState() {
  const players = [...onlineUsers.values()]
    .map(user => ({
      id: user.id,
      name: user.name,
      status: user.status,
      roomCode: user.status === "lobby" && user.publicRoom ? user.roomCode : null,
      registered: Boolean(user.registered)
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const openRooms = [...rooms.values()]
    .filter(room => room.isPublic && canHumanJoin(room) && room.players.some(player => !player.isBot && player.connected))
    .map(room => ({
      code: room.code,
      hostName: roomPlayer(room, room.hostId)?.name || "Jogador",
      playerCount: room.players.length,
      humanCount: humanCount(room),
      botCount: botCount(room),
      mode: room.mode,
      botDifficulty: room.botDifficulty,
      roundsPerBlock: room.roundsPerBlock,
      scoreLimit: room.scoreLimit,
      turnDuration: room.turnDuration
    }))
    .sort((a, b) => b.humanCount - a.humanCount || a.code.localeCompare(b.code));

  return {
    onlineCount: players.length,
    availableCount: players.filter(player => player.status === "available").length,
    players,
    openRooms
  };
}

function broadcastDirectory() {
  io.emit("directory_state", directoryState());
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Não foi possível gerar um código de sala.");
}

function makeHumanPlayer(name, socket) {
  const account = socket.data.account || null;
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("hex"),
    userId: account?.id || null,
    username: account?.username || null,
    registered: Boolean(account?.id),
    name: account?.displayName || name,
    socketId: socket.id,
    connected: true,
    isBot: false,
    hand: [],
    score: 0
  };
}

function makeBotPlayer(room) {
  const used = new Set(room.players.map(player => player.name));
  const base = BOT_NAMES.find(name => !used.has(name)) || "Bot";
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base} ${suffix++}`;
  return {
    id: crypto.randomUUID(),
    token: null,
    name,
    socketId: null,
    connected: true,
    isBot: true,
    difficulty: room.botDifficulty,
    hand: [],
    score: 0
  };
}

function makeDeck() {
  const deck = [];
  let id = 0;
  for (let rank = 0; rank < RANKS.length; rank++) {
    for (let suit = 0; suit < SUITS.length; suit++) deck.push({ id: id++, rank, suit });
  }
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sortCards(cards) {
  return [...cards].sort((a, b) => a.rank - b.rank || a.suit - b.suit);
}

function compareTuples(a, b) {
  const size = Math.max(a.length, b.length);
  for (let i = 0; i < size; i++) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function analyze(cards) {
  const sorted = sortCards(cards);
  const count = sorted.length;

  if (count === 1) return { valid: true, count, type: "Carta", strength: [sorted[0].rank, sorted[0].suit] };

  if (count === 2 && sorted[0].rank === sorted[1].rank) {
    return { valid: true, count, type: "Dupla", strength: [sorted[0].rank, Math.max(...sorted.map(card => card.suit))] };
  }

  if (count === 3 && sorted.every(card => card.rank === sorted[0].rank)) {
    return { valid: true, count, type: "Trinca", strength: [sorted[0].rank] };
  }

  if (count !== 5) return { valid: false };

  const uniqueRanks = [...new Set(sorted.map(card => card.rank))];
  const isForbiddenJqka2 = uniqueRanks.length === 5 &&
    uniqueRanks.every((rank, index) => rank === 8 + index);
  const isStraight = !isForbiddenJqka2 && uniqueRanks.length === 5 &&
    uniqueRanks.every((rank, index) => index === 0 || rank === uniqueRanks[index - 1] + 1);
  const isFlush = sorted.every(card => card.suit === sorted[0].suit);

  const rankCounts = new Map();
  for (const card of sorted) rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
  const entries = [...rankCounts.entries()].map(([rank, amount]) => ({ rank, amount }));
  const four = entries.find(entry => entry.amount === 4);
  const triple = entries.find(entry => entry.amount === 3);
  const pair = entries.find(entry => entry.amount === 2);

  if (isStraight && isFlush) {
    const high = sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência do mesmo naipe", category: 4, strength: [4, high.rank, high.suit] };
  }

  if (four) {
    const kicker = sorted.find(card => card.rank !== four.rank);
    return { valid: true, count, type: "Quadra + carta", category: 3, strength: [3, four.rank, kicker.rank, kicker.suit] };
  }

  if (triple && pair) {
    return { valid: true, count, type: "Full House", category: 2, strength: [2, triple.rank] };
  }

  if (isFlush) {
    const ranksDescending = [...sorted]
      .sort((a, b) => b.rank - a.rank)
      .map(card => card.rank);
    return {
      valid: true,
      count,
      type: "Flush",
      category: 1,
      strength: [1, ...ranksDescending]
    };
  }

  if (isStraight) {
    const high = sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência", category: 0, strength: [0, high.rank, high.suit] };
  }

  return { valid: false };
}

function beats(combo, target) {
  return combo.valid && target.valid && combo.count === target.count && compareTuples(combo.strength, target.strength) > 0;
}

function roomPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function nextPlayerId(room, playerId) {
  const index = room.players.findIndex(player => player.id === playerId);
  return room.players[(index + 1) % room.players.length].id;
}

function allReady(room) {
  return room.players.length === 4 && room.players.every(player => player.isBot || player.connected);
}

function isPaused(room) {
  return room.status === "playing" && room.players.some(player => !player.isBot && !player.connected);
}

function publicLastPlay(room) {
  if (!room.lastPlay) return null;
  const player = roomPlayer(room, room.lastPlay.playerId);
  return {
    cards: sortCards(room.lastPlay.cards),
    combo: { type: room.lastPlay.combo.type, count: room.lastPlay.combo.count },
    playerId: room.lastPlay.playerId,
    playerName: player?.name || "Jogador"
  };
}

function stateFor(room, viewer) {
  return {
    code: room.code,
    status: room.status,
    isPublic: Boolean(room.isPublic),
    mode: room.mode,
    botDifficulty: room.botDifficulty,
    roundsPerBlock: room.roundsPerBlock,
    scoreLimit: room.scoreLimit,
    turnDuration: room.turnDuration,
    turnDeadline: room.turnDeadline || null,
    roundNumber: room.roundNumber,
    blockNumber: room.roundNumber > 0 ? Math.floor((room.roundNumber - 1) / room.roundsPerBlock) + 1 : 1,
    roundInBlock: room.roundNumber > 0 ? ((room.roundNumber - 1) % room.roundsPerBlock) + 1 : 0,
    closingPhase: Boolean(room.closingPhase),
    closingPlayerId: room.closingPlayerId || null,
    closingTurnsRemaining: Array.isArray(room.closingQueue) ? room.closingQueue.length : 0,
    paused: isPaused(room),
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      isBot: player.isBot,
      registered: Boolean(player.userId),
      username: player.username || null,
      botDifficulty: player.isBot ? (player.difficulty || room.botDifficulty) : null,
      cardCount: player.hand.length,
      score: player.score,
      isHost: player.id === room.hostId
    })),
    me: {
      id: viewer.id,
      name: viewer.name,
      registered: Boolean(viewer.userId),
      username: viewer.username || null,
      hand: sortCards(viewer.hand),
      token: viewer.token
    },
    hostId: room.hostId,
    currentPlayerId: room.currentPlayerId,
    firstMove: room.firstMove,
    lastPlay: publicLastPlay(room),
    passCount: room.passCount,
    winnerId: room.winnerId,
    seriesWinnerIds: room.seriesWinnerIds || [],
    seriesLoserIds: room.seriesLoserIds || [],
    roundResults: room.roundResults || [],
    rematchVoteIds: [...(room.rematchVotes || new Set())],
    rematchVoteCount: room.rematchVotes?.size || 0,
    rematchRequired: room.players.filter(player => !player.isBot).length
  };
}

function emitRoom(room) {
  syncTurnClock(room);
  room.updatedAt = Date.now();
  for (const player of room.players) {
    if (!player.isBot && player.connected && player.socketId) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) updatePresence(playerSocket, player.name);
      io.to(player.socketId).emit("room_state", stateFor(room, player));
    }
  }
  broadcastDirectory();
  scheduleBotTurn(room);
}

function emitNotice(room, text, tone = "info") {
  io.to(room.code).emit("notice", { text, tone });
}

function attachSocket(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(player.socketId);
    if (oldSocket) oldSocket.disconnect(true);
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

function validateTurn(room, player) {
  if (room.status !== "playing") return "A partida ainda não começou.";
  if (isPaused(room)) return "A partida está pausada até todos reconectarem.";
  if (room.currentPlayerId !== player.id) return "Ainda não é a sua vez.";
  return null;
}

function clearTurnTimer(code) {
  const timer = turnTimers.get(code);
  if (timer) clearTimeout(timer);
  turnTimers.delete(code);
}

function endTurn(room) {
  clearTurnTimer(room.code);
  room.currentPlayerId = null;
  room.turnDeadline = null;
  room.clockPlayerId = null;
  room.clockSerial = null;
}

function beginTurn(room, playerId) {
  clearTurnTimer(room.code);
  room.currentPlayerId = playerId;
  room.turnSerial = (room.turnSerial || 0) + 1;
  room.turnDeadline = null;
  room.clockPlayerId = null;
  room.clockSerial = null;
}

function chooseTimeoutPlay(room, player) {
  if (player.isBot) return chooseBotPlay(room, player);

  const legal = legalPlays(room, player);
  if (!legal.length) return null;

  legal.sort((a, b) => {
    if (!room.lastPlay && a.combo.count !== b.combo.count) {
      return b.combo.count - a.combo.count;
    }
    return compareTuples(a.combo.strength, b.combo.strength);
  });
  return legal[0];
}

function handleTurnTimeout(code, expectedPlayerId, expectedSerial) {
  turnTimers.delete(code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing" || isPaused(room)) return;
  if (room.currentPlayerId !== expectedPlayerId || room.turnSerial !== expectedSerial) return;

  room.turnDeadline = null;
  const player = roomPlayer(room, expectedPlayerId);
  if (!player) return;

  if (room.lastPlay) {
    emitNotice(room, `O tempo de ${player.name} acabou. A jogada foi passada automaticamente.`, "warning");
    performPass(room, player);
    return;
  }

  const automaticPlay = chooseTimeoutPlay(room, player);
  if (automaticPlay) {
    emitNotice(room, `O tempo de ${player.name} acabou. O sistema fez uma jogada automática.`, "warning");
    performPlay(room, player, automaticPlay.cards, automaticPlay.combo);
  }
}

function syncTurnClock(room) {
  const shouldRun = room.status === "playing" && room.currentPlayerId && !isPaused(room);
  if (!shouldRun) {
    clearTurnTimer(room.code);
    room.turnDeadline = null;
    room.clockPlayerId = null;
    room.clockSerial = null;
    return;
  }

  const timerIsCurrent =
    turnTimers.has(room.code) &&
    room.clockPlayerId === room.currentPlayerId &&
    room.clockSerial === room.turnSerial &&
    Number(room.turnDeadline) > Date.now();

  if (timerIsCurrent) return;

  clearTurnTimer(room.code);
  const durationMs = normalizeTurnDuration(room.turnDuration) * 1000;
  const playerId = room.currentPlayerId;
  const serial = room.turnSerial;
  room.turnDeadline = Date.now() + durationMs;
  room.clockPlayerId = playerId;
  room.clockSerial = serial;

  const timer = setTimeout(() => {
    handleTurnTimeout(room.code, playerId, serial);
  }, durationMs + 25);
  turnTimers.set(room.code, timer);
}

function resetSeries(room) {
  room.roundNumber = 0;
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
  room.rematchVotes = new Set();
  room.matchRecordId = null;
  room.statsRecorded = false;
  room.matchStartedAt = null;
  room.players.forEach(player => { player.score = 0; });
}

function startMatch(room, newSeries = false) {
  if (!allReady(room)) throw new Error("São necessários quatro jogadores ou bots.");
  if (newSeries) resetSeries(room);
  if (newSeries || !room.matchRecordId) {
    room.matchRecordId = crypto.randomUUID();
    room.statsRecorded = false;
    room.matchStartedAt = new Date().toISOString();
  }

  const deck = shuffle(makeDeck());
  room.players.forEach((player, index) => {
    player.hand = sortCards(deck.slice(index * 13, index * 13 + 13));
  });

  const starter = room.players.find(player => player.hand.some(card => card.rank === 0 && card.suit === 0));
  room.roundNumber += 1;
  room.status = "playing";
  beginTurn(room, starter.id);
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.playedCards = [];
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.closingPhase = false;
  room.closingPlayerId = null;
  room.closingQueue = [];
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
  room.rematchVotes = new Set();
  room.startedAt = Date.now();
}

function resetRoomToLobby(room) {
  clearBotTimer(room.code);
  clearTurnTimer(room.code);
  room.status = "lobby";
  endTurn(room);
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.playedCards = [];
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.closingPhase = false;
  room.closingPlayerId = null;
  room.closingQueue = [];
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
  room.rematchVotes = new Set();
  room.roundNumber = 0;
  room.players.forEach(player => {
    player.hand = [];
    player.score = 0;
  });
}

function orderedPlayerIdsAfter(room, playerId) {
  const startIndex = room.players.findIndex(player => player.id === playerId);
  const ids = [];
  for (let offset = 1; offset < room.players.length; offset++) {
    ids.push(room.players[(startIndex + offset) % room.players.length].id);
  }
  return ids;
}

function queueCompletedMatchRecord(room) {
  if (room.statsRecorded || room.status !== "finished") return;
  room.statsRecorded = true;
  const registeredPlayers = room.players.filter(player => !player.isBot && player.userId);
  const participants = [...new Set(registeredPlayers.map(player => player.userId))];
  const winnerPlayerIds = new Set(room.seriesWinnerIds || []);
  const winners = [...new Set(registeredPlayers
    .filter(player => winnerPlayerIds.has(player.id))
    .map(player => player.userId))];

  storage.recordMatch({
    id: room.matchRecordId || crypto.randomUUID(),
    roomCode: room.code,
    mode: room.mode === "points" ? "blocks" : "single",
    participantUserIds: participants,
    winnerUserIds: winners,
    startedAt: room.matchStartedAt || null,
    finishedAt: new Date().toISOString()
  }).then(result => {
    if (!result?.recorded) return;
    for (const player of registeredPlayers) {
      if (player.socketId) io.to(player.socketId).emit("profile_updated");
    }
  }).catch(error => {
    room.statsRecorded = false;
    console.error("Falha ao registrar resultado da partida:", error);
  });
}

function finishRound(room) {
  clearBotTimer(room.code);
  clearTurnTimer(room.code);
  endTurn(room);
  room.closingPhase = false;
  room.closingQueue = [];
  room.rematchVotes = new Set();

  const results = room.players.map(player => {
    const points = player.hand.length;
    if (room.mode === "points") player.score += points;
    return {
      playerId: player.id,
      name: player.name,
      remainingCards: player.hand.length,
      multiplier: 1,
      delta: room.mode === "points" ? points : 0,
      score: player.score
    };
  });
  room.roundResults = results.sort((a, b) => a.remainingCards - b.remainingCards || a.name.localeCompare(b.name, "pt-BR"));

  if (room.mode === "single") {
    room.status = "finished";
    room.seriesWinnerIds = room.winnerId ? [room.winnerId] : [];
    room.seriesLoserIds = [];
    queueCompletedMatchRecord(room);
    return;
  }

  const completedBlock = room.roundNumber % room.roundsPerBlock === 0;
  if (!completedBlock) {
    room.status = "round_finished";
    return;
  }

  const highestScore = Math.max(...room.players.map(player => player.score));
  if (highestScore >= room.scoreLimit) {
    room.status = "finished";
    room.seriesLoserIds = room.players.filter(player => player.score === highestScore).map(player => player.id);
    const lowestScore = Math.min(...room.players.map(player => player.score));
    room.seriesWinnerIds = room.players.filter(player => player.score === lowestScore).map(player => player.id);
    queueCompletedMatchRecord(room);
  } else {
    room.status = "block_finished";
    room.seriesLoserIds = [];
    room.seriesWinnerIds = [];
  }
}

function startClosingPhase(room, hitter) {
  room.winnerId = hitter.id;
  room.closingPhase = true;
  room.closingPlayerId = hitter.id;
  room.closingQueue = orderedPlayerIdsAfter(room, hitter.id);
  room.passCount = 0;

  if (room.closingQueue.length === 0) {
    finishRound(room);
    return;
  }

  beginTurn(room, room.closingQueue[0]);
}

function advanceClosingTurn(room, actingPlayer) {
  if (room.closingQueue[0] === actingPlayer.id) room.closingQueue.shift();
  else room.closingQueue = room.closingQueue.filter(playerId => playerId !== actingPlayer.id);

  if (room.closingQueue.length === 0) {
    finishRound(room);
    emitNotice(room, "Todos concluíram a jogada final. A rodada terminou.", "success");
    emitRoom(room);
    return true;
  }

  beginTurn(room, room.closingQueue[0]);
  return false;
}

function validateCardsForPlay(room, player, requestedIds) {
  if (![1, 2, 3, 5].includes(requestedIds.length)) throw new Error("Selecione 1, 2, 3 ou 5 cartas.");
  const cards = requestedIds.map(id => player.hand.find(card => card.id === id));
  if (cards.some(card => !card)) throw new Error("Uma das cartas selecionadas não está na sua mão.");
  const combo = analyze(cards);
  if (!combo.valid) throw new Error("Essa seleção não forma uma jogada válida.");
  if (room.firstMove && !cards.some(card => card.rank === 0 && card.suit === 0)) {
    throw new Error("A primeira jogada precisa conter o 3 de Ouros.");
  }
  if (room.lastPlay && combo.count !== room.lastPlay.combo.count) {
    throw new Error(`Jogue exatamente ${room.lastPlay.combo.count} carta(s).`);
  }
  if (room.lastPlay && !beats(combo, room.lastPlay.combo)) {
    throw new Error("Sua combinação precisa ser maior que a jogada da mesa.");
  }
  return { cards, combo };
}

function performPlay(room, player, cards, combo) {
  const selected = new Set(cards.map(card => card.id));
  player.hand = player.hand.filter(card => !selected.has(card.id));
  room.lastPlay = { cards: sortCards(cards), combo, playerId: player.id };
  if (!Array.isArray(room.playedCards)) room.playedCards = [];
  room.playedCards.push(...cards.map(card => ({ id: card.id, rank: card.rank, suit: card.suit })));
  room.lastPlayerId = player.id;
  room.passCount = 0;
  room.firstMove = false;

  if (room.closingPhase) {
    emitNotice(room, `${player.name} fez sua jogada final com ${combo.type}.`, "success");
    if (!advanceClosingTurn(room, player)) emitRoom(room);
    return;
  }

  if (player.hand.length === 0) {
    startClosingPhase(room, player);
    emitNotice(room, `${player.name} bateu! Cada adversário agora tem uma última jogada para superar a mesa.`, "success");
    emitRoom(room);
    return;
  }

  beginTurn(room, nextPlayerId(room, player.id));
  emitNotice(room, `${player.name} jogou ${combo.type}.`, "success");
  emitRoom(room);
}

function performPass(room, player) {
  if (room.closingPhase) {
    emitNotice(room, `${player.name} passou na jogada final.`, "info");
    if (!advanceClosingTurn(room, player)) emitRoom(room);
    return;
  }

  room.passCount += 1;
  if (room.passCount >= 3) {
    const opener = roomPlayer(room, room.lastPlayerId);
    beginTurn(room, room.lastPlayerId);
    room.lastPlay = null;
    room.lastPlayerId = null;
    room.passCount = 0;
    emitNotice(room, `${opener.name} venceu a rodada e abre a mesa.`, "success");
    emitRoom(room);
    return;
  }
  beginTurn(room, nextPlayerId(room, player.id));
  emitNotice(room, `${player.name} passou.`, "info");
  emitRoom(room);
}

function combinations(array, amount) {
  const output = [];
  function walk(start, picked) {
    if (picked.length === amount) {
      output.push([...picked]);
      return;
    }
    for (let index = start; index <= array.length - (amount - picked.length); index++) {
      picked.push(array[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  }
  walk(0, []);
  return output;
}

function legalPlays(room, player) {
  const sizes = room.lastPlay ? [room.lastPlay.combo.count] : [1, 2, 3, 5];
  const legal = [];
  for (const size of sizes) {
    if (player.hand.length < size) continue;
    for (const cards of combinations(player.hand, size)) {
      const combo = analyze(cards);
      if (!combo.valid) continue;
      if (room.firstMove && !cards.some(card => card.rank === 0 && card.suit === 0)) continue;
      if (room.lastPlay && !beats(combo, room.lastPlay.combo)) continue;
      legal.push({ cards, combo });
    }
  }
  return legal;
}


function bitCount(value) {
  let count = 0;
  let remaining = value >>> 0;
  while (remaining) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function buildBotAnalysisContext(hand) {
  const cards = sortCards(hand);
  const idToBit = new Map(cards.map((card, index) => [card.id, 1 << index]));
  const fullMask = (1 << cards.length) - 1;
  const masksByCardIndex = Array.from({ length: cards.length }, () => []);
  const fiveMasks = [];
  const allPlayMasks = [];
  const playByMask = new Map();
  const participation = new Map(cards.map(card => [card.id, 0]));

  for (const size of [1, 2, 3, 5]) {
    if (cards.length < size) continue;
    for (const subset of combinations(cards, size)) {
      const combo = analyze(subset);
      if (!combo.valid) continue;
      const mask = subset.reduce((value, card) => value | idToBit.get(card.id), 0);
      const option = {
        mask,
        count: size,
        strength: combo.strength,
        comboType: combo.type
      };
      allPlayMasks.push(option);
      playByMask.set(mask, option);
      subset.forEach(card => {
        const index = Math.log2(idToBit.get(card.id));
        masksByCardIndex[index].push(mask);
      });
      if (size === 5) {
        fiveMasks.push(mask);
        subset.forEach(card => participation.set(card.id, participation.get(card.id) + 1));
      }
    }
  }

  const minTurnsMemo = new Map([[0, 0]]);
  function minTurns(mask) {
    if (minTurnsMemo.has(mask)) return minTurnsMemo.get(mask);
    const firstBit = mask & -mask;
    const firstIndex = Math.log2(firstBit);
    let best = bitCount(mask);
    for (const playMask of masksByCardIndex[firstIndex]) {
      if ((playMask & mask) !== playMask) continue;
      best = Math.min(best, 1 + minTurns(mask ^ playMask));
      if (best === 1) break;
    }
    minTurnsMemo.set(mask, best);
    return best;
  }

  const emptyPlan = Object.freeze({
    turns: 0,
    singles: 0,
    pairs: 0,
    triples: 0,
    fives: 0,
    largestPlay: 0
  });
  const bestPlanMemo = new Map([[0, emptyPlan]]);

  function planIsBetter(candidate, current) {
    if (!current) return true;
    if (candidate.turns !== current.turns) return candidate.turns < current.turns;
    if (candidate.singles !== current.singles) return candidate.singles < current.singles;
    if (candidate.fives !== current.fives) return candidate.fives > current.fives;
    if (candidate.triples !== current.triples) return candidate.triples > current.triples;
    if (candidate.pairs !== current.pairs) return candidate.pairs > current.pairs;
    return candidate.largestPlay > current.largestPlay;
  }

  function bestPlan(mask) {
    if (bestPlanMemo.has(mask)) return bestPlanMemo.get(mask);
    const firstBit = mask & -mask;
    const firstIndex = Math.log2(firstBit);
    let best = null;

    for (const playMask of masksByCardIndex[firstIndex]) {
      if ((playMask & mask) !== playMask) continue;
      const option = playByMask.get(playMask);
      const child = bestPlan(mask ^ playMask);
      const candidate = {
        turns: child.turns + 1,
        singles: child.singles + (option.count === 1 ? 1 : 0),
        pairs: child.pairs + (option.count === 2 ? 1 : 0),
        triples: child.triples + (option.count === 3 ? 1 : 0),
        fives: child.fives + (option.count === 5 ? 1 : 0),
        largestPlay: Math.max(child.largestPlay, option.count)
      };
      if (planIsBetter(candidate, best)) best = candidate;
    }

    const resolved = best || {
      turns: bitCount(mask),
      singles: bitCount(mask),
      pairs: 0,
      triples: 0,
      fives: 0,
      largestPlay: 1
    };
    bestPlanMemo.set(mask, resolved);
    return resolved;
  }

  return {
    cards,
    idToBit,
    fullMask,
    fiveMasks,
    allPlayMasks,
    playByMask,
    participation,
    minTurns,
    bestPlan
  };
}

function cardsMask(context, cards) {
  return cards.reduce((mask, card) => mask | (context.idToBit.get(card.id) || 0), 0);
}

function cardsFromMask(context, mask) {
  return context.cards.filter((_card, index) => mask & (1 << index));
}

function handStructureScore(hand, context = null, mask = null) {
  if (!hand.length) return 0;
  const rankCounts = new Map();
  const suitCounts = new Map();
  for (const card of hand) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
    suitCounts.set(card.suit, (suitCounts.get(card.suit) || 0) + 1);
  }

  let score = 0;
  for (const amount of rankCounts.values()) {
    if (amount === 2) score += 13;
    else if (amount === 3) score += 28;
    else if (amount === 4) score += 38;
  }

  for (const amount of suitCounts.values()) {
    if (amount >= 4) score += (amount - 3) * 5;
  }

  const uniqueRanks = [...rankCounts.keys()].sort((a, b) => a - b);
  let currentRun = 1;
  let bestRun = 1;
  for (let index = 1; index < uniqueRanks.length; index++) {
    if (uniqueRanks[index] === uniqueRanks[index - 1] + 1) currentRun += 1;
    else currentRun = 1;
    bestRun = Math.max(bestRun, currentRun);
  }
  score += Math.max(0, bestRun - 2) * 5;

  if (context && mask !== null) {
    let availableFiveCardGames = 0;
    for (const fiveMask of context.fiveMasks) {
      if ((fiveMask & mask) === fiveMask) availableFiveCardGames += 1;
    }
    score += Math.min(availableFiveCardGames, 10) * 3;
  }

  return score;
}

function brokenCombinationPenalty(originalHand, playedCards, remainingHand, combo, context) {
  if (!remainingHand.length) return 0;
  const originalRanks = new Map();
  const playedRanks = new Map();
  const remainingRanks = new Map();

  originalHand.forEach(card => originalRanks.set(card.rank, (originalRanks.get(card.rank) || 0) + 1));
  playedCards.forEach(card => playedRanks.set(card.rank, (playedRanks.get(card.rank) || 0) + 1));
  remainingHand.forEach(card => remainingRanks.set(card.rank, (remainingRanks.get(card.rank) || 0) + 1));

  let penalty = 0;
  for (const [rank, originalAmount] of originalRanks.entries()) {
    const used = playedRanks.get(rank) || 0;
    const left = remainingRanks.get(rank) || 0;
    if (originalAmount >= 2 && used > 0 && left > 0) {
      if (originalAmount === 2) penalty += 20;
      else if (originalAmount === 3) penalty += 28;
      else penalty += 34;
    }
  }

  if (combo.count < 5) {
    for (const card of playedCards) {
      penalty += Math.min(context.participation.get(card.id) || 0, 5) * 2.5;
    }
  }

  return penalty;
}

function comboPowerCost(combo) {
  if (!combo?.strength) return 0;
  return combo.strength.reduce((total, value, index) => total + Number(value || 0) * (index === 0 ? 4 : 1), 0);
}

function publicDangerLevel(room, player) {
  const opponents = room.players.filter(item => item.id !== player.id);
  const minimumCards = Math.min(...opponents.map(item => item.hand.length));
  if (minimumCards <= 1) return 3;
  if (minimumCards <= 2) return 2;
  if (minimumCards <= 4) return 1;
  return 0;
}

function remainingControlScore(room, player, remainingHand) {
  const playedCards = room.playedCards || [];
  const higherPlayed = rank => playedCards.filter(card => card.rank > rank).length;
  let score = 0;
  for (const card of remainingHand) {
    if (card.rank === 12) score += 10;
    else if (card.rank === 11) score += 5 + Math.min(3, higherPlayed(card.rank));
    else if (card.rank === 10) score += 2;
  }
  return score;
}

function expertRemainingHandScore(remainingHand, remainingMask, context) {
  if (!remainingHand.length) return 0;
  let legalOptions = 0;
  let fiveCardOptions = 0;
  let largestNextPlay = 1;

  for (const option of context.allPlayMasks) {
    if ((option.mask & remainingMask) !== option.mask) continue;
    legalOptions += 1;
    largestNextPlay = Math.max(largestNextPlay, option.count);
    if (option.count === 5) fiveCardOptions += 1;
  }

  const rankCounts = new Map();
  remainingHand.forEach(card => rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1));
  const isolatedCards = remainingHand.filter(card =>
    rankCounts.get(card.rank) === 1 && (context.participation.get(card.id) || 0) === 0
  ).length;

  return Math.min(legalOptions, 45) * 1.5 + Math.min(fiveCardOptions, 12) * 5 + largestNextPlay * 13 - isolatedCards * 8;
}

function expertResponsePressure(room, player, play) {
  if (!room.lastPlay || room.closingPhase) return 0;
  const danger = publicDangerLevel(room, player);
  const power = comboPowerCost(play.combo);
  const opponentCards = room.players.filter(item => item.id !== player.id).map(item => item.hand.length);
  const lowOpponentCount = opponentCards.filter(amount => amount <= 3).length;
  return power * (danger * 1.8 + lowOpponentCount * 0.8);
}

function evaluateBotPlay(room, player, play, context, difficulty) {
  const playedMask = cardsMask(context, play.cards);
  const remainingMask = context.fullMask ^ playedMask;
  const remainingHand = cardsFromMask(context, remainingMask);
  const danger = publicDangerLevel(room, player);
  const remainingTurns = context.minTurns(remainingMask);
  const structure = handStructureScore(remainingHand, context, remainingMask);
  const broken = brokenCombinationPenalty(player.hand, play.cards, remainingHand, play.combo, context);
  const powerCost = comboPowerCost(play.combo);
  const control = remainingControlScore(room, player, remainingHand);
  const isOpening = !room.lastPlay;
  const finishes = remainingHand.length === 0;
  const finalPhase = room.closingPhase;
  const nearestOpponent = Math.min(...room.players.filter(item => item.id !== player.id).map(item => item.hand.length));

  let score = 0;

  if (finalPhase) {
    score += play.cards.length * 260;
    score -= remainingHand.length * 120;
    score -= remainingTurns * 70;
    if (finishes) score += 10000;
    return score;
  }

  const isExpert = difficulty === "expert";
  const isAdvanced = difficulty === "hard" || isExpert;
  score += play.cards.length * (isExpert ? 52 : isAdvanced ? 44 : 38);
  score -= remainingTurns * (isExpert ? 128 : isAdvanced ? 105 : 78);
  score += structure * (isExpert ? 3.6 : isAdvanced ? 2.8 : 1.9);
  score -= broken * (isExpert ? 2.05 : isAdvanced ? 1.55 : 1.15);
  score += control * (isExpert ? 1.9 : isAdvanced ? 1.5 : 0.9);
  if (isExpert) {
    score += expertRemainingHandScore(remainingHand, remainingMask, context);
    score += expertResponsePressure(room, player, play);
  }

  if (finishes) score += 12000;

  if (isOpening) {
    score += play.cards.length * (isExpert ? 36 : isAdvanced ? 30 : 22);
    if (nearestOpponent <= 1 && play.combo.count === 1) score -= 180;
    if (nearestOpponent <= 2 && play.combo.count >= 2) score += 90;
  } else {
    score -= powerCost * (isExpert ? 2.7 : isAdvanced ? 2.4 : 1.7);
  }

  for (const card of play.cards) {
    if (card.rank === 12) score -= danger >= 2 ? 5 : (isExpert ? 68 : isAdvanced ? 55 : 38);
    else if (card.rank === 11) score -= danger >= 2 ? 2 : (isExpert ? 27 : isAdvanced ? 20 : 13);
  }

  if (danger >= 1) {
    score += play.cards.length * danger * 22;
    score -= remainingTurns * danger * 18;
  }

  if (danger >= 2 && room.lastPlay?.combo.count === 1) {
    score += powerCost * 3.2;
  }

  if (room.mode === "points") {
    const proximity = Math.max(0, player.score - 20);
    score += play.cards.length * proximity * 1.8;
    score -= remainingHand.length * proximity * 1.2;
  }

  return score;
}


function playerOrderAfter(room, playerId) {
  const index = room.players.findIndex(item => item.id === playerId);
  const ordered = [];
  for (let offset = 1; offset < room.players.length; offset++) {
    ordered.push(room.players[(index + offset) % room.players.length]);
  }
  return ordered;
}

function seededGenerator(seedText) {
  let seed = 2166136261;
  for (const character of String(seedText)) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  seed >>>= 0;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

function shuffledCopyWithRandom(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function sampledHandCanBeat(hand, targetCombo) {
  const count = targetCombo.count;
  if (hand.length < count) return false;

  if (count === 1) {
    return hand.some(card => beats(analyze([card]), targetCombo));
  }

  if (count === 2 || count === 3) {
    const ranks = new Map();
    for (const card of hand) {
      if (!ranks.has(card.rank)) ranks.set(card.rank, []);
      ranks.get(card.rank).push(card);
    }
    for (const sameRankCards of ranks.values()) {
      if (sameRankCards.length < count) continue;
      const selected = [...sameRankCards]
        .sort((a, b) => b.suit - a.suit)
        .slice(0, count);
      if (beats(analyze(selected), targetCombo)) return true;
    }
    return false;
  }

  for (const cards of combinations(hand, 5)) {
    const combo = analyze(cards);
    if (combo.valid && beats(combo, targetCombo)) return true;
  }
  return false;
}

function estimateExpertHoldProbability(room, player, play, sampleCount) {
  const knownIds = new Set([
    ...player.hand.map(card => card.id),
    ...(room.playedCards || []).map(card => card.id)
  ]);
  const unknownCards = makeDeck().filter(card => !knownIds.has(card.id));
  const opponents = playerOrderAfter(room, player.id);
  const expectedUnknown = opponents.reduce((total, opponent) => total + opponent.hand.length, 0);
  if (unknownCards.length !== expectedUnknown || opponents.length === 0) return 0.5;

  const playKey = play.cards.map(card => card.id).sort((a, b) => a - b).join('-');
  const random = seededGenerator(`${room.code}|${room.roundNumber}|${room.turnSerial}|${player.id}|${playKey}`);
  let holds = 0;

  for (let sample = 0; sample < sampleCount; sample++) {
    const shuffled = shuffledCopyWithRandom(unknownCards, random);
    let cursor = 0;
    let beaten = false;

    for (const opponent of opponents) {
      const sampledHand = shuffled.slice(cursor, cursor + opponent.hand.length);
      cursor += opponent.hand.length;
      if (sampledHandCanBeat(sampledHand, play.combo)) {
        beaten = true;
        break;
      }
    }

    if (!beaten) holds += 1;
  }

  return holds / sampleCount;
}

function isolatedCardPenalty(hand, context) {
  const rankCounts = new Map();
  hand.forEach(card => rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1));
  let penalty = 0;
  for (const card of hand) {
    if (rankCounts.get(card.rank) !== 1) continue;
    const fiveParticipation = context.participation.get(card.id) || 0;
    if (fiveParticipation === 0) penalty += card.rank <= 5 ? 14 : 7;
  }
  return penalty;
}

function highCardUseCost(cards, danger) {
  let cost = 0;
  for (const card of cards) {
    if (card.rank === 12) cost += danger >= 2 ? 80 : 1450;
    else if (card.rank === 11) cost += danger >= 2 ? 30 : 520;
    else if (card.rank === 10) cost += danger >= 2 ? 10 : 140;
  }
  return cost;
}

function lowCardDisposalBonus(cards) {
  return cards.reduce((total, card) => {
    if (card.rank <= 5) return total + (6 - card.rank) * 75;
    return total;
  }, 0);
}

const BOT_AI_PROFILES = Object.freeze({
  medium: Object.freeze({
    turnWeight: 6200,
    singlePenalty: 560,
    fiveBonus: 390,
    tripleBonus: 210,
    pairBonus: 105,
    cardsPlayedBonus: 520,
    structureWeight: 9,
    brokenWeight: 17,
    controlWeight: 8,
    isolatedWeight: 15,
    highCardWeight: 0.48,
    lowCardWeight: 0.48,
    openingPowerCost: 7,
    safeResponsePowerCost: 31,
    dangerResponsePowerBonus: 16,
    canPassStrategically: false,
    simulationSamples: 0
  }),
  hard: Object.freeze({
    turnWeight: 8600,
    singlePenalty: 830,
    fiveBonus: 610,
    tripleBonus: 315,
    pairBonus: 155,
    cardsPlayedBonus: 700,
    structureWeight: 13,
    brokenWeight: 24,
    controlWeight: 13,
    isolatedWeight: 23,
    highCardWeight: 0.72,
    lowCardWeight: 0.67,
    openingPowerCost: 12,
    safeResponsePowerCost: 48,
    dangerResponsePowerBonus: 31,
    canPassStrategically: true,
    simulationSamples: 0
  }),
  expert: Object.freeze({
    turnWeight: 11200,
    singlePenalty: 1180,
    fiveBonus: 760,
    tripleBonus: 390,
    pairBonus: 190,
    cardsPlayedBonus: 860,
    structureWeight: 17,
    brokenWeight: 30,
    controlWeight: 19,
    isolatedWeight: 34,
    highCardWeight: 1,
    lowCardWeight: 1,
    openingPowerCost: 23,
    safeResponsePowerCost: 78,
    dangerResponsePowerBonus: 56,
    canPassStrategically: true,
    simulationSamples: 12
  })
});

function botPlanStateScore(room, player, hand, mask, context, profile) {
  const plan = context.bestPlan(mask);
  const structure = handStructureScore(hand, context, mask);
  const control = remainingControlScore(room, player, hand);

  let score = 0;
  score -= plan.turns * profile.turnWeight;
  score -= plan.singles * profile.singlePenalty;
  score += plan.fives * profile.fiveBonus;
  score += plan.triples * profile.tripleBonus;
  score += plan.pairs * profile.pairBonus;
  score += structure * profile.structureWeight;
  score += control * profile.controlWeight;
  score -= isolatedCardPenalty(hand, context) * profile.isolatedWeight;

  return { score, plan, structure, control };
}

function botCandidateMetrics(room, player, play, context, difficulty) {
  const profile = BOT_AI_PROFILES[difficulty] || BOT_AI_PROFILES.medium;
  const playedMask = cardsMask(context, play.cards);
  const remainingMask = context.fullMask ^ playedMask;
  const remainingHand = cardsFromMask(context, remainingMask);
  const state = botPlanStateScore(room, player, remainingHand, remainingMask, context, profile);
  const danger = publicDangerLevel(room, player);
  const broken = brokenCombinationPenalty(
    player.hand,
    play.cards,
    remainingHand,
    play.combo,
    context
  );
  const power = comboPowerCost(play.combo);
  const finishes = remainingHand.length === 0;
  const opening = !room.lastPlay;
  const opponents = room.players.filter(item => item.id !== player.id);
  const nearestOpponent = opponents.length
    ? Math.min(...opponents.map(item => item.hand.length))
    : 13;

  let score = state.score;
  score += play.cards.length * profile.cardsPlayedBonus;
  score -= broken * profile.brokenWeight;
  score -= highCardUseCost(play.cards, danger) * profile.highCardWeight;
  score += lowCardDisposalBonus(play.cards) * profile.lowCardWeight;

  if (finishes) score += 1_000_000;

  // Depois de uma batida, não existe motivo para economizar cartas.
  if (room.closingPhase) {
    score += play.cards.length * 24_000;
    score -= remainingHand.length * 10_000;
    score -= state.plan.turns * 5_000;
    return {
      play,
      score,
      remainingMask,
      remainingHand,
      plan: state.plan,
      broken,
      holdProbability: 0
    };
  }

  if (state.plan.turns === 1 && remainingHand.length > 0) {
    score += difficulty === "medium" ? 5_000 : difficulty === "hard" ? 8_000 : 11_000;
  } else if (state.plan.turns === 2 && remainingHand.length > 0) {
    score += difficulty === "medium" ? 1_000 : difficulty === "hard" ? 2_000 : 3_000;
  }

  if (opening) {
    // Em mesa livre, elimina cartas baixas sem gastar combinações dominantes.
    score += play.cards.length * (difficulty === "medium" ? 230 : difficulty === "hard" ? 330 : 420);
    if (danger === 0) score -= power * profile.openingPowerCost;

    // Não entrega ao adversário exatamente o tipo de jogo com que ele pode bater.
    for (const opponent of opponents) {
      if (opponent.hand.length <= 5 && play.combo.count === opponent.hand.length) {
        score -= (7 - opponent.hand.length) *
          (difficulty === "medium" ? 750 : difficulty === "hard" ? 1450 : 2400);
      }
    }

    if (nearestOpponent <= 2 && play.combo.count !== nearestOpponent) {
      score += difficulty === "medium" ? 900 : difficulty === "hard" ? 1600 : 2300;
    }
  } else if (danger === 0) {
    // Sem perigo imediato, usa a menor força que preserve a mão.
    score -= power * profile.safeResponsePowerCost;
  } else {
    // Com adversário perto de bater, aumenta a chance de manter o controle.
    score += power * profile.dangerResponsePowerBonus * danger;
  }

  if (danger >= 1) {
    score += play.cards.length * danger *
      (difficulty === "medium" ? 420 : difficulty === "hard" ? 690 : 920);
    score -= state.plan.turns * danger *
      (difficulty === "medium" ? 540 : difficulty === "hard" ? 900 : 1250);
  }

  if (room.mode === "points") {
    const scorePressure = Math.max(0, player.score - 18);
    score += play.cards.length * scorePressure *
      (difficulty === "medium" ? 34 : difficulty === "hard" ? 62 : 95);
    score -= remainingHand.length * scorePressure *
      (difficulty === "medium" ? 16 : difficulty === "hard" ? 30 : 45);
  }

  return {
    play,
    score,
    remainingMask,
    remainingHand,
    plan: state.plan,
    broken,
    holdProbability: 0
  };
}

function botPassScore(room, player, context, difficulty) {
  const profile = BOT_AI_PROFILES[difficulty] || BOT_AI_PROFILES.medium;
  const current = botPlanStateScore(room, player, player.hand, context.fullMask, context, profile);
  const danger = publicDangerLevel(room, player);
  const nextPlayer = roomPlayer(room, nextPlayerId(room, player.id));
  const tableOwner = room.lastPlay ? roomPlayer(room, room.lastPlay.playerId) : null;

  let score = current.score;

  // Passar pode preservar a mão, mas deve ser raro e nunca ocorrer em perigo real.
  if (danger === 0) {
    score += difficulty === "hard" ? 900 : 1200;
  } else if (danger === 1) {
    score -= difficulty === "hard" ? 4_500 : 6_000;
  } else if (danger === 2) {
    score -= 22_000;
  } else {
    score -= 42_000;
  }

  if (nextPlayer && nextPlayer.hand.length <= 2) score -= 12_000;
  if (tableOwner && tableOwner.hand.length <= 2) score -= 10_000;
  if (room.mode === "points" && player.score >= 25) score -= 8_000;

  return score;
}

function sortBotCandidates(candidates, room, danger) {
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.plan.turns !== b.plan.turns) return a.plan.turns - b.plan.turns;
    if (a.plan.singles !== b.plan.singles) return a.plan.singles - b.plan.singles;
    if (b.play.cards.length !== a.play.cards.length) {
      return b.play.cards.length - a.play.cards.length;
    }

    const strengthComparison = compareTuples(a.play.combo.strength, b.play.combo.strength);
    // Resposta segura: prefere a menor combinação suficiente.
    // Perigo alto: prefere a combinação mais forte entre empates estratégicos.
    if (room.lastPlay && danger >= 2) return -strengthComparison;
    return strengthComparison;
  });
  return candidates;
}

function chooseStrategicBotPlay(room, player, legal, difficulty) {
  const profile = BOT_AI_PROFILES[difficulty] || BOT_AI_PROFILES.medium;
  const context = buildBotAnalysisContext(player.hand);
  const danger = publicDangerLevel(room, player);
  const evaluated = sortBotCandidates(
    legal.map(play => botCandidateMetrics(room, player, play, context, difficulty)),
    room,
    danger
  );

  let shortlist = evaluated;

  // O Especialista testa distribuições possíveis das cartas desconhecidas.
  if (difficulty === "expert") {
    const shortlistSize = player.hand.length <= 6 || danger >= 2 ? 10 : 7;
    shortlist = evaluated.slice(0, shortlistSize);
    const samples = danger >= 2
      ? 18
      : player.hand.length <= 6
        ? 15
        : profile.simulationSamples;

    for (const candidate of shortlist) {
      if (candidate.remainingHand.length === 0 || room.closingPhase) continue;
      candidate.holdProbability = estimateExpertHoldProbability(
        room,
        player,
        candidate.play,
        samples
      );
      const oneTurnFinish = candidate.plan.turns === 1;
      const holdWeight = oneTurnFinish
        ? 10_000
        : player.hand.length <= 6
          ? 5_800
          : 2_100;
      candidate.score += candidate.holdProbability * (holdWeight + danger * 3_500);
    }

    sortBotCandidates(shortlist, room, danger);
  }

  const chosen = shortlist[0] || evaluated[0];
  if (!chosen) return null;

  // Mesa livre, batida ou possibilidade de terminar: sempre joga.
  if (
    room.closingPhase ||
    !room.lastPlay ||
    chosen.remainingHand.length === 0 ||
    chosen.play.cards.length === player.hand.length
  ) {
    return chosen.play;
  }

  // O Médio nunca dá um passe estratégico: ele joga a melhor opção legal.
  if (!profile.canPassStrategically) return chosen.play;

  // Difícil e Especialista jamais passam quando alguém está com até duas cartas.
  if (danger >= 2) return chosen.play;

  const passScore = botPassScore(room, player, context, difficulty);
  return chosen.score >= passScore ? chosen.play : null;
}

function chooseBotPlay(room, player) {
  const legal = legalPlays(room, player);
  if (!legal.length) return null;

  const difficulty = normalizeBotDifficulty(player.difficulty || room.botDifficulty);
  return chooseStrategicBotPlay(room, player, legal, difficulty);
}

function clearBotTimer(code) {
  const timer = botTimers.get(code);
  if (timer) clearTimeout(timer);
  botTimers.delete(code);
}

function scheduleBotTurn(room) {
  clearBotTimer(room.code);
  if (room.status !== "playing" || isPaused(room)) return;
  const player = roomPlayer(room, room.currentPlayerId);
  if (!player?.isBot) return;

  const timer = setTimeout(() => {
    botTimers.delete(room.code);
    const currentRoom = rooms.get(room.code);
    const currentBot = currentRoom && roomPlayer(currentRoom, currentRoom.currentPlayerId);
    if (!currentRoom || currentRoom.status !== "playing" || !currentBot?.isBot || isPaused(currentRoom)) return;
    const choice = chooseBotPlay(currentRoom, currentBot);
    if (choice) performPlay(currentRoom, currentBot, choice.cards, choice.combo);
    else if (currentRoom.lastPlay) performPass(currentRoom, currentBot);
  }, 700 + crypto.randomInt(0, 700));
  botTimers.set(room.code, timer);
}

function rematchHumans(room) {
  return room.players.filter(player => !player.isBot);
}

function allRematchVotesReceived(room) {
  const humans = rematchHumans(room);
  return humans.length > 0 && humans.every(player => room.rematchVotes?.has(player.id));
}

function tryStartVotedRematch(room) {
  if (!["round_finished", "block_finished", "finished"].includes(room.status)) return false;
  if (!allRematchVotesReceived(room) || !allReady(room)) return false;
  const newSeries = room.status === "finished";
  startMatch(room, newSeries);
  emitNotice(room, `${roomPlayer(room, room.currentPlayerId).name} começa com o 3 de Ouros.`, "success");
  emitRoom(room);
  return true;
}

io.use(async (socket, next) => {
  try {
    const decoded = verifyAuthToken(socket.handshake.auth?.token);
    socket.data.account = decoded ? await storage.getUserById(decoded.sub) : null;
  } catch {
    socket.data.account = null;
  }
  next();
});

io.on("connection", socket => {
  socket.emit("auth_state", { user: socket.data.account || null });
  socket.emit("directory_state", directoryState());

  socket.on("authenticate_user", async (payload, callback = () => {}) => {
    try {
      const decoded = verifyAuthToken(payload?.token);
      const account = decoded ? await storage.getUserById(decoded.sub) : null;
      socket.data.account = account;
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (player && account) {
        const duplicate = room.players.some(item => item.id !== player.id && item.userId === account.id);
        const duplicateName = room.players.some(item => item.id !== player.id && item.name.toLowerCase() === account.displayName.toLowerCase());
        if (!duplicate && !duplicateName) {
          player.userId = account.id;
          player.username = account.username;
          player.registered = true;
          player.name = account.displayName;
        }
      }
      updatePresence(socket, account?.displayName || null);
      broadcastDirectory();
      if (room) emitRoom(room);
      callback({ ok: true, user: account });
    } catch (error) {
      callback({ ok: false, error: "Não foi possível autenticar a conta." });
    }
  });

  socket.on("set_presence", (payload, callback = () => {}) => {
    try {
      const name = normalizeName(payload?.name);
      if (name.length < 2) {
        onlineUsers.delete(socket.id);
        broadcastDirectory();
        callback({ ok: true, listed: false });
        return;
      }
      updatePresence(socket, name);
      broadcastDirectory();
      callback({ ok: true, listed: true });
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível atualizar sua presença." });
    }
  });

  socket.on("create_room", (payload, callback = () => {}) => {
    try {
      const requestedName = normalizeName(payload?.name);
      const name = socket.data.account?.displayName || requestedName;
      if (name.length < 2) throw new Error("Digite um nome com pelo menos 2 caracteres.");
      const mode = normalizeMode(payload?.mode);
      const botDifficulty = normalizeBotDifficulty(payload?.botDifficulty);
      const code = createRoomCode();
      const player = makeHumanPlayer(name, socket);
      const room = {
        code,
        status: "lobby",
        isPublic: payload?.isPublic !== false,
        mode,
        botDifficulty,
        turnDuration: normalizeTurnDuration(payload?.turnDuration),
        turnDeadline: null,
        turnSerial: 0,
        clockPlayerId: null,
        clockSerial: null,
        roundsPerBlock: 4,
        scoreLimit: 31,
        roundNumber: 0,
        players: [player],
        hostId: player.id,
        currentPlayerId: null,
        lastPlay: null,
        lastPlayerId: null,
        playedCards: [],
        passCount: 0,
        firstMove: true,
        winnerId: null,
        closingPhase: false,
        closingPlayerId: null,
        closingQueue: [],
        seriesWinnerIds: [],
        seriesLoserIds: [],
        roundResults: [],
        rematchVotes: new Set(),
        matchRecordId: null,
        statsRecorded: false,
        matchStartedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      const requestedBots = Math.max(0, Math.min(3, Number.parseInt(payload?.autoBots, 10) || 0));
      for (let index = 0; index < requestedBots && room.players.length < 4; index++) {
        room.players.push(makeBotPlayer(room));
      }

      rooms.set(code, room);
      attachSocket(socket, room, player);
      updatePresence(socket, name);

      if (payload?.autoStartBots === true && room.players.length === 4) {
        startMatch(room, true);
      }

      callback({ ok: true, code, playerId: player.id, token: player.token });
      if (room.status === "playing") {
        emitNotice(room, `${roomPlayer(room, room.currentPlayerId).name} começa com o 3 de Ouros.`, "success");
      }
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível criar a sala." });
    }
  });

  socket.on("join_room", (payload, callback = () => {}) => {
    try {
      const code = normalizeRoomCode(payload?.code);
      const requestedName = normalizeName(payload?.name);
      const name = socket.data.account?.displayName || requestedName;
      const room = rooms.get(code);
      if (!room) throw new Error("Sala não encontrada.");
      if (room.status !== "lobby") throw new Error("Esta partida já começou.");
      if (name.length < 2) throw new Error("Digite um nome com pelo menos 2 caracteres.");
      if (socket.data.account?.id && room.players.some(player => player.userId === socket.data.account.id)) {
        throw new Error("Sua conta já está participando desta sala.");
      }
      if (room.players.some(player => player.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("Já existe um jogador com esse nome na sala.");
      }

      if (room.players.length >= 4) {
        const botIndex = room.players.findIndex(player => player.isBot);
        if (botIndex < 0) throw new Error("A sala já está cheia.");
        room.players.splice(botIndex, 1);
      }

      const player = makeHumanPlayer(name, socket);
      room.players.push(player);
      attachSocket(socket, room, player);
      updatePresence(socket, name);
      callback({ ok: true, code, playerId: player.id, token: player.token });
      emitNotice(room, `${player.name} entrou na sala.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível entrar na sala." });
    }
  });

  socket.on("rejoin_room", (payload, callback = () => {}) => {
    try {
      const code = normalizeRoomCode(payload?.code);
      const token = String(payload?.token || "");
      const room = rooms.get(code);
      if (!room) throw new Error("A sala não existe mais.");
      const player = room.players.find(item => !item.isBot && item.token === token);
      if (!player) throw new Error("Não foi possível recuperar seu lugar nesta sala.");
      attachSocket(socket, room, player);
      updatePresence(socket, player.name);
      callback({ ok: true, code, playerId: player.id, token: player.token });
      emitNotice(room, `${player.name} reconectou.`, "success");
      if (!tryStartVotedRematch(room)) emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Falha ao reconectar." });
    }
  });

  socket.on("update_bot_difficulty", (payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode alterar a dificuldade.");
      if (room.status !== "lobby") throw new Error("A dificuldade só pode ser alterada antes da partida.");

      room.botDifficulty = normalizeBotDifficulty(payload?.difficulty);
      room.players.filter(item => item.isBot).forEach(bot => {
        bot.difficulty = room.botDifficulty;
      });

      callback({ ok: true, difficulty: room.botDifficulty });
      emitNotice(room, `Bots ajustados para o nível ${botDifficultyLabel(room.botDifficulty)}.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível alterar a dificuldade." });
    }
  });

  socket.on("update_turn_duration", (payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode alterar o tempo.");
      if (room.status !== "lobby") throw new Error("O tempo só pode ser alterado antes da partida.");

      room.turnDuration = normalizeTurnDuration(payload?.turnDuration);
      callback({ ok: true, turnDuration: room.turnDuration });
      emitNotice(room, `Tempo por jogada ajustado para ${room.turnDuration} segundos.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível alterar o tempo por jogada." });
    }
  });

  socket.on("add_bot", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode adicionar bots.");
      if (room.status !== "lobby") throw new Error("Bots só podem ser alterados antes da partida.");
      if (room.players.length >= 4) throw new Error("A sala já está cheia.");
      const bot = makeBotPlayer(room);
      room.players.push(bot);
      callback({ ok: true });
      emitNotice(room, `${bot.name} entrou na sala.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível adicionar o bot." });
    }
  });

  socket.on("fill_bots", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode adicionar bots.");
      if (room.status !== "lobby") throw new Error("Bots só podem ser alterados antes da partida.");

      let added = 0;
      while (room.players.length < 4) {
        room.players.push(makeBotPlayer(room));
        added += 1;
      }

      callback({ ok: true, added });
      if (added > 0) emitNotice(room, `${added} bot(s) completaram a sala.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível completar a sala com bots." });
    }
  });

  socket.on("remove_bot", (payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode remover bots.");
      if (room.status !== "lobby") throw new Error("Bots só podem ser alterados antes da partida.");
      const botId = String(payload?.botId || "");
      const bot = room.players.find(item => item.id === botId && item.isBot);
      if (!bot) throw new Error("Bot não encontrado.");
      room.players = room.players.filter(item => item.id !== botId);
      callback({ ok: true });
      emitNotice(room, `${bot.name} saiu da sala.`, "info");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível remover o bot." });
    }
  });

  socket.on("start_game", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode iniciar.");
      if (room.status !== "lobby") throw new Error("Use o botão de revanche para iniciar a próxima rodada.");

      startMatch(room, true);
      callback({ ok: true });
      emitNotice(room, `${roomPlayer(room, room.currentPlayerId).name} começa com o 3 de Ouros.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível iniciar." });
    }
  });

  socket.on("request_rematch", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.isBot) throw new Error("Bots não precisam confirmar a revanche.");
      if (!["round_finished", "block_finished", "finished"].includes(room.status)) {
        throw new Error("A revanche só pode ser solicitada após o fim da rodada.");
      }

      if (!room.rematchVotes) room.rematchVotes = new Set();
      room.rematchVotes.add(player.id);
      callback({ ok: true, votes: room.rematchVotes.size, required: rematchHumans(room).length });
      emitNotice(room, `${player.name} está pronto para continuar.`, "success");
      if (!tryStartVotedRematch(room)) emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível solicitar a revanche." });
    }
  });


  socket.on("play_cards", (payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      const turnError = validateTurn(room, player);
      if (turnError) throw new Error(turnError);
      const requestedIds = Array.isArray(payload?.cardIds) ? [...new Set(payload.cardIds.map(Number))] : [];
      const { cards, combo } = validateCardsForPlay(room, player, requestedIds);
      callback({ ok: true });
      performPlay(room, player, cards, combo);
    } catch (error) {
      callback({ ok: false, error: error.message || "Jogada recusada." });
    }
  });

  socket.on("pass_turn", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      const turnError = validateTurn(room, player);
      if (turnError) throw new Error(turnError);
      if (!room.lastPlay) throw new Error("Você não pode passar com a mesa livre.");
      callback({ ok: true });
      performPass(room, player);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível passar." });
    }
  });

  socket.on("leave_room", (_payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room && roomPlayer(room, socket.data.playerId);
    if (!room || !player) {
      updatePresence(socket);
      broadcastDirectory();
      callback({ ok: true });
      return;
    }

    const matchStarted = room.status !== "lobby";
    room.players = room.players.filter(item => item.id !== player.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    updatePresence(socket, player.name);

    if (room.players.length === 0 || room.players.every(item => item.isBot)) {
      clearBotTimer(room.code);
      clearTurnTimer(room.code);
      rooms.delete(room.code);
      broadcastDirectory();
      callback({ ok: true });
      return;
    }

    if (room.hostId === player.id) room.hostId = room.players.find(item => !item.isBot)?.id || room.players[0].id;
    if (matchStarted) {
      resetRoomToLobby(room);
      emitNotice(room, `${player.name} saiu. A partida foi encerrada e a sala voltou à espera.`, "warning");
    } else {
      emitNotice(room, `${player.name} saiu da sala.`, "info");
    }
    emitRoom(room);
    callback({ ok: true });
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(socket.id);
    const room = rooms.get(socket.data.roomCode);
    const player = room && roomPlayer(room, socket.data.playerId);
    if (!room || !player || player.isBot || player.socketId !== socket.id) {
      broadcastDirectory();
      return;
    }
    player.connected = false;
    player.socketId = null;
    room.updatedAt = Date.now();
    emitNotice(room, `${player.name} perdeu a conexão. Aguardando retorno.`, "warning");
    emitRoom(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const humans = room.players.filter(player => !player.isBot);
    const allOffline = humans.length === 0 || humans.every(player => !player.connected);
    const idleLimit = allOffline ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (now - room.updatedAt > idleLimit) {
      clearBotTimer(code);
      clearTurnTimer(code);
      rooms.delete(code);
    }
  }
  broadcastDirectory();
}, 60 * 1000).unref();

async function startServer() {
  await storage.init();
  server.listen(PORT, "0.0.0.0", () => {
    const status = storage.status();
    console.log(`Pôquer Chinês Online v4.4 rodando na porta ${PORT}`);
    console.log(`Armazenamento de usuários: ${status.backend}${status.persistent ? " (persistente)" : " (local; configure DATABASE_URL para persistência no Render)"}`);
  });
}

startServer().catch(error => {
  console.error("Não foi possível iniciar o servidor:", error);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await storage.close().catch(() => {});
  server.close(() => process.exit(0));
});
