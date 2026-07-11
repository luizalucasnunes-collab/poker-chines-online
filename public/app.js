"use strict";

const socket = io({ reconnection: true });
const SUITS = [
  { symbol: "♦", name: "Ouros", red: true },
  { symbol: "♥", name: "Copas", red: true },
  { symbol: "♠", name: "Espadas", red: false },
  { symbol: "♣", name: "Paus", red: false }
];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];

let state = null;
let selectedIds = new Set();
let toastTimer = null;
let attemptedReconnect = false;
let directory = { onlineCount: 0, availableCount: 0, players: [], openRooms: [] };
let presenceTimer = null;

const $ = id => document.getElementById(id);
const screens = ["homeScreen", "lobbyScreen", "gameScreen"];

function showScreen(id) {
  screens.forEach(screenId => $(screenId).classList.toggle("hidden", screenId !== id));
  $("globalHomeBtn").classList.toggle("hidden", id === "homeScreen");
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function savedName() {
  return cleanName(localStorage.getItem("pokerChinesName") || getSession()?.name || "");
}

function setSavedName(name) {
  const cleaned = cleanName(name);
  if (cleaned) localStorage.setItem("pokerChinesName", cleaned);
  else localStorage.removeItem("pokerChinesName");
}

function syncNameInputs(name, sourceId = null) {
  const cleaned = cleanName(name);
  if (sourceId !== "createName") $("createName").value = cleaned;
  if (sourceId !== "joinName") $("joinName").value = cleaned;
  setSavedName(cleaned);
  return cleaned;
}

function announcePresence(name = savedName()) {
  const cleaned = cleanName(name);
  if (!socket.connected) return;
  socket.emit("set_presence", { name: cleaned }, () => {});
}

function schedulePresence(name, sourceId) {
  const cleaned = syncNameInputs(name, sourceId);
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => announcePresence(cleaned), 350);
}

function setSession(data) {
  localStorage.setItem("pokerChinesSession", JSON.stringify(data));
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem("pokerChinesSession") || "null");
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem("pokerChinesSession");
}

function toast(text, tone = "info") {
  const element = $("toast");
  element.textContent = text;
  element.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.className = "toast";
  }, 2800);
}

function callbackResult(result, onSuccess) {
  if (!result?.ok) {
    toast(result?.error || "Não foi possível concluir a operação.", "error");
    return;
  }
  onSuccess(result);
}

function roomLink(code) {
  const url = new URL(location.href);
  url.searchParams.set("room", code);
  return url.toString();
}

async function copyInvite() {
  if (!state?.code) return;
  const invitation = `Entre na minha sala de Pôquer Chinês: ${state.code}\n${roomLink(state.code)}`;
  try {
    await navigator.clipboard.writeText(invitation);
    toast("Convite copiado.", "success");
  } catch {
    window.prompt("Copie o convite:", invitation);
  }
}

function createRoom() {
  const name = syncNameInputs($("createName").value, "createName");
  const isPublic = $("publicRoomCheck").checked;
  socket.emit("create_room", { name, isPublic }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Sala criada.", "success");
    });
  });
}

function joinRoom(codeOverride = null) {
  const name = syncNameInputs($("joinName").value || $("createName").value, "joinName");
  const code = cleanCode(codeOverride || $("roomCodeInput").value);

  if (name.length < 2) {
    toast("Digite seu nome antes de entrar.", "warning");
    $("joinName").focus();
    return;
  }

  $("roomCodeInput").value = code;
  socket.emit("join_room", { name, code }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Você entrou na sala.", "success");
    });
  });
}

function rejoin() {
  const session = getSession();
  if (!session?.code || !session?.token || !socket.connected) return;
  socket.emit("rejoin_room", { code: session.code, token: session.token }, result => {
    if (!result?.ok) {
      clearSession();
      attemptedReconnect = true;
      toast(result?.error || "A sala anterior não existe mais.", "warning");
      showScreen("homeScreen");
      return;
    }
    attemptedReconnect = true;
  });
}

