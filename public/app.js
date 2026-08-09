"use strict";

const AUTH_TOKEN_KEY = "pokerChinesAuthToken";
const socket = io({ reconnection: true, auth: { token: localStorage.getItem(AUTH_TOKEN_KEY) || "" } });
const SUITS = [
  { symbol: "♦", name: "Ouros", red: true },
  { symbol: "♥", name: "Copas", red: true },
  { symbol: "♠", name: "Espadas", red: false },
  { symbol: "♣", name: "Paus", red: false }
];
const RANKS = ["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"];

let state = null;
let selectedIds = new Set();
let hintedIds = new Set();
let hintTimer = null;
let toastTimer = null;
let directory = { onlineCount: 0, availableCount: 0, players: [], openRooms: [] };
let presenceTimer = null;
let turnCountdownTimer = null;
let account = null;
let leaderboard = [];
let homeRankMode = "single";
let profileCache = null;
let handSortMode = localStorage.getItem("pokerChinesHandSort") === "suit" ? "suit" : "rank";

const $ = id => document.getElementById(id);
const screens = ["homeScreen", "lobbyScreen", "gameScreen"];

function authToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

async function apiFetch(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = authToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  let data;
  try { data = await response.json(); }
  catch { data = { ok: false, error: "Resposta inválida do servidor." }; }
  if (!response.ok || !data?.ok) throw new Error(data?.error || "Não foi possível concluir a operação.");
  return data;
}

function accountInitial() {
  return (account?.displayName || "J").charAt(0).toUpperCase();
}

function syncAccountUi() {
  const registered = Boolean(account?.id);
  $("guestAccountBox").classList.toggle("hidden", registered);
  $("memberAccountBox").classList.toggle("hidden", !registered);
  if (registered) {
    $("accountDisplayName").textContent = account.displayName;
    $("accountAvatar").textContent = accountInitial();
    ["createName", "joinName"].forEach(id => {
      $(id).value = account.displayName;
      $(id).readOnly = true;
      $(id).title = "O nome do perfil é usado nas partidas cadastradas.";
    });
    setSavedName(account.displayName);
  } else {
    ["createName", "joinName"].forEach(id => {
      $(id).readOnly = false;
      $(id).title = "";
    });
  }
}

function setAccountSession(data) {
  account = data?.user || null;
  if (data?.token) localStorage.setItem(AUTH_TOKEN_KEY, data.token);
  socket.auth = { token: authToken() };
  socket.emit("authenticate_user", { token: authToken() }, () => {});
  profileCache = null;
  syncAccountUi();
  loadLeaderboard();
}

function logoutAccount() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  account = null;
  profileCache = null;
  socket.auth = { token: "" };
  socket.emit("authenticate_user", { token: "" }, () => {});
  syncAccountUi();
  toast("Você saiu da conta. O jogo continua disponível como visitante.", "success");
}

function openAuth(mode = "login") {
  showAuthMode(mode);
  $("authModal").classList.remove("hidden");
  setTimeout(() => $(mode === "register" ? "registerDisplayName" : "loginUsername").focus(), 30);
}

function closeAuth() { $("authModal").classList.add("hidden"); }

function showAuthMode(mode) {
  const register = mode === "register";
  $("loginTabBtn").classList.toggle("active", !register);
  $("registerTabBtn").classList.toggle("active", register);
  $("loginForm").classList.toggle("hidden", register);
  $("registerForm").classList.toggle("hidden", !register);
}

async function loginAccount(event) {
  event.preventDefault();
  try {
    const result = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: $("loginUsername").value, password: $("loginPassword").value })
    });
    setAccountSession(result);
    $("loginPassword").value = "";
    closeAuth();
    toast(`Bem-vindo, ${result.user.displayName}.`, "success");
  } catch (error) { toast(error.message, "error"); }
}

async function registerAccount(event) {
  event.preventDefault();
  const password = $("registerPassword").value;
  if (password !== $("registerPasswordConfirm").value) {
    toast("As senhas não coincidem.", "warning");
    return;
  }
  try {
    const result = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: $("registerDisplayName").value,
        username: $("registerUsername").value,
        password
      })
    });
    setAccountSession(result);
    $("registerPassword").value = "";
    $("registerPasswordConfirm").value = "";
    closeAuth();
    toast("Conta criada. Suas próximas vitórias serão registradas.", "success");
  } catch (error) { toast(error.message, "error"); }
}

