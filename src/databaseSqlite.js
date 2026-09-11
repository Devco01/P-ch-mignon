/**
 * Backend SQLite (données locales, fichier data/peche-mignon.db).
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'peche-mignon.db');

function initDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath, { verbose: null });

  db.exec(`
    CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL DEFAULT '',
      reason TEXT,
      banned_by_discord_id TEXT NOT NULL,
      banned_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(discord_user_id, guild_id)
    );
    CREATE INDEX IF NOT EXISTS idx_banned_discord_id ON banned_users(discord_user_id);
    CREATE INDEX IF NOT EXISTS idx_banned_at ON banned_users(banned_at DESC);
    CREATE INDEX IF NOT EXISTS idx_banned_guild ON banned_users(guild_id);

    CREATE TABLE IF NOT EXISTS avertissements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      guild_id TEXT,
      reason TEXT NOT NULL,
      moderator_discord_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_avertissements_user ON avertissements(discord_user_id);
    CREATE INDEX IF NOT EXISTS idx_avertissements_guild ON avertissements(guild_id);
    CREATE INDEX IF NOT EXISTS idx_avertissements_created ON avertissements(created_at DESC);

    CREATE TABLE IF NOT EXISTS presentation_messages (
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'generale',
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, discord_user_id, variant)
    );

    CREATE TABLE IF NOT EXISTS presentation_drafts (
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'generale',
      token TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      panel_message_id TEXT,
      data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, discord_user_id, variant)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT,
      claimed_by TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      panel_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_user_open ON tickets(guild_id, user_id, status);

    CREATE TABLE IF NOT EXISTS ticket_panels (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interaction_dedup (
      interaction_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS instance_lock (
      key TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ban_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      ban_guild_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by_discord_id TEXT,
      discord_message_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ban_proofs_user_guild ON ban_proofs(discord_user_id, ban_guild_id);
  `);

  const bannedCols = db.prepare('PRAGMA table_info(banned_users)').all();
  for (const col of ['proof_guild_id', 'proof_channel_id', 'proof_message_id', 'proof_thread_id']) {
    if (!bannedCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE banned_users ADD COLUMN ${col} TEXT`);
    }
  }

  const ticketCols = db.prepare('PRAGMA table_info(tickets)').all();
  if (!ticketCols.some((c) => c.name === 'close_reason')) {
    db.exec('ALTER TABLE tickets ADD COLUMN close_reason TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS confession_log_channels (
      guild_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      log_channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, source_channel_id)
    );
    CREATE TABLE IF NOT EXISTS confession_seq (
      guild_id TEXT NOT NULL,
      source_channel_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, source_channel_id)
    );
  `);

  return db;
}

export const db = initDb();

export async function initDatabase() {
  return Promise.resolve();
}

export function addBannedUser(discordUserId, reason, bannedByDiscordId, guildId = '') {
  return db
    .prepare(`INSERT INTO banned_users (discord_user_id, guild_id, reason, banned_by_discord_id) VALUES (?, ?, ?, ?)`)
    .run(discordUserId, guildId || '', reason || null, bannedByDiscordId);
}

export function updateBannedUser(discordUserId, guildId, reason, bannedByDiscordId) {
  return db
    .prepare(
      `UPDATE banned_users SET reason = ?, banned_by_discord_id = ?, banned_at = datetime('now') WHERE discord_user_id = ? AND guild_id = ?`
    )
    .run(reason || null, bannedByDiscordId, discordUserId, guildId || '');
}

export function getBannedUser(discordUserId, guildId = null) {
  if (guildId != null && guildId !== '') {
    return db.prepare(`SELECT * FROM banned_users WHERE discord_user_id = ? AND guild_id = ?`).get(discordUserId, guildId);
  }
  return db.prepare(`SELECT * FROM banned_users WHERE discord_user_id = ? LIMIT 1`).get(discordUserId);
}

export function removeBannedUser(discordUserId, guildId) {
  if (guildId != null && guildId !== '') {
    return db.prepare('DELETE FROM banned_users WHERE discord_user_id = ? AND guild_id = ?').run(discordUserId, guildId);
  }
  return db.prepare('DELETE FROM banned_users WHERE discord_user_id = ?').run(discordUserId);
}

export function updateBanProofMessage(discordUserId, guildId, proofGuildId, proofChannelId, proofMessageId, proofThreadId = null) {
  return db
    .prepare(
      'UPDATE banned_users SET proof_guild_id = ?, proof_channel_id = ?, proof_message_id = ?, proof_thread_id = ? WHERE discord_user_id = ? AND guild_id = ?'
    )
    .run(
      proofGuildId || null,
      proofChannelId || null,
      proofMessageId || null,
      proofThreadId || null,
      String(discordUserId),
      String(guildId || '')
    );
}

export function getBannedUserByProofThreadId(threadId) {
  if (!threadId) return null;
  return db.prepare('SELECT * FROM banned_users WHERE proof_thread_id = ?').get(String(threadId));
}

export function addBanProof(discordUserId, banGuildId, type, content, createdByDiscordId = null, discordMessageId = null) {
  return db
    .prepare(
      'INSERT INTO ban_proofs (discord_user_id, ban_guild_id, type, content, created_by_discord_id, discord_message_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(discordUserId),
      String(banGuildId || ''),
      type || 'text',
      content || '',
      createdByDiscordId || null,
      discordMessageId || null
    );
}

export function deleteBanProofsByMessageId(discordMessageId) {
  if (!discordMessageId) return { changes: 0 };
  return db.prepare('DELETE FROM ban_proofs WHERE discord_message_id = ?').run(String(discordMessageId));
}

export function addAvertissement(discordUserId, reason, moderatorDiscordId, guildId) {
  return db
    .prepare(`INSERT INTO avertissements (discord_user_id, guild_id, reason, moderator_discord_id) VALUES (?, ?, ?, ?)`)
    .run(discordUserId, guildId || null, reason || null, moderatorDiscordId);
}

export function getAvertissementCount(discordUserId, guildId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM avertissements WHERE discord_user_id = ? AND guild_id = ?`)
    .get(discordUserId, guildId);
  return row ? row.n : 0;
}

export function listAvertissementsForUser(discordUserId, guildId) {
  if (!guildId) return [];
  return db
    .prepare(
      `SELECT id, discord_user_id, reason, moderator_discord_id, created_at
       FROM avertissements WHERE discord_user_id = ? AND guild_id = ? ORDER BY created_at DESC`
    )
    .all(discordUserId, guildId);
}

export function deleteAvertissementById(id, guildId) {
  if (guildId) {
    return db.prepare('DELETE FROM avertissements WHERE id = ? AND guild_id = ?').run(id, guildId);
  }
  return db.prepare('DELETE FROM avertissements WHERE id = ?').run(id);
}

export function getPresentationMessage(guildId, discordUserId, variant = 'generale') {
  return db
    .prepare(`SELECT * FROM presentation_messages WHERE guild_id = ? AND discord_user_id = ? AND variant = ?`)
    .get(String(guildId || ''), String(discordUserId || ''), String(variant || 'generale'));
}

export function upsertPresentationMessage(guildId, discordUserId, channelId, messageId, variant = 'generale') {
  return db
    .prepare(
      `INSERT INTO presentation_messages (guild_id, discord_user_id, variant, channel_id, message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(guild_id, discord_user_id, variant)
       DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = datetime('now')`
    )
    .run(String(guildId || ''), String(discordUserId || ''), String(variant || 'generale'), String(channelId || ''), String(messageId || ''));
}

export function deletePresentationMessage(guildId, discordUserId, variant = 'generale') {
  return db
    .prepare(`DELETE FROM presentation_messages WHERE guild_id = ? AND discord_user_id = ? AND variant = ?`)
    .run(String(guildId || ''), String(discordUserId || ''), String(variant || 'generale'));
}

export function clearPresentationDataForChannel(channelId) {
  const cid = String(channelId || '');
  const messages = db.prepare(`DELETE FROM presentation_messages WHERE channel_id = ?`).run(cid);
  const drafts = db.prepare(`DELETE FROM presentation_drafts WHERE channel_id = ?`).run(cid);
  return { messages: messages.changes ?? 0, drafts: drafts.changes ?? 0 };
}

export function getPresentationDraft(guildId, discordUserId, variant = 'generale') {
  return db
    .prepare(`SELECT * FROM presentation_drafts WHERE guild_id = ? AND discord_user_id = ? AND variant = ?`)
    .get(String(guildId || ''), String(discordUserId || ''), String(variant || 'generale'));
}

export function upsertPresentationDraft(guildId, discordUserId, token, channelId, panelMessageId, dataJson, variant = 'generale') {
  return db
    .prepare(
      `INSERT INTO presentation_drafts (guild_id, discord_user_id, variant, token, channel_id, panel_message_id, data_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(guild_id, discord_user_id, variant)
       DO UPDATE SET token = excluded.token, channel_id = excluded.channel_id, panel_message_id = excluded.panel_message_id, data_json = excluded.data_json, updated_at = datetime('now')`
    )
    .run(
      String(guildId || ''),
      String(discordUserId || ''),
      String(variant || 'generale'),
      String(token || ''),
      String(channelId || ''),
      panelMessageId == null ? null : String(panelMessageId),
      String(dataJson || '{}')
    );
}

export function deletePresentationDraft(guildId, discordUserId, variant = 'generale') {
  return db
    .prepare(`DELETE FROM presentation_drafts WHERE guild_id = ? AND discord_user_id = ? AND variant = ?`)
    .run(String(guildId || ''), String(discordUserId || ''), String(variant || 'generale'));
}

export function cleanupPresentationDrafts(olderThan = '-3 days') {
  return db.prepare(`DELETE FROM presentation_drafts WHERE updated_at < datetime('now', ?)`).run(String(olderThan));
}

export function createTicket({ guildId, threadId, userId, type, subject, panelMessageId = null }) {
  return db
    .prepare(
      `INSERT INTO tickets (guild_id, thread_id, user_id, type, subject, panel_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(guildId, threadId, userId, type, subject || null, panelMessageId);
}

export function getTicketByThreadId(threadId) {
  return db.prepare(`SELECT * FROM tickets WHERE thread_id = ?`).get(String(threadId || ''));
}

export function getOpenTicketForUser(guildId, userId) {
  return db
    .prepare(`SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`)
    .get(String(guildId || ''), String(userId || ''));
}

export function claimTicket(threadId, claimedBy) {
  return db.prepare(`UPDATE tickets SET claimed_by = ? WHERE thread_id = ? AND status = 'open'`).run(String(claimedBy), String(threadId));
}

export function closeTicket(threadId, closeReason = null) {
  return db
    .prepare(`UPDATE tickets SET status = 'closed', closed_at = datetime('now'), close_reason = ? WHERE thread_id = ?`)
    .run(closeReason || null, String(threadId));
}

export function setTicketPanel(guildId, channelId, messageId) {
  return db
    .prepare(
      `INSERT INTO ticket_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id`
    )
    .run(String(guildId), String(channelId), String(messageId));
}

export function getTicketPanel(guildId) {
  return db.prepare(`SELECT * FROM ticket_panels WHERE guild_id = ?`).get(String(guildId));
}

export function tryAcquireInteraction(interactionId) {
  if (!interactionId) return false;
  const r = db.prepare(`INSERT OR IGNORE INTO interaction_dedup (interaction_id) VALUES (?)`).run(String(interactionId));
  return (r?.changes ?? 0) > 0;
}

export function tryAcquireInstanceLock(key, owner, ttlMs = 90_000) {
  const k = String(key || 'peche-mignon');
  const o = String(owner || '');
  const ttl = Math.max(10_000, Number(ttlMs) || 90_000);
  const now = Date.now();
  const expiresAt = now + ttl;
  try {
    const r = db
      .prepare(
        `INSERT INTO instance_lock (key, owner, acquired_at, expires_at)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(key) DO UPDATE SET
           owner = excluded.owner,
           acquired_at = datetime('now'),
           expires_at = excluded.expires_at
         WHERE instance_lock.expires_at <= excluded.expires_at AND instance_lock.expires_at <= ?`
      )
      .run(k, o, expiresAt, now);
    return (r?.changes ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

export function renewInstanceLock(key, owner, ttlMs = 90_000) {
  const k = String(key || 'peche-mignon');
  const o = String(owner || '');
  const ttl = Math.max(10_000, Number(ttlMs) || 90_000);
  const expiresAt = Date.now() + ttl;
  try {
    const r = db.prepare(`UPDATE instance_lock SET expires_at = ? WHERE key = ? AND owner = ?`).run(expiresAt, k, o);
    return (r?.changes ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

export function releaseInstanceLock(key, owner) {
  try {
    const r = db.prepare(`DELETE FROM instance_lock WHERE key = ? AND owner = ?`).run(String(key || 'peche-mignon'), String(owner || ''));
    return (r?.changes ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

export function upsertConfessionLogConfig(guildId, sourceChannelId, logChannelId) {
  db.prepare(
    'INSERT OR REPLACE INTO confession_log_channels (guild_id, source_channel_id, log_channel_id) VALUES (?, ?, ?)'
  ).run(guildId, sourceChannelId, logChannelId);
}

export function removeConfessionLogConfig(guildId, sourceChannelId) {
  db.prepare('DELETE FROM confession_log_channels WHERE guild_id = ? AND source_channel_id = ?').run(guildId, sourceChannelId);
  db.prepare('DELETE FROM confession_seq WHERE guild_id = ? AND source_channel_id = ?').run(guildId, sourceChannelId);
}

export function clearAllConfessionLogConfigsForGuild(guildId) {
  db.prepare('DELETE FROM confession_log_channels WHERE guild_id = ?').run(guildId);
  db.prepare('DELETE FROM confession_seq WHERE guild_id = ?').run(guildId);
}

export function listConfessionLogConfigsForGuild(guildId) {
  return db
    .prepare('SELECT source_channel_id, log_channel_id FROM confession_log_channels WHERE guild_id = ?')
    .all(guildId)
    .map((r) => ({ sourceChannelId: r.source_channel_id, logChannelId: r.log_channel_id }));
}

export function findConfessionLogConfig(guildId, sourceChannelId) {
  const row = db
    .prepare(
      'SELECT source_channel_id, log_channel_id FROM confession_log_channels WHERE guild_id = ? AND source_channel_id = ?'
    )
    .get(guildId, sourceChannelId);
  return row ? { sourceChannelId: row.source_channel_id, logChannelId: row.log_channel_id } : null;
}

const stmtConfessionInc = db.prepare(`
  INSERT INTO confession_seq (guild_id, source_channel_id, seq) VALUES (?, ?, 1)
  ON CONFLICT(guild_id, source_channel_id) DO UPDATE SET seq = seq + 1
`);
const stmtConfessionGetSeq = db.prepare(
  'SELECT seq FROM confession_seq WHERE guild_id = ? AND source_channel_id = ?'
);

export function incrementConfessionNumber(guildId, sourceChannelId) {
  stmtConfessionInc.run(guildId, sourceChannelId);
  const r = stmtConfessionGetSeq.get(guildId, sourceChannelId);
  return r ? Number(r.seq) : 1;
}
