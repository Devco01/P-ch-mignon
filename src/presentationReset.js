import { config } from './config.js';
import { clearPresentationDataForChannel } from './database.js';

export async function purgePresentationDataForChannelReset(channelId, context = {}) {
  if (!channelId || !config.presentationResetChannelIds.has(channelId)) return null;

  const result = await clearPresentationDataForChannel(channelId).catch((err) => {
    console.error(`[Pêche Mignon] Purge présentations salon ${channelId} échouée:`, err?.message || err);
    return null;
  });
  if (!result) return null;

  const { messages = 0, drafts = 0 } = result;
  if (messages > 0 || drafts > 0) {
    const extra = context.deletedCount != null ? ` (${context.deletedCount} msg Discord supprimés)` : '';
    console.log(
      `[Pêche Mignon] Salon présentation reset (${channelId})${extra} → ${messages} publication(s) et ${drafts} brouillon(s) retirés de la base.`
    );
  }
  return result;
}

export function isPresentationResetChannel(channelId) {
  return Boolean(channelId && config.presentationResetChannelIds.has(channelId));
}

export async function handlePresentationChannelBulkDelete(channel, deletedCount) {
  const channelId = channel?.id;
  if (!isPresentationResetChannel(channelId)) return;
  if ((deletedCount ?? 0) < config.presentationResetMinBulk) return;
  await purgePresentationDataForChannelReset(channelId, { deletedCount });
}

export async function handlePresentationChannelDelete(channel) {
  const channelId = channel?.id;
  if (!isPresentationResetChannel(channelId)) return;
  await purgePresentationDataForChannelReset(channelId, { reason: 'channel_delete' });
}