function leaveRoom() {
  socket.emit("leave_room", {}, result => {
    if (!result?.ok) {
      toast(result?.error || "Não foi possível sair.", "error");
      return;
    }
    clearSession();
    state = null;
    selectedIds.clear();
    $("winnerModal").classList.add("hidden");
    history.replaceState({}, "", location.pathname);
    showScreen("homeScreen");
    announcePresence();
    renderDirectory();
    toast("Você voltou ao início.", "success");
  });
}

function confirmAndLeaveRoom() {
  const activeMatch = state?.status === "playing";
  const message = activeMatch
    ? "Tem certeza que deseja voltar ao início? A partida atual será encerrada para todos os jogadores."
    : "Tem certeza que deseja voltar ao início e sair desta sala?";

  if (window.confirm(message)) {
    leaveRoom();
  }
}

function goHome() {
  if (state) {
    confirmAndLeaveRoom();
    return;
  }
  $("winnerModal").classList.add("hidden");
  history.replaceState({}, "", location.pathname);
  showScreen("homeScreen");
  announcePresence();
}

function startGame() {
  socket.emit("start_game", {}, result => {
    if (!result?.ok) toast(result?.error || "Não foi possível iniciar.", "error");
  });
}

function playCards() {
  if (!state || selectedIds.size === 0) return;
  socket.emit("play_cards", { cardIds: [...selectedIds] }, result => {
    if (!result?.ok) {
      toast(result?.error || "Jogada recusada.", "error");
      return;
    }
    selectedIds.clear();
  });
}

function passTurn() {
  socket.emit("pass_turn", {}, result => {
    if (!result?.ok) toast(result?.error || "Não foi possível passar.", "error");
  });
}

function statusText(player) {
  if (player.status === "available") return "Disponível";
  if (player.status === "lobby") return player.roomCode ? `Em sala pública ${player.roomCode}` : "Em uma sala";
  if (player.status === "playing") return "Jogando agora";
  if (player.status === "finished") return "Partida encerrada";
  return "Online";
}

