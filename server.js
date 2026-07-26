"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  pingTimeout: 20000,
  pingInterval: 25000
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, version: "2.1.0" }));

const SUITS = ["♦", "♥", "♠", "♣"];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const BOT_NAMES = ["Lina Bot", "Mestre Bot", "Dragão Bot", "Panda Bot", "Tigre Bot", "Jade Bot"];
const rooms = new Map();
const onlineUsers = new Map();
const botTimers = new Map();

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

function updatePresence(socket, name = null) {
  const existing = onlineUsers.get(socket.id);
  const normalizedName = name === null ? existing?.name : normalizeName(name);

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
      roomCode: user.status === "lobby" && user.publicRoom ? user.roomCode : null
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
      roundsPerBlock: room.roundsPerBlock,
      scoreLimit: room.scoreLimit
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
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("hex"),
    name,
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
  const isStraight = uniqueRanks.length === 5 &&
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
    const descendingRanks = [...sorted].sort((a, b) => b.rank - a.rank || b.suit - a.suit).map(card => card.rank);
    return { valid: true, count, type: "Flush", category: 1, strength: [1, sorted[0].suit, ...descendingRanks] };
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
    roundsPerBlock: room.roundsPerBlock,
    scoreLimit: room.scoreLimit,
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
      cardCount: player.hand.length,
      score: player.score,
      isHost: player.id === room.hostId
    })),
    me: {
      id: viewer.id,
      name: viewer.name,
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
    roundResults: room.roundResults || []
  };
}

function emitRoom(room) {
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

function resetSeries(room) {
  room.roundNumber = 0;
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
  room.players.forEach(player => { player.score = 0; });
}

function startMatch(room, newSeries = false) {
  if (!allReady(room)) throw new Error("São necessários quatro jogadores ou bots.");
  if (newSeries) resetSeries(room);

  const deck = shuffle(makeDeck());
  room.players.forEach((player, index) => {
    player.hand = sortCards(deck.slice(index * 13, index * 13 + 13));
  });

  const starter = room.players.find(player => player.hand.some(card => card.rank === 0 && card.suit === 0));
  room.roundNumber += 1;
  room.status = "playing";
  room.currentPlayerId = starter.id;
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.closingPhase = false;
  room.closingPlayerId = null;
  room.closingQueue = [];
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
  room.startedAt = Date.now();
}

function resetRoomToLobby(room) {
  clearBotTimer(room.code);
  room.status = "lobby";
  room.currentPlayerId = null;
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.closingPhase = false;
  room.closingPlayerId = null;
  room.closingQueue = [];
  room.roundResults = [];
  room.seriesWinnerIds = [];
  room.seriesLoserIds = [];
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

function finishRound(room) {
  clearBotTimer(room.code);
  room.currentPlayerId = null;
  room.closingPhase = false;
  room.closingQueue = [];

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

  room.currentPlayerId = room.closingQueue[0];
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

  room.currentPlayerId = room.closingQueue[0];
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

  room.currentPlayerId = nextPlayerId(room, player.id);
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
    room.currentPlayerId = room.lastPlayerId;
    room.lastPlay = null;
    room.lastPlayerId = null;
    room.passCount = 0;
    emitNotice(room, `${opener.name} venceu a rodada e abre a mesa.`, "success");
    emitRoom(room);
    return;
  }
  room.currentPlayerId = nextPlayerId(room, player.id);
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

function chooseBotPlay(room, player) {
  const legal = legalPlays(room, player);
  if (!legal.length) return null;
  legal.sort((a, b) => {
    if (!room.lastPlay && a.combo.count !== b.combo.count) return b.combo.count - a.combo.count;
    return compareTuples(a.combo.strength, b.combo.strength);
  });
  return legal[0];
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

io.on("connection", socket => {
  socket.emit("directory_state", directoryState());

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
      const name = normalizeName(payload?.name);
      if (name.length < 2) throw new Error("Digite um nome com pelo menos 2 caracteres.");
      const mode = normalizeMode(payload?.mode);
      const code = createRoomCode();
      const player = makeHumanPlayer(name, socket);
      const room = {
        code,
        status: "lobby",
        isPublic: payload?.isPublic !== false,
        mode,
        roundsPerBlock: 4,
        scoreLimit: 31,
        roundNumber: 0,
        players: [player],
        hostId: player.id,
        currentPlayerId: null,
        lastPlay: null,
        lastPlayerId: null,
        passCount: 0,
        firstMove: true,
        winnerId: null,
        closingPhase: false,
        closingPlayerId: null,
        closingQueue: [],
        seriesWinnerIds: [],
        seriesLoserIds: [],
        roundResults: [],
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
      const name = normalizeName(payload?.name);
      const room = rooms.get(code);
      if (!room) throw new Error("Sala não encontrada.");
      if (room.status !== "lobby") throw new Error("Esta partida já começou.");
      if (name.length < 2) throw new Error("Digite um nome com pelo menos 2 caracteres.");
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
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Falha ao reconectar." });
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
      if (!["lobby", "round_finished", "block_finished", "finished"].includes(room.status)) throw new Error("A partida já está acontecendo.");

      const newSeries = room.status === "lobby" || room.status === "finished";
      startMatch(room, newSeries);
      callback({ ok: true });
      emitNotice(room, `${roomPlayer(room, room.currentPlayerId).name} começa com o 3 de Ouros.`, "success");
      emitRoom(room);
    } catch (error) {
      callback({ ok: false, error: error.message || "Não foi possível iniciar." });
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
      rooms.delete(code);
    }
  }
  broadcastDirectory();
}, 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pôquer Chinês Online v2.1 rodando na porta ${PORT}`);
});
