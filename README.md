# SpotSpace

A music streamer with MySpace-style artist profile pages — a Spotify-dark
UI where anyone who signs up gets their own customizable page, and
publishing is as simple as dragging audio files onto the site.

Runs entirely on your machine. No external services, no API keys, zero
npm dependencies (built-in Node `http`/`fs`/`crypto` only).

## Run it

```
node server.js
```

Then open **http://127.0.0.1:5075**.

Environment variables (all optional, for deployment):
- `PORT` — defaults to 5075
- `HOST` — defaults to `127.0.0.1` (localhost only). Set `HOST=0.0.0.0` to
  accept connections from other machines — required if you're deploying
  this somewhere and want it reachable over the network.
- `COOKIE_SECURE=true` — marks the session cookie `Secure`; only enable
  this once the app is actually served over HTTPS (e.g. behind a reverse
  proxy), or logins will silently break.

Deploying somewhere so other people can reach it? Two free options:
- [`deploy/DEPLOY.md`](deploy/DEPLOY.md) — Oracle Cloud Always Free (real
  persistent storage, no free-tier data loss surprises; needs a card for
  identity verification, never actually billed).
- [`deploy/REPLIT.md`](deploy/REPLIT.md) — Replit (no card at all; free
  Repls persist storage between runs, but may sleep when idle — check
  Replit's current free-tier terms).

Login, signup, and guestbook posting are all rate-limited per IP, which
matters once this is actually reachable by strangers.

## How it works

- **Sign up** (top-right) creates your artist account — display name,
  username, password — and drops you straight onto your own profile page.
- **Upload & Publish** (sidebar button, requires login): drag in
  MP3/WAV/FLAC/M4A/OGG files, tweak title/artist/album/cover if you like,
  hit **Publish all** — tracks are immediately live under your artist
  name, credited to your account.
- **Your artist page** (MySpace-style): a banner + avatar you can set,
  a tagline, an About Me section, a pick-your-own **theme color** that
  accents your whole page, a **Top Friends** grid, your published
  tracks, and a **guestbook** wall where other logged-in artists can
  leave you a comment. A "profile views" counter ticks up on every visit.
- **Artists** (nav tab) — browse every artist's page on this install.
  Clicking any artist's name anywhere (track rows, cards, comments,
  friend tiles) jumps straight to their profile.
- **Friends** — "+ Add Friend" on someone else's page adds them to
  *your* Top Friends (one-directional, no request/approval step — kept
  simple on purpose).
- **Home / Search / Your Library** show tracks from every artist on
  this install — a shared local catalog, not a private one.
- **Player bar** — play/pause, prev/next, shuffle, repeat (off → all →
  one), a scrubbable seek bar (real HTTP range-request streaming, so
  seeking in large files is instant), and volume (persisted between
  sessions).
- Track `⋯` menu: play, add to playlist, edit info, remove from
  playlist, or delete from library (owner-only — deletes the underlying
  audio/cover files too). Playlists are shared/global, not per-account.
- **Share** — every artist page has a **⤴ Share** button (and every
  track's `⋯` menu has **Share track**), opening a modal with:
  - a copyable **link** to the full profile page
  - one-click buttons for **X, Facebook, Reddit, WhatsApp, and Email**
    (plus a native OS share sheet button when the browser supports it)
  - a real, scan-tested **QR code** (with a "Download PNG" button) —
    handy for flyers or scanning at a show
  - an **embed code** — a self-contained `<iframe>` snippet for pasting
    into another site: the artist's whole track list, or just one song
    if shared from the track menu. The embedded player needs no login
    and no SpotSpace account to view or play.

## Embedding elsewhere

The embed code points at `/embed/<username>` (whole player) or
`/embed/<username>?track=<id>` (single track) — a lightweight standalone
page (`public/embed.html/.css/.js`), separate from the main app, sized
to fit comfortably in a `~400×300` (multi-track) or `~400×130`
(single-track) iframe. It only calls the same public, unauthenticated
API routes the main app already exposes, so it works wherever the
server is reachable — which, since this runs on `127.0.0.1`, in
practice means "embeds work when viewed on the same machine." Deploying
this somewhere with a real address would make the embed links/codes
work from anywhere, with no code changes needed.

## Where your data lives

Everything is stored locally under `library/` next to `server.js`
(gitignored — this is personal content, not project source):

```
library/
  catalog.json     # track metadata (each track has an ownerId)
  playlists.json   # playlists (shared/global)
  users.json       # accounts: hashed passwords (scrypt), profile fields, friends
  sessions.json    # login sessions (cookie-based)
  comments.json    # guestbook comments per profile
  audio/           # uploaded audio files, renamed to their track id
  covers/          # uploaded track cover art
  avatars/         # artist avatar images
  banners/         # artist banner images
```

Delete the `library/` folder to wipe everything (all accounts included)
and start fresh.

## Notes on scope

This is a **local** multi-user tool — every account on it shares one
machine's install; there's no public hosting story. Passwords are
hashed with Node's built-in `scrypt` (not plaintext), which is good
practice regardless, but there's no email verification, rate limiting,
or account recovery — fine for a local install among people you know,
not something to expose to the open internet as-is. If you ever want
strangers signing up over the internet, that's a materially different
project: real infra, abuse handling, and a copyright/DMCA takedown
process for what people upload — worth a fresh conversation before
going there.

## Credits

QR code generation (`public/vendor/qrcodegen.js`) is Nayuki's MIT-licensed
[QR-Code-generator](https://github.com/nayuki/QR-Code-generator) library,
compiled from its TypeScript source and vendored verbatim (not an npm
dependency — everything else is still zero-dependency built-in Node/browser
APIs). See the file header for the exact source and build command.
