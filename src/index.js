import { Client, Events, GatewayIntentBits, REST, Routes, MessageFlags, Options, AuditLogEvent } from 'discord.js';
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
import { handleSelfieChannelReaction, keepSelfieThreadOpen } from './selfieReactions.js';
import { handleAutoThreadMessage, keepAutoThreadOpen } from './autoThreads.js';
import {
  handleConfession,
  handleConfessionReponse,
  handleConfessionLog,
} from './commands/confession.js';
import { handleReglement, isReglementButton, handleReglementButton } from './commands/reglement.js';
import { handleInformations } from './commands/informations.js';

validateConfig();

const instanceId = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const instanceOwner = (process.env.PECHE_MIGNON_INSTANCE_OWNER || os.hostname()).trim() || os.hostname();
const INSTANCE_LOCK_KEY = (process.env.PECHE_MIGNON_INSTANCE_LOCK_KEY || 'peche-mignon-main').trim() || 'peche-mignon-main';
const DISABLE_INSTANCE_LOCK = /^(1|true|yes|on)$/i.test(String(process.env.PECHE_MIGNON_DISABLE_INSTANCE_LOCK || '').trim());
const INSTANCE_LOCK_TTL_MS = 90_000;
const AVATAR_SYNC_PATH = path.join(process.cwd(), 'data', 'avatar-sync.json');
let instanceLockHeartbeat = null;
let hasInstanceLock = false;

async function syncBotAvatarWithGuild(client) {
  const guild = (config.guildId && client.guilds.cache.get(config.guildId)) || client.guilds.cache.first();
  if (!guild) {
    console.warn("[Pêche Mignon] Avatar: aucun serveur pour copier l’icône.");
    return;
  }
  if (!guild.icon) {
    console.warn("[Pêche Mignon] Avatar: le serveur n’a pas d’icône.");
    return;
  }

  let last = {};
  try {
    last = JSON.parse(fs.readFileSync(AVATAR_SYNC_PATH, 'utf8'));
  } catch (_) {}

  if (last.guildId === guild.id && last.iconHash === guild.icon) return;

  const iconURL = guild.iconURL({ size: 256 });
  if (!iconURL) return;

  try {
    await client.user.setAvatar(iconURL);
    fs.mkdirSync(path.dirname(AVATAR_SYNC_PATH), { recursive: true });
    fs.writeFileSync(AVATAR_SYNC_PATH, JSON.stringify({ guildId: guild.id, iconHash: guild.icon }));
    console.log("[Pêche Mignon] Photo de profil alignée sur l’icône du serveur.");
  } catch (e) {
    console.warn("[Pêche Mignon] Changement de photo de profil impossible:", e?.message || e);
  }
}

async function safeReleaseInstanceLock(reason) {
  if (DISABLE_INSTANCE_LOCK || !hasInstanceLock) return;
  try {
    if (instanceLockHeartbeat) clearInterval(instanceLockHeartbeat);
  } catch (_) {}
  try {
    await releaseInstanceLock(INSTANCE_LOCK_KEY, instanceOwner);
    console.warn(`[Pêche Mignon] Instance lock libéré (${reason}) (key=${INSTANCE_LOCK_KEY}).`);
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
    console.log(`[Pêche Mignon] RAM rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB`);
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
    MessageManager: 0,
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
    messages: { interval: 60, lifetime: 30 },
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
    await interaction.user.send(`Pêche Mignon: ${dmText}`);
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
      console.error("[Pêche Mignon] interaction.reply échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'reply');
      return null;
    }
  };

  interaction.editReply = async (payload) => {
    try {
      return await baseEditReply(payload);
    } catch (err) {
      console.error("[Pêche Mignon] interaction.editReply échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'editReply');
      return null;
    }
  };

  interaction.followUp = async (payload) => {
    try {
      return await baseFollowUp(payload);
    } catch (err) {
      console.error("[Pêche Mignon] interaction.followUp échoué:", err?.message || err);
      if (shouldSkipFallbackForError(err)) return null;
      await sendInteractionFallback(interaction, payload, 'followUp');
      return null;
    }
  };
}

async function registerCommands() {
  const rest = new REST().setToken(config.token);
  const body = commands;
  if (config.guildId) {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    return await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body });
  }
  return await rest.put(Routes.applicationCommands(client.user.id), { body });
}

