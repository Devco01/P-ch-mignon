import { Client, Events, GatewayIntentBits, REST, Routes, MessageFlags, Options, AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config, validateConfig } from './config.js';
import { startRateLimitCleanup, stopRateLimitCleanup } from './rateLimit.js';
import {
  initDatabase,
  tryAcquireInteraction,
  tryAcquireInstanceLock,
  renewInstanceLock,
  releaseInstanceLock,
  getInstanceLockInfo,
  cleanupPresentationDrafts,
  removeBannedUser,
  addBannedUser,
  getBannedUser,
  updateBannedUser,
} from './database.js';
import { commands } from './commands/index.js';
import {
  handleBan,
  handleUnban,
  handleWarn,
  handleUnwarn,
  handleAnalyse,
  handleMemberAutocomplete,
  isAnalyseButton,
  handleAnalyseButton,
  isUnwarnSelect,
  handleUnwarnSelect,
  isPendingSlashBan,
  sendBanAppealDmToBannedUser,
  sendBanSignalement,
} from './commands/moderation.js';
import {
  handlePresentation,
  isPresentationModal,
  handlePresentationModalSubmit,
  isPresentationButton,
  handlePresentationButton,
  isPresentationContinueButton,
  handlePresentationContinueButton,
} from './commands/presentation.js';
import {
  handleTicketPanel,
  refreshTicketPanelWithoutEdit,
  isTicketSelect,
  handleTicketSelect,
  isTicketOpenButton,
  handleTicketOpenButton,
  isTicketModal,
  handleTicketModalSubmit,
  isTicketCloseModal,
  handleTicketCloseModal,
  isTicketButton,
  handleTicketButton,
} from './commands/tickets.js';
import { handlePresentationChannelBulkDelete, handlePresentationChannelDelete } from './presentationReset.js';
import { persistBanProofMessage, deleteBanProofsForDeletedMessage } from './banProofs.js';
import { handleSelfieChannelReaction } from './selfieReactions.js';
import { handleAutoThreadMessage, deleteAutoThreadIfStarterRemoved, deleteAutoThreadsForBulkRemoved, startIdleThreadArchiver, stopIdleThreadArchiver } from './autoThreads.js';
import {
  handleConfession,
  handleConfessionReponse,
  handleConfessionLog,
} from './commands/confession.js';
import { handleReglement, isReglementButton, handleReglementButton } from './commands/reglement.js';
import { handleInformations } from './commands/informations.js';
import { handleWelcomeMemberAdd, handleWelcomeMemberUpdate } from './welcome.js';
import { handleMessageLogDelete, handleMessageLogUpdate, handleMessageLogBulkDelete } from './messageLogs.js';

validateConfig();

const instanceId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const instanceOwner = (process.env.PECHE_MIGNON_INSTANCE_OWNER || os.hostname()).trim() || os.hostname();
const INSTANCE_LOCK_KEY = (process.env.PECHE_MIGNON_INSTANCE_LOCK_KEY || 'peche-mignon-main').trim() || 'peche-mignon-main';
const DISABLE_INSTANCE_LOCK = /^(1|true|yes|on)$/i.test(String(process.env.PECHE_MIGNON_DISABLE_INSTANCE_LOCK || '').trim());
const INSTANCE_LOCK_TTL_MS = 90_000;
const AVATAR_SYNC_PATH = path.join(process.cwd(), 'data', 'avatar-sync.json');
let instanceLockHeartbeat = null;
let hasInstanceLock = false;

