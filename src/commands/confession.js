import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ThreadAutoArchiveDuration,
  escapeMarkdown,
} from 'discord.js';
import { config } from '../config.js';
import {
  upsertConfessionLogConfig,
  removeConfessionLogConfig,
  clearAllConfessionLogConfigsForGuild,
  listConfessionLogConfigsForGuild,
  findConfessionLogConfig,
  incrementConfessionNumber,
} from '../database.js';
import { checkRateLimit } from '../rateLimit.js';
import { COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';
import { canCloseTicket } from '../permissions.js';

function replyRateLimited(interaction, retryAfterMs) {
  return interaction.reply({
    content: `⏱️ Trop de requêtes. Réessaie dans ${Math.ceil(retryAfterMs / 1000)} secondes.`,
    flags: MessageFlags.Ephemeral,
  });
}

function sanitizeAttachmentName(name) {
  return String(name || 'image')
    .replace(/[^\w.\-()[\] ]+/g, '_')
    .slice(0, 120);
}

async function sendConfessionStaffLog({
  client,
  guild,
  cfg,
  user,
  body,
  channelId,
  messageId,
  originChannelLabel,
  embedTitle = null,
  imageUrl = null,
  logContext = 'confession',
}) {
  const logCh = await client.channels.fetch(cfg.logChannelId).catch(() => null);
  if (!logCh?.isTextBased?.()) return;

  const msgUrl = `https://discord.com/channels/${guild.id}/${channelId}/${messageId}`;
  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setDescription(body)
    .setThumbnail(user.displayAvatarURL({ size: 256, extension: 'png', forceStatic: false }))
    .addFields({ name: 'Auteur', value: `<@${user.id}>`, inline: false })
    .setFooter(getBotFooter(client, { extra: `Salon d’origine : #${originChannelLabel}` }));
  if (embedTitle) embed.setTitle(embedTitle);
  if (imageUrl) embed.setImage(imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Voir le message').setURL(msgUrl).setEmoji('🔗')
  );

  try {
    await logCh.send({
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [user.id] },
    });
  } catch (err) {
    console.error(`[Péché Mignon] /${logContext} log staff:`, err?.message || err);
  }
}

