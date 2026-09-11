/**
 * Tags pour les sanctions (ban et avertissement).
 * Raccourcis : une saisie exacte (insensible à la casse) est développée en tag complet.
 */

export const BAN_TAGS = [
  'Leaks (Violation ToS & cf. Code Pénal)',
  'Arnaque et/ou scam et/ou Escroquerie (Violation ToS & cf. Code Pénal)',
  'Pédopornographie (Violation ToS & cf. Code Pénal)',
  'Zoophilie (Violation ToS & cf. Code Pénal)',
  'Usurpation d\'identité (Violation ToS & cf. Code Pénal)',
  'Doxxing et/ou raid (Violation ToS & cf. Code Pénal)',
  'Mineur présent/participant à un serveur NSFW (Violation ToS)',
  'Menace et/ou intimidation (Violation ToS & cf. Code Pénal)',
  'Violence psychologique (Violation ToS & cf. Code Pénal)',
  'Diffamation',
  'Comportement toxique',
  'Comportement problématique',
  'Fake (Violation ToS & cf. Code Pénal)',
  'Fake : utilisation de l\'IA (Violation ToS & cf. Code Pénal)',
  'Opportuniste',
  'Comportement déplacé et/ou messages sexuels non sollicités',
  'Compte suspect',
  'Compte poubelle et/ou Bot',
  'OFM (manager Only Fan)',
  'Refus de vérification - suspicion de fake',
  'Compte hacké',
];

export const WARN_TAGS = [
  'Ticket abusif',
  'DM sauvage',
  'Demande d\'ami sauvage',
];

const SHORT_TO_FULL_TAG = {
  Leaks: BAN_TAGS[0],
  Arnaque: BAN_TAGS[1],
  Scam: BAN_TAGS[1],
  Escroquerie: BAN_TAGS[1],
  Pédophilie: BAN_TAGS[2],
  Pedophilie: BAN_TAGS[2],
  Pédopornographie: BAN_TAGS[2],
  Pedopornographie: BAN_TAGS[2],
  Pedo: BAN_TAGS[2],
  Zoophilie: BAN_TAGS[3],
  Usurpation: BAN_TAGS[4],
  Doxxing: BAN_TAGS[5],
  Raid: BAN_TAGS[5],
  Mineur: BAN_TAGS[6],
  'Mineur NSFW': BAN_TAGS[6],
  Menace: BAN_TAGS[7],
  Intimidation: BAN_TAGS[7],
  'Violence psychologique': BAN_TAGS[8],
  Violence: BAN_TAGS[8],
  Diffamation: BAN_TAGS[9],
  'Comportement toxique': BAN_TAGS[10],
  Toxique: BAN_TAGS[10],
  'Comportement problématique': BAN_TAGS[11],
  Problématique: BAN_TAGS[11],
  Fake: BAN_TAGS[12],
  'Fake IA': BAN_TAGS[13],
  'Utilisation IA': BAN_TAGS[13],
  Opportuniste: BAN_TAGS[14],
  'Comportement déplacé': BAN_TAGS[15],
  Déplacé: BAN_TAGS[15],
  'Compte suspect': BAN_TAGS[16],
  Suspect: BAN_TAGS[16],
  'Compte poubelle': BAN_TAGS[17],
  Poubelle: BAN_TAGS[17],
  Bot: BAN_TAGS[17],
  OFM: BAN_TAGS[18],
  'Manager Only Fan': BAN_TAGS[18],
  'Refus de vérification': BAN_TAGS[19],
  'Refus vérification': BAN_TAGS[19],
  'Refus verification': BAN_TAGS[19],
  'Suspicion de fake': BAN_TAGS[19],
  'Suspicion fake': BAN_TAGS[19],
  'Compte hacké': BAN_TAGS[20],
  'Compte hacke': BAN_TAGS[20],
  Hacke: BAN_TAGS[20],
  'Ticket abusif': WARN_TAGS[0],
  'DM sauvage': WARN_TAGS[1],
  'Demande d\'ami sauvage': WARN_TAGS[2],
};

export function resolveReasonToFullTag(reason) {
  if (reason == null || typeof reason !== 'string') return reason;
  const trimmed = reason.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const [short, full] of Object.entries(SHORT_TO_FULL_TAG)) {
    if (short.toLowerCase() === lower) return full;
  }
  return trimmed;
}