function renderDirectory() {
  if (!$("onlinePlayers") || !$("openRooms")) return;

  $("onlineCount").textContent = `${directory.onlineCount || 0} online`;
  $("onlineHelper").textContent = `${directory.availableCount || 0} jogador(es) disponível(is) para uma nova sala.`;
  $("openRoomCount").textContent = `${directory.openRooms?.length || 0} sala${directory.openRooms?.length === 1 ? "" : "s"}`;

  const players = Array.isArray(directory.players) ? directory.players : [];
  if (players.length === 0) {
    $("onlinePlayers").innerHTML = '<div class="empty-state">Nenhum jogador identificado neste momento.</div>';
  } else {
    $("onlinePlayers").innerHTML = players.map(player => {
      const isMe = player.id === socket.id;
      const available = player.status === "available";
      return `<div class="online-item">
        <span class="avatar small">${escapeHtml(player.name.charAt(0).toUpperCase())}</span>
        <span class="online-main">
          <b>${escapeHtml(player.name)}${isMe ? " (você)" : ""}</b>
          <small>${escapeHtml(statusText(player))}</small>
        </span>
        <span class="status-chip ${available ? "available" : "busy"}">${available ? "Livre" : "Ocupado"}</span>
      </div>`;
    }).join("");
  }

  const rooms = Array.isArray(directory.openRooms) ? directory.openRooms : [];
  if (rooms.length === 0) {
    $("openRooms").innerHTML = '<div class="empty-state">Nenhuma sala pública aguardando jogadores.</div>';
  } else {
    $("openRooms").innerHTML = rooms.map(room => `<div class="online-item room-list-item">
      <span class="room-code-mini">${escapeHtml(room.code)}</span>
      <span class="online-main">
        <b>Sala de ${escapeHtml(room.hostName)}</b>
        <small>${room.playerCount}/4 jogadores • ${room.connectedCount} conectado(s)</small>
      </span>
      <button class="btn primary compact join-open-room" data-room-code="${escapeHtml(room.code)}">Entrar</button>
    </div>`).join("");
  }
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
  const sorted = [...cards].sort((a, b) => a.rank - b.rank || a.suit - b.suit);
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
  const counts = new Map();
  sorted.forEach(card => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const entries = [...counts.entries()].map(([rank, amount]) => ({ rank, amount }));
  const triple = entries.find(entry => entry.amount === 3);
  const pair = entries.find(entry => entry.amount === 2);

  if (isStraight && isFlush) {
    const high = sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência do mesmo naipe", strength: [3, high.rank, high.suit] };
  }
  if (triple && pair) return { valid: true, count, type: "Full House", strength: [2, triple.rank] };
  if (isFlush) {
    const descending = [...sorted].sort((a, b) => b.rank - a.rank).map(card => card.rank);
    return { valid: true, count, type: "Flush", strength: [1, sorted[0].suit, ...descending] };
  }
  if (isStraight) {
    const high = sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência", strength: [0, high.rank, high.suit] };
  }
  return { valid: false };
}

function cardHtml(card) {
  const red = SUITS[card.suit].red ? " red" : "";
  return `<button class="card${red}" data-card-id="${card.id}" aria-label="${RANKS[card.rank]} de ${SUITS[card.suit].name}">
    <span class="card-rank">${RANKS[card.rank]} ${SUITS[card.suit].symbol}</span>
    <span class="card-suit">${SUITS[card.suit].symbol}</span>
    <span class="card-rank card-bottom">${RANKS[card.rank]} ${SUITS[card.suit].symbol}</span>
  </button>`;
}

function miniDeck(count) {
  const visible = Math.min(count, 13);
  return `<div class="mini-deck">${Array.from({ length: visible }, () => '<span class="card-back"></span>').join("")}</div>`;
}

function playerSeatHtml(player, isMe = false) {
  const active = state.currentPlayerId === player.id ? " active" : "";
  const dot = player.connected ? "" : " off";
  const meLabel = isMe ? " (você)" : "";
  return {
    html: `<div class="seat-name"><span class="online-dot${dot}"></span>${escapeHtml(player.name)}${meLabel}</div>
      <div class="seat-meta">${player.cardCount} carta${player.cardCount === 1 ? "" : "s"}${player.isHost ? " • anfitrião" : ""}</div>
      ${isMe ? "" : miniDeck(player.cardCount)}`,
    active
  };
}

function renderLobby() {
  showScreen("lobbyScreen");
  $("roomCodeDisplay").textContent = state.code;
  $("playerCounter").textContent = `${state.players.length}/4`;
  $("lobbyPlayers").innerHTML = state.players.map(player => `
    <div class="lobby-player${player.connected ? "" : " offline"}">
      <span class="avatar">${escapeHtml(player.name.charAt(0).toUpperCase())}</span>
      <span class="name">${escapeHtml(player.name)}</span>
      <span class="player-tag">${player.id === state.me.id ? "VOCÊ" : ""}${player.isHost ? " ANFITRIÃO" : ""}</span>
    </div>
  `).join("");

  const amHost = state.me.id === state.hostId;
  $("startGameBtn").classList.toggle("hidden", !amHost);
  $("startGameBtn").disabled = state.players.length !== 4 || state.players.some(player => !player.connected);
  $("lobbyHint").textContent =
    state.players.length < 4
      ? `Faltam ${4 - state.players.length} jogador(es).`
      : state.players.some(player => !player.connected)
        ? "Aguardando todos reconectarem."
        : amHost ? "Todos prontos. Você pode iniciar." : "Aguardando o anfitrião iniciar.";
}

function relativePlayers() {
  const myIndex = state.players.findIndex(player => player.id === state.me.id);
  return {
    south: state.players[myIndex],
    east: state.players[(myIndex + 1) % 4],
    north: state.players[(myIndex + 2) % 4],
    west: state.players[(myIndex + 3) % 4]
  };
}

function renderSeat(id, player, isMe = false) {
  const element = $(id);
  const seat = playerSeatHtml(player, isMe);
  element.innerHTML = seat.html;
  element.classList.toggle("active", Boolean(seat.active));
  element.classList.toggle("offline", !player.connected);
}

function renderGame() {
  showScreen("gameScreen");
  $("gameRoomCode").textContent = state.code;
  $("pauseBanner").classList.toggle("hidden", !state.paused);

  const relative = relativePlayers();
  renderSeat("seatSouth", relative.south, true);
  renderSeat("seatEast", relative.east);
  renderSeat("seatNorth", relative.north);
  renderSeat("seatWest", relative.west);

  const myTurn = state.currentPlayerId === state.me.id && !state.paused && state.status === "playing";
  const current = state.players.find(player => player.id === state.currentPlayerId);
  $("turnStatus").textContent = state.paused
    ? "Partida pausada"
    : myTurn ? "Sua vez" : current ? `Vez de ${current.name}` : "Partida encerrada";

  if (state.lastPlay) {
    $("lastPlayLabel").textContent = `${state.lastPlay.playerName} — ${state.lastPlay.combo.type}`;
    $("playedCards").innerHTML = state.lastPlay.cards.map(cardHtml).join("");
    $("playedCards").querySelectorAll(".card").forEach(card => card.disabled = true);
  } else {
    $("lastPlayLabel").textContent = "Mesa livre";
    $("playedCards").innerHTML = "";
  }

  const currentCardIds = new Set(state.me.hand.map(card => card.id));
  selectedIds = new Set([...selectedIds].filter(id => currentCardIds.has(id)));

  $("hand").innerHTML = state.me.hand.map(cardHtml).join("");
  $("hand").classList.toggle("disabled", !myTurn);
  $("hand").querySelectorAll(".card").forEach(element => {
    const id = Number(element.dataset.cardId);
    element.classList.toggle("selected", selectedIds.has(id));
    element.disabled = !myTurn;
    element.addEventListener("click", () => {
      if (!myTurn) return;
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      renderGame();
    });
  });

  const selectedCards = state.me.hand.filter(card => selectedIds.has(card.id));
  const combo = analyze(selectedCards);
  $("selectionText").textContent = selectedCards.length === 0
    ? "Selecione suas cartas"
    : combo.valid
      ? `${selectedCards.length} selecionada(s): ${combo.type}`
      : `${selectedCards.length} selecionada(s): combinação inválida`;

  $("playBtn").disabled = !myTurn || selectedCards.length === 0;
  $("passBtn").disabled = !myTurn || !state.lastPlay;
  $("hintBtn").disabled = !myTurn;
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

function beatsLocal(combo, targetCards) {
  const target = analyze(targetCards);
  return combo.valid && target.valid && combo.count === target.count &&
    compareTuples(combo.strength, target.strength) > 0;
}

function legalLocalPlay(cards) {
  const combo = analyze(cards);
  if (!combo.valid) return null;
  if (state.firstMove && !cards.some(card => card.rank === 0 && card.suit === 0)) return null;
  if (state.lastPlay) {
    if (combo.count !== state.lastPlay.combo.count) return null;
    if (!beatsLocal(combo, state.lastPlay.cards)) return null;
  }
  return combo;
}

function giveHint() {
  if (!state || state.currentPlayerId !== state.me.id) return;
  const sizes = state.lastPlay ? [state.lastPlay.combo.count] : [1, 2, 3, 5];
  const legal = [];
  for (const size of sizes) {
    if (state.me.hand.length < size) continue;
    for (const cards of combinations(state.me.hand, size)) {
      const combo = legalLocalPlay(cards);
      if (combo) legal.push({ cards, combo });
    }
  }

  if (legal.length === 0) {
    toast("Você não possui uma jogada válida. Passe.", "warning");
    return;
  }

  legal.sort((a, b) => {
    if (!state.lastPlay && a.combo.count !== b.combo.count) return b.combo.count - a.combo.count;
    return compareTuples(a.combo.strength, b.combo.strength);
  });

  selectedIds = new Set(legal[0].cards.map(card => card.id));
  renderGame();
  toast(`Sugestão: ${legal[0].combo.type}.`, "success");
}

function renderWinner() {
  const winner = state.players.find(player => player.id === state.winnerId);
  const won = state.winnerId === state.me.id;
  $("winnerTitle").textContent = won ? "Você venceu!" : `${winner?.name || "Um jogador"} venceu`;
  $("winnerText").textContent = won
    ? "Parabéns! Você foi o primeiro a ficar sem cartas."
    : "A partida terminou. O anfitrião pode iniciar uma revanche.";
  $("rematchBtn").classList.toggle("hidden", state.me.id !== state.hostId);
  $("winnerModal").classList.remove("hidden");
}

function renderState() {
  if (!state) return;
  const session = getSession();
  if (!session || session.token !== state.me.token) {
    setSession({ code: state.code, token: state.me.token, playerId: state.me.id, name: state.me.name });
  }

  if (state.status === "lobby") {
    $("winnerModal").classList.add("hidden");
    renderLobby();
  } else {
    renderGame();
    if (state.status === "finished") renderWinner();
    else $("winnerModal").classList.add("hidden");
  }
}

function openRules() { $("rulesModal").classList.remove("hidden"); }
function closeRules() { $("rulesModal").classList.add("hidden"); }

socket.on("connect", () => {
  $("connectionText").textContent = "Servidor conectado.";
  announcePresence();
  if (getSession()) rejoin();
  else attemptedReconnect = true;
});

socket.on("disconnect", () => {
  $("connectionText").textContent = "Conexão perdida. Tentando reconectar...";
  toast("Conexão perdida. Tentando reconectar...", "warning");
});

socket.on("room_state", nextState => {
  state = nextState;
  selectedIds.clear();
  renderState();
});

socket.on("notice", message => toast(message.text, message.tone));

socket.on("directory_state", nextDirectory => {
  directory = nextDirectory || { onlineCount: 0, availableCount: 0, players: [], openRooms: [] };
  renderDirectory();
});

$("createRoomBtn").addEventListener("click", createRoom);
$("joinRoomBtn").addEventListener("click", () => joinRoom());
$("startGameBtn").addEventListener("click", startGame);
$("leaveBtn").addEventListener("click", confirmAndLeaveRoom);
$("gameLeaveBtn").addEventListener("click", confirmAndLeaveRoom);
$("globalHomeBtn").addEventListener("click", goHome);
$("copyRoomBtn").addEventListener("click", copyInvite);
$("copyGameBtn").addEventListener("click", copyInvite);
$("playBtn").addEventListener("click", playCards);
$("passBtn").addEventListener("click", passTurn);
$("hintBtn").addEventListener("click", giveHint);
$("homeRulesBtn").addEventListener("click", openRules);
$("lobbyRulesBtn").addEventListener("click", openRules);
$("gameRulesBtn").addEventListener("click", openRules);
$("closeRulesBtn").addEventListener("click", closeRules);
$("rulesModal").addEventListener("click", event => {
  if (event.target.id === "rulesModal") closeRules();
});
$("rematchBtn").addEventListener("click", () => {
  $("winnerModal").classList.add("hidden");
  startGame();
});
$("winnerLobbyBtn").addEventListener("click", goHome);

$("roomCodeInput").addEventListener("input", event => {
  event.target.value = cleanCode(event.target.value);
});

["createName", "joinName"].forEach(inputId => {
  $(inputId).addEventListener("input", event => schedulePresence(event.target.value, inputId));
});

$("createName").addEventListener("keydown", event => {
  if (event.key === "Enter") createRoom();
});
$("roomCodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") joinRoom();
});

$("openRooms").addEventListener("click", event => {
  const button = event.target.closest(".join-open-room");
  if (!button) return;
  joinRoom(button.dataset.roomCode);
});

const codeFromUrl = cleanCode(new URLSearchParams(location.search).get("room"));
if (codeFromUrl) $("roomCodeInput").value = codeFromUrl;
const initialName = savedName();
if (initialName) syncNameInputs(initialName);
renderDirectory();
