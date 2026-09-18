import {
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  SlashCommandBuilder,
  MessageFlags,
} from 'discord.js';
import { config, isAutoMediaCategoryChannel } from './config.js';
import { getTicketByThreadId, listConfessionLogConfigsForGuild } from './database.js';
import { hasAdminRole } from './permissions.js';

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
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
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

function snowflakeTimeMs(id) {
  if (!id) return 0;
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch (_) {
    return 0;
  }
}

function threadLastActivityMs(thread) {
  return snowflakeTimeMs(thread.lastMessageId) || thread.createdTimestamp || 0;
}

async function isPublicDiscussionThread(thread, confessionSourceIds) {
  if (!thread || typeof thread.isThread !== 'function' || !thread.isThread()) return false;
  if (thread.archived || thread.locked) return false;
  if (thread.type === 12) return false;
  const ticket = await getTicketByThreadId(thread.id).catch(() => null);
  if (ticket) return false;
  const parentId = thread.parentId;
  if (!parentId) return false;
  if (config.ticketChannelId && parentId === config.ticketChannelId) return false;
  if (config.banLogChannelId && parentId === config.banLogChannelId) return false;
  if (config.autoThreadChannelIds.has(parentId)) return true;
  if (config.selfieChannelIds.has(parentId)) return true;
  if (confessionSourceIds?.has(parentId)) return true;
  const parent = thread.parent ?? (await thread.guild?.channels?.fetch?.(parentId).catch(() => null));
  if (isAutoMediaCategoryChannel(parent)) return true;
  return false;
}

async function archiveIdleAutoThreadsForGuild(guild) {
  const idleMs = (config.autoThreadArchiveMinutes || 30) * 60 * 1000;
  const now = Date.now();
  const confessionSourceIds = new Set(
    ((await listConfessionLogConfigsForGuild(guild.id).catch(() => [])) || []).map((c) => c.sourceChannelId).filter(Boolean)
  );
  let active;
  try {
    active = await guild.channels.fetchActiveThreads();
  } catch (err) {
    console.warn(`[Péché Mignon] fetch fils actifs impossible:`, err?.message || err);
    return 0;
  }
  const threads = active?.threads;
  if (!threads?.size) return 0;
  let archived = 0;
  for (const thread of threads.values()) {
    if (!(await isPublicDiscussionThread(thread, confessionSourceIds))) continue;
    const last = threadLastActivityMs(thread);
    if (!last || now - last < idleMs) continue;
    try {
      await thread.setArchived(true, `Inactivité ${config.autoThreadArchiveMinutes} min`);
      archived += 1;
    } catch (err) {
      console.warn(`[Péché Mignon] Archivage fil ${thread.id} impossible:`, err?.message || err);
    }
  }
  return archived;
}

let archiveInterval = null;

export function startIdleThreadArchiver(client) {
  if (archiveInterval) return;
  const run = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const n = await archiveIdleAutoThreadsForGuild(guild);
        if (n) console.log(`[Péché Mignon] ${n} fil(s) archivé(s) après ${config.autoThreadArchiveMinutes} min d’inactivité.`);
      } catch (err) {
        console.warn(`[Péché Mignon] Archivage auto fils:`, err?.message || err);
      }
    }
  };
  archiveInterval = setInterval(run, 60 * 1000);
  if (typeof archiveInterval.unref === 'function') archiveInterval.unref();
  setTimeout(run, 15 * 1000).unref?.();
}

export function stopIdleThreadArchiver() {
  if (!archiveInterval) return;
  clearInterval(archiveInterval);
  archiveInterval = null;
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

export const threadCommands = [
  new SlashCommandBuilder()
    .setName('fil-fermer')
    .setDescription('Archiver ce fil (admins / owner). L’accès en lecture reste possible.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON(),
];

export async function handleFilFermer(interaction) {
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({
      content: '❌ Réservé aux **administrateurs** et au **propriétaire** du serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const thread = interaction.channel;
  if (!thread || typeof thread.isThread !== 'function' || !thread.isThread()) {
    return interaction.reply({
      content: '❌ Utilise cette commande **dans le fil** à fermer.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const ticket = await getTicketByThreadId(thread.id).catch(() => null);
  if (ticket) {
    return interaction.reply({
      content: '❌ Pour un ticket, utilise le bouton **Fermer** dans le fil.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (thread.archived) {
    return interaction.reply({
      content: '✅ Ce fil est déjà archivé. L’accès reste possible.',
      flags: MessageFlags.Ephemeral,
    });
  }
  try {
    await thread.setArchived(true, `Fermé manuellement par ${interaction.user.tag}`);
  } catch (err) {
    return interaction.reply({
      content: `❌ Impossible d’archiver ce fil : ${err?.message || 'erreur'}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  return interaction.reply({
    content: '✅ Fil archivé. Il reste accessible (pas verrouillé).',
    flags: MessageFlags.Ephemeral,
  });
}
