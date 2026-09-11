import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  parseEmoji,
} from 'discord.js';
import crypto from 'crypto';
import { config } from '../config.js';
import {
  getPresentationMessage,
  upsertPresentationMessage,
  deletePresentationMessage,
  getPresentationDraft,
  upsertPresentationDraft,
  deletePresentationDraft,
} from '../database.js';
import { COLOR_OTHER, getBotAuthor, getBotFooter } from '../embeds.js';

const PRESENTATION_MODAL_CUSTOM_ID = 'presentation_modal_v1';
const PRESENTATION_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const PRESENTATION_STEP_REPLY_TTL_MS = 5 * 60 * 1000;
const DISCORD_EMBED_FIELD_VALUE_MAX = 1024;
const PRESENTATION_APROPOS_TEXT_MAX = 165;
const PRESENTATION_STYLE_MAX = 200;
const PRESENTATION_RECHERCHE_MAX = 180;

const presentationSessions = new Map();
const presentationSessionByUser = new Map();

function schedulePresentationEphemeralCleanup(interaction, isLastStep = false) {
  if (isLastStep) return;
  setTimeout(() => interaction.deleteReply().catch(() => {}), PRESENTATION_STEP_REPLY_TTL_MS);
}

function newPresentationToken() {
  return crypto.randomBytes(12).toString('hex');
}

function presentationSessionKey(token) {
  return String(token || '');
}

function presentationUserIndex(guildId, userId) {
  return `${guildId}:${userId}:generale`;
}

function getPresentationSession(token) {
  const k = presentationSessionKey(token);
  const s = presentationSessions.get(k);
  if (!s) return null;
  if (Date.now() - s.createdAt > PRESENTATION_SESSION_TTL_MS) {
    presentationSessions.delete(k);
    return null;
  }
  return s;
}

function upsertPresentationSession(token, patch) {
  const k = presentationSessionKey(token);
  const cur = getPresentationSession(k) || null;
  const next = {
    createdAt: Date.now(),
    variant: 'generale',
    userId: cur?.userId,
    guildId: cur?.guildId,
    channelId: cur?.channelId,
    identite: cur?.identite || {},
    apparence: cur?.apparence || {},
    apropos: cur?.apropos || {},
    ...patch,
  };
  presentationSessions.set(k, next);
  if (next.guildId && next.userId) {
    presentationSessionByUser.set(presentationUserIndex(next.guildId, next.userId), k);
  }
  return next;
}

function getPresentationSessionForInteraction(interaction, token) {
  const byToken = token ? getPresentationSession(token) : null;
  if (byToken) return byToken;
  const gid = interaction?.guild?.id || interaction?.guildId;
  const uid = interaction?.user?.id;
  if (!gid || !uid) return null;
  const k = presentationSessionByUser.get(presentationUserIndex(gid, uid));
  return k ? getPresentationSession(k) : null;
}

function clearPresentationSession(token, session) {
  const k = presentationSessionKey(token);
  presentationSessions.delete(k);
  const gid = session?.guildId;
  const uid = session?.userId;
  if (gid && uid) {
    const idx = presentationUserIndex(gid, uid);
    if (presentationSessionByUser.get(idx) === k) presentationSessionByUser.delete(idx);
  }
}

async function persistPresentationDraft(session) {
  try {
    if (!session?.guildId || !session?.userId) return;
    await upsertPresentationDraft(
      session.guildId,
      session.userId,
      session.token,
      session.channelId,
      session.panelMessageId ?? null,
      JSON.stringify({
        identite: session.identite || {},
        apparence: session.apparence || {},
        apropos: session.apropos || {},
      }),
      'generale'
    );
  } catch (_) {}
}

async function loadPresentationDraftIntoMemory(interaction, tokenHint = null) {
  const gid = interaction?.guild?.id || interaction?.guildId;
  const uid = interaction?.user?.id;
  if (!gid || !uid) return null;
  const draft = await getPresentationDraft(gid, uid, 'generale').catch(() => null);
  if (!draft) return null;
  let data = {};
  try {
    data = JSON.parse(draft.data_json || '{}') || {};
  } catch (_) {
    data = {};
  }
  const token = tokenHint || draft.token || newPresentationToken();
  return upsertPresentationSession(token, {
    createdAt: Date.now(),
    token,
    userId: uid,
    guildId: gid,
    channelId: draft.channel_id || interaction.channelId,
    panelMessageId: draft.panel_message_id || null,
    identite: data.identite || {},
    apparence: data.apparence || {},
    apropos: data.apropos || {},
  });
}

