(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const embedEl = $('#embed');
  const audioEl = $('#embedAudio');

  const pathParts = location.pathname.split('/').filter(Boolean); // ['embed', 'username']
  const username = decodeURIComponent(pathParts[1] || '');
  const onlyTrackId = new URLSearchParams(location.search).get('track');

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function gradientHue(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(hash) % 360;
  }
  function coverStyle(id, coverUrl) {
    if (coverUrl) return `background-image:url(${coverUrl})`;
    const h = gradientHue(id);
    return `background: linear-gradient(135deg, hsl(${h},65%,45%), hsl(${(h + 40) % 360},55%,20%))`;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showState(msg) {
    embedEl.innerHTML = `<div class="embed-state">${escapeHtml(msg)}</div>`;
  }

  async function boot() {
    if (!username) { showState('No artist specified.'); return; }
    let profile;
    try {
      const r = await fetch(`/api/artists/${encodeURIComponent(username)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || 'Artist not found');
      profile = await r.json();
    } catch (err) {
      showState(err.message || 'Could not load this player.');
      return;
    }

    let tracks = profile.tracks || [];
    if (onlyTrackId) tracks = tracks.filter((t) => t.id === onlyTrackId);
    if (!tracks.length) {
      showState(onlyTrackId ? 'That track is unavailable.' : `${profile.displayName} hasn't published anything yet.`);
      return;
    }

    document.documentElement.style.setProperty('--accent', profile.themeColor || '#1ed760');
    render(profile, tracks);
  }

  function render(profile, tracks) {
    const avatarStyle = profile.avatar
      ? `background-image:url(/api/artists/${encodeURIComponent(profile.username)}/avatar-image)`
      : coverStyle(profile.id, null);
    const avatarLetter = profile.avatar ? '' : (profile.displayName || '?').charAt(0).toUpperCase();
    const multi = tracks.length > 1;

    embedEl.innerHTML = `
      <div class="embed-header">
        <div class="embed-avatar" style="${avatarStyle}">${avatarLetter}</div>
        <a class="embed-artist-name" href="/#/artist/${encodeURIComponent(profile.username)}" target="_blank" rel="noopener">${escapeHtml(profile.displayName)}</a>
        <a class="embed-brand" href="/" target="_blank" rel="noopener">▶ SpotSpace</a>
      </div>
      ${multi ? '<div class="embed-body" id="embedBody"></div>' : ''}
      <div class="embed-player">
        <div class="embed-player-cover" id="playerCover"></div>
        <div class="embed-player-info">
          <div class="embed-player-title" id="playerTitle">${multi ? 'Select a track' : escapeHtml(tracks[0].title)}</div>
          <div class="embed-player-artist" id="playerArtist">${multi ? '' : escapeHtml(tracks[0].artist)}</div>
        </div>
        <button class="embed-play-btn" id="playBtn" title="Play">
          <svg id="playIcon" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>
        </button>
        <div class="embed-seek-wrap">
          <span class="embed-time" id="timeCurrent">0:00</span>
          <input type="range" class="embed-seek" id="seekBar" min="0" max="1000" value="0">
          <span class="embed-time total" id="timeTotal">0:00</span>
        </div>
      </div>
    `;

    let queue = tracks.slice();
    let currentIndex = -1;

    function coverUrlFor(t) { return t.cover ? `/api/cover/${t.id}` : null; }

    function setPlayerInfo(t) {
      $('#playerCover').style.cssText = coverStyle(t.id, coverUrlFor(t));
      $('#playerTitle').textContent = t.title;
      $('#playerArtist').textContent = t.artist;
    }

    function highlightRow(trackId) {
      if (!multi) return;
      document.querySelectorAll('.embed-track').forEach((row) => {
        row.classList.toggle('playing', row.dataset.id === trackId);
      });
    }

    function loadTrack(index) {
      currentIndex = index;
      const t = queue[index];
      audioEl.src = `/api/stream/${t.id}`;
      audioEl.play().catch(() => {});
      setPlayerInfo(t);
      highlightRow(t.id);
    }

    if (multi) {
      const body = $('#embedBody');
      tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'embed-track';
        row.dataset.id = t.id;
        row.innerHTML = `
          <div class="embed-track-play">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>
          </div>
          <div class="embed-track-cover" style="${coverStyle(t.id, coverUrlFor(t))}"></div>
          <div class="embed-track-info">
            <div class="embed-track-title">${escapeHtml(t.title)}</div>
            <div class="embed-track-artist">${escapeHtml(t.artist)}</div>
          </div>
          <span class="embed-track-duration">${formatDuration(t.durationSec)}</span>
        `;
        row.addEventListener('click', () => {
          if (currentIndex === i && !audioEl.paused) { audioEl.pause(); return; }
          if (currentIndex === i && audioEl.paused) { audioEl.play().catch(() => {}); return; }
          loadTrack(i);
        });
        body.appendChild(row);
      });
    }

    $('#playBtn').addEventListener('click', () => {
      if (currentIndex === -1) { loadTrack(0); return; }
      if (audioEl.paused) audioEl.play().catch(() => {}); else audioEl.pause();
    });

    function setPlayIcon(playing) {
      $('#playIcon').outerHTML = playing
        ? '<svg id="playIcon" viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/></svg>'
        : '<svg id="playIcon" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>';
    }
    audioEl.addEventListener('play', () => setPlayIcon(true));
    audioEl.addEventListener('pause', () => setPlayIcon(false));

    let seeking = false;
    const seekBar = $('#seekBar');
    audioEl.addEventListener('timeupdate', () => {
      if (!audioEl.duration || seeking) return;
      seekBar.value = String(Math.round((audioEl.currentTime / audioEl.duration) * 1000));
      $('#timeCurrent').textContent = formatDuration(audioEl.currentTime);
      $('#timeTotal').textContent = formatDuration(audioEl.duration);
    });
    seekBar.addEventListener('input', () => { seeking = true; });
    seekBar.addEventListener('change', () => {
      if (audioEl.duration) audioEl.currentTime = (parseInt(seekBar.value, 10) / 1000) * audioEl.duration;
      seeking = false;
    });

    audioEl.addEventListener('ended', () => {
      if (currentIndex + 1 < queue.length) loadTrack(currentIndex + 1);
    });

    if (!multi) setPlayerInfo(tracks[0]);
  }

  boot();
})();
