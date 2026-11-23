// Flags hosts raise when completing a lobby, sent to the admin-only Discord channel.

import { db } from './db.mjs';
import { postToAdmins } from './discord.mjs';

/** Site admins: Discord user IDs in ADMIN_DISCORD_IDS (comma-separated). They can open any lobby and see its flags. */
export const isAdmin = (uid) => !!uid && (process.env.ADMIN_DISCORD_IDS || '').split(',').map((s) => s.trim()).includes(uid);

const who = (u, id) => u ? `**${u.displayName || u.discordUsername}** (@${u.discordUsername}, <@${id}>, ID ${id})` : `user ${id}`;

/**
 * Send every flag on this lobby that hasn't reached the admins yet.
 * Marks them reported on success; failures are retried by the hourly cleanup.
 */
export async function reportLobbyFlags(lobby, siteUrl) {
  const pending = (lobby.flags || []).filter((f) => !f.reported);
  if (!pending.length) return true;
  const ids = [...new Set([lobby.hostId, ...pending.flatMap((f) => [f.userId, f.by]), ...lobby.memberIds])];
  const people = Object.fromEntries((await Promise.all(ids.map((id) => db.users.get(id)))).filter(Boolean).map((u) => [u.id, u]));
  // One message per person who flagged, so each report reads on its own.
  const byReporter = new Map();
  for (const f of pending) byReporter.set(f.by, [...(byReporter.get(f.by) || []), f]);
  try {
    for (const [by, flags] of byReporter) {
      const lines = [
        `🚩 ${who(people[by], by)} flagged ${flags.length === 1 ? 'someone' : `${flags.length} people`} when completing **${lobby.title}**`,
        `Lobby: ${siteUrl}/#/lobbies/${lobby.id} · ${lobby.visibility} · host ${who(people[lobby.hostId], lobby.hostId)}`,
        `Members: ${lobby.memberIds.map((id) => people[id]?.discordUsername ? `@${people[id].discordUsername}` : id).join(', ')}`,
        '',
        ...flags.map((f) => `• ${who(people[f.userId], f.userId)}\n  > ${f.reason.replace(/\n+/g, ' ')}`),
      ];
      await postToAdmins(db.meta, lines.join('\n'));
      for (const f of flags) { f.reported = true; f.reportedAt = new Date().toISOString(); }
    }
    return true;
  } catch (e) {
    console.error(`could not send flags for lobby ${lobby.id} to admins`, e.message);
    return false;
  }
}
