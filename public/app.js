(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    tracks: [],
    playlists: [],
    view: { name: 'home', id: null },
    queue: [],       // array of track ids, current playback context
    queueIndex: -1,
    shuffle: false,
    repeat: 'off',    // off | all | one
    pendingUploads: [], // {uid, file, coverFile, title, artist, album, duration, status, error}
    currentUser: null,  // logged-in user (public fields only), or null
  };

  const NOTE_ICON = '<svg viewBox="0 0 24 24" width="34%" height="34%" style="opacity:.55"><path d="M9 18V5l11-2v13" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>';

  // ---------- dom refs ----------
  const $ = (sel) => document.querySelector(sel);
  const viewEl = $('#view');
  const audioEl = $('#audioEl');
  const toastStack = $('#toastStack');

  // ---------- api ----------
  async function apiGet(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await safeJson(r))?.error || `GET ${url} failed`);
    return r.json();
  }
  async function apiJSON(url, method, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error((await safeJson(r))?.error || `${method} ${url} failed`);
    return r.json();
  }
  async function apiDelete(url) {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) throw new Error((await safeJson(r))?.error || `DELETE ${url} failed`);
    return r.json();
  }
  async function apiUploadForm(url, formData) {
    const r = await fetch(url, { method: 'POST', body: formData });
    if (!r.ok) throw new Error((await safeJson(r))?.error || `Upload to ${url} failed`);
    return r.json();
  }
  async function safeJson(r) { try { return await r.json(); } catch { return null; } }

  // ---------- toast ----------
  function toast(msg, isError) {
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    toastStack.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ---------- formatting ----------
  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function gradientClassFor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return `gradient-cover-${(Math.abs(hash) % 6) + 1}`;
  }
  function coverStyle(track) {
    if (track.cover) return { style: `background-image:url(/api/cover/${track.id})`, cls: '', inner: '' };
    return { style: '', cls: gradientClassFor(track.id), inner: NOTE_ICON };
  }
  function trackById(id) { return state.tracks.find((t) => t.id === id); }

  function avatarStyle(user) {
    if (!user) return { style: '', cls: 'gradient-cover-1', letter: '?' };
    if (user.avatar) return { style: `background-image:url(/api/artists/${encodeURIComponent(user.username)}/avatar-image)`, cls: '', letter: '' };
    return { style: '', cls: gradientClassFor(user.id || user.username), letter: (user.displayName || user.username || '?').charAt(0).toUpperCase() };
  }
  function bannerStyle(user) {
    if (user && user.banner) return `background-image:url(/api/artists/${encodeURIComponent(user.username)}/banner-image)`;
    const c = (user && user.themeColor) || '#1ed760';
    return `background: linear-gradient(135deg, ${c}, #0a0a0a)`;
  }

  // ---------- data loading ----------
  async function loadAll() {
    const [tracks, playlists, me] = await Promise.all([
      apiGet('/api/tracks'), apiGet('/api/playlists'), apiGet('/api/auth/me'),
    ]);
    state.tracks = tracks;
    state.playlists = playlists;
    state.currentUser = me.user;
    renderAuthWidget();
    renderSidebarPlaylists();

    const hashMatch = /^#\/artist\/([^/]+)$/.exec(location.hash);
    if (hashMatch) state.view = { name: 'artist', id: decodeURIComponent(hashMatch[1]) };
    renderView();
  }

  window.addEventListener('hashchange', () => {
    const hashMatch = /^#\/artist\/([^/]+)$/.exec(location.hash);
    if (hashMatch) {
      const username = decodeURIComponent(hashMatch[1]);
      if (!(state.view.name === 'artist' && state.view.id === username)) setView('artist', username, true);
    } else if (location.hash === '' && state.view.name === 'artist') {
      setView('home');
    }
  });

  // ---------- sidebar ----------
  function renderSidebarPlaylists() {
    const list = $('#playlistsList');
    list.innerHTML = '';
    if (!state.playlists.length) {
      const empty = document.createElement('div');
      empty.className = 'playlist-pick-empty';
      empty.textContent = 'No playlists yet';
      list.appendChild(empty);
      return;
    }
    for (const pl of state.playlists) {
      const row = document.createElement('div');
      row.className = 'playlist-row';
      row.innerHTML = `<span class="pl-name" title="${escapeHtml(pl.name)}">${escapeHtml(pl.name)}</span><button class="pl-del" title="Delete playlist">✕</button>`;
      row.querySelector('.pl-name').addEventListener('click', () => setView('playlist', pl.id));
      row.querySelector('.pl-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete playlist "${pl.name}"?`)) return;
        await apiDelete(`/api/playlists/${pl.id}`);
        state.playlists = state.playlists.filter((p) => p.id !== pl.id);
        if (state.view.name === 'playlist' && state.view.id === pl.id) setView('home');
        renderSidebarPlaylists();
        toast('Playlist deleted');
      });
      list.appendChild(row);
    }
  }

  function setActiveNav(name) {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
  }

  function setView(name, id, fromHash) {
    state.view = { name, id: id || null };
    if (name === 'playlist' || name === 'artist') {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      if (name === 'artist') setActiveNav('artists');
    } else {
      setActiveNav(name);
    }
    if (!fromHash) {
      if (name === 'artist') location.hash = '#/artist/' + encodeURIComponent(id);
      else if (location.hash) history.pushState('', document.title, location.pathname + location.search);
    }
    renderView();
  }

  // ---------- view rendering ----------
  function renderView() {
    const { name, id } = state.view;
    if (name === 'home') return renderHome();
    if (name === 'search') return renderSearch($('#searchInput').value || '');
    if (name === 'library') return renderLibrary();
    if (name === 'playlist') return renderPlaylistView(id);
    if (name === 'artists') return renderArtistsBrowse();
    if (name === 'artist') return renderArtistProfile(id);
  }

  function emptyState(title, body, showUploadBtn) {
    viewEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML = `
      <svg viewBox="0 0 24 24" width="52" height="52"><path d="M9 18V5l11-2v13" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor"/><circle cx="17.5" cy="16" r="2.5" fill="currentColor"/></svg>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    `;
    if (showUploadBtn) {
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = 'Upload your first track';
      btn.addEventListener('click', openUploadModal);
      wrap.appendChild(btn);
    }
    viewEl.appendChild(wrap);
  }

  function renderHome() {
    if (!state.tracks.length) {
      return emptyState('Your library is empty', 'Drag in some audio files to publish your first tracks — they show up here instantly.', true);
    }
    viewEl.innerHTML = '';
    const recent = [...state.tracks].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, 12);
    viewEl.appendChild(section('Recently added', cardGrid(recent, recent.map((t) => t.id))));

    const mostPlayed = [...state.tracks].filter((t) => (t.playCount || 0) > 0).sort((a, b) => b.playCount - a.playCount).slice(0, 12);
    if (mostPlayed.length) {
      viewEl.appendChild(section('Most played', cardGrid(mostPlayed, mostPlayed.map((t) => t.id))));
    }

    viewEl.appendChild(section('All tracks', trackList(recentAll(), recentAll().map((t) => t.id)), true));
  }
  function recentAll() { return [...state.tracks].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)); }

  function renderSearch(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      viewEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.innerHTML = `<h3>Search your library</h3><p>Start typing to find a track by title, artist, or album.</p>`;
      viewEl.appendChild(wrap);
      return;
    }
    const results = state.tracks.filter((t) =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)
    );
    viewEl.innerHTML = '';
    if (!results.length) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.innerHTML = `<h3>No results for "${escapeHtml(query)}"</h3><p>Try a different title, artist, or album.</p>`;
      viewEl.appendChild(wrap);
      return;
    }
    viewEl.appendChild(section(`Results for "${query}"`, trackList(results, results.map((t) => t.id))));
  }

  function renderLibrary() {
    if (!state.tracks.length) return emptyState('Your library is empty', 'Everything you publish lands here, newest first.', true);
    viewEl.innerHTML = '';
    const all = recentAll();
    viewEl.appendChild(section('Your Library', trackList(all, all.map((t) => t.id)), true));
  }

  function renderPlaylistView(id) {
    const pl = state.playlists.find((p) => p.id === id);
    if (!pl) return setView('home');
    const tracks = pl.trackIds.map(trackById).filter(Boolean);
    viewEl.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'section';
    header.innerHTML = `<div class="section-title">${escapeHtml(pl.name)}</div><div class="section-sub">${tracks.length} track${tracks.length === 1 ? '' : 's'}</div>`;
    viewEl.appendChild(header);
    if (!tracks.length) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.innerHTML = `<h3>No tracks yet</h3><p>Add tracks to this playlist from the context menu on any track.</p>`;
      viewEl.appendChild(wrap);
      return;
    }
    viewEl.appendChild(trackList(tracks, tracks.map((t) => t.id), pl.id));
  }

  async function renderArtistsBrowse() {
    viewEl.innerHTML = '';
    let artists;
    try { artists = await apiGet('/api/artists'); }
    catch (err) { toast('Failed to load artists: ' + err.message, true); return; }
    if (state.view.name !== 'artists') return;

    if (!artists.length) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.innerHTML = `<h3>No artists yet</h3><p>Sign up to create the first artist page.</p>`;
      viewEl.appendChild(wrap);
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const a of artists) {
      const av = avatarStyle(a);
      const card = document.createElement('div');
      card.className = 'artist-card';
      card.innerHTML = `
        <div class="artist-card-avatar ${av.cls}" style="${av.style}">${av.letter}</div>
        <div class="artist-card-name">${escapeHtml(a.displayName)}</div>
        <div class="artist-card-sub">${a.trackCount} track${a.trackCount === 1 ? '' : 's'}</div>
      `;
      card.addEventListener('click', () => setView('artist', a.username));
      grid.appendChild(card);
    }
    viewEl.appendChild(section('Artists', grid));
  }

  async function renderArtistProfile(username) {
    let profile, comments;
    try {
      [profile, comments] = await Promise.all([
        apiGet(`/api/artists/${encodeURIComponent(username)}`),
        apiGet(`/api/artists/${encodeURIComponent(username)}/comments`),
      ]);
    } catch (err) {
      viewEl.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'empty-state';
      wrap.innerHTML = `<h3>Artist not found</h3><p>${escapeHtml(err.message)}</p>`;
      viewEl.appendChild(wrap);
      return;
    }
    if (!(state.view.name === 'artist' && state.view.id === username)) return;

    const isOwner = !!(state.currentUser && state.currentUser.username === profile.username);
    const isFriend = !!(state.currentUser && (state.currentUser.friends || []).includes(profile.id));

    viewEl.innerHTML = '';
    const page = document.createElement('div');
    page.className = 'artist-page';
    page.style.setProperty('--profile-accent', profile.themeColor || '#1ed760');

    const av = avatarStyle(profile);
    page.innerHTML = `
      <div class="artist-banner" style="${bannerStyle(profile)}">
        <div class="artist-avatar-wrap">
          <div class="artist-avatar-img ${av.cls}" style="${av.style}">${av.letter}</div>
        </div>
      </div>
      <div class="artist-header-row">
        <div class="artist-identity">
          <h1>${escapeHtml(profile.displayName)}</h1>
          <div class="artist-username">@${escapeHtml(profile.username)}</div>
          ${profile.tagline ? `<div class="artist-tagline">${escapeHtml(profile.tagline)}</div>` : ''}
          <div class="artist-stats-row">
            <span><b>${profile.profileViews || 0}</b> profile views</span>
            <span><b>${profile.tracks.length}</b> tracks</span>
            <span><b>${(profile.friends || []).length}</b> friends</span>
          </div>
        </div>
        <div class="artist-header-actions" id="artistHeaderActions"></div>
      </div>
      <div class="artist-layout">
        <div class="artist-col-side">
          <div class="artist-panel">
            <h3>Top Friends</h3>
            <div class="friends-grid" id="artistFriendsGrid"></div>
          </div>
        </div>
        <div class="artist-col-main">
          <div class="artist-panel">
            <h3>About Me</h3>
            <div class="artist-bio ${profile.bio ? '' : 'is-empty'}">${escapeHtml(profile.bio || '')}</div>
          </div>
          <div class="artist-panel" id="artistTracksPanel"><h3>Tracks</h3></div>
          <div class="artist-panel">
            <h3>Guestbook</h3>
            <div id="guestbookForm"></div>
            <div class="guestbook-list" id="guestbookList"></div>
          </div>
        </div>
      </div>
    `;
    viewEl.appendChild(page);

    const actions = page.querySelector('#artistHeaderActions');
    if (isOwner) {
      const btn = document.createElement('button');
      btn.className = 'btn-outline';
      btn.textContent = 'Edit Profile';
      btn.addEventListener('click', () => openEditProfileModal(profile));
      actions.appendChild(btn);
    } else if (state.currentUser) {
      const btn = document.createElement('button');
      btn.className = 'btn-outline' + (isFriend ? ' is-active' : '');
      btn.textContent = isFriend ? '✓ Friends' : '+ Add Friend';
      btn.addEventListener('click', async () => {
        try {
          if (isFriend) {
            await apiDelete(`/api/artists/${encodeURIComponent(profile.username)}/friend`);
            state.currentUser.friends = state.currentUser.friends.filter((id) => id !== profile.id);
            toast('Removed friend');
          } else {
            await apiJSON(`/api/artists/${encodeURIComponent(profile.username)}/friend`, 'POST', {});
            state.currentUser.friends.push(profile.id);
            toast('Added friend');
          }
          renderArtistProfile(username);
        } catch (err) { toast(err.message, true); }
      });
      actions.appendChild(btn);
    }
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-outline';
    shareBtn.textContent = '⤴ Share';
    shareBtn.addEventListener('click', () => openShareModal('artist', profile));
    actions.appendChild(shareBtn);

    const friendsGrid = page.querySelector('#artistFriendsGrid');
    if (!profile.friends.length) {
      friendsGrid.innerHTML = '<div class="friends-empty">No friends added yet.</div>';
    } else {
      for (const f of profile.friends.slice(0, 8)) {
        const fav = avatarStyle(f);
        const tile = document.createElement('div');
        tile.className = 'friend-tile';
        tile.innerHTML = `<div class="friend-tile-avatar ${fav.cls}" style="${fav.style}">${fav.letter}</div><div class="friend-tile-name">${escapeHtml(f.displayName)}</div>`;
        tile.addEventListener('click', () => setView('artist', f.username));
        friendsGrid.appendChild(tile);
      }
    }

    const tracksPanel = page.querySelector('#artistTracksPanel');
    if (!profile.tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'friends-empty';
      empty.textContent = isOwner ? "You haven't published anything yet." : 'No tracks published yet.';
      tracksPanel.appendChild(empty);
    } else {
      tracksPanel.appendChild(trackList(profile.tracks, profile.tracks.map((t) => t.id)));
    }

    const formHost = page.querySelector('#guestbookForm');
    if (state.currentUser) {
      formHost.innerHTML = `
        <div class="guestbook-form">
          <textarea id="guestbookInput" placeholder="Leave a message on ${escapeHtml(profile.displayName)}'s wall..." maxlength="500"></textarea>
          <button class="btn-primary btn-sm" id="guestbookPostBtn">Post</button>
        </div>
      `;
      formHost.querySelector('#guestbookPostBtn').addEventListener('click', async () => {
        const textarea = formHost.querySelector('#guestbookInput');
        const message = textarea.value.trim();
        if (!message) return;
        try {
          await apiJSON(`/api/artists/${encodeURIComponent(profile.username)}/comments`, 'POST', { message });
          renderArtistProfile(username);
        } catch (err) { toast(err.message, true); }
      });
    }

    const list = page.querySelector('#guestbookList');
    if (!comments.length) {
      list.innerHTML = '<div class="comments-empty">No messages yet — be the first to sign the guestbook.</div>';
    } else {
      for (const c of comments) {
        const cav = avatarStyle(c.fromUser);
        const canDelete = !!(state.currentUser && (state.currentUser.id === c.fromUserId || state.currentUser.id === profile.id));
        const row = document.createElement('div');
        row.className = 'comment-row';
        row.innerHTML = `
          <div class="comment-avatar ${cav.cls}" style="${cav.style}">${cav.letter}</div>
          <div class="comment-body">
            <div class="comment-head"><span class="comment-author">${escapeHtml(c.fromUser.displayName)}</span><span class="comment-time">${timeAgo(c.createdAt)}</span></div>
            <div class="comment-text">${escapeHtml(c.message)}</div>
            ${canDelete ? '<button class="comment-del">Delete</button>' : ''}
          </div>
        `;
        row.querySelector('.comment-author').addEventListener('click', () => setView('artist', c.fromUser.username));
        const delBtn = row.querySelector('.comment-del');
        if (delBtn) delBtn.addEventListener('click', async () => {
          try { await apiDelete(`/api/artists/${encodeURIComponent(profile.username)}/comments/${c.id}`); renderArtistProfile(username); }
          catch (err) { toast(err.message, true); }
        });
        list.appendChild(row);
      }
    }
  }

  function section(title, contentEl, noTopMargin) {
    const wrap = document.createElement('div');
    wrap.className = 'section';
    if (!noTopMargin) {
      const h = document.createElement('div');
      h.className = 'section-title';
      h.textContent = title;
      wrap.appendChild(h);
    } else {
      const h = document.createElement('div');
      h.className = 'section-title';
      h.textContent = title;
      wrap.appendChild(h);
    }
    wrap.appendChild(contentEl);
    return wrap;
  }

  // ---------- card grid (home sections) ----------
  function cardGrid(tracks, queueIds) {
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const t of tracks) {
      const cover = coverStyle(t);
      const card = document.createElement('div');
      card.className = 'track-card';
      card.innerHTML = `
        <div class="card-cover ${cover.cls}" style="${cover.style}">${cover.inner}
          <button class="card-play" title="Play">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="card-title">${escapeHtml(t.title)}</div>
        <div class="card-sub${t.ownerUsername ? ' card-sub-link' : ''}">${escapeHtml(t.artist)}</div>
      `;
      card.addEventListener('click', (e) => {
        if (t.ownerUsername && e.target.closest('.card-sub')) { setView('artist', t.ownerUsername); return; }
        playFromQueue(t.id, queueIds);
      });
      grid.appendChild(card);
    }
    return grid;
  }

  // ---------- track list (rows) ----------
  function trackList(tracks, queueIds, playlistId) {
    const wrap = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'list-head';
    head.innerHTML = `<span>#</span><span>Title</span><span>Album</span><span>Added</span><span></span><span></span>`;
    wrap.appendChild(head);

    const list = document.createElement('div');
    list.className = 'track-list';
    tracks.forEach((t, i) => {
      const cover = coverStyle(t);
      const row = document.createElement('div');
      row.className = 'track-row';
      if (state.queue[state.queueIndex] === t.id) row.classList.add('playing');
      row.innerHTML = `
        <span class="idx"><span class="idx-num">${i + 1}</span><span class="row-play-icon">▶</span></span>
        <div class="tr-main">
          <div class="tr-cover ${cover.cls}" style="${cover.style}"></div>
          <div class="tr-titles">
            <div class="tr-title">${escapeHtml(t.title)}</div>
            <div class="tr-artist${t.ownerUsername ? ' tr-artist-link' : ''}">${escapeHtml(t.artist)}</div>
          </div>
        </div>
        <span class="tr-album">${escapeHtml(t.album)}</span>
        <span class="tr-added">${timeAgo(t.addedAt)}</span>
        <span class="tr-duration">${formatDuration(t.durationSec)}</span>
        <button class="tr-menu-btn" title="More">⋯</button>
      `;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tr-menu-btn')) return;
        if (t.ownerUsername && e.target.closest('.tr-artist')) { setView('artist', t.ownerUsername); return; }
        playFromQueue(t.id, queueIds);
      });
      row.querySelector('.tr-menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openCtxMenu(e.clientX, e.clientY, t, playlistId);
      });
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function timeAgo(iso) {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- context menu ----------
  let ctxMenuEl = null;
  function closeCtxMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
  function openCtxMenu(x, y, track, playlistId) {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
      <button data-act="play">Play</button>
      <button data-act="addpl">Add to playlist</button>
      ${track.ownerUsername ? '<button data-act="share">Share track</button>' : ''}
      <button data-act="edit">Edit info</button>
      ${playlistId ? '<button data-act="removepl">Remove from this playlist</button>' : ''}
      <hr>
      <button data-act="delete" class="danger">Delete from library</button>
    `;
    document.body.appendChild(menu);
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, vw - rect.width - 12) + 'px';
    menu.style.top = Math.min(y, vh - rect.height - 12) + 'px';
    ctxMenuEl = menu;

    menu.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      closeCtxMenu();
      if (act === 'play') playFromQueue(track.id, [track.id]);
      if (act === 'addpl') openAddToPlaylistModal(track.id);
      if (act === 'share') openShareModal('track', track);
      if (act === 'edit') openEditModal(track.id);
      if (act === 'removepl' && playlistId) {
        await apiDelete(`/api/playlists/${playlistId}/tracks/${track.id}`);
        const pl = state.playlists.find((p) => p.id === playlistId);
        if (pl) pl.trackIds = pl.trackIds.filter((id) => id !== track.id);
        renderView();
        toast('Removed from playlist');
      }
      if (act === 'delete') {
        if (!confirm(`Delete "${track.title}" from your library? This removes the audio file too.`)) return;
        await apiDelete(`/api/tracks/${track.id}`);
        state.tracks = state.tracks.filter((t) => t.id !== track.id);
        for (const pl of state.playlists) pl.trackIds = pl.trackIds.filter((id) => id !== track.id);
        renderView();
        toast('Track deleted');
      }
    });
    setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
  }

  // ---------- edit modal ----------
  let editingTrackId = null;
  function openEditModal(trackId) {
    const t = trackById(trackId);
    if (!t) return;
    editingTrackId = trackId;
    $('#editTitle').value = t.title;
    $('#editArtist').value = t.artist;
    $('#editAlbum').value = t.album;
    showModal('editModal');
  }
  $('#editSaveBtn').addEventListener('click', async () => {
    if (!editingTrackId) return;
    const body = { title: $('#editTitle').value, artist: $('#editArtist').value, album: $('#editAlbum').value };
    const updated = await apiJSON(`/api/tracks/${editingTrackId}`, 'PATCH', body);
    const idx = state.tracks.findIndex((t) => t.id === editingTrackId);
    if (idx !== -1) state.tracks[idx] = updated;
    hideModal('editModal');
    renderView();
    updateNowPlayingBarIfCurrent(editingTrackId);
    toast('Track updated');
  });

  // ---------- add to playlist modal ----------
  let addingTrackId = null;
  function openAddToPlaylistModal(trackId) {
    addingTrackId = trackId;
    const list = $('#playlistPickList');
    list.innerHTML = '';
    if (!state.playlists.length) {
      list.innerHTML = '<div class="playlist-pick-empty">No playlists yet — create one from the sidebar first.</div>';
    } else {
      for (const pl of state.playlists) {
        const row = document.createElement('div');
        row.className = 'playlist-pick-row';
        const already = pl.trackIds.includes(trackId);
        row.innerHTML = `<span>${escapeHtml(pl.name)}</span><button ${already ? 'disabled' : ''}>${already ? 'Added' : 'Add'}</button>`;
        row.querySelector('button').addEventListener('click', async (e) => {
          await apiJSON(`/api/playlists/${pl.id}/tracks`, 'POST', { trackId });
          pl.trackIds.push(trackId);
          e.target.textContent = 'Added';
          e.target.disabled = true;
          toast(`Added to "${pl.name}"`);
        });
        list.appendChild(row);
      }
    }
    showModal('addToPlaylistModal');
  }

  // ---------- modal plumbing ----------
  function showModal(id) { $('#' + id).hidden = false; }
  function hideModal(id) { $('#' + id).hidden = true; }
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => hideModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
  });

  // ---------- new playlist ----------
  $('#newPlaylistBtn').addEventListener('click', async () => {
    const name = prompt('Playlist name:', 'New Playlist');
    if (name === null) return;
    const pl = await apiJSON('/api/playlists', 'POST', { name: name.trim() || 'New Playlist' });
    state.playlists.push(pl);
    renderSidebarPlaylists();
    toast('Playlist created');
  });

  // ============================================================
  // AUTH
  // ============================================================
  function renderAuthWidget() {
    const guest = $('#authGuest'), userBox = $('#authUser');
    if (state.currentUser) {
      guest.hidden = true;
      userBox.hidden = false;
      const av = avatarStyle(state.currentUser);
      const avatarEl = $('#authAvatar');
      avatarEl.className = 'auth-avatar ' + av.cls;
      avatarEl.style.cssText = av.style;
      avatarEl.textContent = av.letter;
      $('#authName').textContent = state.currentUser.displayName;
    } else {
      guest.hidden = false;
      userBox.hidden = true;
      $('#authDropdown').hidden = true;
    }
  }

  $('#openLoginBtn').addEventListener('click', () => { $('#loginError').hidden = true; showModal('loginModal'); });
  $('#openSignupBtn').addEventListener('click', () => { $('#signupError').hidden = true; showModal('signupModal'); });
  $('#switchToSignupBtn').addEventListener('click', () => { hideModal('loginModal'); $('#signupError').hidden = true; showModal('signupModal'); });
  $('#switchToLoginBtn').addEventListener('click', () => { hideModal('signupModal'); $('#loginError').hidden = true; showModal('loginModal'); });

  $('#authUserBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = $('#authDropdown');
    dd.hidden = !dd.hidden;
  });
  document.addEventListener('click', (e) => {
    const dd = $('#authDropdown');
    if (!dd.hidden && !e.target.closest('.auth-user')) dd.hidden = true;
  });
  $('#authDropdown').addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    $('#authDropdown').hidden = true;
    if (act === 'profile') setView('artist', state.currentUser.username);
    if (act === 'logout') {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
      state.currentUser = null;
      renderAuthWidget();
      setView('home');
      toast('Logged out');
    }
  });

  async function doLogin() {
    const username = $('#loginUsername').value.trim();
    const password = $('#loginPassword').value;
    try {
      const user = await apiJSON('/api/auth/login', 'POST', { username, password });
      state.currentUser = user;
      hideModal('loginModal');
      $('#loginUsername').value = ''; $('#loginPassword').value = '';
      renderAuthWidget();
      toast(`Welcome back, ${user.displayName}`);
    } catch (err) {
      const el = $('#loginError'); el.textContent = err.message; el.hidden = false;
    }
  }
  async function doSignup() {
    const displayName = $('#signupDisplayName').value.trim();
    const username = $('#signupUsername').value.trim();
    const password = $('#signupPassword').value;
    try {
      const user = await apiJSON('/api/auth/signup', 'POST', { displayName, username, password });
      state.currentUser = user;
      hideModal('signupModal');
      $('#signupDisplayName').value = ''; $('#signupUsername').value = ''; $('#signupPassword').value = '';
      renderAuthWidget();
      toast(`Welcome to SpotSpace, ${user.displayName}!`);
      setView('artist', user.username);
    } catch (err) {
      const el = $('#signupError'); el.textContent = err.message; el.hidden = false;
    }
  }
  $('#loginSubmitBtn').addEventListener('click', doLogin);
  $('#signupSubmitBtn').addEventListener('click', doSignup);
  $('#loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#signupPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignup(); });

  // ---------- edit profile modal ----------
  let editingProfile = null;
  function openEditProfileModal(profile) {
    editingProfile = profile;
    $('#editProfileDisplayName').value = profile.displayName || '';
    $('#editProfileTagline').value = profile.tagline || '';
    $('#editProfileBio').value = profile.bio || '';
    $('#editProfileTheme').value = profile.themeColor || '#1ed760';
    const bannerPick = $('#editBannerPick');
    bannerPick.style.backgroundImage = profile.banner ? `url(/api/artists/${encodeURIComponent(profile.username)}/banner-image)` : '';
    const avatarPick = $('#editAvatarPick');
    avatarPick.style.backgroundImage = profile.avatar ? `url(/api/artists/${encodeURIComponent(profile.username)}/avatar-image)` : '';
    avatarPick.querySelector('.edit-image-label').hidden = !!profile.avatar;
    bannerPick.querySelector('.edit-image-label').hidden = !!profile.banner;
    showModal('editProfileModal');
  }
  function refreshAfterProfileChange(updated) {
    state.currentUser = updated;
    renderAuthWidget();
    if (state.view.name === 'artist' && state.view.id === updated.username) renderArtistProfile(updated.username);
  }
  $('#editBannerPick').addEventListener('click', () => $('#editBannerInput').click());
  $('#editAvatarPick').addEventListener('click', () => $('#editAvatarInput').click());
  $('#editBannerInput').addEventListener('change', async () => {
    const file = $('#editBannerInput').files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('image', file, file.name);
    try {
      const updated = await apiUploadForm('/api/artists/me/banner', fd);
      $('#editBannerPick').style.backgroundImage = `url(/api/artists/${encodeURIComponent(updated.username)}/banner-image?t=${Date.now()})`;
      $('#editBannerPick').querySelector('.edit-image-label').hidden = true;
      refreshAfterProfileChange(updated);
      toast('Banner updated');
    } catch (err) { toast(err.message, true); }
    $('#editBannerInput').value = '';
  });
  $('#editAvatarInput').addEventListener('change', async () => {
    const file = $('#editAvatarInput').files[0];
    if (!file) return;
    const fd = new FormData(); fd.append('image', file, file.name);
    try {
      const updated = await apiUploadForm('/api/artists/me/avatar', fd);
      $('#editAvatarPick').style.backgroundImage = `url(/api/artists/${encodeURIComponent(updated.username)}/avatar-image?t=${Date.now()})`;
      $('#editAvatarPick').querySelector('.edit-image-label').hidden = true;
      refreshAfterProfileChange(updated);
      toast('Avatar updated');
    } catch (err) { toast(err.message, true); }
    $('#editAvatarInput').value = '';
  });
  $('#editProfileSaveBtn').addEventListener('click', async () => {
    try {
      const updated = await apiJSON('/api/artists/me', 'PATCH', {
        displayName: $('#editProfileDisplayName').value,
        tagline: $('#editProfileTagline').value,
        bio: $('#editProfileBio').value,
        themeColor: $('#editProfileTheme').value,
      });
      hideModal('editProfileModal');
      refreshAfterProfileChange(updated);
      toast('Profile saved');
    } catch (err) { toast(err.message, true); }
  });

  // ---------- share modal ----------
  function drawQrCode(text, canvas) {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    const border = 2;
    const scale = Math.max(1, Math.floor(canvas.width / (qr.size + border * 2)));
    const dim = (qr.size + border * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    for (let y = -border; y < qr.size + border; y++) {
      for (let x = -border; x < qr.size + border; x++) {
        ctx.fillStyle = qr.getModule(x, y) ? '#000000' : '#ffffff';
        ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
      }
    }
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch { return false; }
    }
  }

  function openShareModal(kind, data) {
    let link, embedSrc, text, title, modalTitle, embedHeight;
    if (kind === 'artist') {
      link = `${location.origin}/#/artist/${encodeURIComponent(data.username)}`;
      embedSrc = `${location.origin}/embed/${encodeURIComponent(data.username)}`;
      text = `Check out ${data.displayName} on SpotSpace!`;
      title = `${data.displayName} — SpotSpace`;
      modalTitle = `Share ${data.displayName}'s player`;
      embedHeight = 300;
    } else {
      link = `${location.origin}/#/artist/${encodeURIComponent(data.ownerUsername)}`;
      embedSrc = `${location.origin}/embed/${encodeURIComponent(data.ownerUsername)}?track=${encodeURIComponent(data.id)}`;
      text = `Check out "${data.title}" by ${data.artist} on SpotSpace!`;
      title = `${data.title} — SpotSpace`;
      modalTitle = `Share "${data.title}"`;
      embedHeight = 130;
    }

    $('#shareModalTitle').textContent = modalTitle;
    $('#shareLinkInput').value = link;
    $('#shareEmbedInput').value = `<iframe src="${embedSrc}" width="100%" height="${embedHeight}" frameborder="0" allow="autoplay"></iframe>`;
    drawQrCode(link, $('#shareQrCanvas'));

    const encodedLink = encodeURIComponent(link);
    const encodedText = encodeURIComponent(text);
    const platforms = [
      { name: 'X', url: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedLink}` },
      { name: 'Facebook', url: `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}` },
      { name: 'Reddit', url: `https://www.reddit.com/submit?url=${encodedLink}&title=${encodedText}` },
      { name: 'WhatsApp', url: `https://wa.me/?text=${encodeURIComponent(text + ' ' + link)}` },
      { name: 'Email', url: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text + '\n\n' + link)}` },
    ];
    const socialRow = $('#shareSocialRow');
    socialRow.innerHTML = '';
    if (navigator.share) {
      const nativeBtn = document.createElement('button');
      nativeBtn.className = 'btn-primary btn-sm';
      nativeBtn.textContent = '⤴ Share…';
      nativeBtn.addEventListener('click', async () => {
        try { await navigator.share({ title, text, url: link }); } catch {}
      });
      socialRow.appendChild(nativeBtn);
    }
    for (const p of platforms) {
      const btn = document.createElement('button');
      btn.className = 'btn-outline btn-sm';
      btn.textContent = p.name;
      btn.addEventListener('click', () => window.open(p.url, '_blank', 'noopener,noreferrer,width=600,height=520'));
      socialRow.appendChild(btn);
    }

    showModal('shareModal');
  }

  $('#shareLinkCopyBtn').addEventListener('click', async () => {
    const ok = await copyToClipboard($('#shareLinkInput').value);
    toast(ok ? 'Link copied' : 'Could not copy — select and copy manually', !ok);
  });
  $('#shareEmbedCopyBtn').addEventListener('click', async () => {
    const ok = await copyToClipboard($('#shareEmbedInput').value);
    toast(ok ? 'Embed code copied' : 'Could not copy — select and copy manually', !ok);
  });
  $('#shareQrDownloadBtn').addEventListener('click', () => {
    const canvas = $('#shareQrCanvas');
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'spotspace-qr.png';
    a.click();
  });

  // ---------- nav ----------
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
  $('#searchInput').addEventListener('input', () => {
    setView('search');
    $('#searchInput').focus();
  });
  $('#searchBox').addEventListener('click', () => $('#searchInput').focus());

  // ============================================================
  // PLAYER
  // ============================================================
  function playFromQueue(trackId, queueIds) {
    state.queue = queueIds.slice();
    state.queueIndex = state.queue.indexOf(trackId);
    loadAndPlay(trackId);
  }

  let playCountFired = false;
  function loadAndPlay(trackId) {
    const t = trackById(trackId);
    if (!t) return;
    audioEl.src = `/api/stream/${trackId}`;
    audioEl.play().catch(() => {});
    playCountFired = false;
    updateNowPlayingBar(t);
    renderView();
  }

  function updateNowPlayingBar(t) {
    $('#playerTitle').textContent = t.title;
    $('#playerArtist').textContent = t.artist;
    const cover = coverStyle(t);
    const el = $('#playerCover');
    el.className = 'player-cover ' + cover.cls;
    el.style.cssText = cover.style;
    el.innerHTML = cover.inner;
  }
  function updateNowPlayingBarIfCurrent(trackId) {
    const current = state.queue[state.queueIndex];
    if (current === trackId) updateNowPlayingBar(trackById(trackId));
  }

  function setPlayIcon(playing) {
    $('#playIcon').outerHTML = playing
      ? '<svg id="playIcon" viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>'
      : '<svg id="playIcon" viewBox="0 0 24 24" width="20" height="20"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>';
  }

  audioEl.addEventListener('play', () => setPlayIcon(true));
  audioEl.addEventListener('pause', () => setPlayIcon(false));
  audioEl.addEventListener('timeupdate', () => {
    if (!audioEl.duration) return;
    if (!playCountFired && audioEl.currentTime > 3) {
      playCountFired = true;
      const id = state.queue[state.queueIndex];
      if (id) {
        apiJSON(`/api/tracks/${id}/play`, 'POST', {}).then((updated) => {
          const idx = state.tracks.findIndex((tr) => tr.id === id);
          if (idx !== -1) state.tracks[idx] = updated;
        }).catch(() => {});
      }
    }
    if (!seeking) {
      $('#seekBar').value = String(Math.round((audioEl.currentTime / audioEl.duration) * 1000));
      $('#timeCurrent').textContent = formatDuration(audioEl.currentTime);
      $('#timeTotal').textContent = formatDuration(audioEl.duration);
    }
  });
  audioEl.addEventListener('ended', () => {
    if (state.repeat === 'one') { audioEl.currentTime = 0; audioEl.play(); return; }
    goNext(true);
  });

  let seeking = false;
  const seekBar = $('#seekBar');
  seekBar.addEventListener('input', () => { seeking = true; });
  seekBar.addEventListener('change', () => {
    if (audioEl.duration) audioEl.currentTime = (parseInt(seekBar.value, 10) / 1000) * audioEl.duration;
    seeking = false;
  });

  const volumeBar = $('#volumeBar');
  const savedVol = parseInt(localStorage.getItem('wc_volume') || '80', 10);
  audioEl.volume = savedVol / 100;
  volumeBar.value = String(savedVol);
  volumeBar.addEventListener('input', () => {
    audioEl.volume = parseInt(volumeBar.value, 10) / 100;
    localStorage.setItem('wc_volume', volumeBar.value);
  });

  $('#playBtn').addEventListener('click', () => {
    if (!audioEl.src) return;
    if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
  });

  function goNext(fromEnded) {
    if (!state.queue.length) return;
    let nextIdx;
    if (state.shuffle && state.queue.length > 1) {
      do { nextIdx = Math.floor(Math.random() * state.queue.length); } while (nextIdx === state.queueIndex);
    } else {
      nextIdx = state.queueIndex + 1;
      if (nextIdx >= state.queue.length) {
        if (state.repeat === 'all') nextIdx = 0;
        else { if (fromEnded) setPlayIcon(false); return; }
      }
    }
    state.queueIndex = nextIdx;
    loadAndPlay(state.queue[nextIdx]);
  }
  function goPrev() {
    if (!state.queue.length) return;
    if (audioEl.currentTime > 3) { audioEl.currentTime = 0; return; }
    let prevIdx = state.queueIndex - 1;
    if (prevIdx < 0) prevIdx = state.repeat === 'all' ? state.queue.length - 1 : 0;
    state.queueIndex = prevIdx;
    loadAndPlay(state.queue[prevIdx]);
  }
  $('#nextBtn').addEventListener('click', () => goNext(false));
  $('#prevBtn').addEventListener('click', goPrev);

  $('#shuffleBtn').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    $('#shuffleBtn').classList.toggle('active-toggle', state.shuffle);
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  });
  $('#repeatBtn').addEventListener('click', () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    const btn = $('#repeatBtn');
    btn.classList.toggle('active-toggle', state.repeat !== 'off');
    btn.title = state.repeat === 'one' ? 'Repeat one' : state.repeat === 'all' ? 'Repeat all' : 'Repeat';
    toast('Repeat: ' + state.repeat);
  });

  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
  });

  // ============================================================
  // UPLOAD
  // ============================================================
  function openUploadModal() {
    if (!state.currentUser) {
      toast('Log in to publish tracks', true);
      showModal('loginModal');
      return;
    }
    showModal('uploadModal');
  }
  $('#openUploadBtn').addEventListener('click', openUploadModal);

  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFilesToQueue(fileInput.files); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); }));
  dropzone.addEventListener('drop', (e) => { addFilesToQueue(e.dataTransfer.files); });

  function getAudioDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = 'metadata';
      const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
      a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
      a.onerror = () => done(0);
      a.src = url;
    });
  }

  function deriveTitleFromFilename(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
  }

  let uidCounter = 0;
  function nextUid() { return `u${Date.now()}_${uidCounter++}`; }

  async function addFilesToQueue(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i.test(f.name));
    if (!files.length) { toast('No audio files found in that drop', true); return; }
    for (const file of files) {
      const uid = nextUid();
      const item = {
        uid, file, coverFile: null,
        title: deriveTitleFromFilename(file.name),
        artist: (state.currentUser && state.currentUser.displayName) || '',
        album: '', duration: 0, status: 'pending',
      };
      state.pendingUploads.push(item);
      renderUploadItem(item);
      getAudioDuration(file).then((d) => { item.duration = d; });
    }
    $('#publishAllBtn').hidden = state.pendingUploads.length === 0;
  }

  function renderUploadItem(item) {
    const queue = $('#uploadQueue');
    const row = document.createElement('div');
    row.className = 'upload-item';
    row.dataset.uid = item.uid;
    row.innerHTML = `
      <div class="up-cover"></div>
      <div class="up-fields">
        <input class="up-title" type="text" value="${escapeHtml(item.title)}" placeholder="Title">
        <input class="up-artist" type="text" value="${escapeHtml(item.artist)}" placeholder="Artist">
        <input class="up-album" type="text" value="${escapeHtml(item.album)}" placeholder="Album (optional)">
      </div>
      <div class="up-status">Ready</div>
    `;
    const coverBox = row.querySelector('.up-cover');
    coverBox.classList.add(gradientClassFor(item.uid));
    coverBox.style.cursor = 'pointer';
    coverBox.title = 'Click to set cover art';
    coverBox.addEventListener('click', () => {
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = 'image/*';
      picker.addEventListener('change', () => {
        if (picker.files[0]) {
          item.coverFile = picker.files[0];
          coverBox.style.backgroundImage = `url(${URL.createObjectURL(item.coverFile)})`;
          coverBox.style.backgroundSize = 'cover';
        }
      });
      picker.click();
    });
    row.querySelector('.up-title').addEventListener('input', (e) => { item.title = e.target.value; });
    row.querySelector('.up-artist').addEventListener('input', (e) => { item.artist = e.target.value; });
    row.querySelector('.up-album').addEventListener('input', (e) => { item.album = e.target.value; });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'up-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from queue';
    removeBtn.addEventListener('click', () => {
      state.pendingUploads = state.pendingUploads.filter((p) => p.uid !== item.uid);
      row.remove();
      $('#publishAllBtn').hidden = state.pendingUploads.length === 0;
    });
    row.querySelector('.up-status').after(removeBtn);

    queue.appendChild(row);
  }

  $('#publishAllBtn').addEventListener('click', publishAll);

  async function publishAll() {
    const items = state.pendingUploads.filter((i) => i.status === 'pending');
    if (!items.length) return;
    $('#publishAllBtn').disabled = true;
    let okCount = 0, errCount = 0;
    for (const item of items) {
      const row = document.querySelector(`.upload-item[data-uid="${item.uid}"]`);
      const statusEl = row && row.querySelector('.up-status');
      if (statusEl) statusEl.textContent = 'Publishing…';
      try {
        // duration may still be resolving right after drop; wait briefly if needed
        if (!item.duration) await new Promise((r) => setTimeout(r, 250));
        const fd = new FormData();
        fd.append('audio', item.file, item.file.name);
        if (item.coverFile) fd.append('cover', item.coverFile, item.coverFile.name);
        fd.append('title', item.title);
        fd.append('artist', item.artist);
        fd.append('album', item.album);
        fd.append('duration', String(item.duration || 0));
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        if (!r.ok) throw new Error((await safeJson(r))?.error || 'Upload failed');
        const track = await r.json();
        state.tracks.push(track);
        item.status = 'done';
        if (row) { row.classList.add('up-done'); if (statusEl) statusEl.textContent = 'Published ✓'; }
        okCount++;
      } catch (err) {
        item.status = 'error';
        if (row) { row.classList.add('up-error'); if (statusEl) statusEl.textContent = 'Failed'; }
        errCount++;
      }
    }
    $('#publishAllBtn').disabled = false;
    renderSidebarPlaylists();
    renderView();
    if (okCount) toast(`Published ${okCount} track${okCount === 1 ? '' : 's'}`);
    if (errCount) toast(`${errCount} upload${errCount === 1 ? '' : 's'} failed`, true);
    state.pendingUploads = state.pendingUploads.filter((i) => i.status !== 'done');
    if (!state.pendingUploads.length) {
      setTimeout(() => {
        hideModal('uploadModal');
        $('#uploadQueue').innerHTML = '';
        $('#publishAllBtn').hidden = true;
      }, 700);
    }
  }

  // ---------- boot ----------
  loadAll().catch((err) => toast('Failed to load library: ' + err.message, true));
})();
