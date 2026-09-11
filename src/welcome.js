import { config } from './config.js';

const WELCOME_PHRASES = [
  'Bienvenue {user} 💋 Ici les mauvaises idées sont souvent les meilleures.',
  '{user} a goûté au fruit défendu 🍎 Trop tard pour reculer.',
  '{user} vient de pousser la porte 🏡  Bienvenue chez nous !',
  'Bienvenue {user} 🍁 Pose tes valises et fais comme chez toi.',
];

const recentlyWelcomed = new Map();
const WELCOME_DEDUP_MS = 10 * 60 * 1000;

function memberHasWelcomeRole(member) {
  if (!member?.roles || !config.welcomeRoleIds.size) return false;
  const roles = member.roles.cache ?? member.roles;
  if (typeof roles.has === 'function') {
    for (const id of config.welcomeRoleIds) {
      if (roles.has(id)) return true;
    }
    return false;
  }
  if (Array.isArray(roles)) {
    return roles.some((id) => config.welcomeRoleIds.has(String(id)));
  }
  return false;
}

function markWelcomed(userId) {
  const now = Date.now();
  for (const [id, ts] of recentlyWelcomed) {
    if (now - ts > WELCOME_DEDUP_MS) recentlyWelcomed.delete(id);
  }
  if (recentlyWelcomed.has(userId)) return false;
  recentlyWelcomed.set(userId, now);
  return true;
}

function pickPhrase(mention) {
  const template = WELCOME_PHRASES[Math.floor(Math.random() * WELCOME_PHRASES.length)];
  return template.replaceAll('{user}', mention);
}

export async function sendWelcomeMessage(member) {
  const channelId = config.welcomeChannelId;
  if (!channelId || !config.welcomeRoleIds.size) return;
  if (!member?.user || member.user.bot) return;
  if (!memberHasWelcomeRole(member)) return;
  if (!markWelcomed(member.id)) return;

  const channel = await member.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.warn(`[Péché Mignon] Salon bienvenue introuvable: ${channelId}`);
    return;
  }

  const mention = `<@${member.id}>`;
  try {
    await channel.send({
      content: pickPhrase(mention),
      allowedMentions: { users: [member.id] },
    });
  } catch (err) {
    recentlyWelcomed.delete(member.id);
    console.warn(`[Péché Mignon] Envoi bienvenue impossible:`, err?.message || err);
  }
}

export async function handleWelcomeMemberAdd(member) {
  try {
    await sendWelcomeMessage(member);
  } catch (err) {
    console.error("[Péché Mignon] Erreur bienvenue (join):", err?.message || err);
  }
}

export async function handleWelcomeMemberUpdate(oldMember, newMember) {
  try {
    if (!oldMember?.roles?.cache?.size) return;
    if (memberHasWelcomeRole(oldMember)) return;
    await sendWelcomeMessage(newMember);
  } catch (err) {
    console.error("[Péché Mignon] Erreur bienvenue (rôle):", err?.message || err);
  }
}
