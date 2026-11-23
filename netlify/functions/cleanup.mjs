// Scheduled Function (free on Netlify), runs every hour:
//  - deletes a lobby's Discord channels + category 14 days after it was marked completed
//  - moves channels made before per-lobby categories into the lobby's own category
//  - for repeating lobbies: opens the next dates for sign-up, and deletes each date's
//    channels 14 days after that date (or right away if the host skipped it)

import { db } from '../lib/db.mjs';
import { deleteLobbyChannels, deleteRoom, hasChannels, moveIntoOwnCategory } from '../lib/discord.mjs';
import { syncSessionSchedule } from '../lib/model.mjs';

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

export async function runCleanup(nowMs = Date.now()) {
  const lobbies = await db.lobbies.all();
  let deleted = 0;
  for (const l of lobbies) {
    const before = JSON.stringify(l);
    try {
      if (l.recurrence) {
        for (const s of syncSessionSchedule(l, nowMs)) await deleteRoom(s.discord);
        for (const s of l.sessions || []) {
          if (!s.discord?.textId || s.discord.deletedAt) continue;
          if (s.status === 'skipped' || nowMs - Date.parse(s.at) >= TWO_WEEKS) {
            await deleteRoom(s.discord);
            deleted++;
          }
        }
      }
      // Older lobbies whose channels sit in a shared category get their own one.
      if (l.status !== 'cancelled' && hasChannels(l)) await moveIntoOwnCategory(l);
      if (l.status === 'completed' && l.completedAt && hasChannels(l) && nowMs - Date.parse(l.completedAt) >= TWO_WEEKS) {
        await deleteLobbyChannels(l);
        deleted++;
      }
    } catch (e) {
      console.error(`cleanup failed for lobby ${l.id}`, e.message);
    }
    if (JSON.stringify(l) !== before) await db.lobbies.put(l);
  }
  console.log(`cleanup: deleted channels for ${deleted} lobbies/dates`);
  return deleted;
}

export default async () => {
  await runCleanup();
  return new Response('ok');
};

export const config = { schedule: '@hourly' };
