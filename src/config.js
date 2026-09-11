import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const discloudPaths = [
  path.join(process.cwd(), 'discloud.config'),
  path.join(__dirname, '..', 'discloud.config'),
];
for (const discloudConfigPath of discloudPaths) {
  if (fs.existsSync(discloudConfigPath)) {
    const content = fs.readFileSync(discloudConfigPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).trim();
      }
      if (key && !process.env[key]) process.env[key] = value;
    }
    break;
  }
}

dotenv.config();

const ADMIN_ROLE_IDS_RAW = process.env.ADMIN_ROLE_IDS || '';
const RATE_LIMIT = Math.min(100, Math.max(1, parseInt(process.env.RATE_LIMIT_PER_MINUTE, 10) || 10));
const useGuildMembersIntent = /^(1|true|yes|on)$/i.test((process.env.GUILD_MEMBERS_INTENT || 'true').trim());
const useMessageContentIntent = /^(1|true|yes|on)$/i.test((process.env.MESSAGE_CONTENT_INTENT || 'false').trim());

function parseHexColor(raw, fallback) {
  const hex = String(raw || '')
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return fallback;
  return parseInt(hex, 16);
}

function parseCsvList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePresentationReactions() {
  const list = [
    (process.env.PRESENTATION_REACTION_1 || '').trim(),
    (process.env.PRESENTATION_REACTION_2 || '').trim(),
  ].filter(Boolean);
  if (list.length) return list.slice(0, 2);
  return parseSelfieReactionIds().slice(0, 2);
}

function parsePresentationResetChannelIds() {
  const raw = process.env.PRESENTATION_RESET_CHANNEL_IDS || process.env.PRESENTATION_CHANNEL_ID || '';
  return new Set(parseCsvList(raw));
}

function parseSelfieChannelIds() {
  return new Set(parseCsvList(process.env.SELFIE_CHANNEL_IDS || ''));
}

function parseAutoThreadChannelIds() {
  return new Set(parseCsvList(process.env.AUTO_THREAD_CHANNEL_IDS || ''));
}

function parseSelfieReactionIds() {
  const fromIds = parseCsvList(process.env.SELFIE_REACTION_IDS || '');
  const fromUrls = parseCsvList(process.env.SELFIE_REACTIONS || '');
  return fromIds.length ? fromIds : fromUrls;
}

function envId(key) {
  const v = (process.env[key] || '').trim();
  return v || null;
}

function parsePresentationResetMinBulk() {
  const n = parseInt(process.env.PRESENTATION_RESET_MIN_BULK, 10);
  if (!Number.isFinite(n) || n < 2) return 2;
  return Math.min(n, 100);
}

export const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID || null,
  adminRoleIds: new Set(parseCsvList(ADMIN_ROLE_IDS_RAW)),
  founderUserId: (process.env.FOUNDER_USER_ID || '').trim() || null,
  rateLimitPerMinute: RATE_LIMIT,
  useGuildMembersIntent,
  useMessageContentIntent,
  /** Embeds de sanctions (ban, warn, unban, unwarn). */
  embedColorSanction: parseHexColor(process.env.EMBED_COLOR_SANCTION || process.env.DISCORD_EMBED_COLOR_SANCTION, 0xef233c),
  /** Embeds hors sanctions (présentation, tickets, analyse). */
  embedColorOther: parseHexColor(process.env.EMBED_COLOR_OTHER || process.env.DISCORD_EMBED_COLOR_OTHER, 0xf6b3ce),
  /** Marque footer / auteur des embeds (règlement, infos, sanctions). */
  embedBrand: (process.env.EMBED_BRAND || 'Pêche Mignon').trim() || 'Pêche Mignon',
  presentationReactions: parsePresentationReactions(),
  presentationResetChannelIds: parsePresentationResetChannelIds(),
  presentationResetMinBulk: parsePresentationResetMinBulk(),
  presentationChannelId: envId('PRESENTATION_CHANNEL_ID'),
  selfieChannelIds: parseSelfieChannelIds(),
  selfieReactionIds: parseSelfieReactionIds(),
  autoThreadChannelIds: parseAutoThreadChannelIds(),
  ticketStaffRoleIds: parseCsvList(process.env.TICKET_STAFF_ROLE_IDS || ''),
  ticketChannelId: envId('TICKET_CHANNEL_ID'),
  /** Salon des transcripts (tickets fermés). */
  ticketTranscriptChannelId: envId('TICKET_TRANSCRIPT_CHANNEL_ID'),
  /** Salon des modalités (lien cliquable sur le bouton partenariat). */
  ticketPartenariatModalitesChannelId: envId('TICKET_PARTENARIAT_MODALITES_CHANNEL_ID'),
  /** Salon où poster l’embed de signalement après un ban. */
  banLogChannelId: envId('BAN_LOG_CHANNEL_ID'),
  /** Rôle donné via le bouton « Lu et approuvé » du règlement. */
  reglementMemberRoleId: envId('REGLEMENT_MEMBER_ROLE_ID'),
  /** Emoji du titre du règlement (`<:nom:id>` ou unicode). */
  reglementSakuraEmoji: envId('REGLEMENT_SAKURA_EMOJI') || '🌸',
  infoChannelId: envId('INFO_CHANNEL_ID'),
  infoLevel1RoleId: envId('INFO_LEVEL_1_ROLE_ID'),
  infoLevel5RoleId: envId('INFO_LEVEL_5_ROLE_ID'),
  infoMpChannelId: envId('INFO_MP_CHANNEL_ID'),
};

export function validateConfig() {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN');
  if (config.adminRoleIds.size === 0) missing.push('ADMIN_ROLE_IDS');
  if (missing.length > 0) {
    throw new Error(`Variables d'environnement manquantes: ${missing.join(', ')}. Copie .env.example vers .env.`);
  }
}
