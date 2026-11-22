# Create & Connect

A site where YouTube and Twitch creators meet, post **lobbies** for streams and videos ("Mario Party Friday!"), show off collabs they've done, and automatically get a **private Discord text + voice channel** in the *Create and Connect* server once a lobby has 2+ people.

Everything runs on free tiers: **Netlify** (hosting, serverless functions, scheduled functions, Netlify Blobs database) and **Discord** (OAuth login + a bot that only uses the REST API).

## Features

- **Discord-verified accounts.** You sign up with "Log in with Discord". The site reads your exact Discord username from Discord itself, so nobody can claim a tag that isn't theirs. Logging in also adds you to the Create and Connect server (`guilds.join` scope).
- **Creator profiles.** Platforms (YouTube, Twitch), content categories (Gaming, IRL, STEM, Beauty, …), bio, and what you're looking for.
- **Collab showcase.** Add YouTube or Twitch videos, VODs, and clips. You have to confirm that you own the content or have the owner's explicit permission. Anyone you tag is asked to confirm, and once they do it shows on their profile too. Videos play inline.
- **Lobbies** with five visibility modes:
  | Mode | Who can see it | How you join |
  |---|---|---|
  | Public | Everyone | Click Join and you take a slot |
  | Approval | Everyone | You go into a request queue; the host or a co-host approves |
  | Code | Everyone | You enter a 4-digit code. Only the host and co-hosts can see it, and they can regenerate it |
  | Private | Only invited creators | By invite |
  | Friends | Only the host's friends | Friends join directly |
- Co-hosts, invites, kick, slot limits, scheduled time, and mark completed or reopen.
- **Discord automation.** At 2+ members the bot creates a hidden text channel and a voice channel that only lobby members can see. Access updates when people join, leave, or get removed.
- **Cleanup.** A scheduled function runs every hour and deletes a lobby's channels **14 days after the lobby is marked completed**. If a lobby is cancelled, its channels are deleted right away.
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
6. Optional: create a category such as "Lobbies", right-click it, and choose **Copy Channel ID**. This is `DISCORD_CATEGORY_ID`, and lobby channels will be created inside that category.

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
| `DISCORD_CATEGORY_ID` | *(optional)* from step 1.6 |
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
- If a lobby member has left the Discord server, the bot can't give them channel access. The lobby page shows who is missing; logging out and back in re-adds them to the server.
