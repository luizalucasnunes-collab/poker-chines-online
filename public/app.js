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
  if (!socket.connected) return;
  socket.emit("set_presence", { name: cleanName(name) }, () => {});
}

function schedulePresence(name, sourceId) {
  const cleaned = syncNameInputs(name, sourceId);
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => announcePresence(cleaned), 350);
}

function toast(text, tone = "info") {
  const element = $("toast");
  element.textContent = text;
  element.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 2800);
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
  if (name.length < 2) {
    toast("Digite seu nome antes de criar a sala.", "warning");
    $("createName").focus();
    return;
  }
  const mode = $("gameModeSelect").value;
  const botDifficulty = $("botDifficultySelect").value;
  const isPublic = $("publicRoomCheck").checked;
  localStorage.setItem("pokerChinesBotDifficulty", botDifficulty);
  socket.emit("create_room", { name, isPublic, mode, botDifficulty }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Sala criada.", "success");
    });
  });
}

function playAgainstBots() {
  const name = syncNameInputs($("createName").value, "createName");
  if (name.length < 2) {
    toast("Digite seu nome antes de jogar contra os bots.", "warning");
    $("createName").focus();
    return;
  }
  const mode = $("gameModeSelect").value;
  const botDifficulty = $("botDifficultySelect").value;
  localStorage.setItem("pokerChinesBotDifficulty", botDifficulty);
  socket.emit("create_room", {
    name,
    isPublic: false,
    mode,
    botDifficulty,
    autoBots: 3,
    autoStartBots: true
  }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Partida contra três bots iniciada.", "success");
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
  if (!code) {
    toast("Informe o código da sala.", "warning");
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
      state = null;
      showScreen("homeScreen");
      toast(result?.error || "A sala anterior não existe mais.", "warning");
    }
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
    toast("Você voltou ao início.", "success");
  });
}

function confirmAndLeaveRoom() {
  const active = state && state.status !== "lobby";
  const message = active
    ? "Tem certeza que deseja sair? A partida será encerrada para os demais jogadores."
    : "Tem certeza que deseja sair desta sala?";
  if (window.confirm(message)) leaveRoom();
}

function goHome() {
  if (state) confirmAndLeaveRoom();
  else showScreen("homeScreen");
}

function addBot() {
  socket.emit("add_bot", {}, result => {
    if (!result?.ok) toast(result?.error || "Não foi possível adicionar o bot.", "error");
  });
}

function fillBots() {
  socket.emit("fill_bots", {}, result => {
    if (!result?.ok) {
      toast(result?.error || "Não foi possível completar a sala com bots.", "error");
      return;
    }
    toast(`${result.added || 0} bot(s) adicionado(s).`, "success");
  });
}

function updateBotDifficulty() {
  const difficulty = $("lobbyBotDifficultySelect").value;
  socket.emit("update_bot_difficulty", { difficulty }, result => {
    if (!result?.ok) {
      toast(result?.error || "Não foi possível alterar a dificuldade.", "error");
      return;
    }
    localStorage.setItem("pokerChinesBotDifficulty", difficulty);
  });
}

function removeBot(botId) {
  socket.emit("remove_bot", { botId }, result => {
    if (!result?.ok) toast(result?.error || "Não foi possível remover o bot.", "error");
  });
}

function startGame() {
  socket.emit("start_game", {}, result => {
    if (!result?.ok) toast(result?.error || "Não foi possível iniciar.", "error");
  });
}

