# Create & Connect

A site where creators from YouTube, Twitch, TikTok, Instagram, X / Twitter and Substack meet, post **lobbies** for streams and videos ("Mario Party Friday!"), show off collabs they've done, and automatically get a **private Discord text + voice channel** in the *Create and Connect* server once a lobby has 2+ people.

Everything runs on free tiers: **Netlify** (hosting, serverless functions, scheduled functions, Netlify Blobs database) and **Discord** (OAuth login + a bot that only uses the REST API).

## Features

- **Discord-verified accounts.** You sign up with "Log in with Discord". The site reads your exact Discord username from Discord itself, so nobody can claim a tag that isn't theirs. Logging in also adds you to the Create and Connect server (`guilds.join` scope).
- **Creator profiles.** Your own display name, profile picture (upload one or keep your Discord picture), pronouns, banner colour, platforms (YouTube, Twitch, TikTok, Instagram, X / Twitter, Substack), content categories (Gaming, IRL, STEM, Beauty, …), bio, and what you're looking for. Your verified Discord username always shows too.
- **Reviews.** On someone else's profile, click **Ask for a review**. They get it in their inbox, give 1–5 stars and write how you are to collab with. New reviews stay hidden until you choose **Show on profile**. You can hide or delete them later.
- **Collab history.** An opt-in profile setting lists the completed lobbies you were in, and who with. A lobby only counts if it had 2+ people, the host marked it completed, and nobody flagged you in it.
- **Flags.** When a host or co-host marks a lobby completed, they can flag anyone who caused problems, with a reason. The flagged person isn't told. Flags are posted to a Discord channel only server admins can see, and that lobby is left out of the flagged person's history.
- **Collab showcase.** Add YouTube or Twitch videos, VODs, and clips. You have to confirm that you own the content or have the owner's explicit permission. Anyone you tag is asked to confirm, and once they do it shows on their profile too. Videos play inline.
- **Lobbies** with four types:
  | Type | Who can see it | How you join |
  |---|---|---|
  | Public | Everyone | Click Join and you take a slot |
  | Friends | Only the host's friends | Friends join directly |
  | Private | Only invited creators | By invite |
  | Code | Everyone | You enter a 4-digit code. Only the host and co-hosts can see it, and they can regenerate it |

  Public, Friends and Private lobbies can also turn on **Needs approval**. Then everyone who can see the lobby, invited people and friends included, goes into a request queue, and the host or a co-host approves them. Code lobbies never use approval, because having the code is enough. Lobbies made with the old "Approval" type now read as Public with approval on.
- Co-hosts, invites, kick, slot limits, scheduled time, and mark completed or reopen.
- **Times.** Start and an optional expected end, picked in 5-minute steps like Google Calendar. Anyone in a lobby (or signed up for a date) gets an **Add to Google Calendar** button with the time, place and lobby link filled in. For repeating lobbies it's a private **calendar feed** instead: add it once, and every date you sign up for later shows up in your calendar by itself (dates you drop are removed). Google Calendar refreshes feeds a few times a day, so new dates can take a few hours. Feed links are signed with `SESSION_SECRET`, so changing that secret breaks existing feed links.
- **Repeating lobbies.** Pick a first date and a repeat (every day, every 1–4 weeks, or every month, optionally until a date). The next 6 dates are always open, and people sign up for just the dates they can make. Slots are per date. Hosts can skip a single date (or restore it). Times stay the same local time across daylight-saving changes.
- **Discord automation.** Every lobby gets its **own category** in the server. At 2+ members the bot creates a hidden text channel and a voice channel in it that only lobby members can see. For repeating lobbies, each date gets its own pair once 2+ people sign up for that date, and the names start with the date, e.g. `2026-12-07-smash-bros`. Access updates when people join, leave, sign up, withdraw, or get removed.
- **Cleanup.** A scheduled function runs every hour. It deletes a lobby's channels and category **14 days after the lobby is marked completed**, and each repeating date's channels 14 days after that date (right away if the host skipped it). If a lobby is cancelled, everything is deleted right away.
- Inbox for join requests, invites, friend requests, and collab tags. There is also a friends list.

## Project layout