async function syncBotAvatarWithGuild(client, { force = false } = {}) {
  let guild = (config.guildId && client.guilds.cache.get(config.guildId)) || client.guilds.cache.first();
  if (!guild) {
    console.warn("[Péché Mignon] Avatar: aucun serveur pour copier l’icône.");
    return;
  }
  try {
    guild = await guild.fetch();
  } catch (e) {
    console.warn("[Péché Mignon] Avatar: fetch serveur impossible:", e?.message || e);
  }
  if (!guild.icon) {
    console.warn("[Péché Mignon] Avatar: le serveur n’a pas d’icône.");
    return;
  }

  let last = {};
  try {
    last = JSON.parse(fs.readFileSync(AVATAR_SYNC_PATH, 'utf8'));
  } catch (_) {}

  if (!force && last.guildId === guild.id && last.iconHash === guild.icon) return;

  const animated = String(guild.icon).startsWith('a_');
  const iconURL = guild.iconURL({ size: 512, extension: animated ? 'gif' : 'png' });
  if (!iconURL) return;

  try {
    await client.user.setAvatar(iconURL);
    fs.mkdirSync(path.dirname(AVATAR_SYNC_PATH), { recursive: true });
    fs.writeFileSync(AVATAR_SYNC_PATH, JSON.stringify({ guildId: guild.id, iconHash: guild.icon }));
    console.log("[Péché Mignon] Photo de profil alignée sur l’icône actuelle du serveur.");
  } catch (e) {
    console.warn("[Péché Mignon] Changement de photo de profil impossible:", e?.message || e);
  }
}

async function syncBotDisplayName(client) {
  const name = (config.embedBrand || '').trim();
  if (!name) return;

  if (client.user.username !== name) {
    try {
      await client.user.setUsername(name);
      console.log(`[Péché Mignon] Nom d’utilisateur Discord : ${name}`);
    } catch (e) {
      console.warn("[Péché Mignon] Changement de nom d’utilisateur impossible:", e?.message || e);
    }
  }

  if (typeof client.user.setGlobalName === 'function' && client.user.globalName !== name) {
    try {
      await client.user.setGlobalName(name);
      console.log(`[Péché Mignon] Nom d’affichage global : ${name}`);
    } catch (e) {
      console.warn("[Péché Mignon] Changement de nom d’affichage impossible:", e?.message || e);
    }
  }

  const guild = (config.guildId && client.guilds.cache.get(config.guildId)) || client.guilds.cache.first();
  if (!guild) return;
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return;
  if (me.nickname === name) {
    console.log(`[Péché Mignon] Surnom serveur déjà à jour : ${name}`);
    return;
  }
  try {
    await me.setNickname(name, 'Aligner le nom du bot sur Le Nid Douillet');
    console.log(`[Péché Mignon] Surnom serveur : ${name}`);
  } catch (e) {
    console.warn("[Péché Mignon] Changement de surnom impossible:", e?.message || e);
  }
}

async function safeReleaseInstanceLock(reason) {
  if (DISABLE_INSTANCE_LOCK || !hasInstanceLock) return;
  try {
    if (instanceLockHeartbeat) clearInterval(instanceLockHeartbeat);
  } catch (_) {}
  try {
    await releaseInstanceLock(INSTANCE_LOCK_KEY, instanceOwner);
    console.warn(`[Péché Mignon] Instance lock libéré (${reason}) (key=${INSTANCE_LOCK_KEY}).`);
  } catch (_) {}
  hasInstanceLock = false;
}

const processedInteractionIds = new Map();
const INTERACTION_DEDUP_TTL_MS = 2 * 60 * 1000;
function isDuplicateInteraction(interactionId) {
  const now = Date.now();
  for (const [id, ts] of processedInteractionIds) {
    if (now - ts > INTERACTION_DEDUP_TTL_MS) processedInteractionIds.delete(id);
  }
  if (!interactionId) return false;
  if (processedInteractionIds.has(interactionId)) return true;
  processedInteractionIds.set(interactionId, now);
  return false;
}

async function findRecentMemberBanAddAuditEntry(guild, userId) {
  for (let a = 0; a < 4; a++) {
    if (a) await new Promise((r) => setTimeout(r, 450));
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 12 }).catch(() => null);
    if (!logs) continue;
    const e = logs.entries.find((x) => x.targetId === userId && Date.now() - x.createdTimestamp < 30_000);
    if (e) return e;
  }
  return null;
}

setInterval(() => {
  try {
    const m = process.memoryUsage();
    const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
    console.log(`[Péché Mignon] RAM rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB`);
  } catch (_) {}
}, 10 * 60 * 1000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildBans,
    ...(config.useGuildMembersIntent ? [GatewayIntentBits.GuildMembers] : []),
    ...(config.useMessageContentIntent ? [GatewayIntentBits.MessageContent] : []),
  ],
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 200,
    PresenceManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
    ReactionManager: 0,
    ReactionUserManager: 0,
    GuildInviteManager: 0,
    GuildScheduledEventManager: 0,
    StageInstanceManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 1800 },
    threads: { interval: 60, lifetime: 30 },
  },
});

