// Calendar feeds (iCalendar / .ics) for repeating lobbies.
// Each person gets a private feed per lobby that lists only the dates they're
// going to. Google Calendar (or Apple / Outlook) subscribes to it once, and from
// then on new sign-ups appear and dropped dates disappear by themselves.

import { endOf } from './model.mjs';

const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes are folded, as the format requires. */
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * The .ics text for one person's dates in one lobby.
 * Without an end time each date is shown as an hour long.
 */
export function lobbyFeed(lobby, uid, { siteUrl, discordUrl }) {
  const page = `${siteUrl}/#/lobbies/${lobby.id}`;
  const going = lobby.status === 'cancelled' ? [] : (lobby.sessions || [])
    .filter((s) => s.status !== 'skipped' && s.memberIds.includes(uid));
  const now = stamp(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Create & Connect//Lobbies//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(lobby.title)}`,
    `X-WR-CALDESC:${text(`Your dates for ${lobby.title} on Create & Connect`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const s of going) {
    const end = endOf(lobby, s.at) || new Date(Date.parse(s.at) + 3600e3).toISOString();
    const chat = discordUrl(s);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${lobby.id}-${s.key}@create-connect`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(s.at)}`,
      `DTEND:${stamp(end)}`,
      `SUMMARY:${text(lobby.title)}`,
      ...(lobby.place ? [`LOCATION:${text(lobby.place)}`] : []),
      `DESCRIPTION:${text([lobby.game, `Lobby: ${page}`, chat ? `Discord chat: ${chat}` : ''].filter(Boolean).join('\n'))}`,
      `URL:${page}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