```
public/                 static frontend (no build step): index.html, app.js, styles.css
netlify/functions/
  api.mjs               the whole REST API (/api/*)
  cleanup.mjs           hourly scheduled job, deletes channels 14 days after completion
netlify/lib/            db (Netlify Blobs), session cookies, Discord, rules
scripts/smoke-test.mjs  end-to-end API tests with a fake Discord (npm test)
scripts/dev-server.mjs  local preview with fake logins (npm run dev:local)
netlify.toml            build and redirect config (Netlify reads it automatically)
```

---

## Setup

### 1. Discord application and bot (free)

1. Go to <https://discord.com/developers/applications> and choose **New Application**. Name it "Create & Connect".
2. **OAuth2** tab:
   - Copy the **Client ID**. This is `DISCORD_CLIENT_ID`.
   - Click **Reset Secret** and copy it. This is `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add `https://YOUR-SITE.netlify.app/api/auth/callback` using your real Netlify URL. If you'll run `netlify dev`, also add `http://localhost:8888/api/auth/callback`.
3. **Bot** tab: click **Reset Token** and copy it. This is `DISCORD_BOT_TOKEN`. You don't need any privileged intents.
4. Invite the bot to your server: **OAuth2 → URL Generator**, select scope **bot** and permission **Administrator**. Open the generated URL and pick the *Create and Connect* server.
   - If you'd rather not use Administrator, the minimum is: Manage Channels, Manage Roles, Create Instant Invite, View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Add Reactions, Connect, Speak, Video, Use Voice Activity.
5. Server ID: in Discord go to **User Settings → Advanced** and turn on **Developer Mode**. Then right-click the server icon and choose **Copy Server ID**. This is `DISCORD_GUILD_ID`.

The bot creates a new category for every lobby, so you don't need to make one. (`DISCORD_CATEGORY_ID` from older versions is no longer used and can be deleted.)

### 2. Netlify

Push this repo to GitHub, then in Netlify choose **Add new site → Import from Git** and pick the repo. Fill the build settings like this. `netlify.toml` sets the same values, so they apply either way.

| Field | Value |
|---|---|
| Base directory | *(leave empty)* |
| Build command | *(leave empty)* |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |

**Environment variables** (Site configuration → Environment variables):

| Key | Value |
|---|---|
| `DISCORD_CLIENT_ID` | from step 1.2 |
| `DISCORD_CLIENT_SECRET` | from step 1.2 (mark as secret) |
| `DISCORD_BOT_TOKEN` | from step 1.3 (mark as secret) |
| `DISCORD_GUILD_ID` | from step 1.5 |
| `SESSION_SECRET` | any long random string. Generate one with `openssl rand -hex 32` |
| `ADMIN_DISCORD_IDS` | *(optional)* comma-separated Discord user IDs of site admins. They can open any lobby (even private ones) and see its flags |
| `DISCORD_ADMIN_CHANNEL_ID` | *(optional)* a channel you made for flag reports. If unset, the bot creates `#create-connect-reports`, hidden from everyone except server admins |
| `SITE_URL` | *(optional)* e.g. `https://create-and-connect.netlify.app`. Pins the OAuth redirect to one domain |

You don't need to set up a database: Netlify Blobs is enabled automatically.

Deploy. Then make sure the redirect URL in Discord (step 1.2) exactly matches your live site URL.

### 3. Local development

```bash
npm install
npm test            # API tests with a fake Discord
npm run dev:local   # http://localhost:8888, use /dev/login?name=alice to fake a login
```

To run against the real Discord app, use `npx netlify-cli dev` with the env vars above (`netlify link`, then `netlify env:list`).

## Notes and limits

- Netlify Blobs is a key/value store, and list pages load every record. That's fine for hundreds to low thousands of users and lobbies. Past that, move to a free Postgres such as Supabase or Neon.
- A Discord server can have at most 500 channels, categories included. Each lobby uses 1 category plus 2 channels (2 per date for repeating lobbies), and cleanup frees them 14 days after the lobby or date is over.
- Profile pictures are shrunk to 256×256 in the browser and stored in Netlify Blobs.
- If a lobby member has left the Discord server, the bot can't give them channel access. The lobby page shows who is missing; logging out and back in re-adds them to the server.