function normalizePayload(payload) {
  if (payload == null) return {};
  if (typeof payload === 'string') return { content: payload };
  return payload;
}

function shouldSkipFallbackForError(err) {
  const code = err?.code ?? err?.rawError?.code;
  const msg = String(err?.message || '');
  if (code === 10062 || code === 40060) return true;
  if (/Unknown interaction/i.test(msg)) return true;
  if (/already been acknowledged/i.test(msg)) return true;
  return false;
}

async function sendInteractionFallback(interaction, payload, context) {
  if (interaction.__peche_mignon_fallback_sent) return;
  interaction.__peche_mignon_fallback_sent = true;
  const p = normalizePayload(payload);
  const channelPayload = { ...(p.content ? { content: p.content } : {}), ...(p.embeds ? { embeds: p.embeds } : {}) };
  if (!channelPayload.content && !channelPayload.embeds) {
    channelPayload.content = `⚠️ Réponse fallback (${context}).`;
  }
  try {
    const ch = interaction.channel;
    if (ch && typeof ch.send === 'function') {
      await ch.send(channelPayload);
      return;
    }
  } catch (_) {}
  try {
    const dmText = channelPayload.content || `Réponse indisponible dans le salon (${context}).`;
    await interaction.user.send(`Péché Mignon: ${dmText}`);
  } catch (_) {}
}

function attachResilientInteractionHandlers(interaction) {
  if (interaction.__peche_mignon_resilient_wrapped) return;
  interaction.__peche_mignon_resilient_wrapped = true;

  const baseReply = interaction.reply.bind(interaction);
  const baseEditReply = interaction.editReply.bind(interaction);
  const baseFollowUp = interaction.followUp.bind(interaction);

  interaction.reply = async (payload) => {
    try {
      return await baseReply(payload);
    } catch (err) {
      console.error("[Péché Mignon] interaction.reply échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'reply');
      return null;
    }
  };

  interaction.editReply = async (payload) => {
    try {
      return await baseEditReply(payload);
    } catch (err) {
      console.error("[Péché Mignon] interaction.editReply échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'editReply');
      return null;
    }
  };

  interaction.followUp = async (payload) => {
    try {
      return await baseFollowUp(payload);
    } catch (err) {
      console.error("[Péché Mignon] interaction.followUp échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'followUp');
      return null;
    }
  };
}

const MEMBER_SLASH_COMMANDS = new Set(['confession', 'confession-reponse', 'presentation']);

function memberVisibleCommandBody() {
  return commands.map((cmd) => {
    const json = { ...cmd };
    if (MEMBER_SLASH_COMMANDS.has(json.name)) {
      json.default_member_permissions = null;
      json.dm_permission = false;
    }
    return json;
  });
}

async function registerCommands() {
  const rest = new REST().setToken(config.token);
  const body = memberVisibleCommandBody();
  if (config.guildId) {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    // Un PUT par nom conserve les IDs → les overwrites Intégrations (admins only) restent.
    // On recrée les commandes pour que Discord oublie ces overwrites.
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: [] });
    return await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body });
  }
  return await rest.put(Routes.applicationCommands(client.user.id), { body });
}

async function grantUseApplicationCommandsToRole(role) {
  if (role.permissions.has(PermissionFlagsBits.UseApplicationCommands)) {
    console.log(`[Péché Mignon] ${role.name} a déjà « Utiliser les commandes de l’application ».`);
    return;
  }
  try {
    await role.setPermissions(
      role.permissions.add(PermissionFlagsBits.UseApplicationCommands),
      'Autoriser /confession, /confession-réponse et /présentation'
    );
    console.log(`[Péché Mignon] Permission commandes ajoutée au rôle ${role.name} (${role.id}).`);
  } catch (err) {
    console.warn(`[Péché Mignon] Impossible de modifier le rôle ${role.name}:`, err?.message || err);
  }
}