function rankingValues(row, mode) {
  if (mode === "blocks") return { points: row.blockPoints, wins: row.blockWins, games: row.blockGames, label: "blocos" };
  if (mode === "total") return { points: row.totalPoints, wins: row.totalWins, games: row.totalGames, label: "jogos" };
  return { points: row.singlePoints, wins: row.singleWins, games: row.singleGames, label: "únicas" };
}

function sortedLeaderboard(mode) {
  return [...leaderboard].sort((a, b) => {
    const av = rankingValues(a, mode);
    const bv = rankingValues(b, mode);
    return bv.points - av.points || bv.wins - av.wins || a.displayName.localeCompare(b.displayName, "pt-BR");
  });
}

function leaderboardHtml(mode, limit = 12) {
  const rows = sortedLeaderboard(mode).slice(0, limit);
  if (!rows.length) return '<div class="empty-state">O ranking começará quando usuários cadastrados vencerem partidas.</div>';
  return rows.map((row, index) => {
    const values = rankingValues(row, mode);
    const mine = account?.id === row.userId;
    return `<div class="leaderboard-row${mine ? " is-me" : ""}">
      <span class="leaderboard-position">${String(index + 1).padStart(2, "0")}</span>
      <span class="leaderboard-player"><b>${escapeHtml(row.displayName)}${mine ? " · você" : ""}</b><small>@${escapeHtml(row.username)} · ${values.wins} vitória(s) em ${values.games} ${values.label}</small></span>
      <span class="leaderboard-score"><b>${values.points}</b><small>pontos</small></span>
    </div>`;
  }).join("");
}

function renderHomeLeaderboard() {
  ["homeRankSingleBtn", "homeRankBlocksBtn", "homeRankTotalBtn"].forEach(id => {
    const button = $(id);
    button.classList.toggle("active", button.dataset.rankMode === homeRankMode);
  });
  $("homeLeaderboard").innerHTML = leaderboardHtml(homeRankMode, 10);
}

