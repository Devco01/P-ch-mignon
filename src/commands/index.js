import { moderationCommands } from './moderation.js';
import { presentationCommands } from './presentation.js';
import { ticketCommands } from './tickets.js';
import { confessionCommands } from './confession.js';
import { reglementCommands } from './reglement.js';
import { informationsCommands } from './informations.js';
import { threadCommands } from '../autoThreads.js';

export const commands = [
  ...moderationCommands,
  ...presentationCommands,
  ...ticketCommands,
  ...confessionCommands,
  ...reglementCommands,
  ...informationsCommands,
  ...threadCommands,
];
