import { ThreadAutoArchiveDuration } from 'discord.js';
import {
  updateBanProofMessage,
  getBannedUserByProofThreadId,
  addBanProof,
  deleteBanProofsByMessageId,
} from './database.js';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveThreadFromMessage(msg) {
  if (!msg) return null;
  if (msg.thread) return msg.thread;
  if (typeof msg.fetchThread === 'function' && msg.hasThread) {
    const t = await msg.fetchThread().catch(() => null);
    if (t) return t;
  }
  return null;
}

export async function createBanProofThread(message, userId) {
  if (!message) return null;
  if (typeof message.channel?.isThread === 'function' && message.channel.isThread()) {
    return message.channel;
  }
  const existing = await resolveThreadFromMessage(message);
  if (existing) return existing;

  const name = `Preuves - ${userId}`.slice(0, 100);
  const opts = {
    name,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Fil pour déposer les preuves du signalement.',
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const thread = await message.startThread(opts);
      return thread;
    } catch (err) {
      const recovered = await resolveThreadFromMessage(await message.fetch?.().catch(() => message));
      if (recovered) return recovered;
      if (attempt >= 3) {
        console.warn(`[Péché Mignon] Création fil preuves échouée:`, err?.message || err);
        return null;
      }
      await wait(400 * (attempt + 1));
    }
  }
  return null;
}

function proofTypeForAttachment(att) {
  const ct = String(att.contentType || '').toLowerCase();
  const name = String(att.name || att.url || '');
  if (ct.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return 'image';
  if (ct.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/i.test(name)) return 'video';
  return 'file';
}

export async function persistBanProofMessage(message, { replace = false } = {}) {
  if (message.author?.bot) return;
  if (!message.channel?.isThread?.()) return;
  const ban = await getBannedUserByProofThreadId(message.channel.id);
  if (!ban) return;

  const userId = ban.discord_user_id;
  const guildId = ban.guild_id ?? '';
  const authorId = message.author.id;
  if (replace) await deleteBanProofsByMessageId(message.id);

  for (const att of message.attachments?.values?.() || []) {
    const url = att.url || att.proxyURL;
    if (!url) continue;
    await addBanProof(userId, guildId, proofTypeForAttachment(att), url, authorId, message.id);
  }

  for (const embed of message.embeds || []) {
    const imageUrl = embed.image?.url || embed.thumbnail?.url;
    if (imageUrl) await addBanProof(userId, guildId, 'image', imageUrl, authorId, message.id);
    if (embed.video?.url) await addBanProof(userId, guildId, 'video', embed.video.url, authorId, message.id);
  }

  const text = (message.content || '').trim();
  if (text) await addBanProof(userId, guildId, 'text', text, authorId, message.id);
}

export async function deleteBanProofsForDeletedMessage(message) {
  const threadId = message.channel?.id ?? message.channelId;
  if (!threadId || !message.id) return;
  const ban = await getBannedUserByProofThreadId(threadId);
  if (!ban) return;
  await deleteBanProofsByMessageId(message.id);
}

export async function persistProofThreadLink({ userId, guildId, proofGuildId, proofChannelId, proofMessageId, proofThreadId }) {
  if (!userId || !guildId) return;
  await updateBanProofMessage(userId, guildId, proofGuildId, proofChannelId, proofMessageId, proofThreadId);
}