async function loadLeaderboard() {
  try {
    const result = await apiFetch("/api/leaderboard", { method: "GET" });
    leaderboard = result.leaderboard || [];
    renderHomeLeaderboard();
    if (!$("profileModal").classList.contains("hidden")) {
      $("profileLeaderboard").innerHTML = leaderboardHtml("total", 10);
    }
  } catch (error) {
    $("homeLeaderboard").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function historyHtml(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return '<div class="empty-state">Nenhuma partida cadastrada.</div>';
  return matches.map(match => {
    const date = match.finishedAt ? new Date(match.finishedAt).toLocaleDateString("pt-BR") : "-";
    const mode = match.mode === "blocks" ? "Blocos de 4" : "Partida única";
    return `<div class="history-row${match.won ? " won" : ""}">
      <span class="history-result">${match.won ? "V" : "-"}</span>
      <span><b>${mode}</b><small>Sala ${escapeHtml(match.roomCode || "-")} · ${date}</small></span>
      <strong>${match.won ? "+1 pt" : "0 pt"}</strong>
    </div>`;
  }).join("");
}

function renderProfile(profile) {
  const stats = profile.stats || {};
  $("profileName").textContent = profile.user.displayName;
  $("profileUsername").textContent = `@${profile.user.username}`;
  $("profileSinglePoints").textContent = stats.singlePoints || 0;
  $("profileSingleWins").textContent = stats.singleWins || 0;
  $("profileSingleGames").textContent = stats.singleGames || 0;
  $("profileBlockPoints").textContent = stats.blockPoints || 0;
  $("profileBlockWins").textContent = stats.blockWins || 0;
  $("profileBlockGames").textContent = stats.blockGames || 0;
  $("profileTotalPoints").textContent = stats.totalPoints || 0;
  $("profileTotalWins").textContent = stats.totalWins || 0;
  $("profileHistory").innerHTML = historyHtml(profile.matches);
  $("profileLeaderboard").innerHTML = leaderboardHtml("total", 10);
}

async function openProfile() {
  if (!account) { openAuth("login"); return; }
  $("profileModal").classList.remove("hidden");
  try {
    const profile = await apiFetch("/api/auth/me", { method: "GET" });
    profileCache = profile;
    account = profile.user;
    syncAccountUi();
    renderProfile(profile);
  } catch (error) {
    closeProfile();
    toast(error.message, "error");
  }
}

function closeProfile() { $("profileModal").classList.add("hidden"); }

async function loadCurrentAccount() {
  if (!authToken()) { syncAccountUi(); return; }
  try {
    const profile = await apiFetch("/api/auth/me", { method: "GET" });
    account = profile.user;
    profileCache = profile;
    socket.auth = { token: authToken() };
    socket.emit("authenticate_user", { token: authToken() }, () => {});
  } catch {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    account = null;
    socket.auth = { token: "" };
  }
  syncAccountUi();
}

function showScreen(id) {
  screens.forEach(screenId => $(screenId).classList.toggle("hidden", screenId !== id));
  $("globalHomeBtn").classList.toggle("hidden", id === "homeScreen");
  if (id !== "gameScreen") stopTurnCountdown();
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
  return cleanName(account?.displayName || localStorage.getItem("pokerChinesName") || getSession()?.name || "");
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
  const name = account?.displayName || syncNameInputs($("createName").value, "createName");
  if (name.length < 2) {
    toast("Digite seu nome antes de criar a sala.", "warning");
    $("createName").focus();
    return;
  }
  const mode = $("gameModeSelect").value;
  const botDifficulty = $("botDifficultySelect").value;
  const turnDuration = Number($("turnDurationSelect").value) === 60 ? 60 : 30;
  const isPublic = $("publicRoomCheck").checked;
  localStorage.setItem("pokerChinesBotDifficulty", botDifficulty);
  localStorage.setItem("pokerChinesTurnDuration", String(turnDuration));
  socket.emit("create_room", { name, isPublic, mode, botDifficulty, turnDuration }, result => {
    callbackResult(result, data => {
      setSession({ code: data.code, token: data.token, playerId: data.playerId, name });
      history.replaceState({}, "", `?room=${data.code}`);
      toast("Sala criada.", "success");
    });
  });
}

function playAgainstBots() {
  const name = account?.displayName || syncNameInputs($("createName").value, "createName");
  if (name.length < 2) {
    toast("Digite seu nome antes de jogar contra os bots.", "warning");
    $("createName").focus();
    return;
  }
  const mode = $("gameModeSelect").value;
  const botDifficulty = $("botDifficultySelect").value;
  const turnDuration = Number($("turnDurationSelect").value) === 60 ? 60 : 30;
  localStorage.setItem("pokerChinesBotDifficulty", botDifficulty);
  localStorage.setItem("pokerChinesTurnDuration", String(turnDuration));
  socket.emit("create_room", {
    name,
    isPublic: false,
    mode,
    botDifficulty,
    turnDuration,
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
  const name = account?.displayName || syncNameInputs($("joinName").value || $("createName").value, "joinName");
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

function updateTurnDuration() {
  const turnDuration = Number($("lobbyTurnDurationSelect").value) === 60 ? 60 : 30;
  socket.emit("update_turn_duration", { turnDuration }, result => {
    if (!result?.ok) {
      toast(result?.error || "Não foi possível alterar o tempo por jogada.", "error");
      return;
    }
    localStorage.setItem("pokerChinesTurnDuration", String(turnDuration));
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
  if (difficulty === "expert") return "Especialista";
  if (difficulty === "hard") return "Difícil";
  return "Médio";
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
          <span class="online-main"><b>${escapeHtml(player.name)}${player.registered ? ' <span class="registered-mark">CAD.</span>' : ""}${isMe ? " (você)" : ""}</b><small>${escapeHtml(statusText(player))}</small></span>
          <span class="status-chip ${available ? "available" : "busy"}">${available ? "Livre" : "Ocupado"}</span>
        </div>`;
      }).join("");

  $("openRooms").innerHTML = rooms.length === 0
    ? '<div class="empty-state">Nenhuma sala pública aguardando jogadores.</div>'
    : rooms.map(room => `<div class="online-item room-list-item">
        <span class="room-code-mini">${escapeHtml(room.code)}</span>
        <span class="online-main">
          <b>Sala de ${escapeHtml(room.hostName)}</b>
          <small>${escapeHtml(modeText(room.mode))} • ${Number(room.turnDuration) === 60 ? 60 : 30}s/jogada • Bots ${escapeHtml(botDifficultyText(room.botDifficulty))} • ${room.humanCount} pessoa(s) • ${room.botCount} bot(s)</small>
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
  const isForbiddenJqka2 = uniqueRanks.length === 5 &&
    uniqueRanks.every((rank, index) => rank === 8 + index);

  // Regra especial: 2-3-4-5-6 é uma sequência válida.
  // Como o 2 é a carta mais alta do jogo, esta é a sequência mais forte.
  const isSpecial23456 = uniqueRanks.length === 5 &&
    [0, 1, 2, 3, 12].every(rank => uniqueRanks.includes(rank));

  const isNormalStraight = uniqueRanks.length === 5 &&
    uniqueRanks.every((rank, index) => index === 0 || rank === uniqueRanks[index - 1] + 1);

  const isStraight = !isForbiddenJqka2 && (isNormalStraight || isSpecial23456);
  const isFlush = sorted.every(card => card.suit === sorted[0].suit);
  const counts = new Map();
  sorted.forEach(card => counts.set(card.rank, (counts.get(card.rank) || 0) + 1));
  const entries = [...counts.entries()].map(([rank, amount]) => ({ rank, amount }));
  const four = entries.find(entry => entry.amount === 4);
  const triple = entries.find(entry => entry.amount === 3);
  const pair = entries.find(entry => entry.amount === 2);

  if (isStraight && isFlush) {
    const high = isSpecial23456
      ? sorted.find(card => card.rank === 12)
      : sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência do mesmo naipe", strength: [4, high.rank, high.suit] };
  }
  if (four) {
    const kicker = sorted.find(card => card.rank !== four.rank);
    return { valid: true, count, type: "Quadra + carta", strength: [3, four.rank, kicker.rank, kicker.suit] };
  }
  if (triple && pair) return { valid: true, count, type: "Full House", strength: [2, triple.rank] };
  if (isFlush) {
    const ranksDescending = [...sorted].sort((a, b) => b.rank - a.rank).map(card => card.rank);
    return { valid: true, count, type: "Flush", strength: [1, ...ranksDescending] };
  }
  if (isStraight) {
    const high = isSpecial23456
      ? sorted.find(card => card.rank === 12)
      : sorted[sorted.length - 1];
    return { valid: true, count, type: "Sequência", strength: [0, high.rank, high.suit] };
  }
  return { valid: false };
}

function cardHtml(card) {
  const suit = SUITS[card.suit];
  const rank = RANKS[card.rank];
  const red = suit.red ? " red" : "";
  const faceClass = rank === "J" || rank === "Q" || rank === "K" || rank === "A"
    ? ` face-card face-${rank.toLowerCase()}`
    : "";

  const center = faceClass
    ? `<span class="card-watermark" aria-hidden="true">${suit.symbol}</span><span class="card-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>`
    : `<span class="card-suit">${suit.symbol}</span>`;

  return `<button class="card${red}${faceClass}" data-card-id="${card.id}" aria-label="${rank} de ${suit.name}">
    <span class="card-rank"><strong>${rank}</strong><small>${suit.symbol}</small></span>
    ${center}
    <span class="card-rank card-bottom"><strong>${rank}</strong><small>${suit.symbol}</small></span>
  </button>`;
}

function sortedPlayerHand(cards) {
  const ordered = [...cards];
  if (handSortMode === "suit") {
    return ordered.sort((a, b) => a.suit - b.suit || a.rank - b.rank || a.id - b.id);
  }
  return ordered.sort((a, b) => a.rank - b.rank || a.suit - b.suit || a.id - b.id);
}

function syncHandSortButtons() {
  const byRank = handSortMode === "rank";
  const rankButton = $("sortByRankBtn");
  const suitButton = $("sortBySuitBtn");
  if (!rankButton || !suitButton) return;

  rankButton.classList.toggle("active", byRank);
  suitButton.classList.toggle("active", !byRank);
  rankButton.setAttribute("aria-pressed", String(byRank));
  suitButton.setAttribute("aria-pressed", String(!byRank));
}

function setHandSortMode(mode) {
  const nextMode = mode === "suit" ? "suit" : "rank";
  if (handSortMode === nextMode) {
    syncHandSortButtons();
    return;
  }

  handSortMode = nextMode;
  localStorage.setItem("pokerChinesHandSort", handSortMode);
  syncHandSortButtons();

  if (state && ["playing", "round_finished", "block_finished", "finished"].includes(state.status)) {
    renderGame();
  }
}

function miniDeck(count) {
  return `<div class="mini-deck">${Array.from({ length: Math.min(count, 13) }, () => '<span class="card-back"></span>').join("")}</div>`;
}

function playerSeatHtml(player, isMe = false) {
  const bot = player.isBot ? " 🤖" : "";
  const botLevel = player.isBot ? ` • ${botDifficultyText(player.botDifficulty || state.botDifficulty)}` : "";
  const meLabel = isMe ? " (você)" : "";
  const registered = player.registered ? ' <span class="registered-mark">●</span>' : "";
  return `<div class="seat-name"><span class="online-dot${player.connected ? "" : " off"}"></span>${escapeHtml(player.name)}${registered}${bot}${meLabel}</div>
    <div class="seat-meta">${player.cardCount} carta${player.cardCount === 1 ? "" : "s"}${botLevel}${state.mode === "points" ? ` • ${player.score}/${state.scoreLimit} pts` : ""}</div>
    ${isMe ? "" : miniDeck(player.cardCount)}`;
}

function renderLobby() {
  showScreen("lobbyScreen");
  $("roomCodeDisplay").textContent = state.code;
  $("roomModeText").textContent = `${modeText(state.mode)} • ${state.turnDuration || 30}s por jogada • Bots ${botDifficultyText(state.botDifficulty)}`;
  $("playerCounter").textContent = `${state.players.length}/4`;
  const amHost = state.me.id === state.hostId;

  $("lobbyPlayers").innerHTML = state.players.map(player => `<div class="lobby-player${player.connected ? "" : " offline"}">
      <span class="avatar">${escapeHtml(player.isBot ? "🤖" : player.name.charAt(0).toUpperCase())}</span>
      <span class="name">${escapeHtml(player.name)}</span>
      <span class="player-tag">${player.id === state.me.id ? "VOCÊ " : ""}${player.registered ? "CADASTRADO " : ""}${player.isBot ? `BOT ${botDifficultyText(player.botDifficulty || state.botDifficulty).toUpperCase()} ` : ""}${player.isHost ? "ANFITRIÃO" : ""}</span>
      ${amHost && player.isBot ? `<button class="bot-remove" data-bot-id="${player.id}" aria-label="Remover bot">×</button>` : ""}
    </div>`).join("");

  $("hostControls").classList.toggle("hidden", !amHost);
  $("botDifficultyControl").classList.toggle("hidden", !amHost);
  $("turnDurationControl").classList.toggle("hidden", !amHost);
  $("lobbyBotDifficultySelect").value = state.botDifficulty || "medium";
  $("lobbyTurnDurationSelect").value = String(state.turnDuration || 30);
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
  board.innerHTML = sorted.map((player, index) => `<div class="score-item ${player.id === state.me.id ? "me" : ""}"><div><span>${index + 1}º ${escapeHtml(player.name)}${player.isBot ? " · bot" : ""}</span><small>Total acumulado</small></div><b>${player.score}/${state.scoreLimit} pts</b></div>`).join("");
}

function stopTurnCountdown() {
  if (turnCountdownTimer) clearInterval(turnCountdownTimer);
  turnCountdownTimer = null;
}

function updateTurnCountdown() {
  const timer = $("turnTimer");
  const text = $("turnTimerText");
  const bar = $("turnProgressBar");
  if (!timer || !text || !bar) return;

  const active = state && state.status === "playing" && !state.paused && state.currentPlayerId && state.turnDeadline;
  if (!active) {
    timer.classList.add("paused");
    timer.classList.remove("warning", "critical");
    text.textContent = state?.paused ? "Pausado" : "--";
    bar.style.width = "0%";
    return;
  }

  timer.classList.remove("paused");
  const duration = Number(state.turnDuration) === 60 ? 60 : 30;
  const remainingMs = Math.max(0, Number(state.turnDeadline) - Date.now());
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const percentage = Math.max(0, Math.min(100, (remainingMs / (duration * 1000)) * 100));

  text.textContent = `${remainingSeconds}s`;
  bar.style.width = `${percentage}%`;
  timer.classList.toggle("warning", remainingSeconds <= 10 && remainingSeconds > 5);
  timer.classList.toggle("critical", remainingSeconds <= 5);
}

function startTurnCountdown() {
  stopTurnCountdown();
  updateTurnCountdown();
  if (state?.status === "playing") {
    turnCountdownTimer = setInterval(updateTurnCountdown, 200);
  }
}

function renderGame() {
  showScreen("gameScreen");
  $("gameRoomCode").textContent = state.code;
  $("roundText").textContent = state.mode === "points"
    ? `Bloco ${state.blockNumber} • Rodada ${state.roundInBlock} de ${state.roundsPerBlock} • ${state.scoreLimit} pontos elimina • ${state.turnDuration || 30}s por jogada`
    : `Partida única • ${state.turnDuration || 30}s por jogada`;
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
  hintedIds = new Set([...hintedIds].filter(id => currentCardIds.has(id)));
  $("hand").innerHTML = sortedPlayerHand(state.me.hand).map(cardHtml).join("");
  syncHandSortButtons();
  $("hand").classList.toggle("disabled", !myTurn);
  $("hand").querySelectorAll(".card").forEach(element => {
    const id = Number(element.dataset.cardId);
    element.classList.toggle("selected", selectedIds.has(id));
    element.classList.toggle("hinted", hintedIds.has(id));
    element.disabled = !myTurn;
    element.addEventListener("click", () => {
      if (!myTurn) return;
      hintedIds.delete(id);
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
  startTurnCountdown();
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
  clearTimeout(hintTimer);
  hintedIds = new Set(legal[0].cards.map(card => card.id));
  renderGame();
  toast(`Sugestão: ${legal[0].combo.type}. As cartas abaixarão novamente.`, "success");
  hintTimer = setTimeout(() => {
    hintedIds.clear();
    if (state?.status === "playing") renderGame();
  }, 2400);
}

function requestRematch() {
  socket.emit("request_rematch", {}, result => {
    if (!result?.ok) {
      toast(result?.error || "Não foi possível confirmar a revanche.", "error");
      return;
    }
    toast(`Você está pronto (${result.votes}/${result.required}).`, "success");
  });
}

function renderRoundResults() {
  const container = $("roundResults");
  if (!state.roundResults?.length) {
    container.innerHTML = "";
    return;
  }
  const sortedResults = [...state.roundResults].sort((a, b) => {
    if (state.mode === "points") return a.score - b.score || a.remainingCards - b.remainingCards || a.name.localeCompare(b.name, "pt-BR");
    return a.remainingCards - b.remainingCards || a.name.localeCompare(b.name, "pt-BR");
  });
  container.innerHTML = sortedResults.map(result => `<div class="result-row">
    <span>${escapeHtml(result.name)}</span>
    <small>${result.remainingCards} carta(s) restantes</small>
    <b class="${result.delta > 0 ? "negative" : "positive"}">${state.mode === "points" ? `+${result.delta} pts • total ${result.score}` : result.remainingCards === 0 ? "Sem cartas" : `${result.remainingCards} carta(s)`}</b>
  </div>`).join("");
}

function renderWinner() {
  const handWinner = state.players.find(player => player.id === state.winnerId);
  const finalSeries = state.mode === "points" && state.status === "finished";
  const alreadyReady = state.rematchVoteIds?.includes(state.me.id);

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
  $("nextRoundBtn").classList.remove("hidden");
  $("nextRoundBtn").disabled = Boolean(alreadyReady);
  if (alreadyReady) $("nextRoundBtn").textContent = "Aguardando os demais...";
  $("rematchStatus").textContent = `${state.rematchVoteCount || 0}/${state.rematchRequired || 1} jogador(es) prontos`;
  $("winnerModal").classList.remove("hidden");
  $("gameScreen").classList.add("modal-open");
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
    $("gameScreen").classList.remove("modal-open");
    renderLobby();
  } else {
    renderGame();
    if (["round_finished", "block_finished", "finished"].includes(state.status)) renderWinner();
    else { $("winnerModal").classList.add("hidden"); $("gameScreen").classList.remove("modal-open"); }
  }
}

function openRules() { $("rulesModal").classList.remove("hidden"); }
function closeRules() { $("rulesModal").classList.add("hidden"); }

socket.on("connect", () => {
  socket.auth = { token: authToken() };
  if (authToken()) socket.emit("authenticate_user", { token: authToken() }, () => {});
  $("connectionText").textContent = "Servidor conectado.";
  announcePresence();
  if (getSession()) rejoin();
});

socket.on("disconnect", () => {
  $("connectionText").textContent = "Conexão perdida. Tentando reconectar...";
  toast("Conexão perdida. Tentando reconectar...", "warning");
});

socket.on("auth_state", payload => {
  if (payload?.user && !account) {
    account = payload.user;
    syncAccountUi();
  }
});

socket.on("profile_updated", () => {
  profileCache = null;
  loadLeaderboard();
  if (!$("profileModal").classList.contains("hidden")) openProfile();
  toast("Seu ranking foi atualizado.", "success");
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
$("nextRoundBtn").addEventListener("click", requestRematch);
$("addBotBtn").addEventListener("click", addBot);
$("fillBotsBtn").addEventListener("click", fillBots);
$("lobbyBotDifficultySelect").addEventListener("change", updateBotDifficulty);
$("lobbyTurnDurationSelect").addEventListener("change", updateTurnDuration);
$("botDifficultySelect").addEventListener("change", event => {
  localStorage.setItem("pokerChinesBotDifficulty", event.target.value);
});
$("turnDurationSelect").addEventListener("change", event => {
  localStorage.setItem("pokerChinesTurnDuration", event.target.value === "60" ? "60" : "30");
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
$("sortByRankBtn").addEventListener("click", () => setHandSortMode("rank"));
$("sortBySuitBtn").addEventListener("click", () => setHandSortMode("suit"));
$("homeRulesBtn").addEventListener("click", openRules);
$("lobbyRulesBtn").addEventListener("click", openRules);
$("gameRulesBtn").addEventListener("click", openRules);
$("closeRulesBtn").addEventListener("click", closeRules);
$("rulesModal").addEventListener("click", event => { if (event.target.id === "rulesModal") closeRules(); });
$("winnerLobbyBtn").addEventListener("click", goHome);
$("openAuthBtn").addEventListener("click", () => openAuth("login"));
$("openProfileBtn").addEventListener("click", openProfile);
$("logoutBtn").addEventListener("click", logoutAccount);
$("lobbyAccountBtn").addEventListener("click", () => account ? openProfile() : openAuth("login"));
$("gameAccountBtn").addEventListener("click", () => account ? openProfile() : openAuth("login"));
$("closeAuthBtn").addEventListener("click", closeAuth);
$("authModal").addEventListener("click", event => { if (event.target.id === "authModal") closeAuth(); });
$("loginTabBtn").addEventListener("click", () => showAuthMode("login"));
$("registerTabBtn").addEventListener("click", () => showAuthMode("register"));
$("loginForm").addEventListener("submit", loginAccount);
$("registerForm").addEventListener("submit", registerAccount);
$("closeProfileBtn").addEventListener("click", closeProfile);
$("profileModal").addEventListener("click", event => { if (event.target.id === "profileModal") closeProfile(); });
["homeRankSingleBtn", "homeRankBlocksBtn", "homeRankTotalBtn"].forEach(id => {
  $(id).addEventListener("click", event => {
    homeRankMode = event.currentTarget.dataset.rankMode;
    renderHomeLeaderboard();
  });
});

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
  if (event.target.closest?.("input, textarea, select, button, [contenteditable='true']")) return;
  if (event.key === "Enter" && state?.status === "playing" && state.currentPlayerId === state.me.id && selectedIds.size > 0) {
    playCards();
  }
});

const codeFromUrl = cleanCode(new URLSearchParams(location.search).get("room"));
if (codeFromUrl) $("roomCodeInput").value = codeFromUrl;
const initialName = savedName();
if (initialName) syncNameInputs(initialName);
const savedBotDifficulty = localStorage.getItem("pokerChinesBotDifficulty");
if (["medium", "hard", "expert"].includes(savedBotDifficulty)) {
  $("botDifficultySelect").value = savedBotDifficulty;
}
const savedTurnDuration = localStorage.getItem("pokerChinesTurnDuration");
if (savedTurnDuration === "30" || savedTurnDuration === "60") {
  $("turnDurationSelect").value = savedTurnDuration;
}
renderDirectory();
syncHandSortButtons();
syncAccountUi();
loadCurrentAccount().then(() => {
  const name = savedName();
  if (name) syncNameInputs(name);
  announcePresence(name);
});
loadLeaderboard();