async function syncMemberSlashCommandAccess(client) {
  const guildId = config.guildId;
  const roleIds = config.memberSlashRoleIds || [];
  if (!guildId || roleIds.length === 0) {
    console.warn("[Péché Mignon] Permissions slash membres : GUILD_ID ou MEMBER_SLASH_ROLE_IDS manquant.");
    return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  for (const roleId of roleIds) {
    const role =
      guild.roles.cache.get(roleId) || (await guild.roles.fetch(roleId).catch(() => null));
    if (!role) {
      console.warn(`[Péché Mignon] Rôle commandes membres ${roleId} introuvable.`);
      continue;
    }
    await grantUseApplicationCommandsToRole(role);
  }
}

client.once(Events.ClientReady, async (c) => {
  try {
    await c.user.setPresence({
      status: 'online',
      activities: [],
    });
  } catch (e) {
    console.warn("[Péché Mignon] Définition de la présence impossible:", e?.message || e);
  }

  try {
    await syncBotAvatarWithGuild(c);
  } catch (e) {
    console.warn("[Péché Mignon] Synchronisation de l’avatar impossible:", e?.message || e);
  }

  try {
    await syncBotDisplayName(c);
  } catch (e) {
    console.warn("[Péché Mignon] Synchronisation du nom impossible:", e?.message || e);
  }

  startRateLimitCleanup();
  startIdleThreadArchiver(c);
  try {
    const registered = await registerCommands();
    const scope = config.guildId ? `serveur ${config.guildId}` : 'tous les serveurs (global)';
    console.log(`[Péché Mignon] Slash commands enregistrées pour ${scope}`);
    const listed = Array.isArray(registered) ? registered : [];
    for (const cmd of listed) {
      if (!MEMBER_SLASH_COMMANDS.has(cmd.name)) continue;
      console.log(
        `[Péché Mignon] /${cmd.name} id=${cmd.id} default_member_permissions=${cmd.default_member_permissions}`
      );
    }
    await syncMemberSlashCommandAccess(c);
  } catch (e) {
    console.error("[Péché Mignon] Erreur enregistrement commandes:", e.message);
  }
  try {
    const guildId = config.guildId || c.guilds.cache.first()?.id;
    if (guildId) await refreshTicketPanelWithoutEdit(c, guildId);
  } catch (e) {
    console.warn("[Péché Mignon] Republier le panneau tickets impossible:", e?.message || e);
  }
  console.log(`[Péché Mignon] Connecté en tant que ${c.user.tag} (instance=${instanceId} pid=${process.pid})`);
  console.log(`[Péché Mignon] Archivage auto des fils publics : ${config.autoThreadArchiveMinutes} min (sans verrouillage).`);
  if (config.useGuildMembersIntent) {
    console.log("[Péché Mignon] Intent Guild Members activé → autocomplétion /ban /warn et /analyse.");
  } else {
    console.log("[Péché Mignon] Intent Guild Members désactivé. Active-le dans le Developer Portal puis GUILD_MEMBERS_INTENT=true.");
  }
  if (config.useMessageContentIntent) {
    console.log("[Péché Mignon] Intent Message Content activé → texte des preuves dans les fils de signalement.");
  } else {
    console.log("[Péché Mignon] Intent Message Content désactivé. Les preuves images/fichiers sont enregistrées, pas le texte.");
  }
  const selfieIds = [...(config.selfieChannelIds || [])];
  const categoryIds = [...(config.autoMediaCategoryIds || [])];
  if (selfieIds.length) {
    console.log(`[Péché Mignon] Selfies / OOTD actifs sur ${selfieIds.length} salon(s): ${selfieIds.join(', ')}`);
  }
  if (categoryIds.length) {
    console.log(`[Péché Mignon] Auto-fil + auto-react sur ${categoryIds.length} catégorie(s): ${categoryIds.join(', ')}`);
  }
  if (!selfieIds.length && !categoryIds.length) {
    console.warn("[Péché Mignon] Selfies / OOTD inactifs: SELFIE_CHANNEL_IDS et AUTO_MEDIA_CATEGORY_IDS sont vides.");
  }
  const autoThreadIds = [...(config.autoThreadChannelIds || [])];
  if (autoThreadIds.length) {
    console.log(`[Péché Mignon] Auto-fils (images/liens) actifs sur ${autoThreadIds.length} salon(s): ${autoThreadIds.join(', ')}`);
  }
  if (config.welcomeChannelId && config.welcomeRoleIds.size) {
    console.log(
      `[Péché Mignon] Bienvenue actif: salon ${config.welcomeChannelId}, ${config.welcomeRoleIds.size} rôle(s)`
    );
  } else {
    console.warn("[Péché Mignon] Bienvenue inactif: WELCOME_CHANNEL_ID ou WELCOME_ROLE_IDS manquant.");
  }
  if (config.messageLogChannelId) {
    console.log(`[Péché Mignon] Logs messages (suppression / édition) : ${config.messageLogChannelId}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (isDuplicateInteraction(interaction.id)) {
    console.warn(`[Péché Mignon] Interaction doublon ignorée: id=${interaction.id}`);
    return;
  }

  try {
    const acquired = await tryAcquireInteraction(interaction.id);
    if (!acquired) {
      console.warn(`[Péché Mignon] Interaction doublon (DB) ignorée: id=${interaction.id}`);
      return;
    }
  } catch (err) {
    console.error(`[Péché Mignon] Interaction dedup indisponible → on continue: id=${interaction.id}`, err?.message || err);
  }

  try {
    attachResilientInteractionHandlers(interaction);

    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'warn' || interaction.commandName === 'unwarn') {
        await handleMemberAutocomplete(interaction).catch(() => {});
      }
      return;
    }

    if (interaction.isStringSelectMenu() && isTicketSelect(interaction.customId)) {
      await handleTicketSelect(interaction);
      return;
    }
    if (interaction.isButton() && isTicketOpenButton(interaction.customId)) {
      await handleTicketOpenButton(interaction);
      return;
    }
    if (interaction.isModalSubmit() && isTicketModal(interaction.customId)) {
      await handleTicketModalSubmit(interaction);
      return;
    }
    if (interaction.isModalSubmit() && isTicketCloseModal(interaction.customId)) {
      await handleTicketCloseModal(interaction);
      return;
    }
    if (interaction.isButton() && isTicketButton(interaction.customId)) {
      await handleTicketButton(interaction);
      return;
    }

    if (interaction.isButton() && isPresentationContinueButton(interaction.customId)) {
      await handlePresentationContinueButton(interaction);
      return;
    }
    if (interaction.isButton() && isPresentationButton(interaction.customId)) {
      await handlePresentationButton(interaction);
      return;
    }
    if (interaction.isModalSubmit() && isPresentationModal(interaction.customId)) {
      await handlePresentationModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && isAnalyseButton(interaction.customId)) {
      await handleAnalyseButton(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && isUnwarnSelect(interaction.customId)) {
      await handleUnwarnSelect(interaction);
      return;
    }

    if (interaction.isButton() && isReglementButton(interaction.customId)) {
      await handleReglementButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    console.log(`[Péché Mignon] Commande reçue: /${interaction.commandName} (user: ${interaction.user?.id})`);
    switch (interaction.commandName) {
      case 'ban':
        await handleBan(interaction);
        break;
      case 'unban':
        await handleUnban(interaction);
        break;
      case 'warn':
        await handleWarn(interaction);
        break;
      case 'unwarn':
        await handleUnwarn(interaction);
        break;
      case 'analyse':
        await handleAnalyse(interaction);
        break;
      case 'presentation':
        await handlePresentation(interaction);
        break;
      case 'ticket-panel':
        await handleTicketPanel(interaction);
        break;
      case 'confession':
        await handleConfession(interaction);
        break;
      case 'confession-reponse':
        await handleConfessionReponse(interaction);
        break;
      case 'confession-log':
        await handleConfessionLog(interaction);
        break;
      case 'reglement':
      case 'règlement':
        await handleReglement(interaction);
        break;
      case 'informations':
        await handleInformations(interaction);
        break;
      default:
        await interaction.reply({ content: 'Commande inconnue.', flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error("[Péché Mignon] Erreur interaction:", err);
    if (interaction.__peche_mignon_fallback_sent) return;
    const payload = { content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    } catch (_) {}
  }
});

client.on(Events.Error, (err) => console.error("[Péché Mignon] Client error:", err));

client.on(Events.GuildUpdate, async (oldGuild, newGuild) => {
  if (config.guildId && newGuild.id !== config.guildId) return;
  if (oldGuild.icon === newGuild.icon) return;
  try {
    await syncBotAvatarWithGuild(newGuild.client, { force: true });
  } catch (err) {
    console.warn("[Péché Mignon] Sync avatar après changement d’icône:", err?.message || err);
  }
});

client.on(Events.MessageBulkDelete, async (messages, channel) => {
  try {
    const ch = channel ?? messages.first()?.channel;
    await handlePresentationChannelBulkDelete(ch, messages?.size ?? 0);
  } catch (err) {
    console.error("[Péché Mignon] Erreur purge présentations (bulk delete):", err?.message || err);
  }
  try {
    await handleMessageLogBulkDelete(messages, channel ?? messages.first()?.channel);
  } catch (err) {
    console.error("[Péché Mignon] Erreur log purge messages:", err?.message || err);
  }
  try {
    await deleteAutoThreadsForBulkRemoved(messages);
  } catch (err) {
    console.error("[Péché Mignon] Erreur suppression auto-fils (purge):", err?.message || err);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  try {
    await handlePresentationChannelDelete(channel);
  } catch (err) {
    console.error("[Péché Mignon] Erreur purge présentations (salon supprimé):", err?.message || err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await persistBanProofMessage(message, { replace: false });
  } catch (err) {
    console.error("[Péché Mignon] Erreur enregistrement preuve:", err?.message || err);
  }
  try {
    await handleSelfieChannelReaction(message);
  } catch (err) {
    console.error("[Péché Mignon] Erreur réactions salon selfie:", err?.message || err);
  }
  try {
    await handleAutoThreadMessage(message);
  } catch (err) {
    console.error("[Péché Mignon] Erreur auto-fil:", err?.message || err);
  }
});

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
  try {
    await handleMessageLogUpdate(_oldMessage, newMessage);
  } catch (err) {
    console.error("[Péché Mignon] Erreur log édition message:", err?.message || err);
  }
  let msg = newMessage;
  if (msg.partial) {
    try {
      msg = await msg.fetch();
    } catch {
      return;
    }
  }
  try {
    await persistBanProofMessage(msg, { replace: true });
  } catch (err) {
    console.error("[Péché Mignon] Erreur maj preuve:", err?.message || err);
  }
  try {
    await handleSelfieChannelReaction(msg);
  } catch (err) {
    console.error("[Péché Mignon] Erreur réactions salon selfie (maj):", err?.message || err);
  }
  try {
    await handleAutoThreadMessage(msg);
  } catch (err) {
    console.error("[Péché Mignon] Erreur auto-fil (maj):", err?.message || err);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    await deleteBanProofsForDeletedMessage(message);
  } catch (err) {
    console.error("[Péché Mignon] Erreur suppression preuve:", err?.message || err);
  }
  try {
    await handleMessageLogDelete(message);
  } catch (err) {
    console.error("[Péché Mignon] Erreur log suppression message:", err?.message || err);
  }
  try {
    await deleteAutoThreadIfStarterRemoved(message);
  } catch (err) {
    console.error("[Péché Mignon] Erreur suppression auto-fil:", err?.message || err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  await handleWelcomeMemberAdd(member);
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await handleWelcomeMemberUpdate(oldMember, newMember);
});

client.on(Events.GuildBanAdd, async (ban) => {
  try {
    const userId = ban.user?.id;
    if (!userId) return;
    if (isPendingSlashBan(userId)) return;
    const entry = await findRecentMemberBanAddAuditEntry(ban.guild, userId);
    if (entry?.executorId === client.user.id) return;
    const fetchedBan = typeof ban?.fetch === 'function' ? await ban.fetch().catch(() => null) : ban;
    const reasonFromBan = fetchedBan && 'reason' in fetchedBan ? fetchedBan.reason : null;
    const reason = (entry?.reason ?? reasonFromBan) || 'Non précisée';
    const bannedAt = entry ? new Date(entry.createdTimestamp) : new Date();
    const moderatorId = entry?.executorId || client.user.id;
    const guildId = ban.guild.id;
    const existing = await getBannedUser(userId, guildId);
    if (existing) {
      await updateBannedUser(userId, guildId, reason, moderatorId);
    } else {
      await addBannedUser(userId, reason, moderatorId, guildId);
    }
    await sendBanAppealDmToBannedUser(client, ban.guild, userId, reason, bannedAt);
    await sendBanSignalement(client, {
      userId,
      guildId,
      reason,
      moderatorId,
      bannedAt,
      avatarURL: ban.user?.displayAvatarURL?.({ size: 128 }) || null,
    });
  } catch (err) {
    console.error("[Péché Mignon] Erreur GuildBanAdd (MP banni):", err?.message || err);
  }
});

client.on(Events.GuildBanRemove, async (ban) => {
  try {
    const userId = ban.user?.id ?? ban.userId;
    const guildId = ban.guild?.id;
    if (userId && guildId) await removeBannedUser(userId, guildId);
  } catch (err) {
    console.error("[Péché Mignon] Erreur sync unban:", err?.message);
  }
});

process.on('SIGINT', () => {
  stopRateLimitCleanup();
  stopIdleThreadArchiver();
  safeReleaseInstanceLock('SIGINT').catch(() => {});
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopRateLimitCleanup();
  stopIdleThreadArchiver();
  safeReleaseInstanceLock('SIGTERM').catch(() => {});
  client.destroy();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error("[Péché Mignon] uncaughtException:", err?.stack || err?.message || err);
  stopRateLimitCleanup();
  stopIdleThreadArchiver();
  safeReleaseInstanceLock('uncaughtException')
    .catch(() => {})
    .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error("[Péché Mignon] unhandledRejection:", reason?.stack || reason?.message || reason);
  stopRateLimitCleanup();
  stopIdleThreadArchiver();
  safeReleaseInstanceLock('unhandledRejection')
    .catch(() => {})
    .finally(() => process.exit(1));
});

async function main() {
  try {
    const uri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
    console.log("[Péché Mignon] MONGODB_URI défini:", uri.length > 0 ? 'oui' : 'non');
    await initDatabase();
    console.log("[Péché Mignon] Base de données initialisée" + (uri.length > 0 ? ' (MongoDB persistant).' : ' (SQLite local).'));

    if (DISABLE_INSTANCE_LOCK) {
      console.warn(`[Péché Mignon] Instance lock désactivé (key=${INSTANCE_LOCK_KEY}).`);
    } else {
      const acquired = await tryAcquireInstanceLock(INSTANCE_LOCK_KEY, instanceOwner, INSTANCE_LOCK_TTL_MS);
      if (!acquired) {
        const info = await getInstanceLockInfo(INSTANCE_LOCK_KEY).catch(() => null);
        console.error(`[Péché Mignon] Instance lock refusé: un autre bot est déjà actif (key=${INSTANCE_LOCK_KEY}).`);
        if (info?.owner) console.error(`[Péché Mignon] Lock actuel: owner=${info.owner}`);
        process.exit(1);
      }
      console.log(`[Péché Mignon] Instance lock acquis (key=${INSTANCE_LOCK_KEY}, owner=${instanceOwner})`);
      hasInstanceLock = true;
      instanceLockHeartbeat = setInterval(async () => {
        try {
          const ok = await renewInstanceLock(INSTANCE_LOCK_KEY, instanceOwner, INSTANCE_LOCK_TTL_MS);
          if (!ok) {
            console.error(`[Péché Mignon] Instance lock perdu → arrêt.`);
            process.exit(1);
          }
        } catch (_) {}
      }, Math.floor(INSTANCE_LOCK_TTL_MS / 3));
    }

    const runDraftCleanup = async () => {
      try {
        await cleanupPresentationDrafts('-3 days');
      } catch (e) {
        console.error("[Péché Mignon] Cleanup presentation_drafts:", e?.message || e);
      }
    };
    await runDraftCleanup().catch(() => {});
    setInterval(() => runDraftCleanup().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (err) {
    console.error("[Péché Mignon] Erreur init base de données:", err.message);
    process.exit(1);
  }
  await client.login(config.token).catch((err) => {
    console.error("[Péché Mignon] Login failed:", err.message);
    process.exit(1);
  });
}
main();
