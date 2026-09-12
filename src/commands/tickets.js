import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { config } from '../config.js';
import {
  createTicket,
  getTicketByThreadId,
  claimTicket,
  closeTicket,
  setTicketPanel,
  getTicketPanel,
} from '../database.js';
import { COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';
import { isStaffMember, canCloseTicket } from '../permissions.js';
import { sanitizeReason, formatBanDate } from '../validation.js';

/**
 * Couleurs demandées (#ef233c, #edf6f9, #aaf683) : Discord n’accepte pas d’hex sur les boutons.
 * On mappe sur Danger (rouge), Secondary (gris clair), Success (vert).
 */
export const TICKET_TYPES = [
  {
    id: 'signalement',
    label: 'Signalement',
    emoji: '\u{1F3F3}\u{FE0F}',
    blurb: 'report / comportements / problèmes',
    threadPrefix: 'Signalement',
    title: '\u{1F3F3}\u{FE0F} - Signalement',
    buttonStyle: ButtonStyle.Danger,
  },
  {
    id: 'aide',
    label: 'Aide',
    emoji: '💬',
    blurb: 'questions, soucis de permissions ou signalement d’un bug',
    threadPrefix: 'Aide',
    title: '💬 - Aide',
    buttonStyle: ButtonStyle.Secondary,
  },
  {
    id: 'certification',
    label: 'Certification',
    emoji: '✅',
    blurb: 'vérification de ton âge et de l’authenticité de ton compte',
    threadPrefix: 'Certification',
    title: '✅ - Certification',
    buttonStyle: ButtonStyle.Success,
  },
  {
    id: 'partenariat',
    label: 'Partenariat',
    emoji: '\u{1FAF1}\u{1F3FC}\u{200D}\u{1FAF2}\u{1F3FB}',
    buttonEmoji: '🤝',
    blurb: 'uniquement après lecture des modalités',
    threadPrefix: 'Partenariat',
    title: '\u{1FAF1}\u{1F3FC}\u{200D}\u{1FAF2}\u{1F3FB} - Partenariat',
    buttonStyle: ButtonStyle.Primary,
  },
];

function getTicketType(id) {
  return TICKET_TYPES.find((t) => t.id === id) || TICKET_TYPES[0];
}

async function fetchThreadMessagesChronological(thread) {
  const collected = [];
  let before;
  for (let i = 0; i < 25; i++) {
    const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    collected.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return collected;
}

function formatTranscriptText({ ticket, meta, messages, closedById, closeReason }) {
  const header = [
    `Ticket ${meta.label}`,
    `Sujet : ${ticket.subject || '—'}`,
    `Auteur : ${ticket.user_id}`,
    ticket.claimed_by ? `Pris en charge par : ${ticket.claimed_by}` : null,
    `Fermé par : ${closedById}`,
    closeReason ? `Phrase de fermeture : ${closeReason}` : null,
    `Ouvert le : ${formatBanDate(ticket.created_at)}`,
    `Messages : ${messages.length}`,
    '—'.repeat(40),
    '',
  ]
    .filter((l) => l != null)
    .join('\n');

  const body = messages
    .map((msg) => {
      const ts = formatBanDate(new Date(msg.createdTimestamp).toISOString());
      const name = msg.author?.tag || msg.author?.username || 'inconnu';
      const text = (msg.content || '').trim();
      const atts = [...(msg.attachments?.values?.() || [])].map((a) => a.url);
      const lines = [`[${ts}] ${name} (${msg.author?.id || '?'})`];
      if (text) lines.push(text);
      else if (!atts.length) lines.push('(pas de texte)');
      for (const url of atts) lines.push(`Pièce jointe : ${url}`);
      return lines.join('\n');
    })
    .join('\n\n');

  return `${header}${body}\n`;
}

async function sendTicketTranscript(client, { thread, ticket, closedById, closeReason }) {
  const channelId = config.ticketTranscriptChannelId;
  if (!channelId) return false;
  const dest = await client.channels.fetch(channelId).catch(() => null);
  if (!dest?.isTextBased?.()) {
    console.warn(`[Péché Mignon] Salon transcripts introuvable: ${channelId}`);
    return false;
  }

  const meta = getTicketType(ticket.type);
  const messages = await fetchThreadMessagesChronological(thread);
  const text = formatTranscriptText({ ticket, meta, messages, closedById, closeReason });
  const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), {
    name: `ticket-${meta.id}-${ticket.user_id}.txt`,
  });

  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setTitle(`${meta.emoji} Transcript — ${meta.label}`)
    .setDescription(ticket.subject ? `**Sujet :** ${String(ticket.subject).slice(0, 1000)}` : 'Aucun sujet.')
    .addFields(
      { name: 'Auteur', value: `<@${ticket.user_id}>`, inline: true },
      { name: 'Fermé par', value: `<@${closedById}>`, inline: true },
      { name: 'Pris en charge', value: ticket.claimed_by ? `<@${ticket.claimed_by}>` : '—', inline: true },
      { name: 'Messages', value: String(messages.length), inline: true },
      { name: 'Fil', value: `<#${thread.id}>`, inline: true }
    )
    .setFooter(getBotFooter(client, { extra: 'Transcript', date: new Date() }));
  if (closeReason) {
    embed.addFields({ name: 'Phrase de fermeture', value: closeReason.slice(0, 1024), inline: false });
  }

  await dest.send({ embeds: [embed], files: [file] });
  return true;
}

