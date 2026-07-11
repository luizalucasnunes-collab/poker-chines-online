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

const $ = id => document.getElementById(id);
const screens = ["homeScreen", "lobbyScreen", "gameScreen"];

function showScreen(id) {
  screens.forEach(screenId => $(screenId).classList.toggle("hidden", screenId !== id));
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 20);
}

function cleanCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
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
  const name = cleanName($("createName").value);
  socket.emit("create_room", { name }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Sala criada.", "success");
    });
  });
}

function joinRoom() {
  const name = cleanName($("joinName").value);
  const code = cleanCode($("roomCodeInput").value);
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
    history.replaceState({}, "", location.pathname);
    showScreen("homeScreen");
  });
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
    html: `<div class="seat-name"><span class="online-dot${dot}"></span>${player.name}${meLabel}</div>
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
      <span class="avatar">${player.name.charAt(0).toUpperCase()}</span>
      <span class="name">${player.name}</span>
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

$("createRoomBtn").addEventListener("click", createRoom);
$("joinRoomBtn").addEventListener("click", joinRoom);
$("startGameBtn").addEventListener("click", startGame);
$("leaveBtn").addEventListener("click", leaveRoom);
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
$("winnerLobbyBtn").addEventListener("click", () => {
  clearSession();
  state = null;
  selectedIds.clear();
  $("winnerModal").classList.add("hidden");
  history.replaceState({}, "", location.pathname);
  location.reload();
});

$("roomCodeInput").addEventListener("input", event => {
  event.target.value = cleanCode(event.target.value);
});
$("createName").addEventListener("keydown", event => {
  if (event.key === "Enter") createRoom();
});
$("roomCodeInput").addEventListener("keydown", event => {
  if (event.key === "Enter") joinRoom();
});

const codeFromUrl = cleanCode(new URLSearchParams(location.search).get("room"));
if (codeFromUrl) $("roomCodeInput").value = codeFromUrl;
const prior = getSession();
if (prior?.name) {
  $("createName").value = prior.name;
  $("joinName").value = prior.name;
}