async function getPresentationSessionAsync(interaction, token) {
  const inMem = getPresentationSessionForInteraction(interaction, token);
  if (inMem) return inMem;
  return await loadPresentationDraftIntoMemory(interaction, token);
}

function clampStr(v, maxLen) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function buildEmbedField(name, lines, maxLen = DISCORD_EMBED_FIELD_VALUE_MAX) {
  let value = lines.join('\n');
  if (value.length > maxLen) value = value.slice(0, maxLen - 1) + '…';
  return { name, value, inline: false };
}

function isDiscordEmbedLengthError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return err?.code === 50035 || msg.includes('embed') || msg.includes('1024') || msg.includes('length');
}

function doneKeys(obj, keys) {
  return keys.every((k) => (obj?.[k] || '').trim().length > 0);
}

function isPresentationComplete(session) {
  return (
    doneKeys(session?.identite, ['pseudo', 'age', 'localisation', 'genre', 'orientation', 'recherche', 'situation']) &&
    doneKeys(session?.apparence, ['taille', 'poids', 'yeux', 'cheveux', 'tatouages', 'style']) &&
    doneKeys(session?.apropos, ['aime', 'deteste', 'positifs', 'negatifs', 'passions', 'dm'])
  );
}

function presentationDraftHasData(data) {
  const hasKeys = (obj) => obj && Object.values(obj).some((v) => String(v || '').trim().length > 0);
  return hasKeys(data?.identite) || hasKeys(data?.apparence) || hasKeys(data?.apropos);
}

function buildPresentationPanelEmbed(interaction, session) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setTitle('Présentation — Assistant')
    .setAuthor(getBotAuthor(interaction.client))
    .setDescription(
      [
        `Utilisateur : <@${session.userId}>`,
        '',
        `- 🌈 Identité : ${doneKeys(session.identite, ['pseudo', 'age', 'localisation', 'genre', 'orientation', 'recherche', 'situation']) ? '✅' : '⏳'}`,
        `- 👘 Apparence : ${doneKeys(session.apparence, ['taille', 'poids', 'yeux', 'cheveux', 'tatouages', 'style']) ? '✅' : '⏳'}`,
        `- ✍🏼 À propos : ${doneKeys(session.apropos, ['aime', 'deteste', 'positifs', 'negatifs', 'passions', 'dm']) ? '✅' : '⏳'}`,
        '',
        'Clique sur **Commencer** puis suis les étapes jusqu’à **Finaliser**.',
      ].join('\n')
    )
    .setFooter(getBotFooter(interaction.client, { extra: 'Session présentation (6 h)', date: new Date() }));
  return embed;
}

function buildPresentationStartComponents(token) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`presentation_start_${token}`).setLabel('Commencer la présentation').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`presentation_annuler_${token}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildPresentationFinaliserComponents(token) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`presentation_finaliser_${token}`).setLabel('Finaliser').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`presentation_annuler_${token}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildContinueRow(token, nextAction) {
  const stepNumber =
    nextAction === 'identite_2' ? 1 : nextAction === 'apparence_1' ? 2 : nextAction === 'apropos_1' ? 3 : null;
  const label = stepNumber ? `Suite ${stepNumber}/3` : 'Suite';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`presentation_continue_${nextAction}_${token}`).setLabel(label).setStyle(ButtonStyle.Secondary)
  );
}

function showPresentationModal(interaction, modal) {
  try {
    return interaction.showModal(modal);
  } catch (e) {
    console.error("[Péché Mignon] présentation: showModal échoué:", e?.message || e);
    return interaction.reply({ content: '❌ Impossible d’ouvrir le formulaire (modal).', flags: MessageFlags.Ephemeral });
  }
}

function withPrefill(input, value, max) {
  if (value) input.setValue(clampStr(value, max));
  return input;
}