function sanitizeThreadNamePart(name) {
  return String(name || 'membre')
    .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
    .replace(/\s+/g, '')
    .slice(0, 40) || 'membre';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureTicketChannelMemberAccess(channel, guild) {
  const allow = {
    ViewChannel: true,
    ReadMessageHistory: true,
    UseApplicationCommands: true,
    SendMessagesInThreads: true,
  };
  const targets = [guild.roles.everyone];
  if (config.reglementMemberRoleId) {
    const role =
      guild.roles.cache.get(config.reglementMemberRoleId) ||
      (await guild.roles.fetch(config.reglementMemberRoleId).catch(() => null));
    if (role) targets.push(role);
  }
  for (const target of targets) {
    try {
      await channel.permissionOverwrites.edit(target, allow, { reason: 'Permettre aux membres d’ouvrir des tickets' });
    } catch (err) {
      console.warn(`[Péché Mignon] tickets overwrite ${target.id}:`, err?.message || err);
    }
  }
}

async function addMemberToTicketThread(thread, userId) {
  for (let i = 0; i < 4; i++) {
    try {
      await thread.members.add(userId);
      const has = thread.members.cache.has(userId) || (await thread.members.fetch(userId).then(() => true).catch(() => false));
      if (has) return true;
    } catch (err) {
      console.warn(`[Péché Mignon] Ajout membre au ticket (essai ${i + 1}):`, err?.message || err);
    }
    await wait(350 * (i + 1));
  }
  return false;
}

function staffPingContent() {
  const ids = config.ticketStaffRoleIds;
  if (!ids.length) return null;
  return ids.map((id) => `<@&${id}>`).join(' ');
}

function ticketActionRow({ claimed = false, closed = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel('Revendiquer')
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(claimed || closed),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Fermer')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
  );
}

function buildTicketEmbed({ client, userId, type, subject, claimedBy = null, closed = false, closeReason = null }) {
  const meta = getTicketType(type);
  const desc = closed
    ? `Ce ticket est **fermé**. Seuls les modérateurs peuvent le rouvrir.`
    : `Bonjour <@${userId}>,\nL’équipe de modération prendra en charge ta demande dès que possible.`;
  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setTitle(meta.title)
    .setDescription(desc)
    .addFields({ name: 'Sujet', value: subject || '—', inline: false })
    .setFooter(getBotFooter(client, { extra: closed ? 'Ticket fermé' : claimedBy ? `Pris en charge` : undefined, date: new Date() }));
  if (claimedBy) {
    embed.addFields({ name: 'Pris en charge par', value: `<@${claimedBy}>`, inline: true });
  }
  if (closed && closeReason) {
    embed.addFields({ name: 'Phrase de fermeture', value: closeReason.slice(0, 1024), inline: false });
  }
  return embed;
}

const PANEL_TICKET_TYPES = TICKET_TYPES.filter((t) => t.id !== 'partenariat');

function buildPanelEmbed(client) {
  return new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(client))
    .setTitle('🎫 Besoin d’aide ?')
    .setDescription(
      [
        'Clique sur le bouton qui correspond le mieux à ta demande afin que ton ticket soit traité correctement :',
        '',
        '🚨 **Signalement** — signaler un membre, un comportement ou un problème',
        '💬 **Aide** — questions, soucis de permissions ou signalement d’un bug',
        '✅ **Certification** — vérification de ton âge et de l’authenticité de ton compte',
        '',
        '📌 **À savoir :**',
        '• Sois clair et précis dès ton premier message.',
        '• Un ticket resté sans réponse pendant plus de 24 heures fera l’objet d’un warn.',
        '• La certification s’effectue uniquement par vérification en caméra + CNI.',
        '',
        '🔒 **Confidentialité :**',
        'Les tickets sont des espaces privés : seuls toi et les membres autorisés du staff peuvent les consulter.',
      ].join('\n')
    )
    .setFooter(getBotFooter(client, { extra: 'Support' }));
}