function playCards() {
  if (!state || state.currentPlayerId !== state.me.id) return;
  if (selectedIds.size === 0) {
    toast("Selecione as cartas antes de clicar na mesa.", "warning");
    return;
  }
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

function modeText(mode) {
  return mode === "points" ? "Pontuação • blocos de 4 • perde aos 31" : "Partida única";
}

function botDifficultyText(difficulty) {
  return difficulty === "hard" ? "Difícil" : "Médio";
}

function statusText(player) {
  if (player.status === "available") return "Disponível";
  if (player.status === "lobby") return player.roomCode ? `Em sala pública ${player.roomCode}` : "Em uma sala";
  if (player.status === "playing") return "Jogando agora";
  if (player.status === "finished") return "Entre rodadas";
  return "Online";
}

function renderDirectory() {
  $("onlineCount").textContent = `${directory.onlineCount || 0} online`;
  $("onlineHelper").textContent = `${directory.availableCount || 0} jogador(es) disponível(is).`;
  const rooms = Array.isArray(directory.openRooms) ? directory.openRooms : [];
  $("openRoomCount").textContent = `${rooms.length} sala${rooms.length === 1 ? "" : "s"}`;

  const players = Array.isArray(directory.players) ? directory.players : [];
  $("onlinePlayers").innerHTML = players.length === 0
    ? '<div class="empty-state">Nenhum jogador identificado neste momento.</div>'
    : players.map(player => {
        const isMe = player.id === socket.id;
        const available = player.status === "available";
        return `<div class="online-item">
          <span class="avatar small">${escapeHtml(player.name.charAt(0).toUpperCase())}</span>
          <span class="online-main"><b>${escapeHtml(player.name)}${isMe ? " (você)" : ""}</b><small>${escapeHtml(statusText(player))}</small></span>
          <span class="status-chip ${available ? "available" : "busy"}">${available ? "Livre" : "Ocupado"}</span>
        </div>`;
      }).join("");

  $("openRooms").innerHTML = rooms.length === 0
    ? '<div class="empty-state">Nenhuma sala pública aguardando jogadores.</div>'
    : rooms.map(room => `<div class="online-item room-list-item">
        <span class="room-code-mini">${escapeHtml(room.code)}</span>
        <span class="online-main">
          <b>Sala de ${escapeHtml(room.hostName)}</b>
          <small>${escapeHtml(modeText(room.mode))} • Bots ${escapeHtml(botDifficultyText(room.botDifficulty))} • ${room.humanCount} pessoa(s) • ${room.botCount} bot(s)</small>
        </span>
        <button class="btn primary compact join-open-room" data-room-code="${escapeHtml(room.code)}">Entrar</button>
      </div>`).join("");
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
  const isStraight = uniqueRanks.length === 5 && uniqueRanks.every((rank, index) => index === 0 || rank === uniqueRanks[index - 1] + 1);
  const isFlush = sorted.every(card => card.suit === sorted[0].suit);
  const counts = new Map();
  sorted.forEach(card => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const entries = [...counts.entries()].map(([rank, amount]) => ({ rank, amount }));
  const four = entries.find(entry => entry.amount === 4);
  const triple = entries.find(entry => entry.amount === 3);
  const pair = entries.find(entry => entry.amount === 2);

  if (isStraight && isFlush) {
    const high = sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência do mesmo naipe", strength: [4, high.rank, high.suit] };
  }
  if (four) {
    const kicker = sorted.find(card => card.rank !== four.rank);
    return { valid: true, count, type: "Quadra + carta", strength: [3, four.rank, kicker.rank, kicker.suit] };
  }
  if (triple && pair) return { valid: true, count, type: "Full House", strength: [2, triple.rank] };
  if (isFlush) {
    const descending = [...sorted].sort((a, b) => b.rank - a.rank || b.suit - a.suit).map(card => card.rank);
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
  return `<div class="mini-deck">${Array.from({ length: Math.min(count, 13) }, () => '<span class="card-back"></span>').join("")}</div>`;
}

function playerSeatHtml(player, isMe = false) {
  const bot = player.isBot ? " 🤖" : "";
  const botLevel = player.isBot ? ` • ${botDifficultyText(player.botDifficulty || state.botDifficulty)}` : "";
  const meLabel = isMe ? " (você)" : "";
  return `<div class="seat-name"><span class="online-dot${player.connected ? "" : " off"}"></span>${escapeHtml(player.name)}${bot}${meLabel}</div>
    <div class="seat-meta">${player.cardCount} carta${player.cardCount === 1 ? "" : "s"}${botLevel}${state.mode === "points" ? ` • ${player.score}/${state.scoreLimit} pts` : ""}</div>
    ${isMe ? "" : miniDeck(player.cardCount)}`;
}

function renderLobby() {
  showScreen("lobbyScreen");
  $("roomCodeDisplay").textContent = state.code;
  $("roomModeText").textContent = `${modeText(state.mode)} • Bots ${botDifficultyText(state.botDifficulty)}`;
  $("playerCounter").textContent = `${state.players.length}/4`;
  const amHost = state.me.id === state.hostId;

  $("lobbyPlayers").innerHTML = state.players.map(player => `<div class="lobby-player${player.connected ? "" : " offline"}">
      <span class="avatar">${escapeHtml(player.isBot ? "🤖" : player.name.charAt(0).toUpperCase())}</span>
      <span class="name">${escapeHtml(player.name)}</span>
      <span class="player-tag">${player.id === state.me.id ? "VOCÊ " : ""}${player.isBot ? `BOT ${botDifficultyText(player.botDifficulty || state.botDifficulty).toUpperCase()} ` : ""}${player.isHost ? "ANFITRIÃO" : ""}</span>
      ${amHost && player.isBot ? `<button class="bot-remove" data-bot-id="${player.id}" aria-label="Remover bot">×</button>` : ""}
    </div>`).join("");

  $("hostControls").classList.toggle("hidden", !amHost);
  $("botDifficultyControl").classList.toggle("hidden", !amHost);
  $("lobbyBotDifficultySelect").value = state.botDifficulty || "medium";
  $("addBotBtn").disabled = state.players.length >= 4;
  $("fillBotsBtn").disabled = state.players.length >= 4;
  $("startGameBtn").disabled = state.players.length !== 4 || state.players.some(player => !player.isBot && !player.connected);
  $("lobbyHint").textContent = state.players.length < 4
    ? `Faltam ${4 - state.players.length} jogador(es). Você pode aguardar ou adicionar bots.`
    : amHost ? "Mesa completa. Você pode iniciar." : "Aguardando o anfitrião iniciar.";
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
  element.innerHTML = playerSeatHtml(player, isMe);
  element.classList.toggle("active", state.currentPlayerId === player.id);
  element.classList.toggle("offline", !player.connected);
}

function renderScoreboard() {
  const board = $("scoreboard");
  if (state.mode !== "points") {
    board.classList.add("hidden");
    return;
  }
  board.classList.remove("hidden");
  const sorted = [...state.players].sort((a, b) => a.score - b.score || a.name.localeCompare(b.name, "pt-BR"));
  board.innerHTML = sorted.map((player, index) => `<div class="score-item"><span>${index + 1}º ${escapeHtml(player.name)}${player.isBot ? " 🤖" : ""}</span><b>${player.score}/${state.scoreLimit} pts</b></div>`).join("");
}

function renderGame() {
  showScreen("gameScreen");
  $("gameRoomCode").textContent = state.code;
  $("roundText").textContent = state.mode === "points"
    ? `Bloco ${state.blockNumber} • Rodada ${state.roundInBlock} de ${state.roundsPerBlock} • ${state.scoreLimit} pontos elimina`
    : "Partida única";
  $("pauseBanner").classList.toggle("hidden", !state.paused);
  renderScoreboard();

  const relative = relativePlayers();
  renderSeat("seatSouth", relative.south, true);
  renderSeat("seatEast", relative.east);
  renderSeat("seatNorth", relative.north);
  renderSeat("seatWest", relative.west);

  const myTurn = state.currentPlayerId === state.me.id && !state.paused && state.status === "playing";
  const current = state.players.find(player => player.id === state.currentPlayerId);
  $("turnStatus").textContent = state.paused
    ? "Partida pausada"
    : state.closingPhase
      ? myTurn ? "Jogada final: sua vez" : current ? `Jogada final: vez de ${current.name}` : "Finalizando a rodada"
      : myTurn ? "Sua vez" : current ? `Vez de ${current.name}` : "Rodada encerrada";

  if (state.lastPlay) {
    $("lastPlayLabel").textContent = `${state.lastPlay.playerName} — ${state.lastPlay.combo.type}`;
    $("playedCards").innerHTML = state.lastPlay.cards.map(cardHtml).join("");
    $("playedCards").querySelectorAll(".card").forEach(card => { card.disabled = true; });
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
    : combo.valid ? `${selectedCards.length} selecionada(s): ${combo.type}` : `${selectedCards.length} selecionada(s): combinação inválida`;
  $("tableActionHint").textContent = myTurn
    ? selectedCards.length
      ? state.closingPhase ? "Clique na mesa para fazer sua última jogada" : "Clique na mesa para confirmar a jogada"
      : state.closingPhase ? "Faça uma última jogada maior ou passe" : "Selecione as cartas e clique aqui para jogar"
    : state.closingPhase ? "Aguardando as jogadas finais" : "Aguarde sua vez";
  $("playSurface").classList.toggle("disabled", !myTurn);
  $("playSurface").setAttribute("aria-disabled", String(!myTurn));
  $("playSurface").classList.toggle("ready", myTurn && selectedCards.length > 0);
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
  return combo.valid && target.valid && combo.count === target.count && compareTuples(combo.strength, target.strength) > 0;
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
  if (!legal.length) {
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

function renderRoundResults() {
  const container = $("roundResults");
  if (!state.roundResults?.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = state.roundResults.map(result => `<div class="result-row">
    <span>${escapeHtml(result.name)}</span>
    <small>${result.remainingCards} carta(s) restantes</small>
    <b class="${result.delta > 0 ? "negative" : "positive"}">${state.mode === "points" ? `+${result.delta} pts • total ${result.score}` : result.remainingCards === 0 ? "Sem cartas" : `${result.remainingCards} carta(s)`}</b>
  </div>`).join("");
}

function renderWinner() {
  const handWinner = state.players.find(player => player.id === state.winnerId);
  const amHost = state.me.id === state.hostId;
  const finalSeries = state.mode === "points" && state.status === "finished";

  if (finalSeries) {
    const winners = state.players.filter(player => state.seriesWinnerIds.includes(player.id));
    const losers = state.players.filter(player => state.seriesLoserIds.includes(player.id));
    const winnerNames = winners.map(player => player.name).join(" e ");
    const loserNames = losers.map(player => player.name).join(" e ");
    const amLoser = losers.some(player => player.id === state.me.id);
    $("winnerTitle").textContent = amLoser
      ? "Você atingiu 31 pontos e perdeu"
      : winners.some(player => player.id === state.me.id) ? "Você venceu!" : `${winnerNames} venceu`;
    $("winnerText").textContent = `${loserNames} chegou a ${state.scoreLimit} pontos ou mais. A partida terminou após ${state.roundNumber} rodadas.`;
    $("nextRoundBtn").textContent = "Nova partida";
  } else if (state.status === "block_finished") {
    $("winnerTitle").textContent = `Bloco ${state.blockNumber} concluído`;
    $("winnerText").textContent = `Ninguém atingiu ${state.scoreLimit} pontos. Os pontos continuam acumulados e serão jogadas mais quatro rodadas.`;
    $("nextRoundBtn").textContent = "Começar próximo bloco";
  } else if (state.status === "round_finished") {
    $("winnerTitle").textContent = handWinner?.id === state.me.id ? "Você bateu!" : `${handWinner?.name || "Um jogador"} bateu`;
    $("winnerText").textContent = `Rodada ${state.roundInBlock} de ${state.roundsPerBlock} do bloco ${state.blockNumber} concluída.`;
    $("nextRoundBtn").textContent = "Próxima rodada";
  } else {
    $("winnerTitle").textContent = handWinner?.id === state.me.id ? "Você venceu!" : `${handWinner?.name || "Um jogador"} venceu`;
    $("winnerText").textContent = "Todos tiveram sua jogada final e a partida terminou.";
    $("nextRoundBtn").textContent = "Jogar novamente";
  }

  renderRoundResults();
  $("nextRoundBtn").classList.toggle("hidden", !amHost);
  $("winnerModal").classList.remove("hidden");
}

function renderState() {
  if (!state) return;
  const session = getSession();
  if (!session || session.token !== state.me.token) {
    setSession({ code: state.code, token: state.me.token, playerId: state.me.id, name: state.me.name });
  }
  if (state.status === "lobby") {
    selectedIds.clear();
    $("winnerModal").classList.add("hidden");
    renderLobby();
  } else {
    renderGame();
    if (["round_finished", "block_finished", "finished"].includes(state.status)) renderWinner();
    else $("winnerModal").classList.add("hidden");
  }
}

function openRules() { $("rulesModal").classList.remove("hidden"); }
function closeRules() { $("rulesModal").classList.add("hidden"); }

socket.on("connect", () => {
  $("connectionText").textContent = "Servidor conectado.";
  announcePresence();
  if (getSession()) rejoin();
});

socket.on("disconnect", () => {
  $("connectionText").textContent = "Conexão perdida. Tentando reconectar...";
  toast("Conexão perdida. Tentando reconectar...", "warning");
});

socket.on("room_state", nextState => {
  state = nextState;
  renderState();
});

socket.on("notice", message => toast(message.text, message.tone));
socket.on("directory_state", nextDirectory => {
  directory = nextDirectory || { onlineCount: 0, availableCount: 0, players: [], openRooms: [] };
  renderDirectory();
});

$("createRoomBtn").addEventListener("click", createRoom);
$("playBotsBtn").addEventListener("click", playAgainstBots);
$("joinRoomBtn").addEventListener("click", () => joinRoom());
$("startGameBtn").addEventListener("click", startGame);
$("nextRoundBtn").addEventListener("click", () => {
  $("winnerModal").classList.add("hidden");
  startGame();
});
$("addBotBtn").addEventListener("click", addBot);
$("fillBotsBtn").addEventListener("click", fillBots);
$("lobbyBotDifficultySelect").addEventListener("change", updateBotDifficulty);
$("botDifficultySelect").addEventListener("change", event => {
  localStorage.setItem("pokerChinesBotDifficulty", event.target.value);
});
$("lobbyPlayers").addEventListener("click", event => {
  const button = event.target.closest(".bot-remove");
  if (button) removeBot(button.dataset.botId);
});
$("leaveBtn").addEventListener("click", confirmAndLeaveRoom);
$("gameLeaveBtn").addEventListener("click", confirmAndLeaveRoom);
$("globalHomeBtn").addEventListener("click", goHome);
$("copyRoomBtn").addEventListener("click", copyInvite);
$("copyGameBtn").addEventListener("click", copyInvite);
$("playSurface").addEventListener("click", playCards);
$("playSurface").addEventListener("keydown", event => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    playCards();
  }
});
$("passBtn").addEventListener("click", passTurn);
$("hintBtn").addEventListener("click", giveHint);
$("homeRulesBtn").addEventListener("click", openRules);
$("lobbyRulesBtn").addEventListener("click", openRules);
$("gameRulesBtn").addEventListener("click", openRules);
$("closeRulesBtn").addEventListener("click", closeRules);
$("rulesModal").addEventListener("click", event => { if (event.target.id === "rulesModal") closeRules(); });
$("winnerLobbyBtn").addEventListener("click", goHome);

$("roomCodeInput").addEventListener("input", event => { event.target.value = cleanCode(event.target.value); });
["createName", "joinName"].forEach(inputId => {
  $(inputId).addEventListener("input", event => schedulePresence(event.target.value, inputId));
});
$("createName").addEventListener("keydown", event => { if (event.key === "Enter") createRoom(); });
$("roomCodeInput").addEventListener("keydown", event => { if (event.key === "Enter") joinRoom(); });
$("openRooms").addEventListener("click", event => {
  const button = event.target.closest(".join-open-room");
  if (button) joinRoom(button.dataset.roomCode);
});

document.addEventListener("keydown", event => {
  if (event.key === "Enter" && state?.status === "playing" && state.currentPlayerId === state.me.id && selectedIds.size > 0) {
    playCards();
  }
});

const codeFromUrl = cleanCode(new URLSearchParams(location.search).get("room"));
if (codeFromUrl) $("roomCodeInput").value = codeFromUrl;
const initialName = savedName();
if (initialName) syncNameInputs(initialName);
const savedBotDifficulty = localStorage.getItem("pokerChinesBotDifficulty");
if (savedBotDifficulty === "medium" || savedBotDifficulty === "hard") {
  $("botDifficultySelect").value = savedBotDifficulty;
}
renderDirectory();