function buildModalIdentite1(token, session) {
  const modal = new ModalBuilder().setCustomId(`${PRESENTATION_MODAL_CUSTOM_ID}_identite_1_${token}`).setTitle('Présentation — Identité');
  const ident = session?.identite || {};
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('pseudo').setLabel('Prénom / Pseudo').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80), ident.pseudo, 80)
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('age').setLabel('Âge').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16), ident.age, 16)
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('localisation').setLabel('Région').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64), ident.localisation, 64)
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('genre').setLabel('Genre').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32), ident.genre, 32)
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('orientation').setLabel('Orientation (sexuelle)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(48), ident.orientation, 48)
    )
  );
  return modal;
}

function buildModalIdentite2(token, session) {
  const modal = new ModalBuilder().setCustomId(`${PRESENTATION_MODAL_CUSTOM_ID}_identite_2_${token}`).setTitle('Présentation — Identité / Apparence');
  const ident = session?.identite || {};
  const app = session?.apparence || {};
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('recherche').setLabel('Recherche (sur ce serveur)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_RECHERCHE_MAX),
        ident.recherche,
        PRESENTATION_RECHERCHE_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('situation').setLabel('Situation (célibataire/en couple/etc.)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32), ident.situation, 32)
    ),
    new ActionRowBuilder().addComponents(withPrefill(new TextInputBuilder().setCustomId('taille').setLabel('Taille').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16), app.taille, 16)),
    new ActionRowBuilder().addComponents(withPrefill(new TextInputBuilder().setCustomId('poids').setLabel('Poids').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(16), app.poids, 16)),
    new ActionRowBuilder().addComponents(withPrefill(new TextInputBuilder().setCustomId('yeux').setLabel('Couleur des yeux').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24), app.yeux, 24))
  );
  return modal;
}

function buildModalApparence1(token, session) {
  const modal = new ModalBuilder().setCustomId(`${PRESENTATION_MODAL_CUSTOM_ID}_apparence_1_${token}`).setTitle('Présentation — Apparence / À propos');
  const app = session?.apparence || {};
  const apro = session?.apropos || {};
  modal.addComponents(
    new ActionRowBuilder().addComponents(withPrefill(new TextInputBuilder().setCustomId('cheveux').setLabel('Couleur des cheveux').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24), app.cheveux, 24)),
    new ActionRowBuilder().addComponents(withPrefill(new TextInputBuilder().setCustomId('tatouages').setLabel('Tatouages et/ou piercings').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(64), app.tatouages, 64)),
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('style').setLabel('Style vestimentaire').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_STYLE_MAX),
        app.style,
        PRESENTATION_STYLE_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('aime').setLabel('Aime').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_APROPOS_TEXT_MAX),
        apro.aime,
        PRESENTATION_APROPOS_TEXT_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('deteste').setLabel('Déteste').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_APROPOS_TEXT_MAX),
        apro.deteste,
        PRESENTATION_APROPOS_TEXT_MAX
      )
    )
  );
  return modal;
}

function buildModalApropos1(token, session) {
  const modal = new ModalBuilder().setCustomId(`${PRESENTATION_MODAL_CUSTOM_ID}_apropos_1_${token}`).setTitle('Présentation — À propos');
  const apro = session?.apropos || {};
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('positifs').setLabel('Traits positifs').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_APROPOS_TEXT_MAX),
        apro.positifs,
        PRESENTATION_APROPOS_TEXT_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('negatifs').setLabel('Traits négatifs').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_APROPOS_TEXT_MAX),
        apro.negatifs,
        PRESENTATION_APROPOS_TEXT_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(
        new TextInputBuilder().setCustomId('passions').setLabel('Passions').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(PRESENTATION_APROPOS_TEXT_MAX),
        apro.passions,
        PRESENTATION_APROPOS_TEXT_MAX
      )
    ),
    new ActionRowBuilder().addComponents(
      withPrefill(new TextInputBuilder().setCustomId('dm').setLabel('DM (ouverts / sur demande / fermés)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(24), apro.dm, 24)
    )
  );
  return modal;
}

