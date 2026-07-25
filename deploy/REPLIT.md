# Deploying SpotSpace to Replit (no credit card)

Replit's free tier doesn't ask for a card to sign up, and a Repl's
filesystem persists between runs (unlike most ephemeral free PaaS
containers) — good enough to hold uploaded songs without extra setup.

**Read this before committing to it**: Replit's exact free-tier limits
(storage quota, whether a free Repl sleeps when idle, whether "always on"
hosting requires a paid plan) have shifted more than once and I can't
verify current numbers from here — check replit.com's current pricing
page for those specifics, especially the storage quota, since that's the
one that directly caps how many songs you can hold.

## 1. Sign up + import

1. Create a free account at replit.com (no card).
2. **Create Repl → Import from GitHub** → paste
   `https://github.com/ohgahbriel/spotspace` → Replit should auto-detect
   it as a Node.js project (it reads `package.json`'s `scripts.start`,
   already set to `node server.js`).

## 2. Config already in the repo

Two things are pre-set so this works without manual fiddling:
- `.replit` sets `HOST=0.0.0.0` (required — Replit's proxy can't reach
  the app if it's only listening on localhost) and maps the app's port
  5075 to external port 80.
- `package.json`'s `start` script already points at `server.js`.

If Replit's importer doesn't pick up `.replit` automatically, open the
**Configure** / **Run command** panel in the Repl and set it manually:
run command `node server.js`, with an environment variable `HOST` set to
`0.0.0.0`.

## 3. Run it

Click **Run**. Replit shows a webview with the live URL (something like
`https://spotspace.<your-username>.repl.co`, though Replit's public URL
scheme has changed before — use whatever the Repl's webview shows you).
That URL is what you'd share.

## 4. Keeping it awake

Free Repls commonly sleep after a period of no traffic and wake back up
on the next request (with a short cold-start delay) — check Replit's
current docs for exact behavior. If a paid "Always On"/Deployments
option exists and matters to you, that's the one place this path isn't
fully free; otherwise, some people ping their Repl periodically (e.g.
with a free external uptime-monitor service) to discourage sleep — works,
but is a workaround rather than an intended feature, and platforms have
cracked down on this pattern before.

## Updating the code later

Since this repo lives on GitHub, pull latest changes from the Repl's
shell:
```
git pull
```
then click **Run** again (or it may auto-restart, depending on how the
Repl is configured).