function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    PANEL_TICKET_TYPES.map((t) =>
      new ButtonBuilder()
        .setCustomId(`ticket_open_${t.id}`)
        .setLabel(t.label)
        .setEmoji(t.buttonEmoji || t.emoji)
        .setStyle(t.buttonStyle)
    )
  );
}

async function deleteStoredTicketPanel(client, guildId) {
  const panel = await getTicketPanel(guildId).catch(() => null);
  if (!panel?.channel_id || !panel?.message_id) return;
  const ch = await client.channels.fetch(panel.channel_id).catch(() => null);
  const msg = ch?.messages ? await ch.messages.fetch(panel.message_id).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => {});
}

export async function refreshTicketPanelWithoutEdit(client, guildId) {
  const panel = await getTicketPanel(guildId).catch(() => null);
  const channelId = panel?.channel_id || config.ticketChannelId;
  if (!channelId) return false;
  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased?.() || ch.isThread?.()) return false;

  const msg = panel?.message_id ? await ch.messages.fetch(panel.message_id).catch(() => null) : null;
  const desc = msg?.embeds?.[0]?.description || '';
  const hasPartenariat =
    /partenariat/i.test(desc) ||
    msg?.components?.some((row) =>
      row.components?.some((c) => String(c.customId || '').includes('partenariat'))
    );
  if (msg && !hasPartenariat) return false;

  if (msg) await msg.delete().catch(() => {});
  const sent = await ch.send({
    embeds: [buildPanelEmbed(client)],
    components: [buildPanelButtons()],
  });
  if (guildId) await setTicketPanel(guildId, ch.id, sent.id);
  console.log("[Péché Mignon] Panneau tickets renvoyé (partenariat retiré, nouveau message).");
  return true;
}

export const ticketCommands = [
  (() => {
    const json = new SlashCommandBuilder()
      .setName('ticket-panel')
      .setDescription('Poster le panneau d’ouverture de tickets (fils privés) dans ce salon.')
      .setDefaultMemberPermissions(0n)
      .setDMPermission(false)
      .toJSON();
    json.default_member_permissions = '0';
    json.dm_permission = false;
    return json;
  })(),
];

export function isTicketOpenButton(customId) {
  return typeof customId === 'string' && customId.startsWith('ticket_open_');
}

export function isTicketSelect(customId) {
  return customId === 'ticket_open';
}

export function isTicketModal(customId) {
  return typeof customId === 'string' && customId.startsWith('ticket_modal_');
}

export function isTicketCloseModal(customId) {
  return customId === 'ticket_close_modal';
}

