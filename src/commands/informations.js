import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  AttachmentBuilder,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';
import { canCloseTicket } from '../permissions.js';
import { config } from '../config.js';

const THUMBNAIL_NAME = 'informations-thumbnail.png';
const THUMBNAIL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', THUMBNAIL_NAME);

function roleMention(id) {
  return id ? `<@&${id}>` : '';
}

function sectionTitle(title) {
  return `✦ **__${title}__**`;
}

function buildInformationsEmbed(client) {
  const sakura = config.reglementSakuraEmoji;
  const level1 = roleMention(config.infoLevel1RoleId);
  const level5 = roleMention(config.infoLevel5RoleId);

  return new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setThumbnail(`attachment://${THUMBNAIL_NAME}`)
    .setDescription(
      [
        `${sakura} **__Informations — ${config.embedBrand}__** ${sakura}`,
        '',
        sectionTitle('✨ Niveaux & avantages'),
        '',
        'Votre activité sur le serveur vous permet de débloquer progressivement de nouveaux avantages !',
        '',
        `${sectionTitle('🔊 Niveau 1')}${level1 ? `  ${level1}` : ''}`,
        '',
        'Vous débloquez l’accès aux salons vocaux du serveur.',
        '',
        `${sectionTitle('💫 Niveau 5')}${level5 ? `  ${level5}` : ''}`,
        '',
        'Vous débloquez la catégorie réservée aux membres, avec :',
        '・📸 Les salons Selfie & OOTD',
        '・💬 Le forum des passions des membres',
        '・🤫 Les confessions anonymes',
        config.infoMpChannelId
          ? `Ainsi que la possibilité de faire des demandes de <#${config.infoMpChannelId}>`
          : 'Ainsi que la possibilité de faire des demandes de MP',
        '',
        sectionTitle('🚀 Boost du serveur'),
        '',
        'En boostant le serveur, vous profitez :',
        '・D’un boost d’XP x1,5, aussi bien à l’écrit qu’en vocal',
        '・De la possibilité d’obtenir un rôle totalement personnalisé rien qu’à vous !',
        '',
        sectionTitle('🎁 Concernant les giveaways'),
        '',
        'Les futurs giveaways seront entièrement organisés et pris en charge par le staff. Cette décision a pour objectif de protéger au maximum nos membres et d’éviter toute tentative d’arnaque ou situation problématique. Nous souhaitons également rester totalement indépendants : nous ne voulons être redevables envers personne et préférons gérer chaque giveaway de A à Z, de son organisation jusqu’à la remise des récompenses.',
        '',
        'Merci de respecter ce fonctionnement et, surtout, merci de faire vivre le serveur au quotidien. 🫶',
      ].join('\n')
    )
    .setFooter(getBotFooter(client, { extra: 'Informations' }));
}

function buildThumbnailFile() {
  if (!fs.existsSync(THUMBNAIL_PATH)) return null;
  return new AttachmentBuilder(THUMBNAIL_PATH, { name: THUMBNAIL_NAME });
}

export const informationsCommands = [
  (() => {
    const json = new SlashCommandBuilder()
      .setName('informations')
      .setDescription('Poster l’embed d’informations (niveaux, boost, giveaways).')
      .setDefaultMemberPermissions(0n)
      .setDMPermission(false)
      .addChannelOption((o) =>
        o
          .setName('salon')
          .setDescription('Salon où poster (sinon le salon informations)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
      .toJSON();
    json.default_member_permissions = '0';
    json.dm_permission = false;
    return json;
  })(),
];

export async function handleInformations(interaction) {
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

  const channel =
    interaction.options.getChannel('salon') ||
    (config.infoChannelId ? await interaction.client.channels.fetch(config.infoChannelId).catch(() => null) : null) ||
    interaction.channel;

  if (!channel?.isTextBased?.() || channel.isThread?.() || channel.isDMBased?.()) {
    return interaction.reply({
      content: '❌ Poster les informations dans un salon texte ou annonces.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const perms = me?.permissionsIn(channel);
  if (
    !perms?.has(PermissionFlagsBits.ViewChannel) ||
    !perms?.has(PermissionFlagsBits.SendMessages) ||
    !perms?.has(PermissionFlagsBits.EmbedLinks)
  ) {
    return interaction.reply({
      content: `❌ Le bot doit pouvoir **voir** ${channel}, **y envoyer des messages** et **intégrer des liens**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const file = buildThumbnailFile();
  const payload = {
    embeds: [buildInformationsEmbed(interaction.client)],
    allowedMentions: { parse: [] },
  };
  if (file) {
    if (!perms?.has(PermissionFlagsBits.AttachFiles)) {
      return interaction.reply({
        content: `❌ Le bot doit pouvoir **joindre des fichiers** dans ${channel} pour l’icône de l’embed.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    payload.files = [file];
  }

  try {
    await channel.send(payload);
  } catch (err) {
    console.error("[Pêche Mignon] /informations envoi:", err?.message || err);
    return interaction.reply({
      content: `❌ Impossible de poster les informations : ${err?.message || 'erreur'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Embed informations posté dans ${channel}.`,
    flags: MessageFlags.Ephemeral,
  });
}
