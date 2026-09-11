import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import crypto from 'crypto';
import { config } from '../config.js';
import {
  getBannedUser,
  addBannedUser,
  removeBannedUser,
  updateBannedUser,
  addAvertissement,
  getAvertissementCount,
  listAvertissementsForUser,
  deleteAvertissementById,
} from '../database.js';
import { isValidDiscordId, sanitizeReason, parseUserIdFromOption, formatBanDate } from '../validation.js';
import { checkRateLimit } from '../rateLimit.js';
import { resolveReasonToFullTag } from '../sanctionsTags.js';
import { COLOR_SANCTION, COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';
import { hasAdminRole } from '../permissions.js';
import { createBanProofThread, persistProofThreadLink } from '../banProofs.js';

const ANALYSE_CACHE_TTL_MS = 10 * 60 * 1000;
const analyseCache = new Map();

const pendingSlashBanUserIds = new Map();

function registerPendingSlashBan(userId) {
  const old = pendingSlashBanUserIds.get(userId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => pendingSlashBanUserIds.delete(userId), 6_000);
  pendingSlashBanUserIds.set(userId, t);
}

function clearPendingSlashBan(userId) {
  const old = pendingSlashBanUserIds.get(userId);
  if (old) clearTimeout(old);
  pendingSlashBanUserIds.delete(userId);
}

export function isPendingSlashBan(userId) {
  return pendingSlashBanUserIds.has(userId);
}

function replyRateLimited(interaction, retryAfterMs) {
  return interaction.reply({
    content: `⏱️ Trop de requêtes. Réessaie dans ${Math.ceil(retryAfterMs / 1000)} secondes.`,
    flags: MessageFlags.Ephemeral,
  });
}

function buildBanReasonForDiscord(reason, moderatorDisplayName) {
  const base = (reason || `Ban via ${config.embedBrand}`).trim();
  const suffix = moderatorDisplayName ? ` | Banni par ${String(moderatorDisplayName).trim()}` : '';
  const full = base + suffix;
  return full.length > 512 ? base.slice(0, 512 - suffix.length) + suffix : full;
}

function normForPseudoSimilarity(s) {
  if (!s) return '';
  let x = String(s).toLowerCase();
  x = x.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  x = x
    .replace(/[@]/g, 'a')
    .replace(/[€]/g, 'e')
    .replace(/[0]/g, 'o')
    .replace(/[1|!]/g, 'l')
    .replace(/[3]/g, 'e')
    .replace(/[5]/g, 's')
    .replace(/[7]/g, 't');
  x = x.replace(/[^a-z0-9]+/g, '');
  return x;
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const s1 = a;
  const s2 = b;
  const len1 = s1.length;
  const len2 = s2.length;
  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let t = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const transpositions = t / 2;
  const jaro = (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  const maxPrefix = 4;
  for (let i = 0; i < Math.min(maxPrefix, len1, len2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function analysePairSimilarityScore(a, b) {
  let max = 0;
  const consider = (n1, n2) => {
    if (!n1 || !n2 || n1.length < 4 || n2.length < 4) return;
    if (Math.abs(n1.length - n2.length) >= 6) return;
    const s = jaroWinkler(n1, n2);
    if (s > max) max = s;
  };
  consider(a.normDisplay, b.normDisplay);
  consider(a.normAccount, b.normAccount);
  consider(a.normDisplay, b.normAccount);
  consider(a.normAccount, b.normDisplay);
  return max;
}

function addAnalyseMemberToBuckets(buckets, p) {
  const push = (norm) => {
    if (!norm || norm.length < 4) return;
    const k = norm.slice(0, 4);
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    if (!arr.some((x) => x.userId === p.userId)) arr.push(p);
  };
  if (p.normDisplay.length >= 4) push(p.normDisplay);
  if (p.normAccount.length >= 4) {
    if (p.normDisplay.length < 4 || p.normAccount.slice(0, 4) !== p.normDisplay.slice(0, 4)) push(p.normAccount);
  }
}

function makeAnalysePseudoEmbedPage({ guild, groupsPage, page, totalPages, totalGroups, minScore }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(guild.client))
    .setTitle('Analyse pseudos')
    .setDescription(`Seuil **${Math.round(minScore * 100)}%** • groupes **${totalGroups}**\nPage **${page + 1}/${totalPages}**`)
    .setFooter(getBotFooter(guild.client, {}));

  if (groupsPage.length === 0) {
    embed.addFields({ name: 'Résultat', value: 'Aucun groupe suspect trouvé avec ce seuil.', inline: false });
    return embed;
  }

  for (const g of groupsPage) {
    const lines = g.members
      .slice(0, 10)
      .map((m) => {
        const handle = String(m.accountName ?? '—').replace(/`/g, '′');
        return `- <@${m.userId}> — \`${handle}\``;
      })
      .join('\n');
    const more = g.members.length > 10 ? `\n… +${g.members.length - 10} autre(s)` : '';
    embed.addFields({
      name: `Score max: ${Math.round(g.maxScore * 100)}% • ${g.members.length} membre(s)`,
      value: lines + more,
      inline: false,
    });
  }
  return embed;
}

function buildAnalyseButtons(token, page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`analyse_${token}_prev_${page}`)
      .setLabel('◀️ Précédent')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`analyse_${token}_next_${page}`)
      .setLabel('Suivant ▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

export function isAnalyseButton(customId) {
  return typeof customId === 'string' && customId.startsWith('analyse_');
}

export async function handleAnalyseButton(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({
      content: '❌ `/analyse` est réservée aux **modérateurs** et aux **administrateurs**.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferUpdate();
  const parts = String(interaction.customId).split('_');
  const token = parts[1];
  const dir = parts[2];
  const page = parseInt(parts[3], 10) || 0;

  const cached = analyseCache.get(token);
  if (!cached || Date.now() - cached.createdAt > ANALYSE_CACHE_TTL_MS) {
    analyseCache.delete(token);
    return interaction.editReply({ content: '⏱️ Analyse expirée. Relance `/analyse`.', embeds: [], components: [] }).catch(() => {});
  }
  const totalPages = cached.pages.length;
  const newPage = dir === 'next' ? Math.min(totalPages - 1, page + 1) : Math.max(0, page - 1);
  const payload = cached.pages[newPage];
  const row = buildAnalyseButtons(token, newPage, totalPages);
  return interaction.editReply({ embeds: [payload.embed], components: [row], allowedMentions: { parse: [] } });
}

export const moderationCommands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Bannir un utilisateur du serveur (mention ou ID, même hors serveur).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('utilisateur').setDescription('@membre ou ID Discord (y compris hors serveur)').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du ban').setRequired(true).setMaxLength(500))
    .addStringOption((o) =>
      o
        .setName('supprimer_messages')
        .setDescription('Supprimer les messages de l’utilisateur sur le serveur (optionnel)')
        .setRequired(false)
        .addChoices(
          { name: 'Aucun', value: '0' },
          { name: 'Dernières 24 heures', value: '86400' },
          { name: 'Derniers 3 jours', value: '259200' },
          { name: 'Derniers 7 jours', value: '604800' }
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Débannir un utilisateur par son ID Discord.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('utilisateur').setDescription('ID Discord de l’utilisateur à débannir').setRequired(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du unban').setRequired(true).setMaxLength(500))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Donner un avertissement à un utilisateur')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('utilisateur').setDescription('@membre ou ID Discord').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison (texte libre, max 500 car.)').setRequired(true).setMaxLength(500))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Retirer un avertissement d’un utilisateur (sélection + raison).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((o) => o.setName('utilisateur').setDescription('Mention (@utilisateur) ou ID Discord').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('raison').setDescription('Raison du retrait').setRequired(true).setMaxLength(500))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('analyse')
    .setDescription('Analyser les pseudos similaires (modération)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .toJSON(),
];

export async function handleMemberAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'utilisateur') return;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.respond([]).catch(() => {});
    return;
  }
  const query = (focused.value || '').trim();
  if (query.length < 2) {
    await interaction.respond([]).catch(() => {});
    return;
  }
  try {
    const members = await guild.members.search({ query, limit: 25 });
    const choices = members.map((m) => {
      const displayName = m.nickname || m.user.globalName || m.user.username;
      return { name: displayName.slice(0, 100), value: m.user.id };
    });
    await interaction.respond(choices);
  } catch (_) {
    await interaction.respond([]).catch(() => {});
  }
}

export async function sendBanAppealDmToBannedUser(client, guild, userId, reason, bannedAt) {
  const motive = String(reason || 'Non précisée').slice(0, 1700);
  const footerDate = bannedAt != null ? bannedAt : new Date();
  try {
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setColor(COLOR_SANCTION)
      .setAuthor(getBotAuthor(client))
      .setTitle('Bannissement')
      .setDescription(`Vous avez été banni pour la raison suivante :\n\n**${motive}**`)
      .setFooter(getBotFooter(client, { date: footerDate }));
    const guildIcon = guild.iconURL({ extension: 'png', size: 256 });
    if (guildIcon) embed.setThumbnail(guildIcon);
    await user.send({ embeds: [embed] });
    console.log(`[Péché Mignon] MP ban envoyé à l'utilisateur ${userId}.`);
  } catch (err) {
    if (err?.code === 50007) {
      console.warn(`[Péché Mignon] MP ban impossible (DMs fermés) pour ${userId}.`);
      return;
    }
    console.warn(`[Péché Mignon] MP ban échoué pour ${userId}:`, err?.message || err);
  }
}

function buildBanSignalementEmbed(client, { userId, reason, moderatorId, bannedAt, avatarURL, updated = false }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(client))
    .setTitle('🚨 Signalement')
    .setDescription(
      updated
        ? `Fiche mise à jour et banni par <@${moderatorId}>`
        : `Banni par <@${moderatorId}>`
    )
    .addFields(
      { name: 'Utilisateur banni', value: `<@${userId}> (ID: ${userId})`, inline: true },
      { name: 'Motif du ban', value: reason || 'Non précisée', inline: false },
      { name: 'Date et heure', value: formatBanDate(bannedAt || new Date().toISOString()), inline: false }
    )
    .setFooter(getBotFooter(client, { date: bannedAt || new Date() }));
  if (avatarURL) embed.setThumbnail(avatarURL);
  return embed;
}

export async function sendBanSignalement(client, options) {
  const channelId = config.banLogChannelId;
  if (!channelId) return { posted: false };
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) {
      console.warn(`[Péché Mignon] Salon signalements introuvable: ${channelId}`);
      return { posted: false };
    }
    const embed = buildBanSignalementEmbed(client, options);
    const message = await channel.send({
      content: '🚨 Un nouveau signalement vient d’être enregistré.',
      embeds: [embed],
    });

    const thread = await createBanProofThread(message, options.userId);
    const guildId = options.guildId || message.guild?.id;
    await persistProofThreadLink({
      userId: options.userId,
      guildId,
      proofGuildId: message.guild?.id || guildId,
      proofChannelId: message.channel?.id || channel.id,
      proofMessageId: message.id,
      proofThreadId: thread?.id || null,
    });

    if (!thread) {
      console.warn(`[Péché Mignon] Signalement posté sans fil de preuves (user ${options.userId}).`);
    }

    return { posted: true, threadId: thread?.id || null, messageId: message.id };
  } catch (err) {
    console.warn(`[Péché Mignon] Envoi signalement ban échoué:`, err?.message || err);
    return { posted: false };
  }
}

export async function handleBan(interaction) {
  const formatBanApiError = (err) => {
    const code = err?.code ?? err?.rawError?.code;
    if (code === 10013) return 'Utilisateur introuvable : cet ID n’existe pas, ou le compte a été supprimé.';
    if (code === 10026) return 'Action impossible sur ce ban (ban inconnu côté Discord).';
    if (code === 50013 || code === 50001) return 'Je n’ai pas les permissions nécessaires pour bannir cet utilisateur sur ce serveur.';
    if (code === 50035) return String(err?.message || 'Requête refusée par Discord.').slice(0, 300);
    return String(err?.message || 'Erreur inconnue').slice(0, 300);
  };

  const replyBanError = async (content) => {
    const payload = { content, flags: MessageFlags.Ephemeral };
    if (!interaction.deferred && !interaction.replied) {
      await interaction.reply(payload).catch(() => {});
      return;
    }
    try {
      await interaction.followUp(payload);
    } catch (_) {
      await interaction.editReply({ content, embeds: [] }).catch(() => {});
    }
  };

  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
    if (!rl.allowed) {
      return replyBanError(`⏱️ Trop de requêtes. Réessaie dans ${Math.ceil(rl.retryAfterMs / 1000)} secondes.`);
    }
    if (!(await hasAdminRole(interaction))) {
      return replyBanError('❌ Tu n’as pas le droit d’utiliser cette commande.');
    }

    const utilisateurRaw = (interaction.options.getString('utilisateur') || '').trim();
    const reasonRaw = sanitizeReason(interaction.options.getString('raison'));
    const reason = resolveReasonToFullTag(reasonRaw) || reasonRaw;
    const deleteMessageSeconds = parseInt(interaction.options.getString('supprimer_messages') || '0', 10) || 0;
    const userId = parseUserIdFromOption(utilisateurRaw);

    if (!userId) {
      return replyBanError('❌ **Utilisateur** invalide. Indique @membre ou un ID Discord (17–20 chiffres), même s’il n’est plus sur le serveur.');
    }

    const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    if (!me) throw new Error('Impossible de récupérer les permissions du bot sur ce serveur.');
    if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
      throw new Error("Le bot n'a pas la permission **Bannir des membres** sur ce serveur.");
    }

    const targetMember = await guild.members.fetch(userId).catch(() => null);
    if (targetMember && me.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
      throw new Error('Je ne peux pas bannir cet utilisateur: mon rôle est inférieur ou égal au sien.');
    }

    let bannedAvatarURL = null;
    try {
      const fetched = await interaction.client.users.fetch(userId);
      bannedAvatarURL = fetched.displayAvatarURL({ size: 128 });
    } catch (_) {}

    const moderatorPseudo = interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username ?? interaction.user.id;
    const existing = await getBannedUser(userId, guild.id);
    const existingGuildBan = await guild.bans.fetch(userId).catch(() => null);

    if (existingGuildBan) {
      try {
        await guild.members.unban(userId);
      } catch (_) {}
    }

    registerPendingSlashBan(userId);
    try {
      await guild.members.ban(userId, { reason: buildBanReasonForDiscord(reason, moderatorPseudo), deleteMessageSeconds });
    } catch (e) {
      clearPendingSlashBan(userId);
      throw e;
    }

    if (existing) {
      await updateBannedUser(userId, guild.id, reason, interaction.user.id);
    } else {
      await addBannedUser(userId, reason, interaction.user.id, guild.id);
    }
    const inserted = await getBannedUser(userId, guild.id);
    await sendBanAppealDmToBannedUser(interaction.client, guild, userId, reason, inserted?.banned_at);

    const signalement = {
      userId,
      guildId: guild.id,
      reason,
      moderatorId: interaction.user.id,
      bannedAt: inserted?.banned_at || new Date(),
      avatarURL: bannedAvatarURL,
      updated: Boolean(existing || existingGuildBan),
    };
    const result = await sendBanSignalement(interaction.client, signalement);
    const embed = buildBanSignalementEmbed(interaction.client, signalement);
    const content = result?.posted
      ? `Signalement publié dans <#${config.banLogChannelId}>.`
      : '⚠️ Ban effectué, mais le salon de signalements est inaccessible.';

    return interaction.editReply({ content, embeds: [embed] });
  } catch (err) {
    console.error("[Péché Mignon] Erreur handleBan:", err);
    return replyBanError(`❌ ${formatBanApiError(err)}`);
  }
}

export async function handleUnban(interaction) {
  const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
  if (!rl.allowed) return replyRateLimited(interaction, rl.retryAfterMs);
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({ content: '❌ Tu n’as pas le droit d’utiliser cette commande.', flags: MessageFlags.Ephemeral });
  }

  const userId = (interaction.options.getString('utilisateur') || '').trim();
  const reason = sanitizeReason(interaction.options.getString('raison'));
  if (!reason) {
    return interaction.reply({ content: '❌ Une raison est obligatoire.', flags: MessageFlags.Ephemeral });
  }
  if (!isValidDiscordId(userId)) {
    return interaction.reply({
      content: '❌ ID invalide. Un ID Discord contient 17 à 20 chiffres.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
    }

    await guild.members.unban(userId, reason || `Unban via ${config.embedBrand}`);
    await removeBannedUser(userId, guild.id);

    let unbannedAvatarURL = null;
    try {
      const fetched = await interaction.client.users.fetch(userId);
      unbannedAvatarURL = fetched.displayAvatarURL({ size: 128 });
    } catch (_) {}

    const embed = new EmbedBuilder()
      .setColor(COLOR_SANCTION)
      .setAuthor(getBotAuthor(interaction.client))
      .setTitle('Utilisateur débanni')
      .setDescription(`Débanni par <@${interaction.user.id}>`)
      .addFields(
        { name: 'Utilisateur', value: `<@${userId}> (ID: \`${userId}\`)`, inline: true },
        { name: 'Par', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Raison du débannissement', value: reason, inline: false }
      )
      .setFooter(getBotFooter(interaction.client, { date: new Date() }));
    if (unbannedAvatarURL) embed.setThumbnail(unbannedAvatarURL);

    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    return interaction.reply({
      content: `❌ Erreur lors du unban: ${err.message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleWarn(interaction) {
  const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
  if (!rl.allowed) return replyRateLimited(interaction, rl.retryAfterMs);
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({ content: '❌ Tu n’as pas le droit d’utiliser cette commande.', flags: MessageFlags.Ephemeral });
  }

  const utilisateurRaw = interaction.options.getString('utilisateur').trim();
  const reasonSan = sanitizeReason(interaction.options.getString('raison'));
  const reason = resolveReasonToFullTag(reasonSan) || reasonSan || 'Non précisée';
  const userId = parseUserIdFromOption(utilisateurRaw);

  if (!userId) {
    return interaction.reply({
      content: '❌ **Utilisateur** invalide. Indique @membre ou un ID Discord.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: '❌ Cette commande est utilisable uniquement sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let userAvatarURL = null;
  try {
    const fetched = await interaction.client.users.fetch(userId);
    userAvatarURL = fetched.displayAvatarURL({ size: 128 });
  } catch (_) {}

  await addAvertissement(userId, reason, interaction.user.id, guild.id);
  const count = await getAvertissementCount(userId, guild.id);

  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(interaction.client))
    .setTitle('Avertissement enregistré')
    .setDescription(`Averti par <@${interaction.user.id}>`)
    .addFields(
      { name: 'Utilisateur', value: `<@${userId}> (ID: ${userId})`, inline: true },
      { name: 'Par', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Raison', value: reason, inline: false },
      { name: 'Nombre d’avertissements', value: `${count} avertissement(s) pour cet utilisateur`, inline: false }
    )
    .setFooter(getBotFooter(interaction.client, { date: new Date() }));
  if (userAvatarURL) embed.setThumbnail(userAvatarURL);

  return interaction.reply({
    embeds: [embed],
    allowedMentions: { users: [userId] },
  });
}

const unwarnReasonByInteraction = new Map();

export async function handleUnwarn(interaction) {
  const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
  if (!rl.allowed) return replyRateLimited(interaction, rl.retryAfterMs);
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({ content: '❌ Tu n’as pas le droit d’utiliser cette commande.', flags: MessageFlags.Ephemeral });
  }

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: '❌ Cette commande est utilisable uniquement sur un serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const raw = interaction.options.getString('utilisateur').trim();
  const userId = parseUserIdFromOption(raw);
  const reason = sanitizeReason(interaction.options.getString('raison'));
  if (!reason) {
    return interaction.reply({ content: '❌ Une raison est obligatoire.', flags: MessageFlags.Ephemeral });
  }

  if (!userId) {
    return interaction.reply({
      content: '❌ Utilisateur invalide. Indique une mention (@utilisateur) ou un ID Discord.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const list = await listAvertissementsForUser(userId, guild.id);
  if (list.length === 0) {
    return interaction.reply({
      content: `❌ <@${userId}> n’a aucun avertissement sur ce serveur.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const token = crypto.randomBytes(8).toString('hex');
  unwarnReasonByInteraction.set(token, { reason, userId, guildId: guild.id, createdAt: Date.now() });
  setTimeout(() => unwarnReasonByInteraction.delete(token), 10 * 60 * 1000).unref?.();

  const options = list.slice(0, 25).map((a, i) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`${i + 1}. ${(a.reason || '—').slice(0, 90)}`)
      .setValue(String(i + 1))
      .setDescription(formatBanDate(a.created_at))
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`unwarn_${userId}_${guild.id}_${token}`)
    .setPlaceholder("Sélectionne l'avertissement à retirer…")
    .addOptions(options);

  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(interaction.client))
    .setTitle('Retirer un avertissement')
    .setDescription(
      `Avertissements de <@${userId}> (ID: ${userId}) sur ce serveur.\nRaison du retrait : **${reason}**\nChoisis celui à retirer ci-dessous.`
    )
    .setFooter(
      getBotFooter(interaction.client, list.length > 5 ? { extra: `${list.length} avertissement(s) au total • Sélectionne dans le menu` } : {})
    );
  for (let i = 0; i < Math.min(list.length, 5); i++) {
    const a = list[i];
    embed.addFields({
      name: `${i + 1}. ${(a.reason || '—').slice(0, 256)}`,
      value: formatBanDate(a.created_at),
      inline: false,
    });
  }

  return interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
  });
}

export function isUnwarnSelect(customId) {
  return typeof customId === 'string' && customId.startsWith('unwarn_');
}

export async function handleUnwarnSelect(interaction) {
  const parts = interaction.customId.split('_');
  const userId = parts[1];
  const guildId = parts[2];
  const token = parts[3];
  const value = interaction.values[0];
  const index = parseInt(value, 10);
  if (!userId || !guildId || !value || index < 1) {
    return interaction.update({ content: '❌ Sélection invalide.', components: [] }).catch(() => {});
  }

  const stored = token ? unwarnReasonByInteraction.get(token) : null;
  const unwarnReason = stored?.reason || 'Non précisée';

  const list = await listAvertissementsForUser(userId, guildId);
  if (index > list.length) {
    return interaction.update({ content: "❌ Cet avertissement n'existe plus.", components: [] }).catch(() => {});
  }

  const avert = list[index - 1];
  const result = await deleteAvertissementById(avert.id, guildId);
  if (result.changes === 0) {
    return interaction.update({ content: '❌ Erreur lors de la suppression.', components: [] }).catch(() => {});
  }
  if (token) unwarnReasonByInteraction.delete(token);

  const count = await getAvertissementCount(userId, guildId);
  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(interaction.client))
    .setTitle('Avertissement retiré')
    .addFields(
      { name: 'Utilisateur', value: `<@${userId}> (ID: ${userId})`, inline: false },
      { name: 'Avertissement retiré', value: `${avert.reason || '—'} (${formatBanDate(avert.created_at)})`, inline: false },
      { name: 'Raison du retrait', value: unwarnReason, inline: false },
      { name: 'Avertissements restants', value: `${count} avertissement(s) pour cet utilisateur`, inline: false }
    )
    .setFooter(getBotFooter(interaction.client, { date: avert.created_at }));
  return interaction.update({ embeds: [embed], components: [] });
}

