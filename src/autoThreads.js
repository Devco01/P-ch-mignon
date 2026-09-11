import { PermissionFlagsBits, ThreadAutoArchiveDuration } from 'discord.js';
import { config, isAutoMediaCategoryChannel } from './config.js';
import { getTicketByThreadId } from './database.js';

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
  if (typeof message.channel?.isThread === 'function' && message.channel.isThread()) return false;
  if (config.autoThreadChannelIds?.has(message.channelId)) return true;
  return isAutoMediaCategoryChannel(message.channel);
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
      console.warn(`[Péché Mignon] auto-fil: permission « Créer des fils publics » manquante sur ${message.channelId}.`);
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
      console.log(`[Péché Mignon] auto-fil créé sous ${message.id}: ${thread.id}`);
      return thread;
    } catch (err) {
      const recovered = await resolveExistingThread(await message.fetch?.().catch(() => message));
      if (recovered) return recovered;
      if (attempt >= 2) {
        console.warn(`[Péché Mignon] auto-fil impossible (${message.id}):`, err?.message || err);
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
  if (!thread?.parentId) return;
  const parent = thread.parent ?? (await thread.guild?.channels?.fetch?.(thread.parentId).catch(() => null));
  const keep =
    config.autoThreadChannelIds.has(thread.parentId) || isAutoMediaCategoryChannel(parent);
  if (!keep) return;
  if (!thread.archived) return;
  if (thread.locked) return;

  try {
    const me = thread.guild?.members?.me;
    if (me && parent && typeof me.permissionsIn === 'function') {
      const perms = me.permissionsIn(parent);
      if (perms && !perms.has(PermissionFlagsBits.ManageThreads)) {
        console.warn(`[Péché Mignon] auto-fil: permission « Gérer les fils » manquante pour désarchiver ${thread.id}.`);
        return;
      }
    }
    await thread.setArchived(false, 'Les fils automatiques restent ouverts.');
  } catch (err) {
    console.warn(`[Péché Mignon] auto-fil désarchivage impossible (${thread.id}):`, err?.message || err);
  }
}

function isAutoThreadParentChannelId(channel) {
  if (!channel?.id) return false;
  if (typeof channel.isThread === 'function' && channel.isThread()) return false;
  if (config.autoThreadChannelIds.has(channel.id)) return true;
  if (config.selfieChannelIds.has(channel.id)) return true;
  return isAutoMediaCategoryChannel(channel);
}

async function resolveThreadFromStarter(message) {
  if (!message) return null;
  if (message.thread) return message.thread;
  if (message.hasThread && typeof message.fetchThread === 'function') {
    const t = await message.fetchThread().catch(() => null);
    if (t) return t;
  }
  const byId = await message.guild?.channels?.fetch?.(message.id).catch(() => null);
  if (byId && typeof byId.isThread === 'function' && byId.isThread()) return byId;
  return null;
}

/** Supprime le fil auto si le message d’origine est effacé. Ne touche pas aux tickets. */
export async function deleteAutoThreadIfStarterRemoved(message) {
  if (!message?.guild || !message.id) return;
  if (typeof message.channel?.isThread === 'function' && message.channel.isThread()) return;
  if (!isAutoThreadParentChannelId(message.channel)) return;

  const thread = await resolveThreadFromStarter(message);
  if (!thread) return;

  const ticket = await getTicketByThreadId(thread.id).catch(() => null);
  if (ticket) return;

  try {
    const me = message.guild.members.me ?? (await message.guild.members.fetchMe().catch(() => null));
    const parent = thread.parent ?? message.channel;
    if (me && parent && typeof me.permissionsIn === 'function') {
      const perms = me.permissionsIn(parent);
      if (perms && !perms.has(PermissionFlagsBits.ManageThreads)) {
        console.warn(`[Péché Mignon] auto-fil: permission « Gérer les fils » manquante pour supprimer ${thread.id}.`);
        return;
      }
    }
    await thread.delete('Message d’origine supprimé');
    console.log(`[Péché Mignon] auto-fil supprimé (starter ${message.id}): ${thread.id}`);
  } catch (err) {
    console.warn(`[Péché Mignon] auto-fil suppression impossible (${thread.id}):`, err?.message || err);
  }
}

export async function deleteAutoThreadsForBulkRemoved(messages) {
  if (!messages?.size) return;
  for (const message of messages.values()) {
    await deleteAutoThreadIfStarterRemoved(message);
  }
}
