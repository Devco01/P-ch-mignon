/**
 * Validation stricte des IDs Discord (snowflakes).
 */
const DISCORD_ID_REGEX = /^\d{17,20}$/;

export function isValidDiscordId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const str = String(value).trim();
  if (!str) return false;
  if (!DISCORD_ID_REGEX.test(str)) return false;
  const n = BigInt(str);
  return n >= 0n && n <= 0xFFFFFFFFFFFFFFFFn;
}

/** Extrait un ID Discord depuis une mention <@id> / <@!id> ou un ID brut. */
export function parseUserIdFromOption(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const mentionMatch = str.match(/^<@!?(\d{17,20})>$/);
  const id = mentionMatch ? mentionMatch[1] : str;
  return isValidDiscordId(id) ? id : null;
}

const MAX_REASON_LENGTH = 500;
const SAFE_REASON_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeReason(reason) {
  if (reason == null) return null;
  let s = String(reason).replace(SAFE_REASON_REGEX, '').trim();
  if (s.length > MAX_REASON_LENGTH) s = s.slice(0, MAX_REASON_LENGTH);
  return s || null;
}

/** Formate une date/heure pour affichage en français (heure France). */
export function formatBanDate(dateStr) {
  if (!dateStr) return '—';
  let s = String(dateStr).trim();
  if (!s) return '—';
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  });
}

/** Date + heure pour le footer des embeds (format court). */
export function formatFooterDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  });
}