function buildFinalPresentationEmbed(interaction, session) {
  const user = interaction.user;
  const avatar = user?.displayAvatarURL?.({ size: 256 });
  const SEP = '┈┈୨୧┈┈୨୧┈┈୨୧┈┈';
  const f = (label, val, maxLen) => {
    const v = maxLen ? clampStr(val, maxLen) : val && String(val).trim() ? String(val).trim() : '';
    return `✦ **${label} :** ${v || '—'}`;
  };
  const ident = session.identite || {};
  const app = session.apparence || {};
  const apro = session.apropos || {};

  const embed = new EmbedBuilder()
    .setColor(COLOR_OTHER)
    .setAuthor(getBotAuthor(interaction.client))
    .setDescription(`\u200b\nPrésentation de <@${user.id}>\n\u200b`)
    .addFields(
      buildEmbedField('🌈 Identité', [
        SEP,
        '',
        f('Prénom / Pseudo', ident.pseudo),
        f('Âge', ident.age),
        f('Région', ident.localisation),
        f('Genre', ident.genre),
        f('Orientation', ident.orientation),
        f('Recherche', ident.recherche, PRESENTATION_RECHERCHE_MAX),
        f('Situation', ident.situation),
        '\u200b',
      ]),
      buildEmbedField('👘 Apparence', [
        SEP,
        '',
        f('Taille', app.taille),
        f('Poids', app.poids),
        f('Couleur des yeux', app.yeux),
        f('Couleur des cheveux', app.cheveux),
        f('Tatouages / piercings', app.tatouages),
        f('Style vestimentaire', app.style, PRESENTATION_STYLE_MAX),
        '\u200b',
      ]),
      buildEmbedField('✍🏼 À propos', [
        SEP,
        '',
        f('Aime', apro.aime, PRESENTATION_APROPOS_TEXT_MAX),
        f('Déteste', apro.deteste, PRESENTATION_APROPOS_TEXT_MAX),
        f('Traits positifs', apro.positifs, PRESENTATION_APROPOS_TEXT_MAX),
        f('Traits négatifs', apro.negatifs, PRESENTATION_APROPOS_TEXT_MAX),
        f('Passions', apro.passions, PRESENTATION_APROPOS_TEXT_MAX),
        f('DM', apro.dm),
        '\u200b',
      ])
    )
    .setFooter(getBotFooter(interaction.client, { date: new Date() }));
  if (avatar) embed.setThumbnail(avatar);
  return embed;
}

function parseReactionIdentifier(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/discord\.com\/assets\//i.test(s)) return null;
  const fromCdn = s.match(/emojis\/(\d+)/i);
  if (fromCdn) {
    return {
      id: fromCdn[1],
      animated: /animated=true/i.test(s) || /<a:/i.test(s),
    };
  }
  const parsed = parseEmoji(s);
  if (parsed?.id) return { id: parsed.id, animated: Boolean(parsed.animated) };
  if (/^\d{17,20}$/.test(s)) return { id: s, animated: false };
  return s;
}

async function resolveReactEmoji(guild, parsed) {
  if (!parsed) return null;
  if (typeof parsed === 'string') return parsed;
  const id = parsed.id;
  if (!id) return parsed;
  let emoji = guild?.emojis?.cache.get(id);
  if (!emoji && guild?.emojis?.fetch) {
    try {
      emoji = await guild.emojis.fetch(id);
    } catch (_) {
      try {
        const all = await guild.emojis.fetch();
        emoji = all.get(id);
      } catch (_) {}
    }
  }
  if (emoji) return emoji;
  return parsed.animated ? `a:${id}` : `_:${id}`;
}

async function addPresentationPostReactions(message, guild) {
  const reactions = (config.presentationReactions || []).slice(0, 2);
  if (!reactions.length || !message?.react) return;
  const channel = message.channel;
  const me = guild?.members?.me ?? (guild && channel ? await guild.members.fetchMe().catch(() => null) : null);
  if (me && channel && !me.permissionsIn(channel).has(PermissionFlagsBits.AddReactions)) {
    console.warn(`[Péché Mignon] présentation: permission « Ajouter des réactions » manquante sur ${channel.id}.`);
    return;
  }
  for (let i = 0; i < reactions.length; i++) {
    const raw = reactions[i];
    try {
      const parsed = parseReactionIdentifier(raw);
      const emoji = await resolveReactEmoji(guild, parsed);
      if (!emoji) continue;
      await message.react(emoji);
      if (i < reactions.length - 1) await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.warn(`[Péché Mignon] présentation réaction « ${raw} » impossible:`, e?.message || e);
    }
  }
}

