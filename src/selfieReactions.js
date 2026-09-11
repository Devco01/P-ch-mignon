import { PermissionFlagsBits, parseEmoji, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from './config.js';

const MEDIA_ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|mp4|mov|webm)$/i;
const recentlyHandled = new Set();

/** Ordre des réactions auto (IDs ou URL CDN, y compris animated=true). */
function selfieReactionList() {
  return config.selfieReactionIds || [];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberHandled(messageId) {
  recentlyHandled.add(messageId);
  if (recentlyHandled.size > 400) {
    const first = recentlyHandled.values().next().value;
    recentlyHandled.delete(first);
  }
}

function parseReactionIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/discord\.com\/assets\//i.test(s)) return null;
  const fromCdn = s.match(/emojis\/(\d+)/i);
  if (fromCdn) {
    return {
      id: fromCdn[1],
      animated: /animated=true/i.test(s) || /<a:/i.test(s),
    };
  }
  const parsed = parseEmoji(s);
  if (parsed?.id) return { id: parsed.id, animated: Boolean(parsed.animated) };
  if (/^\d{17,20}$/.test(s)) return { id: s, animated: false };
  return s;
}

function messageHasImage(message) {
  if (!message) return false;
  if (message.attachments?.size) {
    for (const att of message.attachments.values()) {
      const ct = (att.contentType || '').toLowerCase();
      const name = att.name || '';
      if (ct.startsWith('image/') || ct.startsWith('video/')) return true;
      if (MEDIA_ATTACHMENT_EXT.test(name)) return true;
    }
  }
  for (const embed of message.embeds || []) {
    if (embed.image || embed.thumbnail || embed.video) return true;
    if (embed.type === 'image' || embed.type === 'gifv' || embed.type === 'video') return true;
  }
  return false;
}

function isSelfieParentChannel(message) {
  const ids = config.selfieChannelIds;
  if (!ids?.size) return false;
  if (typeof message.channel?.isThread === 'function' && message.channel.isThread()) return false;
  return ids.has(message.channelId);
}

function selfieThreadName(message) {
  const raw = message.member?.displayName || message.author?.globalName || message.author?.username || 'selfie';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 100) || 'selfie';
}

async function resolveExistingThread(message) {
  if (!message) return null;
  if (message.thread) return message.thread;
  if (message.hasThread && typeof message.fetchThread === 'function') {
    return message.fetchThread().catch(() => null);
  }
  return null;
}

async function ensureSelfieThread(message, me) {
  const existing = await resolveExistingThread(message);
  if (existing) return existing;

  const channel = message.channel;
  if (me && channel && typeof me.permissionsIn === 'function') {
    const perms = me.permissionsIn(channel);
    if (perms && !perms.has(PermissionFlagsBits.CreatePublicThreads)) {
      console.warn(`[Pêche Mignon] selfie: permission « Créer des fils publics » manquante sur ${message.channelId}.`);
      return null;
    }
  }

  const opts = {
    name: selfieThreadName(message),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Fil automatique sous l’image.',
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const thread = await message.startThread(opts);
      console.log(`[Pêche Mignon] selfie fil créé sous ${message.id}: ${thread.id}`);
      return thread;
    } catch (err) {
      const recovered = await resolveExistingThread(await message.fetch?.().catch(() => message));
      if (recovered) return recovered;
      if (attempt >= 2) {
        console.warn(`[Pêche Mignon] selfie fil impossible (${message.id}):`, err?.message || err);
        return null;
      }
      await wait(400 * (attempt + 1));
    }
  }
  return null;
}

async function resolveReactEmoji(guild, parsed) {
  if (!parsed) return null;
  if (typeof parsed === 'string') return parsed;
  const id = parsed.id;
  if (!id) return parsed;
  let emoji = guild.emojis.cache.get(id);
  if (!emoji) {
    try {
      const fetched = await guild.emojis.fetch(id);
      emoji = fetched;
    } catch (_) {
      try {
        const all = await guild.emojis.fetch();
        emoji = all.get(id);
      } catch (_) {}
    }
  }
  if (emoji) return emoji;
  return parsed.animated ? `a:${id}` : `_:${id}`;
}

async function addSelfieReactions(message, me) {
  const reactions = selfieReactionList();
  if (!reactions?.length || !message.react) return;

  const channel = message.channel;
  if (me && channel && typeof me.permissionsIn === 'function') {
    const perms = me.permissionsIn(channel);
    if (perms && !perms.has(PermissionFlagsBits.AddReactions)) {
      console.warn(`[Pêche Mignon] selfie: permission « Ajouter des réactions » manquante sur ${message.channelId}.`);
      return;
    }
  }

  console.log(`[Pêche Mignon] selfie réactions (ordre) sur ${message.id}: ${reactions.join(' → ')}`);

  for (let i = 0; i < reactions.length; i++) {
    const raw = reactions[i];
    try {
      const parsed = parseReactionIdentifier(raw);
      const emoji = await resolveReactEmoji(message.guild, parsed);
      if (!emoji) continue;
      await message.react(emoji);
      if (i < reactions.length - 1) await wait(400);
    } catch (e) {
      console.warn(`[Pêche Mignon] selfie réaction impossible (${raw}):`, e?.message || e);
    }
  }
}

export async function handleSelfieChannelReaction(message) {
  if (!message?.guild || message.author?.bot) return;
  if (!isSelfieParentChannel(message)) return;
  if (!messageHasImage(message)) return;
  if (recentlyHandled.has(message.id)) return;

  rememberHandled(message.id);

  const me = message.guild.members.me ?? (await message.guild.members.fetchMe().catch(() => null));
  await ensureSelfieThread(message, me);
  await addSelfieReactions(message, me);
}

/** Discord archive forcément les fils inactifs : on les rouvre tout de suite. */
export async function keepSelfieThreadOpen(_oldThread, newThread) {
  const thread = newThread;
  if (!thread?.parentId || !config.selfieChannelIds.has(thread.parentId)) return;
  if (!thread.archived) return;
  if (thread.locked) return;

  try {
    const me = thread.guild?.members?.me;
    const parent = thread.parent ?? (await thread.guild?.channels?.fetch?.(thread.parentId).catch(() => null));
    if (me && parent && typeof me.permissionsIn === 'function') {
      const perms = me.permissionsIn(parent);
      if (perms && !perms.has(PermissionFlagsBits.ManageThreads)) {
        console.warn(`[Pêche Mignon] selfie: permission « Gérer les fils » manquante pour désarchiver ${thread.id}.`);
        return;
      }
    }
    await thread.setArchived(false, 'Les fils selfies restent ouverts.');
  } catch (err) {
    console.warn(`[Pêche Mignon] selfie désarchivage impossible (${thread.id}):`, err?.message || err);
  }
}
