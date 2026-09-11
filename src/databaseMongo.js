/**
 * Backend MongoDB (données persistantes).
 * Même URI que L’éphémère, base isolée `peche_mignon` (pas la base `ephemere`).
 */
import { MongoClient, ObjectId } from 'mongodb';

const MONGO_URI = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
const DB_NAME = 'peche_mignon';

let client = null;
let db = null;

export async function initDatabase() {
  if (!MONGO_URI) throw new Error('MONGODB_URI (ou MONGO_URI) est requis pour le backend MongoDB.');
  let uri = MONGO_URI;
  if (!uri.includes('authSource=')) {
    uri += uri.includes('?') ? '&authSource=admin' : '?authSource=admin';
  }
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(DB_NAME);
  await db.collection('banned_users').createIndex({ discord_user_id: 1, guild_id: 1 }, { unique: true });
  await db.collection('banned_users').createIndex({ proof_thread_id: 1 }, { sparse: true });
  await db.collection('ban_proofs').createIndex({ discord_user_id: 1, ban_guild_id: 1 });
  await db.collection('ban_proofs').createIndex({ discord_message_id: 1 });
  await db.collection('avertissements').createIndex({ discord_user_id: 1, guild_id: 1 });
  await db.collection('presentation_messages').createIndex({ guild_id: 1, discord_user_id: 1, variant: 1 }, { unique: true });
  await db.collection('presentation_drafts').createIndex({ guild_id: 1, discord_user_id: 1, variant: 1 }, { unique: true });
  await db.collection('tickets').createIndex({ thread_id: 1 }, { unique: true });
  await db.collection('tickets').createIndex({ guild_id: 1, user_id: 1, status: 1 });
  await db.collection('ticket_panels').createIndex({ guild_id: 1 }, { unique: true });
  await db.collection('interaction_dedup').createIndex({ interaction_id: 1 }, { unique: true });
  try {
    await db.collection('interaction_dedup').createIndex({ created_at: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
  } catch (_) {}
  await db.collection('instance_lock').createIndex({ key: 1 }, { unique: true });
  await db.collection('confession_log_channels').createIndex({ guild_id: 1, source_channel_id: 1 }, { unique: true });
  await db.collection('confession_seq').createIndex({ guild_id: 1, source_channel_id: 1 }, { unique: true });
  return db;
}

function toPlain(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: _id?.toString?.() ?? _id };
}

export async function addBannedUser(discordUserId, reason, bannedByDiscordId, guildId = '') {
  const banned_at = new Date().toISOString();
  await db.collection('banned_users').updateOne(
    { discord_user_id: String(discordUserId), guild_id: String(guildId || '') },
    {
      $set: { reason: reason || null, banned_by_discord_id: bannedByDiscordId, banned_at },
      $setOnInsert: { discord_user_id: String(discordUserId), guild_id: String(guildId || '') },
    },
    { upsert: true }
  );
  return { banned_at };
}

export async function updateBannedUser(discordUserId, guildId, reason, bannedByDiscordId) {
  const banned_at = new Date().toISOString();
  const r = await db.collection('banned_users').updateOne(
    { discord_user_id: String(discordUserId), guild_id: String(guildId || '') },
    { $set: { reason: reason || null, banned_by_discord_id: bannedByDiscordId, banned_at } }
  );
  return r.matchedCount > 0 ? { banned_at } : null;
}

export async function getBannedUser(discordUserId, guildId = null) {
  const uid = String(discordUserId);
  const doc =
    guildId != null && guildId !== ''
      ? await db.collection('banned_users').findOne({ discord_user_id: uid, guild_id: String(guildId) })
      : await db.collection('banned_users').findOne({ discord_user_id: uid });
  return toPlain(doc);
}

export async function removeBannedUser(discordUserId, guildId) {
  const uid = String(discordUserId);
  if (guildId != null && guildId !== '') {
    const r = await db.collection('banned_users').deleteOne({ discord_user_id: uid, guild_id: String(guildId) });
    return { changes: r.deletedCount };
  }
  const r = await db.collection('banned_users').deleteMany({ discord_user_id: uid });
  return { changes: r.deletedCount };
}

export async function updateBanProofMessage(discordUserId, guildId, proofGuildId, proofChannelId, proofMessageId, proofThreadId = null) {
  const uid = String(discordUserId);
  const gid = String(guildId || '');
  const r = await db.collection('banned_users').updateOne(
    { discord_user_id: uid, guild_id: gid },
    {
      $set: {
        proof_guild_id: proofGuildId || null,
        proof_channel_id: proofChannelId || null,
        proof_message_id: proofMessageId || null,
        proof_thread_id: proofThreadId || null,
      },
    }
  );
  return r.matchedCount > 0;
}

export async function getBannedUserByProofThreadId(threadId) {
  if (!threadId) return null;
  return toPlain(await db.collection('banned_users').findOne({ proof_thread_id: String(threadId) }));
}

export async function addBanProof(discordUserId, banGuildId, type, content, createdByDiscordId = null, discordMessageId = null) {
  await db.collection('ban_proofs').insertOne({
    discord_user_id: String(discordUserId),
    ban_guild_id: String(banGuildId || ''),
    type: type || 'text',
    content: content || '',
    created_at: new Date().toISOString(),
    created_by_discord_id: createdByDiscordId || null,
    discord_message_id: discordMessageId || null,
  });
}

export async function deleteBanProofsByMessageId(discordMessageId) {
  if (!discordMessageId) return { changes: 0 };
  const r = await db.collection('ban_proofs').deleteMany({ discord_message_id: String(discordMessageId) });
  return { changes: r.deletedCount };
}

export async function addAvertissement(discordUserId, reason, moderatorDiscordId, guildId) {
  await db.collection('avertissements').insertOne({
    discord_user_id: discordUserId,
    guild_id: guildId || null,
    reason: reason || null,
    moderator_discord_id: moderatorDiscordId,
    created_at: new Date().toISOString(),
  });
}

export async function getAvertissementCount(discordUserId, guildId) {
  return db.collection('avertissements').countDocuments({ discord_user_id: discordUserId, guild_id: guildId });
}

export async function listAvertissementsForUser(discordUserId, guildId) {
  if (!guildId) return [];
  const docs = await db
    .collection('avertissements')
    .find({ discord_user_id: discordUserId, guild_id: guildId })
    .sort({ created_at: -1 })
    .toArray();
  return docs.map(toPlain);
}

export async function deleteAvertissementById(id, guildId) {
  const filter = { _id: new ObjectId(id) };
  if (guildId) filter.guild_id = guildId;
  const r = await db.collection('avertissements').deleteOne(filter);
  return { changes: r.deletedCount };
}

export async function getPresentationMessage(guildId, discordUserId, variant = 'generale') {
  const doc = await db.collection('presentation_messages').findOne({
    guild_id: String(guildId || ''),
    discord_user_id: String(discordUserId || ''),
    variant: String(variant || 'generale'),
  });
  return toPlain(doc);
}

export async function upsertPresentationMessage(guildId, discordUserId, channelId, messageId, variant = 'generale') {
  return db.collection('presentation_messages').updateOne(
    { guild_id: String(guildId || ''), discord_user_id: String(discordUserId || ''), variant: String(variant || 'generale') },
    {
      $set: {
        variant: String(variant || 'generale'),
        channel_id: String(channelId || ''),
        message_id: String(messageId || ''),
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

export async function deletePresentationMessage(guildId, discordUserId, variant = 'generale') {
  const r = await db.collection('presentation_messages').deleteOne({
    guild_id: String(guildId || ''),
    discord_user_id: String(discordUserId || ''),
    variant: String(variant || 'generale'),
  });
  return { changes: r.deletedCount };
}

export async function clearPresentationDataForChannel(channelId) {
  const cid = String(channelId || '');
  const [messages, drafts] = await Promise.all([
    db.collection('presentation_messages').deleteMany({ channel_id: cid }),
    db.collection('presentation_drafts').deleteMany({ channel_id: cid }),
  ]);
  return { messages: messages.deletedCount ?? 0, drafts: drafts.deletedCount ?? 0 };
}

export async function getPresentationDraft(guildId, discordUserId, variant = 'generale') {
  const doc = await db.collection('presentation_drafts').findOne({
    guild_id: String(guildId || ''),
    discord_user_id: String(discordUserId || ''),
    variant: String(variant || 'generale'),
  });
  return toPlain(doc);
}

export async function upsertPresentationDraft(guildId, discordUserId, token, channelId, panelMessageId, dataJson, variant = 'generale') {
  await db.collection('presentation_drafts').updateOne(
    { guild_id: String(guildId || ''), discord_user_id: String(discordUserId || ''), variant: String(variant || 'generale') },
    {
      $set: {
        variant: String(variant || 'generale'),
        token: String(token || ''),
        channel_id: String(channelId || ''),
        panel_message_id: panelMessageId ? String(panelMessageId) : null,
        data_json: String(dataJson || '{}'),
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

export async function deletePresentationDraft(guildId, discordUserId, variant = 'generale') {
  const r = await db.collection('presentation_drafts').deleteOne({
    guild_id: String(guildId || ''),
    discord_user_id: String(discordUserId || ''),
    variant: String(variant || 'generale'),
  });
  return { changes: r.deletedCount };
}

export async function cleanupPresentationDrafts(olderThan = null) {
  let cutoffMs = 3 * 24 * 60 * 60 * 1000;
  const raw = String(olderThan || '').trim();
  const rel = raw.match(/^-(\d+)\s+(day|days|hour|hours)$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unitMs = rel[2].toLowerCase().startsWith('hour') ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    cutoffMs = n * unitMs;
  }
  const cutoff = new Date(Date.now() - cutoffMs).toISOString();
  const r = await db.collection('presentation_drafts').deleteMany({ updated_at: { $lt: cutoff } });
  return { changes: r.deletedCount };
}

export async function createTicket({ guildId, threadId, userId, type, subject, panelMessageId = null }) {
  await db.collection('tickets').insertOne({
    guild_id: String(guildId),
    thread_id: String(threadId),
    user_id: String(userId),
    type: String(type),
    subject: subject || null,
    claimed_by: null,
    status: 'open',
    panel_message_id: panelMessageId || null,
    created_at: new Date().toISOString(),
    closed_at: null,
  });
}

export async function getTicketByThreadId(threadId) {
  return toPlain(await db.collection('tickets').findOne({ thread_id: String(threadId || '') }));
}

export async function getOpenTicketForUser(guildId, userId) {
  const doc = await db.collection('tickets').findOne(
    { guild_id: String(guildId || ''), user_id: String(userId || ''), status: 'open' },
    { sort: { created_at: -1 } }
  );
  return toPlain(doc);
}

export async function claimTicket(threadId, claimedBy) {
  const r = await db.collection('tickets').updateOne(
    { thread_id: String(threadId), status: 'open' },
    { $set: { claimed_by: String(claimedBy) } }
  );
  return { changes: r.modifiedCount };
}

export async function closeTicket(threadId, closeReason = null) {
  const r = await db.collection('tickets').updateOne(
    { thread_id: String(threadId) },
    { $set: { status: 'closed', closed_at: new Date().toISOString(), close_reason: closeReason || null } }
  );
  return { changes: r.modifiedCount };
}

export async function setTicketPanel(guildId, channelId, messageId) {
  await db.collection('ticket_panels').updateOne(
    { guild_id: String(guildId) },
    { $set: { channel_id: String(channelId), message_id: String(messageId) } },
    { upsert: true }
  );
}

export async function getTicketPanel(guildId) {
  return toPlain(await db.collection('ticket_panels').findOne({ guild_id: String(guildId) }));
}

export async function tryAcquireInteraction(interactionId) {
  if (!interactionId) return true;
  try {
    const r = await db
      .collection('interaction_dedup')
      .updateOne(
        { interaction_id: String(interactionId) },
        { $setOnInsert: { interaction_id: String(interactionId), created_at: new Date() } },
        { upsert: true }
      );
    return (r?.upsertedCount ?? 0) > 0;
  } catch (e) {
    if (e?.code === 11000) return false;
    console.warn(`[Pêche Mignon] Dedup interaction:`, e?.message || e);
    return true;
  }
}

export async function tryAcquireInstanceLock(key, owner, ttlMs = 90_000) {
  const k = String(key || 'peche-mignon');
  const o = String(owner || '');
  const now = new Date();
  const expires = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 90_000));
  try {
    const r0 = await db.collection('instance_lock').updateOne({ key: k, owner: o }, { $set: { expires_at: expires, acquired_at: now } });
    if ((r0?.matchedCount ?? 0) > 0) return true;
  } catch (_) {}
  try {
    const r = await db.collection('instance_lock').findOneAndUpdate(
      { key: k, $or: [{ expires_at: { $lte: now } }, { expires_at: { $exists: false } }] },
      { $set: { key: k, owner: o, acquired_at: now, expires_at: expires } },
      { upsert: true, returnDocument: 'after' }
    );
    // Driver Mongo 6 : le document est renvoyé directement (plus { value }).
    const doc = r?.value !== undefined ? r.value : r;
    return doc?.owner === o;
  } catch (_) {
    return false;
  }
}

export async function renewInstanceLock(key, owner, ttlMs = 90_000) {
  const expires = new Date(Date.now() + Math.max(10_000, Number(ttlMs) || 90_000));
  try {
    const r = await db.collection('instance_lock').updateOne({ key: String(key || 'peche-mignon'), owner: String(owner || '') }, { $set: { expires_at: expires } });
    return (r?.matchedCount ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

export async function releaseInstanceLock(key, owner) {
  try {
    const r = await db.collection('instance_lock').deleteOne({ key: String(key || 'peche-mignon'), owner: String(owner || '') });
    return (r?.deletedCount ?? 0) > 0;
  } catch (_) {
    return false;
  }
}

export async function getInstanceLockInfo(key) {
  try {
    const doc = await db.collection('instance_lock').findOne({ key: String(key || 'peche-mignon') });
    if (!doc) return null;
    return { key: doc.key, owner: doc.owner, acquired_at: doc.acquired_at, expires_at: doc.expires_at };
  } catch (_) {
    return null;
  }
}

export async function upsertConfessionLogConfig(guildId, sourceChannelId, logChannelId) {
  await db.collection('confession_log_channels').updateOne(
    { guild_id: guildId, source_channel_id: sourceChannelId },
    { $set: { guild_id: guildId, source_channel_id: sourceChannelId, log_channel_id: logChannelId } },
    { upsert: true }
  );
}

export async function removeConfessionLogConfig(guildId, sourceChannelId) {
  await db.collection('confession_log_channels').deleteOne({ guild_id: guildId, source_channel_id: sourceChannelId });
  await db.collection('confession_seq').deleteOne({ guild_id: guildId, source_channel_id: sourceChannelId });
}

export async function clearAllConfessionLogConfigsForGuild(guildId) {
  await db.collection('confession_log_channels').deleteMany({ guild_id: guildId });
  await db.collection('confession_seq').deleteMany({ guild_id: guildId });
}

export async function listConfessionLogConfigsForGuild(guildId) {
  const docs = await db.collection('confession_log_channels').find({ guild_id: guildId }).toArray();
  return docs.map((d) => ({
    sourceChannelId: d.source_channel_id,
    logChannelId: d.log_channel_id,
  }));
}

export async function findConfessionLogConfig(guildId, sourceChannelId) {
  const doc = await db
    .collection('confession_log_channels')
    .findOne({ guild_id: guildId, source_channel_id: sourceChannelId });
  if (!doc) return null;
  return { sourceChannelId: doc.source_channel_id, logChannelId: doc.log_channel_id };
}

export async function incrementConfessionNumber(guildId, sourceChannelId) {
  await db.collection('confession_seq').updateOne(
    { guild_id: guildId, source_channel_id: sourceChannelId },
    { $inc: { seq: 1 } },
    { upsert: true }
  );
  const doc = await db.collection('confession_seq').findOne({
    guild_id: guildId,
    source_channel_id: sourceChannelId,
  });
  return typeof doc?.seq === 'number' && doc.seq > 0 ? doc.seq : 1;
}
