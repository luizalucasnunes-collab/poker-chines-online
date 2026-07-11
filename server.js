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
app.get("/health", (_req, res) => res.json({ ok: true }));

const SUITS = ["♦", "♥", "♠", "♣"];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];
const rooms = new Map();
const onlineUsers = new Map();

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
    else if (room.status === "finished") status = "finished";
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
    .filter(room =>
      room.isPublic &&
      room.status === "lobby" &&
      room.players.length > 0 &&
      room.players.length < 4 &&
      room.players.some(player => player.connected)
    )
    .map(room => ({
      code: room.code,
      hostName: roomPlayer(room, room.hostId)?.name || "Jogador",
      playerCount: room.players.length,
      connectedCount: room.players.filter(player => player.connected).length
    }))
    .sort((a, b) => b.playerCount - a.playerCount || a.code.localeCompare(b.code));

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
    for (let i = 0; i < 5; i++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Não foi possível gerar um código de sala.");
}

function makePlayer(name, socket) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("hex"),
    name,
    socketId: socket.id,
    connected: true,
    hand: []
  };
}

function makeDeck() {
  const deck = [];
  let id = 0;
  for (let rank = 0; rank < RANKS.length; rank++) {
    for (let suit = 0; suit < SUITS.length; suit++) {
      deck.push({ id: id++, rank, suit });
    }
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

  if (count === 1) {
    return {
      valid: true,
      count,
      type: "Carta",
      strength: [sorted[0].rank, sorted[0].suit]
    };
  }

  if (count === 2 && sorted[0].rank === sorted[1].rank) {
    return {
      valid: true,
      count,
      type: "Dupla",
      strength: [sorted[0].rank, Math.max(...sorted.map(card => card.suit))]
    };
  }

  if (count === 3 && sorted.every(card => card.rank === sorted[0].rank)) {
    return {
      valid: true,
      count,
      type: "Trinca",
      strength: [sorted[0].rank]
    };
  }

  if (count !== 5) return { valid: false };

  const uniqueRanks = [...new Set(sorted.map(card => card.rank))];
  const isStraight =
    uniqueRanks.length === 5 &&
    uniqueRanks.every((rank, index) => index === 0 || rank === uniqueRanks[index - 1] + 1);
  const isFlush = sorted.every(card => card.suit === sorted[0].suit);

  const rankCounts = new Map();
  for (const card of sorted) {
    rankCounts.set(card.rank, (rankCounts.get(card.rank) || 0) + 1);
  }

  const entries = [...rankCounts.entries()].map(([rank, amount]) => ({ rank, amount }));
  const triple = entries.find(entry => entry.amount === 3);
  const pair = entries.find(entry => entry.amount === 2);

  if (isStraight && isFlush) {
    const high = sorted[sorted.length - 1];
    return {
      valid: true,
      count,
      type: "Sequência do mesmo naipe",
      category: 3,
      strength: [3, high.rank, high.suit]
    };
  }

  if (triple && pair) {
    return {
      valid: true,
      count,
      type: "Full House",
      category: 2,
      strength: [2, triple.rank]
    };
  }

  if (isFlush) {
    const descendingRanks = [...sorted]
      .sort((a, b) => b.rank - a.rank || b.suit - a.suit)
      .map(card => card.rank);
    return {
      valid: true,
      count,
      type: "Flush",
      category: 1,
      // Primeiro o naipe, depois as cartas do maior valor para o menor.
      strength: [1, sorted[0].suit, ...descendingRanks]
    };
  }

  if (isStraight) {
    const high = sorted[sorted.length - 1];
    return {
      valid: true,
      count,
      type: "Sequência",
      category: 0,
      strength: [0, high.rank, high.suit]
    };
  }

  return { valid: false };
}

function beats(combo, target) {
  return (
    combo.valid &&
    target.valid &&
    combo.count === target.count &&
    compareTuples(combo.strength, target.strength) > 0
  );
}

function roomPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function nextPlayerId(room, playerId) {
  const index = room.players.findIndex(player => player.id === playerId);
  return room.players[(index + 1) % room.players.length].id;
}

function allConnected(room) {
  return room.players.length === 4 && room.players.every(player => player.connected);
}

function isPaused(room) {
  return room.status === "playing" && !allConnected(room);
}

function publicLastPlay(room) {
  if (!room.lastPlay) return null;
  const player = roomPlayer(room, room.lastPlay.playerId);
  return {
    cards: sortCards(room.lastPlay.cards),
    combo: {
      type: room.lastPlay.combo.type,
      count: room.lastPlay.combo.count
    },
    playerId: room.lastPlay.playerId,
    playerName: player?.name || "Jogador"
  };
}

function stateFor(room, viewer) {
  return {
    code: room.code,
    status: room.status,
    isPublic: Boolean(room.isPublic),
    paused: isPaused(room),
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      cardCount: player.hand.length,
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
    winnerName: room.winnerId ? roomPlayer(room, room.winnerId)?.name : null
  };
}

function emitRoom(room) {
  room.updatedAt = Date.now();
  for (const player of room.players) {
    if (player.connected && player.socketId) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      if (playerSocket) updatePresence(playerSocket, player.name);
      io.to(player.socketId).emit("room_state", stateFor(room, player));
    }
  }
  broadcastDirectory();
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

function startMatch(room) {
  if (!allConnected(room)) throw new Error("São necessários quatro jogadores conectados.");

  const deck = shuffle(makeDeck());
  room.players.forEach((player, index) => {
    player.hand = sortCards(deck.slice(index * 13, index * 13 + 13));
  });

  const starter = room.players.find(player =>
    player.hand.some(card => card.rank === 0 && card.suit === 0)
  );

  room.status = "playing";
  room.currentPlayerId = starter.id;
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.startedAt = Date.now();
}


function resetRoomToLobby(room) {
  room.status = "lobby";
  room.currentPlayerId = null;
  room.lastPlay = null;
  room.lastPlayerId = null;
  room.passCount = 0;
  room.firstMove = true;
  room.winnerId = null;
  room.players.forEach(player => {
    player.hand = [];
  });
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

      const code = createRoomCode();
      const player = makePlayer(name, socket);
      const room = {
        code,
        status: "lobby",
        isPublic: payload?.isPublic !== false,
        players: [player],
        hostId: player.id,
        currentPlayerId: null,
        lastPlay: null,
        lastPlayerId: null,
        passCount: 0,
        firstMove: true,
        winnerId: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      rooms.set(code, room);
      attachSocket(socket, room, player);
      updatePresence(socket, name);
      callback({ ok: true, code, playerId: player.id, token: player.token });
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
      if (room.players.length >= 4) throw new Error("A sala já está cheia.");
      if (name.length < 2) throw new Error("Digite um nome com pelo menos 2 caracteres.");
      if (room.players.some(player => player.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("Já existe um jogador com esse nome na sala.");
      }

      const player = makePlayer(name, socket);
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

      const player = room.players.find(item => item.token === token);
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

  socket.on("start_game", (_payload, callback = () => {}) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const player = room && roomPlayer(room, socket.data.playerId);
      if (!room || !player) throw new Error("Você não está em uma sala.");
      if (player.id !== room.hostId) throw new Error("Somente o anfitrião pode iniciar.");
      if (!["lobby", "finished"].includes(room.status)) throw new Error("A partida já está acontecendo.");

      startMatch(room);
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

      const requestedIds = Array.isArray(payload?.cardIds)
        ? [...new Set(payload.cardIds.map(Number))]
        : [];

      if (![1, 2, 3, 5].includes(requestedIds.length)) {
        throw new Error("Selecione 1, 2, 3 ou 5 cartas.");
      }

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

      const selected = new Set(requestedIds);
      player.hand = player.hand.filter(card => !selected.has(card.id));
      room.lastPlay = { cards: sortCards(cards), combo, playerId: player.id };
      room.lastPlayerId = player.id;
      room.passCount = 0;
      room.firstMove = false;

      if (player.hand.length === 0) {
        room.status = "finished";
        room.winnerId = player.id;
        room.currentPlayerId = null;
        callback({ ok: true });
        emitNotice(room, `${player.name} venceu a partida!`, "success");
        emitRoom(room);
        return;
      }

      room.currentPlayerId = nextPlayerId(room, player.id);
      callback({ ok: true });
      emitNotice(room, `${player.name} jogou ${combo.type}.`, "success");
      emitRoom(room);
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

      room.passCount += 1;

      if (room.passCount >= 3) {
        const opener = roomPlayer(room, room.lastPlayerId);
        room.currentPlayerId = room.lastPlayerId;
        room.lastPlay = null;
        room.lastPlayerId = null;
        room.passCount = 0;
        callback({ ok: true });
        emitNotice(room, `${opener.name} venceu a rodada e abre a mesa.`, "success");
        emitRoom(room);
        return;
      }

      room.currentPlayerId = nextPlayerId(room, player.id);
      callback({ ok: true });
      emitNotice(room, `${player.name} passou.`, "info");
      emitRoom(room);
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

    const partidaEmAndamento = room.status === "playing";
    const partidaEncerrada = room.status === "finished";

    room.players = room.players.filter(item => item.id !== player.id);
    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    updatePresence(socket, player.name);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      broadcastDirectory();
      callback({ ok: true });
      return;
    }

    if (room.hostId === player.id) {
      room.hostId = room.players[0].id;
    }

    if (partidaEmAndamento || partidaEncerrada) {
      resetRoomToLobby(room);
      const motivo = partidaEmAndamento
        ? `${player.name} saiu da sala. A partida foi encerrada e a sala voltou para a espera.`
        : `${player.name} saiu da sala. A sala voltou para a espera.`;
      emitNotice(room, motivo, "warning");
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
    if (!room || !player || player.socketId !== socket.id) {
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
    const allOffline = room.players.every(player => !player.connected);
    const idleLimit = allOffline ? 10 * 60 * 1000 : 6 * 60 * 60 * 1000;
    if (now - room.updatedAt > idleLimit) {
      rooms.delete(code);
      broadcastDirectory();
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pôquer Chinês Online rodando na porta ${PORT}`);
});
