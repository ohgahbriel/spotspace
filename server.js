// SpotSpace — music streamer with MySpace-style artist profile pages.
// Zero external dependencies: built-in http/fs/crypto only.
// Run: node server.js  ->  http://127.0.0.1:5075

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5075;
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to accept connections from outside this machine
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true'; // enable once served over HTTPS
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const LIBRARY_DIR = path.join(ROOT, 'library');
const AUDIO_DIR = path.join(LIBRARY_DIR, 'audio');
const COVERS_DIR = path.join(LIBRARY_DIR, 'covers');
const AVATARS_DIR = path.join(LIBRARY_DIR, 'avatars');
const BANNERS_DIR = path.join(LIBRARY_DIR, 'banners');
const CATALOG_FILE = path.join(LIBRARY_DIR, 'catalog.json');
const PLAYLISTS_FILE = path.join(LIBRARY_DIR, 'playlists.json');
const USERS_FILE = path.join(LIBRARY_DIR, 'users.json');
const SESSIONS_FILE = path.join(LIBRARY_DIR, 'sessions.json');
const COMMENTS_FILE = path.join(LIBRARY_DIR, 'comments.json');

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024; // 300MB per request, generous for lossless files
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

// ---------- bootstrap storage ----------
function ensureLibrary() {
  for (const dir of [LIBRARY_DIR, AUDIO_DIR, COVERS_DIR, AVATARS_DIR, BANNERS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(CATALOG_FILE)) writeJSON(CATALOG_FILE, { tracks: [] });
  if (!fs.existsSync(PLAYLISTS_FILE)) writeJSON(PLAYLISTS_FILE, { playlists: [] });
  if (!fs.existsSync(USERS_FILE)) writeJSON(USERS_FILE, { users: [] });
  if (!fs.existsSync(SESSIONS_FILE)) writeJSON(SESSIONS_FILE, { sessions: {} });
  if (!fs.existsSync(COMMENTS_FILE)) writeJSON(COMMENTS_FILE, { comments: [] });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------- mime ----------
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac',
  '.aac': 'audio/aac', '.opus': 'audio/opus', '.webm': 'audio/webm',
};
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function notFound(res, msg) { sendJSON(res, 404, { error: msg || 'Not found' }); }
function badRequest(res, msg) { sendJSON(res, 400, { error: msg || 'Bad request' }); }

// ---------- body readers ----------
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (limit && size > limit) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJSONBody(req) {
  const buf = await readRawBody(req, 5 * 1024 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

// ---------- multipart/form-data parser (binary-safe, no deps) ----------
function parseContentType(header) {
  const parts = header.split(';').map((s) => s.trim());
  const type = parts[0];
  let boundary = null;
  for (const p of parts.slice(1)) {
    const m = /^boundary=(.*)$/i.exec(p);
    if (m) boundary = m[1].replace(/^"|"$/g, '');
  }
  return { type, boundary };
}

function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const boundaryBuf = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return { fields, files };

  while (true) {
    const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
    if (next === -1) break;

    let part = buffer.slice(start + boundaryBuf.length, next);
    // strip leading CRLF after the boundary marker
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
    // strip trailing CRLF right before the next boundary marker
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = part.slice(0, headerEnd).toString('utf8');
      const body = part.slice(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerStr);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerStr);
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
      const name = nameMatch ? nameMatch[1] : null;
      if (name) {
        if (filenameMatch && filenameMatch[1]) {
          files[name] = {
            filename: filenameMatch[1],
            contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
            data: body,
          };
        } else {
          fields[name] = body.toString('utf8');
        }
      }
    }
    start = next;
  }
  return { fields, files };
}