export const presentationCommands = [
  new SlashCommandBuilder()
    .setName('presentation')
    .setNameLocalizations({ fr: 'présentation' })
    .setDescription('Créer ta présentation via un formulaire')
    .setDescriptionLocalizations({ fr: 'Créer ta présentation via un formulaire' })
    .toJSON(),
];

export function isPresentationModal(customId) {
  return typeof customId === 'string' && customId.startsWith(PRESENTATION_MODAL_CUSTOM_ID);
}

export function isPresentationButton(customId) {
  return typeof customId === 'string' && customId.startsWith('presentation_') && !customId.startsWith('presentation_continue_');
}

export function isPresentationContinueButton(customId) {
  return typeof customId === 'string' && customId.startsWith('presentation_continue_');
}

export async function handlePresentation(interaction) {
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }

  const existingDraft = await getPresentationDraft(interaction.guild.id, interaction.user.id, 'generale').catch(() => null);
  if (existingDraft?.data_json) {
    let data = {};
    try {
      data = JSON.parse(existingDraft.data_json || '{}') || {};
    } catch (_) {
      data = {};
    }
    if (presentationDraftHasData(data)) {
      const token = existingDraft.token || newPresentationToken();
      const session = upsertPresentationSession(token, {
        token,
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        identite: data.identite || {},
        apparence: data.apparence || {},
        apropos: data.apropos || {},
      });
      await persistPresentationDraft(session);
      const complete = isPresentationComplete(session);
      const components = complete ? buildPresentationFinaliserComponents(token) : buildPresentationStartComponents(token);
      const content = complete
        ? '📋 **Brouillon retrouvé** — ta présentation est complète. Clique sur **Finaliser** pour publier.'
        : '📋 **Brouillon retrouvé** — reprends là où tu t’étais arrêté(e).';
      await interaction.reply({
        content,
        embeds: [buildPresentationPanelEmbed(interaction, session)],
        components,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
        fetchReply: true,
      });
      try {
        const msg = await interaction.fetchReply();
        if (msg?.id) {
          const s2 = upsertPresentationSession(token, { panelMessageId: msg.id });
          await persistPresentationDraft(s2);
        }
      } catch (_) {}
      schedulePresentationEphemeralCleanup(interaction, complete);
      return;
    }
  }

  const token = newPresentationToken();
  const session = upsertPresentationSession(token, {
    token,
    userId: interaction.user.id,
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    identite: {},
    apparence: {},
    apropos: {},
  });
  await persistPresentationDraft(session);
  await interaction.reply({
    embeds: [buildPresentationPanelEmbed(interaction, session)],
    components: buildPresentationStartComponents(token),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
    fetchReply: true,
  });
  try {
    const msg = await interaction.fetchReply();
    if (msg?.id) {
      const s2 = upsertPresentationSession(token, { panelMessageId: msg.id });
      await persistPresentationDraft(s2);
    }
  } catch (_) {}
  schedulePresentationEphemeralCleanup(interaction, false);
}