client.once(Events.ClientReady, async (c) => {
  try {
    await c.user.setPresence({
      status: 'online',
      activities: [],
    });
  } catch (e) {
    console.warn("[Pêche Mignon] Définition de la présence impossible:", e?.message || e);
  }

  try {
    await syncBotAvatarWithGuild(c);
  } catch (e) {
    console.warn("[Pêche Mignon] Synchronisation de l’avatar impossible:", e?.message || e);
  }

  startRateLimitCleanup();
  try {
    await registerCommands();
    const scope = config.guildId ? `serveur ${config.guildId}` : 'tous les serveurs (global)';
    console.log(`[Pêche Mignon] Slash commands enregistrées pour ${scope}`);
  } catch (e) {
    console.error("[Pêche Mignon] Erreur enregistrement commandes:", e.message);
  }
  console.log(`[Pêche Mignon] Connecté en tant que ${c.user.tag} (instance=${instanceId} pid=${process.pid})`);
  if (config.useGuildMembersIntent) {
    console.log("[Pêche Mignon] Intent Guild Members activé → autocomplétion /ban /warn et /analyse.");
  } else {
    console.log("[Pêche Mignon] Intent Guild Members désactivé. Active-le dans le Developer Portal puis GUILD_MEMBERS_INTENT=true.");
  }
  if (config.useMessageContentIntent) {
    console.log("[Pêche Mignon] Intent Message Content activé → texte des preuves dans les fils de signalement.");
  } else {
    console.log("[Pêche Mignon] Intent Message Content désactivé. Les preuves images/fichiers sont enregistrées, pas le texte.");
  }
  const selfieIds = [...(config.selfieChannelIds || [])];
  if (selfieIds.length) {
    console.log(`[Pêche Mignon] Selfies / OOTD actifs sur ${selfieIds.length} salon(s): ${selfieIds.join(', ')}`);
  } else {
    console.warn("[Pêche Mignon] Selfies / OOTD inactifs: SELFIE_CHANNEL_IDS est vide dans le .env.");
  }
  const autoThreadIds = [...(config.autoThreadChannelIds || [])];
  if (autoThreadIds.length) {
    console.log(`[Pêche Mignon] Auto-fils (images/liens) actifs sur ${autoThreadIds.length} salon(s): ${autoThreadIds.join(', ')}`);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (isDuplicateInteraction(interaction.id)) {
    console.warn(`[Pêche Mignon] Interaction doublon ignorée: id=${interaction.id}`);
    return;
  }

  try {
    const acquired = await tryAcquireInteraction(interaction.id);
    if (!acquired) {
      console.warn(`[Pêche Mignon] Interaction doublon (DB) ignorée: id=${interaction.id}`);
      return;
    }
  } catch (err) {
    console.error(`[Pêche Mignon] Interaction dedup indisponible → on continue: id=${interaction.id}`, err?.message || err);
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
    console.log(`[Pêche Mignon] Commande reçue: /${interaction.commandName} (user: ${interaction.user?.id})`);
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
    console.error("[Pêche Mignon] Erreur interaction:", err);
    if (interaction.__peche_mignon_fallback_sent) return;
    const payload = { content: '❌ Une erreur est survenue.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    } catch (_) {}
  }
});

client.on(Events.Error, (err) => console.error("[Pêche Mignon] Client error:", err));

client.on(Events.MessageBulkDelete, async (messages, channel) => {
  try {
    const ch = channel ?? messages.first()?.channel;
    await handlePresentationChannelBulkDelete(ch, messages?.size ?? 0);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur purge présentations (bulk delete):", err?.message || err);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  try {
    await handlePresentationChannelDelete(channel);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur purge présentations (salon supprimé):", err?.message || err);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await persistBanProofMessage(message, { replace: false });
  } catch (err) {
    console.error("[Pêche Mignon] Erreur enregistrement preuve:", err?.message || err);
  }
  try {
    await handleSelfieChannelReaction(message);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur réactions salon selfie:", err?.message || err);
  }
  try {
    await handleAutoThreadMessage(message);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur auto-fil:", err?.message || err);
  }
});

client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
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
    console.error("[Pêche Mignon] Erreur maj preuve:", err?.message || err);
  }
  try {
    await handleSelfieChannelReaction(msg);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur réactions salon selfie (maj):", err?.message || err);
  }
  try {
    await handleAutoThreadMessage(msg);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur auto-fil (maj):", err?.message || err);
  }
});