export async function handleAnalyse(interaction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  if (!(await hasAdminRole(interaction))) {
    return interaction.reply({
      content: '❌ `/analyse` est réservée aux **modérateurs** et aux **administrateurs**.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const minScore = 0.92;
  await interaction.deferReply();

  let members = [];
  try {
    const fetched = await guild.members.fetch({ force: true });
    members = [...fetched.values()];
  } catch (e) {
    try {
      const fetched = await guild.members.fetch();
      members = [...fetched.values()];
    } catch (_) {
      members = [...guild.members.cache.values()];
    }
  }

  if (members.length === 0) {
    return interaction.editReply({
      content:
        '❌ Impossible de récupérer la liste des membres. Vérifie l’intent **Server Members** dans le Developer Portal (comme sur Eden).',
    });
  }

  const pool = members
    .filter((m) => !m.user?.bot)
    .map((m) => {
      const displayName = m.displayName || m.nickname || m.user?.globalName || m.user?.username || m.user?.id || '—';
      const accountName = m.user?.username || m.user?.id || '—';
      return {
        userId: m.user.id,
        displayName,
        accountName,
        normDisplay: normForPseudoSimilarity(displayName),
        normAccount: normForPseudoSimilarity(accountName),
      };
    })
    .filter((x) => x.normDisplay.length >= 4 || x.normAccount.length >= 4);

  const buckets = new Map();
  for (const p of pool) addAnalyseMemberToBuckets(buckets, p);

  const parent = new Map();
  const find = (id) => {
    let x = parent.get(id) ?? id;
    if (x !== id) {
      x = find(x);
      parent.set(id, x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const p of pool) parent.set(p.userId, p.userId);
  const pairMaxScore = new Map();

  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > 300) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i];
        const b = arr[j];
        const score = analysePairSimilarityScore(a, b);
        if (score >= minScore) {
          union(a.userId, b.userId);
          const key = a.userId < b.userId ? `${a.userId}:${b.userId}` : `${b.userId}:${a.userId}`;
          const prev = pairMaxScore.get(key) ?? 0;
          if (score > prev) pairMaxScore.set(key, score);
        }
      }
    }
  }

  const groupsMap = new Map();
  for (const p of pool) {
    const r = find(p.userId);
    const g = groupsMap.get(r);
    if (g) g.push(p);
    else groupsMap.set(r, [p]);
  }

  const currentIds = new Set(pool.map((m) => m.userId));
  const groupsFiltered = [];
  for (const membersArr of groupsMap.values()) {
    const mems = membersArr.filter((m) => currentIds.has(m.userId));
    if (mems.length < 2) continue;
    let maxScoreF = 0;
    for (let i = 0; i < mems.length; i++) {
      for (let j = i + 1; j < mems.length; j++) {
        const s = analysePairSimilarityScore(mems[i], mems[j]);
        if (s > maxScoreF) maxScoreF = s;
      }
    }
    if (maxScoreF < minScore) continue;
    groupsFiltered.push({ members: mems, maxScore: maxScoreF });
  }

  groupsFiltered.sort((a, b) => b.maxScore - a.maxScore || b.members.length - a.members.length);

  const pageSize = 4;
  const totalGroups = groupsFiltered.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / pageSize));
  const pages = [];
  for (let page = 0; page < totalPages; page++) {
    const slice = groupsFiltered.slice(page * pageSize, page * pageSize + pageSize).map((g) => ({
      members: g.members.map((m) => ({ userId: m.userId, accountName: m.accountName })),
      maxScore: g.maxScore,
    }));
    const embed = makeAnalysePseudoEmbedPage({
      guild,
      groupsPage: slice,
      page,
      totalPages,
      totalGroups,
      minScore,
    });
    pages.push({ embed });
  }

  const token = crypto.randomUUID();
  analyseCache.set(token, { createdAt: Date.now(), pages });
  setTimeout(() => analyseCache.delete(token), ANALYSE_CACHE_TTL_MS).unref?.();

  const row = buildAnalyseButtons(token, 0, pages.length);
  return interaction.editReply({
    embeds: [pages[0].embed],
    components: pages.length > 1 ? [row] : [],
    allowedMentions: { parse: [] },
  });
}
