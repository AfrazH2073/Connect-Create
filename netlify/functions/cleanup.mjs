// Scheduled Function (free on Netlify): runs every hour and deletes the Discord
// text + voice channels of lobbies that were marked completed 14+ days ago.

import { db } from '../lib/db.mjs';
import { deleteLobbyChannels } from '../lib/discord.mjs';

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

export async function runCleanup(nowMs = Date.now()) {
  const lobbies = await db.lobbies.all();
  let deleted = 0;
  for (const l of lobbies) {
    if (l.status !== 'completed' || !l.completedAt || !l.discord?.textId || l.discord.deletedAt) continue;
    if (nowMs - Date.parse(l.completedAt) < TWO_WEEKS) continue;
    try {
      await deleteLobbyChannels(l);
      await db.lobbies.put(l);
      deleted++;
    } catch (e) {
      console.error(`cleanup failed for lobby ${l.id}`, e.message);
    }
  }
  console.log(`cleanup: deleted channels for ${deleted} lobbies`);
  return deleted;
}

export default async () => {
  await runCleanup();
  return new Response('ok');
};

export const config = { schedule: '@hourly' };
