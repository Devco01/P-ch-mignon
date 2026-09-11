import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';
import { canCloseTicket } from '../permissions.js';
import { config } from '../config.js';

const REGLEMENT_ACCEPT_BUTTON_ID = 'reglement_accept';

function formatRuleTitle(title) {
  const m = String(title).match(/^(\d+\.\s+\S+\s+)(.+)$/);
  if (!m) return `✦ **__${title}__**`;
  return `✦ ${m[1]}**__${m[2]}__**`;
}

function barParagraph(...lines) {
  if (!lines.length) return '';
  const [first, ...rest] = lines;
  return [formatRuleTitle(first), '', ...rest].join('\n');
}

function joinRules(rules) {
  return rules.join('\n\n');
}

function buildReglementEmbeds(client) {
  const sakura = config.reglementSakuraEmoji;
  const brand = config.embedBrand;
  const rules = [
    barParagraph(
      '1. 🔐 Choisissez vos accès :',
      `Sur ${brand}, vous êtes libre de choisir le type de contenu auquel vous souhaitez avoir accès.`,
      '',
      '🍎 **Certification SFW :**',
      'Accès uniquement à la partie classique du serveur : communauté, gaming, discussions et animations. Aucun contenu NSFW ne vous sera accessible.',
      '',
      '🔞 **Certification NSFW :**',
      'Elle comprend tous les accès SFW, ainsi que les espaces réservés aux adultes : discussions -18, nudes, teases, action ou vérité, etc.',
      '',
      '🎫 Lors de votre certification, merci de nous préciser en ticket si vous souhaitez un accès SFW ou NSFW.',
      '',
      '🔄 **Vous changez d’avis ?**',
      'Aucun souci ! Votre choix n’est pas définitif. Vous pouvez passer d’une certification SFW à NSFW, ou inversement, à tout moment en ouvrant simplement un nouveau ticket auprès du staff.',
      '',
      'Vous pourrez ainsi profiter du serveur selon vos préférences, sans être exposé à du contenu que vous ne souhaitez pas voir.'
    ),
    barParagraph(
      '2. 🚫 Respect & tolérance :',
      'Aucun comportement discriminatoire ou haineux ne sera toléré.',
      'Sont notamment interdits :',
      '❌ Les propos racistes ;',
      '❌ Les propos homophobes ou LGBTQphobes ;',
      '❌ Les propos sexistes ou misogynes ;',
      '❌ Les insultes visant à rabaisser ou humilier;',
      '❌ Le harcèlement;',
      '❌ Les menaces;',
      '❌ Toute forme de discrimination ou de haine.',
      'Tout comportement grave entraînera un ban immédiat et définitif, sans avertissement.'
    ),
    barParagraph(
      '3. ⚖️ Apolitique & areligieux :',
      `${brand} est un espace apolitique et areligieux. Les débats, prises de position, propagande ou provocations autour de la politique et de la religion n’ont pas leur place sur le serveur. Chacun est libre d’avoir ses opinions, ses convictions et ses croyances, mais celles-ci relèvent de la sphère personnelle. Respectez les autres comme vous souhaitez être respecté. Aucun jugement, conflit, discrimination ou attaque envers un membre en raison de ses idées ou de ses croyances ne sera toléré.`,
      '',
      'Ici, nous sommes avant tout réunis pour partager de bons moments et profiter de la communauté, pas pour opposer nos convictions. 💕'
    ),
    barParagraph(
      '4. 🏷️ Utilisation des salons :',
      'Merci de respecter l’utilisation prévue pour chaque salon. Postez vos messages dans les salons appropriés et évitez le hors sujet lorsque celui-ci n’est pas autorisé.'
    ),
    barParagraph(
      '5. 🎫 Tickets :',
      'Lorsque vous ouvrez un ticket auprès de la modération, merci de rester réactif et disponible. Nous faisons notre maximum pour vous répondre rapidement; nous vous demandons donc d’en faire de même. Un ticket resté sans réponse pendant plus de 24 heures entraînera un warn.'
    ),
    barParagraph(
      '6. 🌿 Le mot d’ordre : bienveillance',
      `${brand} est avant tout un espace où chacun doit pouvoir se sentir à l’aise, respecté et en sécurité. Soyez respectueux envers les autres membres, la modération et vous-même. En cas de conflit ou de situation problématique, privilégiez le dialogue et faites appel à la modération.`
    ),
  ];

  const first = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setDescription(
      [
        `${sakura} **__Bienvenue sur ${brand}__** ${sakura}`,
        '',
        'Afin de préserver un espace chill, convivial, bienveillant et sécurisé, merci de prendre connaissance du règlement avant de participer à la vie du serveur.',
        '',
        joinRules(rules.slice(0, 3)),
      ].join('\n')
    );

  const second = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setDescription(
      [
        joinRules(rules.slice(3)),
        '',
        `🌸 En rejoignant **__${brand}__**, vous acceptez l’intégralité de ce règlement.`,
      ].join('\n')
    )
    .setFooter(getBotFooter(client, { extra: 'Règlement' }));

  return [first, second];
}

function buildReglementButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(REGLEMENT_ACCEPT_BUTTON_ID)
      .setEmoji('✔')
      .setLabel('Lu et approuvé')
      .setStyle(ButtonStyle.Danger)
  );
}

export function isReglementButton(customId) {
  return customId === REGLEMENT_ACCEPT_BUTTON_ID;
}

export const reglementCommands = [
  (() => {
    const json = new SlashCommandBuilder()
      .setName('reglement')
      .setNameLocalizations({ fr: 'règlement' })
      .setDescription('Poster le règlement du serveur dans ce salon.')
      .setDescriptionLocalizations({ fr: 'Poster le règlement du serveur dans ce salon.' })
      .setDefaultMemberPermissions(0n)
      .setDMPermission(false)
      .addChannelOption((o) =>
        o
          .setName('salon')
          .setDescription('Salon où poster le règlement (sinon le salon actuel)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
      .toJSON();
    json.default_member_permissions = '0';
    json.dm_permission = false;
    return json;
  })(),
];

export async function handleReglement(interaction) {
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

  const channel = interaction.options.getChannel('salon') || interaction.channel;
  if (!channel?.isTextBased?.() || channel.isThread?.() || channel.isDMBased?.()) {
    return interaction.reply({
      content: '❌ Poster le règlement dans un salon texte ou annonces.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const perms = me?.permissionsIn(channel);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({
      content: `❌ Le bot doit pouvoir **voir** ${channel}, **y envoyer des messages** et **intégrer des liens**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: '❌ Le bot a besoin de la permission **Gérer les rôles** pour donner le rôle membre.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await channel.send({
      embeds: buildReglementEmbeds(interaction.client),
      components: [buildReglementButtons()],
      allowedMentions: { parse: [] },
    });
  } catch (err) {
    console.error("[Péché Mignon] /règlement envoi:", err?.message || err);
    return interaction.reply({
      content: `❌ Impossible de poster le règlement : ${err?.message || 'erreur'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: `✅ Règlement posté dans ${channel}.`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleReglementButton(interaction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }

  const member =
    interaction.member && typeof interaction.member.roles?.add === 'function'
      ? interaction.member
      : await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    return interaction.reply({ content: '❌ Impossible de récupérer ton profil membre.', flags: MessageFlags.Ephemeral });
  }

  if (!config.reglementMemberRoleId) {
    return interaction.reply({
      content: '❌ Rôle membre non configuré (`REGLEMENT_MEMBER_ROLE_ID`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (member.roles.cache.has(config.reglementMemberRoleId)) {
    return interaction.reply({
      content: '✅ Tu as déjà accepté le règlement.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const role = guild.roles.cache.get(config.reglementMemberRoleId) ?? (await guild.roles.fetch(config.reglementMemberRoleId).catch(() => null));
  if (!role) {
    return interaction.reply({
      content: '❌ Le rôle membre est introuvable. Préviens un administrateur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({
      content: '❌ Le bot n’a pas la permission **Gérer les rôles**.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    return interaction.reply({
      content: '❌ Le rôle du bot doit être **au-dessus** du rôle membre pour pouvoir l’attribuer.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await member.roles.add(role, 'Règlement lu et approuvé');
  } catch (err) {
    console.error("[Péché Mignon] règlement rôle:", err?.message || err);
    return interaction.reply({
      content: `❌ Impossible de t’attribuer le rôle : ${err?.message || 'erreur'}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: '✅ Règlement lu et approuvé. Tu as maintenant le rôle membre.',
    flags: MessageFlags.Ephemeral,
  });
}