export function isTicketButton(customId) {
  return customId === 'ticket_claim' || customId === 'ticket_close';
}

async function showTicketSubjectModal(interaction, typeId) {
  const meta = getTicketType(typeId);
  if (!interaction.guild && !interaction.guildId) {
    return interaction.reply({ content: '❌ Utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder().setCustomId(`ticket_modal_${meta.id}`).setTitle(`${meta.label} — sujet`);
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sujet')
        .setLabel('Sujet de ta demande')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(4)
        .setMaxLength(400)
        .setPlaceholder('Décris brièvement le motif…')
    )
  );
  try {
    await interaction.showModal(modal);
  } catch (err) {
    console.error(`[Péché Mignon] Ticket showModal (${meta.id}):`, err?.message || err);
    if (!interaction.replied && !interaction.deferred) {
      return interaction
        .reply({
          content: '❌ Impossible d’ouvrir le formulaire. Réessaie dans un instant.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}

export async function handleTicketOpenButton(interaction) {
  const typeId = String(interaction.customId || '').replace('ticket_open_', '');
  console.log(`[Péché Mignon] Ticket bouton: ${typeId} user=${interaction.user?.id}`);
  return showTicketSubjectModal(interaction, typeId);
}

export async function handleTicketSelect(interaction) {
  const typeId = interaction.values?.[0];
  return showTicketSubjectModal(interaction, typeId);
}

export async function handleTicketPanel(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  if (!(await canCloseTicket(interaction))) {
    return interaction.reply({
      content: '❌ Réservé aux **administrateurs** et au **propriétaire** du serveur.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const channel = interaction.channel;
  if (!channel?.isTextBased?.() || channel.isThread?.() || channel.isDMBased?.()) {
    return interaction.reply({
      content: '❌ Poster le panneau dans un salon texte (celui où les fils privés seront créés, ex. `#ticket`).',
      flags: MessageFlags.Ephemeral,
    });
  }

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe().catch(() => null));
  const perms = me?.permissionsIn(channel);
  const missing = [];
  if (!perms?.has(PermissionFlagsBits.SendMessages)) missing.push('Envoyer des messages');
  if (!perms?.has(PermissionFlagsBits.CreatePrivateThreads)) missing.push('Créer des fils privés');
  if (!perms?.has(PermissionFlagsBits.SendMessagesInThreads)) missing.push('Envoyer des messages dans les fils');
  if (!perms?.has(PermissionFlagsBits.ManageThreads)) missing.push('Gérer les fils');
  if (missing.length) {
    return interaction.reply({
      content: `❌ Permissions manquantes dans ce salon : **${missing.join(', ')}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await ensureTicketChannelMemberAccess(channel, interaction.guild);
  await deleteStoredTicketPanel(interaction.client, interaction.guild.id);

  const msg = await channel.send({
    embeds: [buildPanelEmbed(interaction.client)],
    components: [buildPanelButtons()],
  });
  await setTicketPanel(interaction.guild.id, channel.id, msg.id);
  const pingHint = config.ticketStaffRoleIds.length
    ? ''
    : '\n⚠️ `TICKET_STAFF_ROLE_IDS` est vide : aucun rôle ne sera pingé à l’ouverture.';
  return interaction.reply({
    content: `✅ Panneau de tickets posté dans ${channel}. Les fils privés s’ouvriront ici.${pingHint}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleTicketModalSubmit(interaction) {
  const typeId = String(interaction.customId || '').replace('ticket_modal_', '');
  const meta = getTicketType(typeId);
  const guild =
    interaction.guild ||
    (interaction.guildId ? await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
  if (!guild) {
    return interaction.reply({ content: '❌ Utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }

  const subject = sanitizeReason(interaction.fields.getTextInputValue('sujet')) || 'Non précisé';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const parentId = config.ticketChannelId || interaction.channelId;
  const parent = await interaction.client.channels.fetch(parentId).catch(() => null);
  if (!parent || !parent.isTextBased?.() || parent.isThread?.() || parent.type === ChannelType.DM) {
    return interaction.editReply({
      content: '❌ Salon tickets introuvable. Un staff doit relancer `/ticket-panel` dans le salon `#ticket`.',
    });
  }

  await ensureTicketChannelMemberAccess(parent, guild);

  const username = sanitizeThreadNamePart(interaction.user.username || interaction.user.globalName || interaction.user.id);
  const threadName = `${meta.threadPrefix}-${username}`.slice(0, 100);

  let thread;
  try {
    thread = await parent.threads.create({
      name: threadName,
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Ticket ${meta.label} — ${interaction.user.tag}`,
    });
  } catch (err) {
    console.error("[Péché Mignon] Création thread ticket:", err?.message || err);
    const code = err?.code ?? err?.rawError?.code;
    const atCap = code === 30033 || /maximum number of active threads/i.test(String(err?.message || ''));
    return interaction.editReply({
      content: atCap
        ? '❌ Discord refuse un nouveau fil : la limite de fils actifs du serveur est atteinte. Un staff doit en archiver/fermer.'
        : '❌ Impossible de créer le fil privé. Vérifie que le bot a **Créer des fils privés** et **Gérer les fils** dans ce salon.',
    });
  }

  const added = await addMemberToTicketThread(thread, interaction.user.id);
  if (!added) {
    console.warn(`[Péché Mignon] Ticket: membre ${interaction.user.id} non ajouté au fil ${thread.id}`);
  }

  const ping = staffPingContent();
  const embed = buildTicketEmbed({
    client: interaction.client,
    userId: interaction.user.id,
    type: meta.id,
    subject,
  });

  try {
    const intro = await thread.send({
      content: ping || undefined,
      embeds: [embed],
      components: [ticketActionRow()],
      allowedMentions: { roles: config.ticketStaffRoleIds, users: [interaction.user.id] },
    });
    await createTicket({
      guildId: guild.id,
      threadId: thread.id,
      userId: interaction.user.id,
      type: meta.id,
      subject,
      panelMessageId: intro.id,
    });
  } catch (err) {
    console.error("[Péché Mignon] Message initial ticket:", err?.message || err);
    return interaction.editReply({ content: `❌ Fil créé (<#${thread.id}>) mais le message d’accueil a échoué.` });
  }

  return interaction.editReply({
    content: added
      ? `✅ Ticket ouvert : ${thread}`
      : `✅ Ticket créé (${thread}) mais je n’ai pas pu t’y ajouter. Un staff va t’ajouter — vérifie que tu vois le salon tickets.`,
  });
}

export async function handleTicketButton(interaction) {
  const thread = interaction.channel;
  if (!thread?.isThread?.()) {
    return interaction.reply({ content: '❌ Ces boutons ne fonctionnent que dans un fil de ticket.', flags: MessageFlags.Ephemeral });
  }

  const ticket = await getTicketByThreadId(thread.id);
  if (!ticket) {
    return interaction.reply({ content: '❌ Ce fil n’est pas un ticket connu.', flags: MessageFlags.Ephemeral });
  }

  const member = interaction.member;
  const staff = isStaffMember(member);

  if (interaction.customId === 'ticket_claim') {
    if (!staff) {
      return interaction.reply({ content: '❌ Seul le staff peut revendiquer un ticket.', flags: MessageFlags.Ephemeral });
    }
    if (ticket.status !== 'open') {
      return interaction.reply({ content: '❌ Ce ticket est déjà fermé.', flags: MessageFlags.Ephemeral });
    }
    if (ticket.claimed_by) {
      return interaction.reply({ content: `ℹ️ Déjà pris en charge par <@${ticket.claimed_by}>.`, flags: MessageFlags.Ephemeral });
    }

    await claimTicket(thread.id, interaction.user.id);
    const embed = buildTicketEmbed({
      client: interaction.client,
      userId: ticket.user_id,
      type: ticket.type,
      subject: ticket.subject,
      claimedBy: interaction.user.id,
    });

    try {
      await interaction.update({
        embeds: [embed],
        components: [ticketActionRow({ claimed: true })],
      });
    } catch (_) {
      await interaction.reply({ content: `✅ Ticket revendiqué par <@${interaction.user.id}>.`, flags: MessageFlags.Ephemeral });
    }

    await thread.send({
      content: `🛡️ Ticket revendiqué par <@${interaction.user.id}>.`,
      allowedMentions: { users: [interaction.user.id, ticket.user_id] },
    }).catch(() => {});
    return;
  }

  if (interaction.customId === 'ticket_close') {
    if (!(await canCloseTicket(interaction))) {
      return interaction.reply({ content: '❌ Seuls les administrateurs et le propriétaire du serveur peuvent fermer un ticket.', flags: MessageFlags.Ephemeral });
    }
    if (ticket.status === 'closed') {
      return interaction.reply({ content: 'ℹ️ Ce ticket est déjà fermé.', flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder().setCustomId('ticket_close_modal').setTitle('Fermer le ticket');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('close_reason')
          .setLabel('Phrase de fermeture')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(8)
          .setMaxLength(400)
          .setPlaceholder('Ex. : Ticket pris en compte, la personne signalée a été bannie.')
      )
    );
    return interaction.showModal(modal);
  }
}

async function editTicketControlMessage(thread, embed, claimed) {
  const msgs = await thread.messages.fetch({ limit: 40 }).catch(() => null);
  if (!msgs) return;
  const target = msgs.find((m) =>
    m.components?.some((row) => row.components?.some((c) => c.customId === 'ticket_close' || c.customId === 'ticket_claim'))
  );
  if (!target) return;
  await target
    .edit({
      embeds: [embed],
      components: [ticketActionRow({ claimed, closed: true })],
    })
    .catch(() => {});
}

export async function handleTicketCloseModal(interaction) {
  const thread = interaction.channel;
  if (!thread?.isThread?.()) {
    return interaction.reply({ content: '❌ Ce formulaire ne fonctionne que dans un fil de ticket.', flags: MessageFlags.Ephemeral });
  }

  const ticket = await getTicketByThreadId(thread.id);
  if (!ticket) {
    return interaction.reply({ content: '❌ Ce fil n’est pas un ticket connu.', flags: MessageFlags.Ephemeral });
  }

  if (!(await canCloseTicket(interaction))) {
    return interaction.reply({ content: '❌ Seuls les administrateurs et le propriétaire du serveur peuvent fermer un ticket.', flags: MessageFlags.Ephemeral });
  }
  if (ticket.status === 'closed') {
    return interaction.reply({ content: 'ℹ️ Ce ticket est déjà fermé.', flags: MessageFlags.Ephemeral });
  }

  const closeReason =
    sanitizeReason(interaction.fields.getTextInputValue('close_reason')) ||
    'Ticket fermé sans phrase de clôture.';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await closeTicket(thread.id, closeReason);

  const embed = buildTicketEmbed({
    client: interaction.client,
    userId: ticket.user_id,
    type: ticket.type,
    subject: ticket.subject,
    claimedBy: ticket.claimed_by,
    closed: true,
  });
  await editTicketControlMessage(thread, embed, Boolean(ticket.claimed_by));

  await thread
    .send({
      content: `🔒 Ticket fermé par <@${interaction.user.id}>.`,
      allowedMentions: { users: [interaction.user.id] },
    })
    .catch(() => {});

  try {
    await sendTicketTranscript(interaction.client, {
      thread,
      ticket,
      closedById: interaction.user.id,
      closeReason,
    });
  } catch (err) {
    console.warn("[Péché Mignon] Transcript ticket:", err?.message || err);
  }

  try {
    await thread.setLocked(true, `Ticket fermé par ${interaction.user.tag}`);
    await thread.setArchived(true, `Ticket fermé par ${interaction.user.tag}`);
  } catch (err) {
    console.warn("[Péché Mignon] Archivage ticket:", err?.message || err);
  }

  return interaction.editReply({ content: '✅ Ticket fermé. La phrase de clôture figure dans le transcript.' });
}
