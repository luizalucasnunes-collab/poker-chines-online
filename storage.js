"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "poker-users.json");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const ONLINE_ONLY = process.env.RENDER === "true" || process.env.ONLINE_ONLY === "true";
let pool = null;
let backend = "json";
let initialized = false;
let jsonQueue = Promise.resolve();

function normalizeUsername(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 24);
}

function cleanDisplayName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");
  if (password.length > 128) throw new Error("A senha é muito longa.");
  return password;
}

function passwordDigest(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqualHex(left, right) {
  try {
    const a = Buffer.from(String(left), "hex");
    const b = Buffer.from(String(right), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function emptyData() {
  return { version: 1, users: [], stats: {}, matches: [] };
}

async function readJson() {
  try {
    const content = await fsp.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(content);
    return {
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {},
      matches: Array.isArray(parsed.matches) ? parsed.matches : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyData();
    throw error;
  }
}

async function writeJson(data) {
  await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(temporary, DATA_FILE);
}

function withJsonLock(operation) {
  const next = jsonQueue.then(operation, operation);
  jsonQueue = next.catch(() => {});
  return next;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.displayName,
    createdAt: row.created_at ?? row.createdAt
  };
}

function defaultStats(userId) {
  return {
    userId,
    singleGames: 0,
    singleWins: 0,
    singlePoints: 0,
    blockGames: 0,
    blockWins: 0,
    blockPoints: 0,
    updatedAt: new Date().toISOString()
  };
}

function publicStats(row, user = null) {
  const base = defaultStats(row?.user_id || row?.userId || user?.id || null);
  const output = {
    ...base,
    userId: row?.user_id ?? row?.userId ?? base.userId,
    singleGames: Number(row?.single_games ?? row?.singleGames ?? 0),
    singleWins: Number(row?.single_wins ?? row?.singleWins ?? 0),
    singlePoints: Number(row?.single_points ?? row?.singlePoints ?? 0),
    blockGames: Number(row?.block_games ?? row?.blockGames ?? 0),
    blockWins: Number(row?.block_wins ?? row?.blockWins ?? 0),
    blockPoints: Number(row?.block_points ?? row?.blockPoints ?? 0),
    updatedAt: row?.updated_at ?? row?.updatedAt ?? base.updatedAt
  };
  output.totalGames = output.singleGames + output.blockGames;
  output.totalWins = output.singleWins + output.blockWins;
  output.totalPoints = output.singlePoints + output.blockPoints;
  if (user) {
    output.username = user.username;
    output.displayName = user.displayName;
  }
  return output;
}

async function initPostgres() {
  const { Pool } = require("pg");
  const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  await pool.query("SELECT 1");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pc_users (
      id TEXT PRIMARY KEY,
      username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(20) NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pc_user_stats (
      user_id TEXT PRIMARY KEY REFERENCES pc_users(id) ON DELETE CASCADE,
      single_games INTEGER NOT NULL DEFAULT 0,
      single_wins INTEGER NOT NULL DEFAULT 0,
      single_points INTEGER NOT NULL DEFAULT 0,
      block_games INTEGER NOT NULL DEFAULT 0,
      block_wins INTEGER NOT NULL DEFAULT 0,
      block_points INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pc_matches (
      id TEXT PRIMARY KEY,
      room_code VARCHAR(8),
      mode VARCHAR(12) NOT NULL,
      participant_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      winner_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS pc_matches_finished_idx ON pc_matches(finished_at DESC);
  `);
  backend = "postgres";
}

async function init() {
  if (initialized) return;
  if (DATABASE_URL) {
    await initPostgres();
  } else if (ONLINE_ONLY) {
    throw new Error(
      "DATABASE_URL não configurada. Para o jogo online, conecte o banco PostgreSQL do Neon no Render."
    );
  } else {
    await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
    if (!fs.existsSync(DATA_FILE)) await writeJson(emptyData());
    backend = "json";
  }
  initialized = true;
}

async function createUser({ username, displayName, password }) {
  await init();
  const cleanUsername = normalizeUsername(username);
  const cleanName = cleanDisplayName(displayName);
  const cleanPassword = validatePassword(password);
  if (cleanUsername.length < 3) throw new Error("O usuário precisa ter pelo menos 3 caracteres.");
  if (cleanName.length < 2) throw new Error("O nome público precisa ter pelo menos 2 caracteres.");

  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(18).toString("hex");
  const hash = passwordDigest(cleanPassword, salt);
  const createdAt = new Date().toISOString();

  if (backend === "postgres") {
    try {
      const result = await pool.query(
        `INSERT INTO pc_users (id, username, display_name, password_salt, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, display_name, created_at`,
        [id, cleanUsername, cleanName, salt, hash]
      );
      await pool.query("INSERT INTO pc_user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
      return publicUser(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") throw new Error("Este nome de usuário já está cadastrado.");
      throw error;
    }
  }

  return withJsonLock(async () => {
    const data = await readJson();
    if (data.users.some(user => user.username === cleanUsername)) {
      throw new Error("Este nome de usuário já está cadastrado.");
    }
    const user = {
      id,
      username: cleanUsername,
      displayName: cleanName,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt
    };
    data.users.push(user);
    data.stats[id] = defaultStats(id);
    await writeJson(data);
    return publicUser(user);
  });
}

async function authenticateUser(username, password) {
  await init();
  const cleanUsername = normalizeUsername(username);
  const supplied = String(password || "");
  let row;
  if (backend === "postgres") {
    const result = await pool.query(
      `SELECT id, username, display_name, password_salt, password_hash, created_at
       FROM pc_users WHERE username = $1`,
      [cleanUsername]
    );
    row = result.rows[0];
  } else {
    const data = await readJson();
    row = data.users.find(user => user.username === cleanUsername);
    if (row) {
      row = {
        ...row,
        display_name: row.displayName,
        password_salt: row.passwordSalt,
        password_hash: row.passwordHash,
        created_at: row.createdAt
      };
    }
  }
  if (!row) throw new Error("Usuário ou senha inválidos.");
  const digest = passwordDigest(supplied, row.password_salt);
  if (!safeEqualHex(digest, row.password_hash)) throw new Error("Usuário ou senha inválidos.");
  return publicUser(row);
}

async function getUserById(id) {
  await init();
  if (!id) return null;
  if (backend === "postgres") {
    const result = await pool.query(
      "SELECT id, username, display_name, created_at FROM pc_users WHERE id = $1",
      [id]
    );
    return publicUser(result.rows[0]);
  }
  const data = await readJson();
  return publicUser(data.users.find(user => user.id === id));
}

async function getProfile(userId) {
  await init();
  const user = await getUserById(userId);
  if (!user) return null;

  let stats;
  let matches;
  if (backend === "postgres") {
    const statsResult = await pool.query("SELECT * FROM pc_user_stats WHERE user_id = $1", [userId]);
    stats = publicStats(statsResult.rows[0], user);
    const matchesResult = await pool.query(
      `SELECT id, room_code, mode, participant_user_ids, winner_user_ids, started_at, finished_at
       FROM pc_matches
       WHERE participant_user_ids @> $1::jsonb
       ORDER BY finished_at DESC LIMIT 12`,
      [JSON.stringify([userId])]
    );
    matches = matchesResult.rows.map(row => ({
      id: row.id,
      roomCode: row.room_code,
      mode: row.mode,
      won: Array.isArray(row.winner_user_ids) && row.winner_user_ids.includes(userId),
      startedAt: row.started_at,
      finishedAt: row.finished_at
    }));
  } else {
    const data = await readJson();
    stats = publicStats(data.stats[userId], user);
    matches = data.matches
      .filter(match => match.participantUserIds.includes(userId))
      .sort((a, b) => new Date(b.finishedAt) - new Date(a.finishedAt))
      .slice(0, 12)
      .map(match => ({
        id: match.id,
        roomCode: match.roomCode,
        mode: match.mode,
        won: match.winnerUserIds.includes(userId),
        startedAt: match.startedAt,
        finishedAt: match.finishedAt
      }));
  }

  return { user, stats, matches };
}

async function getLeaderboard(limit = 20) {
  await init();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  if (backend === "postgres") {
    const result = await pool.query(
      `SELECT u.id, u.username, u.display_name, s.*
       FROM pc_users u
       JOIN pc_user_stats s ON s.user_id = u.id
       ORDER BY (s.single_points + s.block_points) DESC,
                (s.single_wins + s.block_wins) DESC,
                u.created_at ASC
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows.map(row => publicStats(row, publicUser(row)));
  }
  const data = await readJson();
  return data.users
    .map(user => publicStats(data.stats[user.id], publicUser(user)))
    .sort((a, b) => b.totalPoints - a.totalPoints || b.totalWins - a.totalWins || a.displayName.localeCompare(b.displayName, "pt-BR"))
    .slice(0, safeLimit);
}

async function recordMatch({ id, roomCode, mode, participantUserIds, winnerUserIds, startedAt, finishedAt }) {
  await init();
  const matchId = String(id || crypto.randomUUID());
  const participants = [...new Set((participantUserIds || []).filter(Boolean).map(String))];
  const winners = [...new Set((winnerUserIds || []).filter(Boolean).map(String))];
  const normalizedMode = mode === "blocks" || mode === "points" ? "blocks" : "single";
  if (participants.length === 0) return { recorded: false, reason: "no_registered_participants" };

  if (backend === "postgres") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO pc_matches
          (id, room_code, mode, participant_user_ids, winner_user_ids, started_at, finished_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [matchId, roomCode || null, normalizedMode, JSON.stringify(participants), JSON.stringify(winners), startedAt || null, finishedAt || new Date().toISOString()]
      );
      if (inserted.rowCount === 0) {
        await client.query("ROLLBACK");
        return { recorded: false, reason: "already_recorded" };
      }
      for (const userId of participants) {
        const won = winners.includes(userId) ? 1 : 0;
        if (normalizedMode === "single") {
          await client.query(
            `INSERT INTO pc_user_stats (user_id, single_games, single_wins, single_points)
             VALUES ($1, 1, $2, $2)
             ON CONFLICT (user_id) DO UPDATE SET
               single_games = pc_user_stats.single_games + 1,
               single_wins = pc_user_stats.single_wins + $2,
               single_points = pc_user_stats.single_points + $2,
               updated_at = NOW()`,
            [userId, won]
          );
        } else {
          await client.query(
            `INSERT INTO pc_user_stats (user_id, block_games, block_wins, block_points)
             VALUES ($1, 1, $2, $2)
             ON CONFLICT (user_id) DO UPDATE SET
               block_games = pc_user_stats.block_games + 1,
               block_wins = pc_user_stats.block_wins + $2,
               block_points = pc_user_stats.block_points + $2,
               updated_at = NOW()`,
            [userId, won]
          );
        }
      }
      await client.query("COMMIT");
      return { recorded: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return withJsonLock(async () => {
    const data = await readJson();
    if (data.matches.some(match => match.id === matchId)) {
      return { recorded: false, reason: "already_recorded" };
    }
    data.matches.push({
      id: matchId,
      roomCode: roomCode || null,
      mode: normalizedMode,
      participantUserIds: participants,
      winnerUserIds: winners,
      startedAt: startedAt || null,
      finishedAt: finishedAt || new Date().toISOString()
    });
    if (data.matches.length > 5000) data.matches = data.matches.slice(-5000);
    for (const userId of participants) {
      const stats = publicStats(data.stats[userId] || defaultStats(userId));
      const won = winners.includes(userId) ? 1 : 0;
      if (normalizedMode === "single") {
        stats.singleGames += 1;
        stats.singleWins += won;
        stats.singlePoints += won;
      } else {
        stats.blockGames += 1;
        stats.blockWins += won;
        stats.blockPoints += won;
      }
      stats.updatedAt = new Date().toISOString();
      delete stats.totalGames;
      delete stats.totalWins;
      delete stats.totalPoints;
      data.stats[userId] = stats;
    }
    await writeJson(data);
    return { recorded: true };
  });
}

function status() {
  return {
    backend,
    persistent: backend === "postgres",
    configured: Boolean(DATABASE_URL),
    dataFile: backend === "json" ? DATA_FILE : null
  };
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  init,
  close,
  status,
  normalizeUsername,
  createUser,
  authenticateUser,
  getUserById,
  getProfile,
  getLeaderboard,
  recordMatch
};