export const confessionCommands = [
  new SlashCommandBuilder()
    .setName('confession')
    .setDescription('Publier une confession anonyme.')
    .setDefaultMemberPermissions(null)
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('texte').setDescription('Texte de la confession (obligatoire)').setRequired(true).setMaxLength(4096)
    )
    .addAttachmentOption((o) =>
      o.setName('image').setDescription('Image optionnelle, en plus du texte (pas d’image seule)').setRequired(false)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('confession-reponse')
    .setNameLocalizations({ fr: 'confession-réponse' })
    .setDescription('Répondre anonymement dans le fil d’une confession.')
    .setDescriptionLocalizations({ fr: 'Répondre anonymement dans le fil d’une confession.' })
    .setDefaultMemberPermissions(null)
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName('texte').setDescription('Texte de la réponse (obligatoire)').setRequired(true).setMaxLength(4096)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('confession-log')
    .setDescription('Configurer les logs staff des confessions.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName('configurer')
        .setDescription('Définir le salon des confessions et le salon des logs staff')
        .addChannelOption((o) =>
          o
            .setName('salon_source')
            .setDescription('Salon où /confession est autorisé')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
        .addChannelOption((o) =>
          o
            .setName('salon_logs')
            .setDescription('Salon staff : auteur réel de chaque confession')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('retirer')
        .setDescription('Retirer la config pour un salon de confessions')
        .addChannelOption((o) =>
          o
            .setName('salon_source')
            .setDescription('Salon de confessions à retirer')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('desactiver').setDescription('Désactiver toutes les paires confession-log sur ce serveur')
    )
    .toJSON(),
];

export async function handleConfessionLog(interaction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  if (!(await canCloseTicket(interaction))) {
    return interaction.reply({
      content: '❌ Réservé aux **administrateurs** et au **propriétaire** du serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'desactiver') {
    await clearAllConfessionLogConfigsForGuild(guild.id);
    return interaction.reply({
      content: '✅ Toutes les paires **confession-log** ont été désactivées sur ce serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'retirer') {
    const source = interaction.options.getChannel('salon_source');
    if (!source?.id) {
      return interaction.reply({ content: '❌ Salon source invalide.', flags: MessageFlags.Ephemeral });
    }
    const cfg = await findConfessionLogConfig(guild.id, source.id);
    if (!cfg) {
      return interaction.reply({ content: 'ℹ️ Aucune config confession pour ce salon source.', flags: MessageFlags.Ephemeral });
    }
    await removeConfessionLogConfig(guild.id, source.id);
    const rest = await listConfessionLogConfigsForGuild(guild.id);
    const suffix = rest.length > 0 ? `\nIl reste **${rest.length}** paire(s) configurée(s).` : '\nAucune paire restante.';
    return interaction.reply({
      content: `✅ **confession-log** retiré pour ${source} (logs : <#${cfg.logChannelId}>).${suffix}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub !== 'configurer') {
    return interaction.reply({ content: '❌ Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
  }

  const source = interaction.options.getChannel('salon_source');
  const logs = interaction.options.getChannel('salon_logs');
  if (!source?.id || !logs?.id) {
    return interaction.reply({ content: '❌ Salons invalides.', flags: MessageFlags.Ephemeral });
  }
  if (!source.isTextBased?.() || !logs.isTextBased?.()) {
    return interaction.reply({ content: '❌ Utilise des salons texte ou annonces.', flags: MessageFlags.Ephemeral });
  }
  if (source.id === logs.id) {
    return interaction.reply({
      content: '❌ Le salon des confessions et le salon des logs doivent être **différents**.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return interaction.reply({ content: '❌ Impossible de vérifier les permissions du bot.', flags: MessageFlags.Ephemeral });
  }

  const permsSource = me.permissionsIn(source);
  if (
    !permsSource.has(PermissionFlagsBits.ViewChannel) ||
    !permsSource.has(PermissionFlagsBits.SendMessages) ||
    !permsSource.has(PermissionFlagsBits.EmbedLinks)
  ) {
    return interaction.reply({
      content:
        '❌ Le bot doit pouvoir **voir** le salon des confessions, **y envoyer des messages** et **intégrer des liens** (embeds).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const permsLog = me.permissionsIn(logs);
  if (!permsLog.has(PermissionFlagsBits.ViewChannel) || !permsLog.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({
      content: '❌ Le bot doit pouvoir **voir** et **envoyer des messages** dans le salon des logs.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await upsertConfessionLogConfig(guild.id, source.id, logs.id);

  return interaction.reply({
    content:
      `✅ **confession-log configuré.**\n` +
      `• **${source}** : les membres peuvent utiliser \`/confession\` ici et \`/confession-réponse\` dans les fils ; seules les **confessions** et **réponses** sont enregistrées dans **${logs}** avec l’auteur réel.\n` +
      `• \`/confession-log retirer\` pour une paire • \`/confession-log desactiver\` pour tout arrêter.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleConfession(interaction) {
  const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
  if (!rl.allowed) return replyRateLimited(interaction, rl.retryAfterMs);

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  const channel = interaction.channel;
  if (!channel?.isTextBased?.()) {
    return interaction.reply({ content: '❌ Utilise cette commande dans un salon texte.', flags: MessageFlags.Ephemeral });
  }

  const text = (interaction.options.getString('texte') || '').trim();
  const image = interaction.options.getAttachment('image');
  const imageUrl = image?.url || '';

  if (!text) {
    return interaction.reply({
      content: '❌ Indique le **texte** de la confession (obligatoire).',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (image) {
    const ct = image.contentType || '';
    if (ct && !ct.startsWith('image/')) {
      return interaction.reply({
        content: '❌ L’option **image** doit être un fichier image (png, jpg, gif, webp…).',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (_) {}

  const cfg = await findConfessionLogConfig(guild.id, channel.id);
  if (!cfg) {
    return interaction.editReply({
      content:
        '❌ Ce salon n’est pas configuré pour `/confession`. Demande au staff d’utiliser `/confession-log configurer`.',
    });
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return interaction.editReply({ content: '❌ Impossible de vérifier les permissions du bot.' });
  }
  const permsHere = me.permissionsIn(channel);
  if (
    !permsHere.has(PermissionFlagsBits.ViewChannel) ||
    !permsHere.has(PermissionFlagsBits.SendMessages) ||
    !permsHere.has(PermissionFlagsBits.EmbedLinks)
  ) {
    return interaction.editReply({
      content:
        '❌ Je dois pouvoir **voir** ce salon, **envoyer des messages** et **intégrer des liens** (embeds) pour publier la confession.',
    });
  }
  if (imageUrl && !permsHere.has(PermissionFlagsBits.AttachFiles)) {
    return interaction.editReply({
      content: '❌ Pour publier une confession avec **image**, j’ai besoin de la permission **joindre des fichiers**.',
    });
  }

  let confessionNo = 0;
  try {
    confessionNo = await incrementConfessionNumber(guild.id, channel.id);
  } catch (e) {
    console.error("[Péché Mignon] /confession numéro:", e?.message || e);
  }

  const confessionBody = escapeMarkdown(text.slice(0, 4096));
  const fileName = imageUrl ? sanitizeAttachmentName(image?.name) : '';

  let sent;
  try {
    const publicEmbed = new EmbedBuilder()
      .setColor(COLOR_OTHER)
      .setAuthor(getBotAuthor(interaction.client))
      .setDescription(confessionBody)
      .setFooter(getBotFooter(interaction.client, { extra: 'Confession', date: new Date() }));
    if (confessionNo > 0) publicEmbed.setTitle(`Confession n°${confessionNo}`);
    if (imageUrl) {
      publicEmbed.setImage(`attachment://${fileName}`);
      sent = await channel.send({
        embeds: [publicEmbed],
        files: [{ attachment: imageUrl, name: fileName }],
        allowedMentions: { parse: [] },
      });
    } else {
      sent = await channel.send({
        embeds: [publicEmbed],
        allowedMentions: { parse: [] },
      });
    }
  } catch (e) {
    console.error("[Péché Mignon] /confession envoi:", e?.message || e);
    return interaction.editReply({ content: `❌ Impossible d’envoyer la confession : ${e?.message || 'erreur'}` });
  }

  try {
    const threadName = (confessionNo > 0 ? `Confession n°${confessionNo} — fil` : 'Confession — fil').slice(0, 100);
    await sent.startThread({
      name: threadName,
      reason: 'Fil de discussion lié à une confession.',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
  } catch (e) {
    console.warn("[Péché Mignon] /confession fil: création impossible:", e?.message || e);
  }

  const originChannelLabel = (channel.name || 'salon inconnu').slice(0, 200);
  await sendConfessionStaffLog({
    client: interaction.client,
    guild,
    cfg,
    user: interaction.user,
    body: confessionBody,
    channelId: channel.id,
    messageId: sent.id,
    originChannelLabel,
    embedTitle: confessionNo > 0 ? `Confession n°${confessionNo}` : null,
    imageUrl: imageUrl || null,
    logContext: 'confession',
  });

  try {
    await interaction.deleteReply().catch(() => {});
  } catch (_) {}
}

export async function handleConfessionReponse(interaction) {
  const rl = checkRateLimit(interaction.user.id, config.rateLimitPerMinute);
  if (!rl.allowed) return replyRateLimited(interaction, rl.retryAfterMs);

  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }

  const channel = interaction.channel;
  if (!channel?.isThread?.()) {
    return interaction.reply({
      content: '❌ Utilise `/confession-réponse` **dans le fil** d’une confession (pas dans le salon principal).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const text = (interaction.options.getString('texte') || '').trim();
  if (!text) {
    return interaction.reply({
      content: '❌ Indique le **texte** de ta réponse (obligatoire).',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (_) {}

  const sourceChannelId = channel.parentId;
  const cfg = sourceChannelId ? await findConfessionLogConfig(guild.id, sourceChannelId) : null;
  if (!cfg) {
    return interaction.editReply({
      content:
        '❌ Ce fil n’est pas lié à un salon configuré pour `/confession`. Demande au staff d’utiliser `/confession-log configurer`.',
    });
  }

  const botId = interaction.client.user?.id;
  let starter;
  try {
    starter = await channel.fetchStarterMessage().catch(() => null);
  } catch (_) {
    starter = null;
  }
  if (!starter?.author?.id || starter.author.id !== botId) {
    return interaction.editReply({
      content: '❌ Utilise `/confession-réponse` uniquement dans le **fil d’une confession** publiée via `/confession`.',
    });
  }

  const confessionTitle = starter.embeds?.[0]?.title?.trim() || null;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) {
    return interaction.editReply({ content: '❌ Impossible de vérifier les permissions du bot.' });
  }
  const permsHere = me.permissionsIn(channel);
  if (
    !permsHere.has(PermissionFlagsBits.ViewChannel) ||
    !permsHere.has(PermissionFlagsBits.SendMessages) ||
    !permsHere.has(PermissionFlagsBits.EmbedLinks)
  ) {
    return interaction.editReply({
      content:
        '❌ Je dois pouvoir **voir** ce fil, **envoyer des messages** et **intégrer des liens** (embeds) pour publier la réponse.',
    });
  }

  const replyBody = escapeMarkdown(text.slice(0, 4096));

  let sent;
  try {
    const publicEmbed = new EmbedBuilder()
      .setColor(COLOR_OTHER)
      .setAuthor(getBotAuthor(interaction.client))
      .setDescription(replyBody)
      .setFooter(getBotFooter(interaction.client, { extra: 'Confession', date: new Date() }));
    sent = await channel.send({
      embeds: [publicEmbed],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    console.error("[Péché Mignon] /confession-réponse envoi:", e?.message || e);
    return interaction.editReply({ content: `❌ Impossible d’envoyer la réponse anonyme : ${e?.message || 'erreur'}` });
  }

  const sourceChannel = sourceChannelId ? await interaction.client.channels.fetch(sourceChannelId).catch(() => null) : null;
  const originChannelLabel = (sourceChannel?.name || 'salon inconnu').slice(0, 200);

  await sendConfessionStaffLog({
    client: interaction.client,
    guild,
    cfg,
    user: interaction.user,
    body: replyBody,
    channelId: channel.id,
    messageId: sent.id,
    originChannelLabel,
    embedTitle: confessionTitle,
    logContext: 'confession-réponse',
  });

  try {
    await interaction.deleteReply().catch(() => {});
  } catch (_) {}
}
