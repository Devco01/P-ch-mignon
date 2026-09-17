import { config } from './config.js';

function getFooterBrand() {
  return config.embedBrand || 'Le Nid Douillet⁺¹⁸';
}

export const COLOR_SANCTION = config.embedColorSanction;
export const COLOR_OTHER = config.embedColorOther;

function getBotAvatarIconURL(client) {
  const user = client?.user;
  if (!user) return null;
  return user.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true });
}

function getEmbedBrandIconURL(client) {
  const guildId = config.guildId;
  if (guildId && client) {
    const guild = client.guilds.cache.get(guildId);
    const guildIcon = guild?.iconURL?.({ extension: 'png', size: 128, forceStatic: true });
    if (guildIcon) return guildIcon;
  }
  return getBotAvatarIconURL(client);
}

export function getBotAuthor(client) {
  const iconURL = getEmbedBrandIconURL(client);
  const name = getFooterBrand();
  return iconURL ? { name, iconURL } : { name };
}

export function getBotFooter(client, _options = {}) {
  const text = config.embedFooter || 'Le Nid Douillet⁺¹⁸ | © All rights reserved.';
  const iconURL = getEmbedBrandIconURL(client);
  return iconURL ? { text, iconURL } : { text };
}
