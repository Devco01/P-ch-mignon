import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { config } from './config.js';

export async function hasAdminRole(interaction) {
  const member = interaction.member;
  const guild = interaction.guild;
  if (!member || !guild) return false;
  if (interaction.user?.id === guild.ownerId) return true;
  if (config.founderUserId && interaction.user.id === config.founderUserId) return true;

  const mp = interaction.memberPermissions;
  if (mp?.has?.(PermissionFlagsBits.Administrator) || mp?.has?.(PermissionFlagsBits.BanMembers)) return true;

  if (member.permissions) {
    const perms =
      typeof member.permissions?.has === 'function'
        ? member.permissions
        : new PermissionsBitField(BigInt(member.permissions));
    if (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.BanMembers)) return true;
  }

  if (member.roles?.cache?.some?.((r) => config.adminRoleIds.has(r.id))) return true;
  if (Array.isArray(member.roles) && member.roles.some((roleId) => config.adminRoleIds.has(roleId))) return true;

  try {
    const liveMember = await guild.members.fetch(interaction.user.id);
    if (!liveMember) return false;
    if (liveMember.permissions.has(PermissionFlagsBits.Administrator) || liveMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      return true;
    }
    if (liveMember.roles?.cache?.some((r) => config.adminRoleIds.has(r.id))) return true;
  } catch (_) {}
  return false;
}

/** Fermeture des tickets : owner du serveur, fondateur, Administrateur, ou rôle ADMIN_ROLE_IDS. */
export async function canCloseTicket(interaction) {
  const member = interaction.member;
  const guild = interaction.guild;
  if (!member || !guild) return false;
  if (interaction.user?.id === guild.ownerId) return true;
  if (config.founderUserId && interaction.user.id === config.founderUserId) return true;

  const mp = interaction.memberPermissions;
  if (mp?.has?.(PermissionFlagsBits.Administrator)) return true;

  if (member.permissions) {
    const perms =
      typeof member.permissions?.has === 'function'
        ? member.permissions
        : new PermissionsBitField(BigInt(member.permissions));
    if (perms.has(PermissionFlagsBits.Administrator)) return true;
  }

  if (member.roles?.cache?.some?.((r) => config.adminRoleIds.has(r.id))) return true;
  if (Array.isArray(member.roles) && member.roles.some((roleId) => config.adminRoleIds.has(roleId))) return true;

  try {
    const liveMember = await guild.members.fetch(interaction.user.id);
    if (!liveMember) return false;
    if (liveMember.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (liveMember.roles?.cache?.some((r) => config.adminRoleIds.has(r.id))) return true;
  } catch (_) {}
  return false;
}

export function isStaffMember(member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator) || member.permissions?.has?.(PermissionFlagsBits.BanMembers)) {
    return true;
  }
  if (member.permissions?.has?.(PermissionFlagsBits.ManageThreads)) return true;
  if (member.roles?.cache?.some?.((r) => config.adminRoleIds.has(r.id))) return true;
  if (config.ticketStaffRoleIds.some((id) => member.roles?.cache?.has?.(id))) return true;
  return false;
}
