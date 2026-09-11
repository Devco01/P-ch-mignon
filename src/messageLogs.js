import { EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import { COLOR_SANCTION, getBotAuthor, getBotFooter } from './embeds.js';

const FIELD_MAX = 1024;
const UNAVAILABLE = '*Contenu non disponible (message hors cache).*';

function clip(text, max = FIELD_MAX) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 15)}\n… *(tronqué)*`;
}

function attachmentsLine(message) {
  const list = [...(message?.attachments?.values?.() || [])]
    .map((a) => a.name || a.url)
    .filter(Boolean);
  if (!list.length) return '';
  return list.map((n) => `• ${n}`).join('\n');
}

function formatBody(message) {
  if (!message || message.partial) return UNAVAILABLE;
  const parts = [];
  const content = String(message.content || '').trim();
  if (content) parts.push(content);
  const files = attachmentsLine(message);
  if (files) parts.push(`**Fichiers :**\n${files}`);
  if (!parts.length) {
    if (message.embeds?.length) return '*Embed / média (pas de texte).*';
    return '*Message vide.*';
  }
  return clip(parts.join('\n\n'));
}

function shouldIgnore(message) {
  if (!config.messageLogChannelId) return true;
  if (!message?.guild) return true;
  if (config.guildId && message.guild.id !== config.guildId) return true;
  if (message.channelId === config.messageLogChannelId) return true;
  if (message.author?.bot) return true;
  return false;
}

async function getLogChannel(client) {
  const channel = await client.channels.fetch(config.messageLogChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  return channel;
}

function authorLabel(message) {
  const user = message.author;
  if (!user) return 'Auteur inconnu';
  return `<@${user.id}> (\`${user.tag}\` · \`${user.id}\`)`;
}

function channelLabel(message) {
  const id = message.channelId;
  return id ? `<#${id}>` : 'Salon inconnu';
}

export async function handleMessageLogDelete(message) {
  if (shouldIgnore(message)) return;
  const log = await getLogChannel(message.client);
  if (!log) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(message.client))
    .setTitle('Message supprimé')
    .addFields(
      { name: 'Auteur', value: authorLabel(message), inline: false },
      { name: 'Salon', value: channelLabel(message), inline: true },
      { name: 'Message d’origine', value: formatBody(message), inline: false }
    )
    .setFooter(getBotFooter(message.client, { extra: 'Logs messages', date: new Date() }));

  if (message.author) {
    embed.setThumbnail(message.author.displayAvatarURL({ size: 128 }));
  }

  await log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    console.warn(`[Péché Mignon] Log suppression impossible:`, err?.message || err);
  });
}

export async function handleMessageLogBulkDelete(messages, channel) {
  if (!config.messageLogChannelId) return;
  if (channel?.id === config.messageLogChannelId) return;
  if (config.guildId && channel?.guildId && channel.guildId !== config.guildId) return;

  const log = await getLogChannel(channel?.client ?? [...(messages?.values?.() || [])][0]?.client);
  if (!log) return;

  const cached = [...(messages?.values?.() || [])].filter((m) => m && !m.author?.bot);
  const count = messages?.size ?? cached.length;
  const preview = cached
    .slice(0, 8)
    .map((m) => {
      const who = m.author ? `${m.author.tag}` : 'inconnu';
      const body = clip(m.content || attachmentsLine(m) || '*vide*', 120).replace(/\n/g, ' ');
      return `• **${who}** : ${body}`;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(log.client))
    .setTitle('Messages supprimés en masse')
    .setDescription(
      `${count} message(s) supprimé(s) dans ${channel?.id ? `<#${channel.id}>` : 'un salon'}.`
    )
    .setFooter(getBotFooter(log.client, { extra: 'Logs messages', date: new Date() }));

  if (preview) embed.addFields({ name: 'Aperçu (cache)', value: clip(preview) });

  await log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    console.warn(`[Péché Mignon] Log purge impossible:`, err?.message || err);
  });
}

export async function handleMessageLogUpdate(oldMessage, newMessage) {
  let fresh = newMessage;
  if (fresh?.partial) {
    try {
      fresh = await fresh.fetch();
    } catch {
      return;
    }
  }
  if (shouldIgnore(fresh)) return;

  const oldContent = String(oldMessage?.content ?? '');
  const newContent = String(fresh.content ?? '');
  const oldAtt = attachmentsLine(oldMessage);
  const newAtt = attachmentsLine(fresh);
  if (oldContent === newContent && oldAtt === newAtt) return;
  if (oldMessage?.partial && !oldContent && oldContent === newContent) return;

  const log = await getLogChannel(fresh.client);
  if (!log) return;

  const embed = new EmbedBuilder()
    .setColor(COLOR_SANCTION)
    .setAuthor(getBotAuthor(fresh.client))
    .setTitle('Message modifié')
    .addFields(
      { name: 'Auteur', value: authorLabel(fresh), inline: false },
      { name: 'Salon', value: channelLabel(fresh), inline: true },
      { name: 'Message d’origine', value: formatBody(oldMessage?.partial ? null : oldMessage), inline: false },
      { name: 'Nouveau message', value: formatBody(fresh), inline: false }
    )
    .setFooter(getBotFooter(fresh.client, { extra: 'Logs messages', date: new Date() }));

  if (fresh.author) {
    embed.setThumbnail(fresh.author.displayAvatarURL({ size: 128 }));
  }
  if (fresh.url) {
    embed.addFields({ name: 'Lien', value: `[Aller au message](${fresh.url})`, inline: false });
  }

  await log.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    console.warn(`[Péché Mignon] Log édition impossible:`, err?.message || err);
  });
}