client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
  try {
    await keepSelfieThreadOpen(oldThread, newThread);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur maintien fil selfie:", err?.message || err);
  }
  try {
    await keepAutoThreadOpen(oldThread, newThread);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur maintien auto-fil:", err?.message || err);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    await deleteBanProofsForDeletedMessage(message);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur suppression preuve:", err?.message || err);
  }
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
    console.error("[Pêche Mignon] Erreur GuildBanAdd (MP banni):", err?.message || err);
  }
});

client.on(Events.GuildBanRemove, async (ban) => {
  try {
    const userId = ban.user?.id ?? ban.userId;
    const guildId = ban.guild?.id;
    if (userId && guildId) await removeBannedUser(userId, guildId);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur sync unban:", err?.message);
  }
});

process.on('SIGINT', () => {
  stopRateLimitCleanup();
  safeReleaseInstanceLock('SIGINT').catch(() => {});
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopRateLimitCleanup();
  safeReleaseInstanceLock('SIGTERM').catch(() => {});
  client.destroy();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error("[Pêche Mignon] uncaughtException:", err?.stack || err?.message || err);
  stopRateLimitCleanup();
  safeReleaseInstanceLock('uncaughtException')
    .catch(() => {})
    .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error("[Pêche Mignon] unhandledRejection:", reason?.stack || reason?.message || reason);
  stopRateLimitCleanup();
  safeReleaseInstanceLock('unhandledRejection')
    .catch(() => {})
    .finally(() => process.exit(1));
});

async function main() {
  try {
    const uri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
    console.log("[Pêche Mignon] MONGODB_URI défini:", uri.length > 0 ? 'oui' : 'non');
    await initDatabase();
    console.log("[Pêche Mignon] Base de données initialisée" + (uri.length > 0 ? ' (MongoDB persistant).' : ' (SQLite local).'));

    if (DISABLE_INSTANCE_LOCK) {
      console.warn(`[Pêche Mignon] Instance lock désactivé (key=${INSTANCE_LOCK_KEY}).`);
    } else {
      const acquired = await tryAcquireInstanceLock(INSTANCE_LOCK_KEY, instanceOwner, INSTANCE_LOCK_TTL_MS);
      if (!acquired) {
        const info = await getInstanceLockInfo(INSTANCE_LOCK_KEY).catch(() => null);
        console.error(`[Pêche Mignon] Instance lock refusé: un autre bot est déjà actif (key=${INSTANCE_LOCK_KEY}).`);
        if (info?.owner) console.error(`[Pêche Mignon] Lock actuel: owner=${info.owner}`);
        process.exit(0);
      }
      console.log(`[Pêche Mignon] Instance lock acquis (key=${INSTANCE_LOCK_KEY}, owner=${instanceOwner})`);
      hasInstanceLock = true;
      instanceLockHeartbeat = setInterval(async () => {
        try {
          const ok = await renewInstanceLock(INSTANCE_LOCK_KEY, instanceOwner, INSTANCE_LOCK_TTL_MS);
          if (!ok) {
            console.error(`[Pêche Mignon] Instance lock perdu → arrêt.`);
            process.exit(1);
          }
        } catch (_) {}
      }, Math.floor(INSTANCE_LOCK_TTL_MS / 3));
    }

    const runDraftCleanup = async () => {
      try {
        await cleanupPresentationDrafts('-3 days');
      } catch (e) {
        console.error("[Pêche Mignon] Cleanup presentation_drafts:", e?.message || e);
      }
    };
    await runDraftCleanup().catch(() => {});
    setInterval(() => runDraftCleanup().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (err) {
    console.error("[Pêche Mignon] Erreur init base de données:", err.message);
    process.exit(1);
  }
  await client.login(config.token).catch((err) => {
    console.error("[Pêche Mignon] Login failed:", err.message);
    process.exit(1);
  });
}
main();
