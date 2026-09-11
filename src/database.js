/**
 * Point d'entrée base de données.
 * - Si MONGODB_URI (ou MONGO_URI) est défini : MongoDB (données persistantes).
 * - Sinon : SQLite local (data/peche-mignon.db).
 */
let useMongo = false;
let backend = null;

export async function initDatabase() {
  const uri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  useMongo = uri.length > 0;
  if (useMongo) {
    const m = await import('./databaseMongo.js');
    await m.initDatabase();
    backend = m;
  } else {
    backend = await import('./databaseSqlite.js');
    await backend.initDatabase();
  }
  return backend;
}

function getBackend() {
  if (!backend) throw new Error("[Péché Mignon] initDatabase() doit être appelé au démarrage (index.js).");
  return backend;
}

function wrap(name) {
  return async (...args) => {
    const b = getBackend();
    return useMongo ? b[name](...args) : Promise.resolve(b[name](...args));
  };
}

export const tryAcquireInstanceLock = wrap('tryAcquireInstanceLock');
export const renewInstanceLock = wrap('renewInstanceLock');
export const releaseInstanceLock = wrap('releaseInstanceLock');
export async function getInstanceLockInfo(...args) {
  const b = getBackend();
  if (!useMongo) return Promise.resolve(null);
  return b.getInstanceLockInfo(...args);
}

export const tryAcquireInteraction = wrap('tryAcquireInteraction');

export const addBannedUser = wrap('addBannedUser');
export const getBannedUser = wrap('getBannedUser');
export const removeBannedUser = wrap('removeBannedUser');
export const updateBannedUser = wrap('updateBannedUser');
export const updateBanProofMessage = wrap('updateBanProofMessage');
export const getBannedUserByProofThreadId = wrap('getBannedUserByProofThreadId');
export const addBanProof = wrap('addBanProof');
export const deleteBanProofsByMessageId = wrap('deleteBanProofsByMessageId');

export const addAvertissement = wrap('addAvertissement');
export const getAvertissementCount = wrap('getAvertissementCount');
export const listAvertissementsForUser = wrap('listAvertissementsForUser');
export const deleteAvertissementById = wrap('deleteAvertissementById');

export const getPresentationMessage = wrap('getPresentationMessage');
export const upsertPresentationMessage = wrap('upsertPresentationMessage');
export const deletePresentationMessage = wrap('deletePresentationMessage');
export const clearPresentationDataForChannel = wrap('clearPresentationDataForChannel');
export const getPresentationDraft = wrap('getPresentationDraft');
export const upsertPresentationDraft = wrap('upsertPresentationDraft');
export const deletePresentationDraft = wrap('deletePresentationDraft');
export const cleanupPresentationDrafts = wrap('cleanupPresentationDrafts');

export const createTicket = wrap('createTicket');
export const getTicketByThreadId = wrap('getTicketByThreadId');
export const getOpenTicketForUser = wrap('getOpenTicketForUser');
export const claimTicket = wrap('claimTicket');
export const closeTicket = wrap('closeTicket');
export const setTicketPanel = wrap('setTicketPanel');
export const getTicketPanel = wrap('getTicketPanel');

export const upsertConfessionLogConfig = wrap('upsertConfessionLogConfig');
export const removeConfessionLogConfig = wrap('removeConfessionLogConfig');
export const clearAllConfessionLogConfigsForGuild = wrap('clearAllConfessionLogConfigsForGuild');
export const listConfessionLogConfigsForGuild = wrap('listConfessionLogConfigsForGuild');
export const findConfessionLogConfig = wrap('findConfessionLogConfig');
export const incrementConfessionNumber = wrap('incrementConfessionNumber');