// ---------- range-enabled file streaming ----------
function serveFileRange(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stats) => {
    if (err) return notFound(res, 'File missing');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let startPos = m && m[1] ? parseInt(m[1], 10) : 0;
      let endPos = m && m[2] ? parseInt(m[2], 10) : stats.size - 1;
      if (isNaN(startPos)) startPos = 0;
      if (isNaN(endPos) || endPos >= stats.size) endPos = stats.size - 1;
      if (startPos > endPos || startPos >= stats.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${startPos}-${endPos}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': endPos - startPos + 1,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath, { start: startPos, end: endPos }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ---------- static file serving ----------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res); // traversal guard
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- embeddable player page ----------
// Every path under /embed/ serves the same static shell; embed.js reads the
// username (and optional ?track= id) from window.location itself.
function serveEmbedPage(req, res) {
  const filePath = path.join(PUBLIC_DIR, 'embed.html');
  fs.stat(filePath, (err, stats) => {
    if (err) return notFound(res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------- helpers ----------
function newId() { return crypto.randomUUID(); }

function extFor(filename, fallbackMap, fallbackExt) {
  const ext = path.extname(filename || '').toLowerCase();
  if (fallbackMap[ext]) return ext;
  return fallbackExt;
}

function deriveTitleFromFilename(filename) {
  const base = filename.replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
}

// ---------- auth: passwords, cookies, sessions ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}
function verifyPassword(password, salt, hash) {
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}
function setSessionCookie(res, token) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ss_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`);
}
function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ss_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
function createSession(userId) {
  const sessionsData = readJSON(SESSIONS_FILE, { sessions: {} });
  const token = newId();
  sessionsData.sessions[token] = { userId, createdAt: new Date().toISOString() };
  writeJSON(SESSIONS_FILE, sessionsData);
  return token;
}
function destroySession(token) {
  const sessionsData = readJSON(SESSIONS_FILE, { sessions: {} });
  delete sessionsData.sessions[token];
  writeJSON(SESSIONS_FILE, sessionsData);
}
function getCurrentUser(req) {
  const token = parseCookies(req).ss_session;
  if (!token) return null;
  const sessionsData = readJSON(SESSIONS_FILE, { sessions: {} });
  const session = sessionsData.sessions[token];
  if (!session) return null;
  const usersData = readJSON(USERS_FILE, { users: [] });
  return usersData.users.find((u) => u.id === session.userId) || null;
}
function toPublicUser(u) {
  if (!u) return null;
  const { passwordHash, passwordSalt, ...pub } = u;
  return pub;
}
function findUserByUsername(usersData, username) {
  const lower = (username || '').toLowerCase();
  return usersData.users.find((u) => u.username.toLowerCase() === lower);
}
function attachOwnerUsernames(tracks, usersData) {
  return tracks.map((t) => {
    const owner = t.ownerId ? usersData.users.find((u) => u.id === t.ownerId) : null;
    return { ...t, ownerUsername: owner ? owner.username : null };
  });
}

// ---------- rate limiting (in-memory, per IP) ----------
// Fine for a single-process deployment; resets on restart, which is an acceptable
// tradeoff for a small self-hosted install rather than pulling in a store/dependency.
const rateLimitBuckets = new Map(); // key -> { count, resetAt }
function checkRateLimit(key, maxAttempts, windowMs) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateLimitBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= maxAttempts;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function getClientIp(req) {
  // Direct connections only (no reverse proxy in front) — if you later add one,
  // switch this to trust X-Forwarded-For from that proxy specifically.
  return req.socket.remoteAddress || 'unknown';
}

// ---------- route handlers ----------
async function handleUpload(req, res) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in to publish tracks' });

  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) return badRequest(res, 'Expected multipart/form-data');
  const { boundary } = parseContentType(ct);
  if (!boundary) return badRequest(res, 'Missing multipart boundary');

  let raw;
  try {
    raw = await readRawBody(req, MAX_UPLOAD_BYTES);
  } catch {
    return sendJSON(res, 413, { error: 'File too large' });
  }
  const { fields, files } = parseMultipart(raw, boundary);
  const audioFile = files.audio;
  if (!audioFile || !audioFile.data || !audioFile.data.length) {
    return badRequest(res, 'No audio file provided');
  }

  const id = newId();
  const audioExt = extFor(audioFile.filename, AUDIO_MIME, '.mp3');
  const audioName = `${id}${audioExt}`;
  fs.writeFileSync(path.join(AUDIO_DIR, audioName), audioFile.data);

  let coverName = null;
  const coverFile = files.cover;
  if (coverFile && coverFile.data && coverFile.data.length) {
    const coverExt = extFor(coverFile.filename, IMAGE_MIME, '.jpg');
    coverName = `${id}${coverExt}`;
    fs.writeFileSync(path.join(COVERS_DIR, coverName), coverFile.data);
  }

  const title = (fields.title || '').trim() || deriveTitleFromFilename(audioFile.filename);
  const artist = (fields.artist || '').trim() || user.displayName;
  const album = (fields.album || '').trim() || 'Singles';
  const durationSec = parseFloat(fields.duration) || 0;

  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const track = {
    id, title, artist, album, durationSec,
    file: audioName, cover: coverName, ownerId: user.id,
    addedAt: new Date().toISOString(),
    playCount: 0, lastPlayedAt: null,
  };
  catalog.tracks.push(track);
  writeJSON(CATALOG_FILE, catalog);

  sendJSON(res, 201, { ...track, ownerUsername: user.username });
}

function handleListTracks(req, res) {
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const usersData = readJSON(USERS_FILE, { users: [] });
  sendJSON(res, 200, attachOwnerUsernames(catalog.tracks, usersData));
}

async function handleUpdateTrack(req, res, id) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const track = catalog.tracks.find((t) => t.id === id);
  if (!track) return notFound(res, 'Track not found');
  if (track.ownerId && track.ownerId !== user.id) return sendJSON(res, 403, { error: 'Not your track' });
  for (const field of ['title', 'artist', 'album']) {
    if (typeof body[field] === 'string' && body[field].trim()) track[field] = body[field].trim();
  }
  writeJSON(CATALOG_FILE, catalog);
  sendJSON(res, 200, { ...track, ownerUsername: user.username });
}

function handleDeleteTrack(req, res, id) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const idx = catalog.tracks.findIndex((t) => t.id === id);
  if (idx === -1) return notFound(res, 'Track not found');
  if (catalog.tracks[idx].ownerId && catalog.tracks[idx].ownerId !== user.id) {
    return sendJSON(res, 403, { error: 'Not your track' });
  }
  const [track] = catalog.tracks.splice(idx, 1);
  writeJSON(CATALOG_FILE, catalog);
  try { fs.unlinkSync(path.join(AUDIO_DIR, track.file)); } catch {}
  if (track.cover) { try { fs.unlinkSync(path.join(COVERS_DIR, track.cover)); } catch {} }

  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  let changed = false;
  for (const pl of playlists.playlists) {
    const before = pl.trackIds.length;
    pl.trackIds = pl.trackIds.filter((tid) => tid !== id);
    if (pl.trackIds.length !== before) changed = true;
  }
  if (changed) writeJSON(PLAYLISTS_FILE, playlists);

  sendJSON(res, 200, { ok: true });
}

function handleStream(req, res, id) {
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const track = catalog.tracks.find((t) => t.id === id);
  if (!track) return notFound(res, 'Track not found');
  const ext = path.extname(track.file).toLowerCase();
  serveFileRange(req, res, path.join(AUDIO_DIR, track.file), AUDIO_MIME[ext] || 'application/octet-stream');
}

function handleCover(req, res, id) {
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const track = catalog.tracks.find((t) => t.id === id);
  if (!track || !track.cover) return notFound(res, 'No cover');
  const ext = path.extname(track.cover).toLowerCase();
  const filePath = path.join(COVERS_DIR, track.cover);
  fs.stat(filePath, (err, stats) => {
    if (err) return notFound(res, 'No cover');
    res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext] || 'image/jpeg', 'Content-Length': stats.size, 'Cache-Control': 'public, max-age=31536000' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleMarkPlayed(req, res, id) {
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const track = catalog.tracks.find((t) => t.id === id);
  if (!track) return notFound(res, 'Track not found');
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayedAt = new Date().toISOString();
  writeJSON(CATALOG_FILE, catalog);
  sendJSON(res, 200, track);
}

function handleListPlaylists(req, res) {
  sendJSON(res, 200, readJSON(PLAYLISTS_FILE, { playlists: [] }).playlists);
}

async function handleCreatePlaylist(req, res) {
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');
  const name = (body.name || '').trim() || 'New Playlist';
  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  const playlist = { id: newId(), name, createdAt: new Date().toISOString(), trackIds: [] };
  playlists.playlists.push(playlist);
  writeJSON(PLAYLISTS_FILE, playlists);
  sendJSON(res, 201, playlist);
}

async function handleUpdatePlaylist(req, res, id) {
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');
  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  const playlist = playlists.playlists.find((p) => p.id === id);
  if (!playlist) return notFound(res, 'Playlist not found');
  if (typeof body.name === 'string' && body.name.trim()) playlist.name = body.name.trim();
  if (Array.isArray(body.trackIds)) playlist.trackIds = body.trackIds;
  writeJSON(PLAYLISTS_FILE, playlists);
  sendJSON(res, 200, playlist);
}

function handleDeletePlaylist(req, res, id) {
  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  const idx = playlists.playlists.findIndex((p) => p.id === id);
  if (idx === -1) return notFound(res, 'Playlist not found');
  playlists.playlists.splice(idx, 1);
  writeJSON(PLAYLISTS_FILE, playlists);
  sendJSON(res, 200, { ok: true });
}

async function handleAddToPlaylist(req, res, id) {
  const body = await readJSONBody(req);
  if (body === null || !body.trackId) return badRequest(res, 'trackId required');
  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  const playlist = playlists.playlists.find((p) => p.id === id);
  if (!playlist) return notFound(res, 'Playlist not found');
  if (!playlist.trackIds.includes(body.trackId)) playlist.trackIds.push(body.trackId);
  writeJSON(PLAYLISTS_FILE, playlists);
  sendJSON(res, 200, playlist);
}

function handleRemoveFromPlaylist(req, res, id, trackId) {
  const playlists = readJSON(PLAYLISTS_FILE, { playlists: [] });
  const playlist = playlists.playlists.find((p) => p.id === id);
  if (!playlist) return notFound(res, 'Playlist not found');
  playlist.trackIds = playlist.trackIds.filter((tid) => tid !== trackId);
  writeJSON(PLAYLISTS_FILE, playlists);
  sendJSON(res, 200, playlist);
}

// ---------- auth routes ----------
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

async function handleSignup(req, res) {
  if (!checkRateLimit(`signup:${getClientIp(req)}`, 5, 60 * 60 * 1000)) {
    return sendJSON(res, 429, { error: 'Too many accounts created from this address. Try again later.' });
  }
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');
  const username = (body.username || '').trim();
  const password = body.password || '';
  const displayName = (body.displayName || '').trim() || username;

  if (!USERNAME_RE.test(username)) {
    return badRequest(res, 'Username must be 3-20 characters: letters, numbers, underscore only');
  }
  if (password.length < 6) return badRequest(res, 'Password must be at least 6 characters');

  const usersData = readJSON(USERS_FILE, { users: [] });
  if (findUserByUsername(usersData, username)) return sendJSON(res, 409, { error: 'Username already taken' });

  const { salt, hash } = createPasswordHash(password);
  const user = {
    id: newId(), username, passwordHash: hash, passwordSalt: salt, displayName: displayName.slice(0, 60),
    tagline: '', bio: '', avatar: null, banner: null, themeColor: '#1ed760',
    friends: [], profileViews: 0, createdAt: new Date().toISOString(),
  };
  usersData.users.push(user);
  writeJSON(USERS_FILE, usersData);

  const token = createSession(user.id);
  setSessionCookie(res, token);
  sendJSON(res, 201, toPublicUser(user));
}

async function handleLogin(req, res) {
  if (!checkRateLimit(`login:${getClientIp(req)}`, 10, 15 * 60 * 1000)) {
    return sendJSON(res, 429, { error: 'Too many login attempts. Try again in a few minutes.' });
  }
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');
  const username = (body.username || '').trim();
  const password = body.password || '';
  const usersData = readJSON(USERS_FILE, { users: [] });
  const user = findUserByUsername(usersData, username);
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return sendJSON(res, 401, { error: 'Incorrect username or password' });
  }
  const token = createSession(user.id);
  setSessionCookie(res, token);
  sendJSON(res, 200, toPublicUser(user));
}

function handleLogout(req, res) {
  const token = parseCookies(req).ss_session;
  if (token) destroySession(token);
  clearSessionCookie(res);
  sendJSON(res, 200, { ok: true });
}

function handleMe(req, res) {
  sendJSON(res, 200, { user: toPublicUser(getCurrentUser(req)) });
}

// ---------- artist profile routes ----------
function handleListArtists(req, res) {
  const usersData = readJSON(USERS_FILE, { users: [] });
  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const list = usersData.users.map((u) => ({
    ...toPublicUser(u),
    trackCount: catalog.tracks.filter((t) => t.ownerId === u.id).length,
  }));
  sendJSON(res, 200, list);
}

function handleGetArtist(req, res, username) {
  const usersData = readJSON(USERS_FILE, { users: [] });
  const user = findUserByUsername(usersData, username);
  if (!user) return notFound(res, 'Artist not found');

  user.profileViews = (user.profileViews || 0) + 1;
  writeJSON(USERS_FILE, usersData);

  const catalog = readJSON(CATALOG_FILE, { tracks: [] });
  const tracks = catalog.tracks
    .filter((t) => t.ownerId === user.id)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .map((t) => ({ ...t, ownerUsername: user.username }));

  const friends = (user.friends || [])
    .map((fid) => usersData.users.find((u) => u.id === fid))
    .filter(Boolean)
    .map((f) => ({ id: f.id, username: f.username, displayName: f.displayName, avatar: f.avatar }));

  sendJSON(res, 200, { ...toPublicUser(user), friends, tracks });
}

async function handleUpdateMyProfile(req, res) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const body = await readJSONBody(req);
  if (body === null) return badRequest(res, 'Invalid JSON');

  const usersData = readJSON(USERS_FILE, { users: [] });
  const u = usersData.users.find((x) => x.id === user.id);
  if (typeof body.displayName === 'string' && body.displayName.trim()) u.displayName = body.displayName.trim().slice(0, 60);
  if (typeof body.tagline === 'string') u.tagline = body.tagline.trim().slice(0, 120);
  if (typeof body.bio === 'string') u.bio = body.bio.trim().slice(0, 2000);
  if (typeof body.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.themeColor)) u.themeColor = body.themeColor;
  writeJSON(USERS_FILE, usersData);
  sendJSON(res, 200, toPublicUser(u));
}

async function handleProfileImageUpload(req, res, dir, userField) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) return badRequest(res, 'Expected multipart/form-data');
  const { boundary } = parseContentType(ct);
  if (!boundary) return badRequest(res, 'Missing multipart boundary');

  let raw;
  try {
    raw = await readRawBody(req, MAX_IMAGE_BYTES);
  } catch {
    return sendJSON(res, 413, { error: 'Image too large' });
  }
  const { files } = parseMultipart(raw, boundary);
  const img = files.image;
  if (!img || !img.data || !img.data.length) return badRequest(res, 'No image provided');

  const usersData = readJSON(USERS_FILE, { users: [] });
  const u = usersData.users.find((x) => x.id === user.id);
  const oldFile = u[userField];
  const ext = extFor(img.filename, IMAGE_MIME, '.jpg');
  const filename = `${user.id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir, filename), img.data);
  u[userField] = filename;
  writeJSON(USERS_FILE, usersData);
  if (oldFile) { try { fs.unlinkSync(path.join(dir, oldFile)); } catch {} }

  sendJSON(res, 200, toPublicUser(u));
}

function handleServeProfileImage(req, res, dir, username, field) {
  const usersData = readJSON(USERS_FILE, { users: [] });
  const user = findUserByUsername(usersData, username);
  if (!user || !user[field]) return notFound(res, 'No image');
  const filePath = path.join(dir, user[field]);
  const ext = path.extname(user[field]).toLowerCase();
  fs.stat(filePath, (err, stats) => {
    if (err) return notFound(res, 'No image');
    res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext] || 'image/jpeg', 'Content-Length': stats.size, 'Cache-Control': 'public, max-age=31536000' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleFriendAdd(req, res, username) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const usersData = readJSON(USERS_FILE, { users: [] });
  const target = findUserByUsername(usersData, username);
  if (!target) return notFound(res, 'Artist not found');
  if (target.id === user.id) return badRequest(res, "You can't add yourself as a friend");
  const me = usersData.users.find((u) => u.id === user.id);
  if (!me.friends.includes(target.id)) me.friends.push(target.id);
  writeJSON(USERS_FILE, usersData);
  sendJSON(res, 200, toPublicUser(me));
}

async function handleFriendRemove(req, res, username) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const usersData = readJSON(USERS_FILE, { users: [] });
  const target = findUserByUsername(usersData, username);
  if (!target) return notFound(res, 'Artist not found');
  const me = usersData.users.find((u) => u.id === user.id);
  me.friends = (me.friends || []).filter((id) => id !== target.id);
  writeJSON(USERS_FILE, usersData);
  sendJSON(res, 200, toPublicUser(me));
}

// ---------- guestbook / comments ----------
function handleGetComments(req, res, username) {
  const usersData = readJSON(USERS_FILE, { users: [] });
  const profileUser = findUserByUsername(usersData, username);
  if (!profileUser) return notFound(res, 'Artist not found');
  const commentsData = readJSON(COMMENTS_FILE, { comments: [] });
  const list = commentsData.comments
    .filter((c) => c.profileUserId === profileUser.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((c) => {
      const from = usersData.users.find((u) => u.id === c.fromUserId);
      return {
        ...c,
        fromUser: from
          ? { id: from.id, username: from.username, displayName: from.displayName, avatar: from.avatar }
          : { id: c.fromUserId, username: 'unknown', displayName: 'Unknown user', avatar: null },
      };
    });
  sendJSON(res, 200, list);
}

async function handlePostComment(req, res, username) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  if (!checkRateLimit(`comment:${getClientIp(req)}`, 10, 5 * 60 * 1000)) {
    return sendJSON(res, 429, { error: 'Too many comments — slow down a bit.' });
  }
  const usersData = readJSON(USERS_FILE, { users: [] });
  const profileUser = findUserByUsername(usersData, username);
  if (!profileUser) return notFound(res, 'Artist not found');
  const body = await readJSONBody(req);
  const message = body && typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return badRequest(res, 'Message required');

  const commentsData = readJSON(COMMENTS_FILE, { comments: [] });
  const comment = {
    id: newId(), profileUserId: profileUser.id, fromUserId: user.id,
    message: message.slice(0, 500), createdAt: new Date().toISOString(),
  };
  commentsData.comments.push(comment);
  writeJSON(COMMENTS_FILE, commentsData);
  sendJSON(res, 201, { ...comment, fromUser: { id: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar } });
}

function handleDeleteComment(req, res, username, commentId) {
  const user = getCurrentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Log in required' });
  const usersData = readJSON(USERS_FILE, { users: [] });
  const profileUser = findUserByUsername(usersData, username);
  if (!profileUser) return notFound(res, 'Artist not found');
  const commentsData = readJSON(COMMENTS_FILE, { comments: [] });
  const idx = commentsData.comments.findIndex((c) => c.id === commentId && c.profileUserId === profileUser.id);
  if (idx === -1) return notFound(res, 'Comment not found');
  const comment = commentsData.comments[idx];
  if (comment.fromUserId !== user.id && profileUser.id !== user.id) return sendJSON(res, 403, { error: 'Not allowed' });
  commentsData.comments.splice(idx, 1);
  writeJSON(COMMENTS_FILE, commentsData);
  sendJSON(res, 200, { ok: true });
}

// ---------- router ----------
ensureLibrary();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  try {
    if (pathname === '/api/tracks' && method === 'GET') return handleListTracks(req, res);
    if (pathname === '/api/upload' && method === 'POST') return await handleUpload(req, res);

    let m = /^\/api\/tracks\/([^/]+)$/.exec(pathname);
    if (m && method === 'PATCH') return await handleUpdateTrack(req, res, m[1]);
    if (m && method === 'DELETE') return handleDeleteTrack(req, res, m[1]);

    m = /^\/api\/tracks\/([^/]+)\/play$/.exec(pathname);
    if (m && method === 'POST') return handleMarkPlayed(req, res, m[1]);

    m = /^\/api\/stream\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') return handleStream(req, res, m[1]);

    m = /^\/api\/cover\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') return handleCover(req, res, m[1]);

    if (pathname === '/api/playlists' && method === 'GET') return handleListPlaylists(req, res);
    if (pathname === '/api/playlists' && method === 'POST') return await handleCreatePlaylist(req, res);

    m = /^\/api\/playlists\/([^/]+)$/.exec(pathname);
    if (m && method === 'PATCH') return await handleUpdatePlaylist(req, res, m[1]);
    if (m && method === 'DELETE') return handleDeletePlaylist(req, res, m[1]);

    m = /^\/api\/playlists\/([^/]+)\/tracks$/.exec(pathname);
    if (m && method === 'POST') return await handleAddToPlaylist(req, res, m[1]);

    m = /^\/api\/playlists\/([^/]+)\/tracks\/([^/]+)$/.exec(pathname);
    if (m && method === 'DELETE') return handleRemoveFromPlaylist(req, res, m[1], m[2]);

    if (pathname === '/api/auth/signup' && method === 'POST') return await handleSignup(req, res);
    if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth/logout' && method === 'POST') return handleLogout(req, res);
    if (pathname === '/api/auth/me' && method === 'GET') return handleMe(req, res);

    if (pathname === '/api/artists' && method === 'GET') return handleListArtists(req, res);
    if (pathname === '/api/artists/me' && method === 'PATCH') return await handleUpdateMyProfile(req, res);
    if (pathname === '/api/artists/me/avatar' && method === 'POST') return await handleProfileImageUpload(req, res, AVATARS_DIR, 'avatar');
    if (pathname === '/api/artists/me/banner' && method === 'POST') return await handleProfileImageUpload(req, res, BANNERS_DIR, 'banner');

    m = /^\/api\/artists\/([^/]+)\/avatar-image$/.exec(pathname);
    if (m && method === 'GET') return handleServeProfileImage(req, res, AVATARS_DIR, m[1], 'avatar');

    m = /^\/api\/artists\/([^/]+)\/banner-image$/.exec(pathname);
    if (m && method === 'GET') return handleServeProfileImage(req, res, BANNERS_DIR, m[1], 'banner');

    m = /^\/api\/artists\/([^/]+)\/friend$/.exec(pathname);
    if (m && method === 'POST') return await handleFriendAdd(req, res, m[1]);
    if (m && method === 'DELETE') return await handleFriendRemove(req, res, m[1]);

    m = /^\/api\/artists\/([^/]+)\/comments$/.exec(pathname);
    if (m && method === 'GET') return handleGetComments(req, res, m[1]);
    if (m && method === 'POST') return await handlePostComment(req, res, m[1]);

    m = /^\/api\/artists\/([^/]+)\/comments\/([^/]+)$/.exec(pathname);
    if (m && method === 'DELETE') return handleDeleteComment(req, res, m[1], m[2]);

    m = /^\/api\/artists\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') return handleGetArtist(req, res, m[1]);

    if (pathname.startsWith('/api/')) return notFound(res, 'Unknown API route');

    if (pathname === '/embed' || pathname.startsWith('/embed/')) return serveEmbedPage(req, res);

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Server error', detail: String(err && err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '<this-machine-ip>' : HOST;
  console.log(`SpotSpace running at http://${displayHost}:${PORT}`);
  console.log(`Library data stored in: ${LIBRARY_DIR}`);
});
