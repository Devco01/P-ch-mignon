import { PermissionFlagsBits, ThreadAutoArchiveDuration } from 'discord.js';
import { config } from './config.js';

const MEDIA_ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif|mp4|mov|webm)$/i;
const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<]+|discord\.gg\/[^\s<]+/i;
const recentlyHandled = new Set();

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

function isAutoThreadParentChannel(message) {
  const ids = config.autoThreadChannelIds;
  if (!ids?.size) return false;
  if (typeof message.channel?.isThread === 'function' && message.channel.isThread()) return false;
  return ids.has(message.channelId);
}

function messageHasImageOrVideo(message) {
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

function messageHasLink(message) {
  if (!message) return false;
  if (URL_IN_TEXT.test(message.content || '')) return true;
  for (const embed of message.embeds || []) {
    if (embed.url) return true;
  }
  return false;
}

function threadName(message) {
  const raw = message.member?.displayName || message.author?.globalName || message.author?.username || 'discussion';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 100) || 'discussion';
}

async function resolveExistingThread(message) {
  if (!message) return null;
  if (message.thread) return message.thread;
  if (message.hasThread && typeof message.fetchThread === 'function') {
    return message.fetchThread().catch(() => null);
  }
  return null;
}

async function ensureThread(message, me) {
  const existing = await resolveExistingThread(message);
  if (existing) return existing;

  const channel = message.channel;
  if (me && channel && typeof me.permissionsIn === 'function') {
    const perms = me.permissionsIn(channel);
    if (perms && !perms.has(PermissionFlagsBits.CreatePublicThreads)) {
      console.warn(`[Pêche Mignon] auto-fil: permission « Créer des fils publics » manquante sur ${message.channelId}.`);
      return null;
    }
  }

  const opts = {
    name: threadName(message),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: 'Fil automatique sous l’image ou le lien.',
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const thread = await message.startThread(opts);
      console.log(`[Pêche Mignon] auto-fil créé sous ${message.id}: ${thread.id}`);
      return thread;
    } catch (err) {
      const recovered = await resolveExistingThread(await message.fetch?.().catch(() => message));
      if (recovered) return recovered;
      if (attempt >= 2) {
        console.warn(`[Pêche Mignon] auto-fil impossible (${message.id}):`, err?.message || err);
        return null;
      }
      await wait(400 * (attempt + 1));
    }
  }
  return null;
}

export async function handleAutoThreadMessage(message) {
  if (!message?.guild || message.author?.bot) return;
  if (!isAutoThreadParentChannel(message)) return;
  if (!messageHasImageOrVideo(message) && !messageHasLink(message)) return;
  if (recentlyHandled.has(message.id)) return;

  rememberHandled(message.id);

  const me = message.guild.members.me ?? (await message.guild.members.fetchMe().catch(() => null));
  await ensureThread(message, me);
}

export async function keepAutoThreadOpen(_oldThread, newThread) {
  const thread = newThread;
  if (!thread?.parentId || !config.autoThreadChannelIds.has(thread.parentId)) return;
  if (!thread.archived) return;
  if (thread.locked) return;

  try {
    const me = thread.guild?.members?.me;
    const parent = thread.parent ?? (await thread.guild?.channels?.fetch?.(thread.parentId).catch(() => null));
    if (me && parent && typeof me.permissionsIn === 'function') {
      const perms = me.permissionsIn(parent);
      if (perms && !perms.has(PermissionFlagsBits.ManageThreads)) {
        console.warn(`[Pêche Mignon] auto-fil: permission « Gérer les fils » manquante pour désarchiver ${thread.id}.`);
        return;
      }
    }
    await thread.setArchived(false, 'Les fils automatiques restent ouverts.');
  } catch (err) {
    console.warn(`[Pêche Mignon] auto-fil désarchivage impossible (${thread.id}):`, err?.message || err);
  }
}