export async function handlePresentationModalSubmit(interaction) {
  const customId = String(interaction.customId || '');
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: '❌ Commande utilisable uniquement sur un serveur.', flags: MessageFlags.Ephemeral });
  }
  const parts = customId.split('_');
  const token = parts[parts.length - 1];
  const step = parts.slice(3, parts.length - 1).join('_');

  const session = await getPresentationSessionAsync(interaction, token);
  if (!session) {
    return interaction.reply({
      content: '⏱️ Session de présentation introuvable/expirée (souvent après redémarrage). Relance `/présentation`.',
      flags: MessageFlags.Ephemeral,
    });
  }
  if (session.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Cette session ne t’appartient pas.', flags: MessageFlags.Ephemeral });
  }

  let nextAction = null;
  if (step === 'identite_1') {
    const s2 = upsertPresentationSession(token, {
      identite: {
        ...session.identite,
        pseudo: interaction.fields.getTextInputValue('pseudo')?.trim() || '',
        age: interaction.fields.getTextInputValue('age')?.trim() || '',
        localisation: interaction.fields.getTextInputValue('localisation')?.trim() || '',
        genre: interaction.fields.getTextInputValue('genre')?.trim() || '',
        orientation: interaction.fields.getTextInputValue('orientation')?.trim() || '',
      },
    });
    await persistPresentationDraft(s2);
    nextAction = 'identite_2';
  } else if (step === 'identite_2') {
    const s2 = upsertPresentationSession(token, {
      identite: {
        ...session.identite,
        recherche: clampStr(interaction.fields.getTextInputValue('recherche'), PRESENTATION_RECHERCHE_MAX),
        situation: interaction.fields.getTextInputValue('situation')?.trim() || '',
      },
      apparence: {
        ...session.apparence,
        taille: interaction.fields.getTextInputValue('taille')?.trim() || '',
        poids: interaction.fields.getTextInputValue('poids')?.trim() || '',
        yeux: interaction.fields.getTextInputValue('yeux')?.trim() || '',
      },
    });
    await persistPresentationDraft(s2);
    nextAction = 'apparence_1';
  } else if (step === 'apparence_1') {
    const s2 = upsertPresentationSession(token, {
      apparence: {
        ...session.apparence,
        cheveux: interaction.fields.getTextInputValue('cheveux')?.trim() || '',
        tatouages: interaction.fields.getTextInputValue('tatouages')?.trim() || '',
        style: clampStr(interaction.fields.getTextInputValue('style'), PRESENTATION_STYLE_MAX),
      },
      apropos: {
        ...session.apropos,
        aime: clampStr(interaction.fields.getTextInputValue('aime'), PRESENTATION_APROPOS_TEXT_MAX),
        deteste: clampStr(interaction.fields.getTextInputValue('deteste'), PRESENTATION_APROPOS_TEXT_MAX),
      },
    });
    await persistPresentationDraft(s2);
    nextAction = 'apropos_1';
  } else if (step === 'apparence_2') {
    const s2 = upsertPresentationSession(token, {
      apparence: { ...session.apparence, style: clampStr(interaction.fields.getTextInputValue('style'), PRESENTATION_STYLE_MAX) },
    });
    await persistPresentationDraft(s2);
    nextAction = 'apropos_1';
  } else if (step === 'apropos_1') {
    const s2 = upsertPresentationSession(token, {
      apropos: {
        ...session.apropos,
        positifs: clampStr(interaction.fields.getTextInputValue('positifs'), PRESENTATION_APROPOS_TEXT_MAX),
        negatifs: clampStr(interaction.fields.getTextInputValue('negatifs'), PRESENTATION_APROPOS_TEXT_MAX),
        passions: clampStr(interaction.fields.getTextInputValue('passions'), PRESENTATION_APROPOS_TEXT_MAX),
        dm: interaction.fields.getTextInputValue('dm')?.trim() || '',
      },
    });
    await persistPresentationDraft(s2);
    nextAction = 'finaliser';
  } else if (step === 'apropos_2') {
    const s2 = upsertPresentationSession(token, {
      apropos: { ...session.apropos, dm: interaction.fields.getTextInputValue('dm')?.trim() || '' },
    });
    await persistPresentationDraft(s2);
    nextAction = 'finaliser';
  }

  try {
    if (nextAction === 'finaliser') {
      await interaction.reply({
        content: '✅ Dernière étape enregistrée. Clique sur **Finaliser** pour publier.',
        components: buildPresentationFinaliserComponents(token),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
    await interaction.reply({
      content: '✅ Enregistré. Clique sur **Suite**.',
      components: [
        buildContinueRow(token, nextAction),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`presentation_annuler_${token}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)),
      ],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    schedulePresentationEphemeralCleanup(interaction, false);
  } catch (_) {}
}

export async function handlePresentationButton(interaction) {
  const customId = String(interaction.customId || '');
  const parts = customId.split('_');
  const action = parts[1];
  const token = parts.slice(2).join('_');

  const session = await getPresentationSessionAsync(interaction, token);
  if (!session) {
    return interaction.reply({ content: '⏱️ Session de présentation introuvable/expirée. Relance `/présentation`.', flags: MessageFlags.Ephemeral });
  }
  if (session.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Cette session ne t’appartient pas.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'annuler') {
    clearPresentationSession(token, session);
    try {
      if (interaction.guild?.id && interaction.user?.id) {
        await deletePresentationDraft(interaction.guild.id, interaction.user.id, 'generale').catch(() => {});
      }
    } catch (_) {}
    return interaction.reply({ content: '✅ Session annulée.', flags: MessageFlags.Ephemeral });
  }

  if (action === 'start') {
    return showPresentationModal(interaction, buildModalIdentite1(token, session));
  }

  if (action === 'finaliser') {
    if (!isPresentationComplete(session)) {
      return interaction.reply({
        content: '❌ Ta présentation n’est pas complète. Termine les catégories Identité / Apparence / À propos puis retente **Finaliser**.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = buildFinalPresentationEmbed(interaction, session);
    const notify = async (content) => {
      try {
        return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch (_) {
        return null;
      }
    };

    let sent = false;
    let deleteFailed = false;
    try {
      const guildId = interaction.guild?.id;
      const userId = interaction.user?.id;
      const existing = guildId && userId ? await getPresentationMessage(guildId, userId, 'generale').catch(() => null) : null;
      const sessionChannelId = config.presentationChannelId || session.channelId || interaction.channelId;

      if (existing?.channel_id && existing?.message_id) {
        try {
          const ch = await interaction.client.channels.fetch(existing.channel_id).catch(() => null);
          const msg = ch && typeof ch.messages?.fetch === 'function' ? await ch.messages.fetch(existing.message_id).catch(() => null) : null;
          if (msg) {
            await msg.delete().catch((e) => {
              deleteFailed = true;
              throw e;
            });
          }
        } catch (_) {}
      }

      const ch = sessionChannelId ? await interaction.client.channels.fetch(sessionChannelId).catch(() => null) : null;
      if (ch && typeof ch.send === 'function') {
        const newMsg = await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
        if (guildId && userId && newMsg?.id) {
          await upsertPresentationMessage(guildId, userId, sessionChannelId, newMsg.id, 'generale').catch(() => {});
        }
        await addPresentationPostReactions(newMsg, interaction.guild).catch(() => {});
        sent = true;
      }
    } catch (e) {
      console.error("[Péché Mignon] présentation: envoi embed final échoué:", e?.message || e);
      try {
        if (interaction.guild?.id && interaction.user?.id) {
          await deletePresentationMessage(interaction.guild.id, interaction.user.id, 'generale').catch(() => {});
        }
      } catch (_) {}
      if (isDiscordEmbedLengthError(e)) {
        await notify('❌ Ta présentation est trop longue pour Discord. Raccourcis surtout **Passions**, **Aime**, **Traits** ou **Style**, puis reclique **Finaliser**.');
        return;
      }
    }

    if (sent) {
      await notify(deleteFailed ? '✅ Présentation publiée. ⚠️ Je n’ai pas pu supprimer l’ancienne (permissions).' : '✅ Présentation publiée.');
    } else {
      await notify('⚠️ Présentation enregistrée, mais impossible de l’envoyer dans ce salon (droits/accès).');
    }
    setTimeout(() => interaction.deleteReply().catch(() => {}), 60_000);
    clearPresentationSession(token, session);
    try {
      if (interaction.guild?.id && interaction.user?.id) {
        await deletePresentationDraft(interaction.guild.id, interaction.user.id, 'generale').catch(() => {});
      }
    } catch (_) {}
  }
}

export async function handlePresentationContinueButton(interaction) {
  const customId = String(interaction.customId || '');
  const parts = customId.split('_');
  const token = parts[parts.length - 1];
  const nextAction = parts.slice(2, parts.length - 1).join('_');

  const session = await getPresentationSessionAsync(interaction, token);
  if (!session) {
    return interaction.reply({ content: '⏱️ Session de présentation introuvable/expirée. Relance `/présentation`.', flags: MessageFlags.Ephemeral });
  }
  if (session.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Cette session ne t’appartient pas.', flags: MessageFlags.Ephemeral });
  }

  let modal = null;
  if (nextAction === 'identite_2') modal = buildModalIdentite2(token, session);
  if (nextAction === 'apparence_1' || nextAction === 'apparence_2') modal = buildModalApparence1(token, session);
  if (nextAction === 'apropos_1' || nextAction === 'apropos_2') modal = buildModalApropos1(token, session);
  if (!modal) return interaction.reply({ content: '❌ Action inconnue.', flags: MessageFlags.Ephemeral });
  return showPresentationModal(interaction, modal);
}
