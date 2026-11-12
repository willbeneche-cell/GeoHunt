/* ==========================================================================
   GEOHUNT — moteur de jeu
   MapLibre GL · Turf.js · Supabase Realtime · Html5-Qrcode
   Conçu par Nolan Lebert
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     Constantes & utilitaires
     ------------------------------------------------------------------------ */

  const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  const HIDE_MS = 60_000;
  const HOLD_MS = 5_000;
  const EXTRACTION_METERS = 10;
  const RADIO_PING_MS = 12_000;
  const RADIO_PINGS_PER_ROUND = 5;
  const HEARTBEAT_MS = 2_000;
  const PRESENCE_TTL_MS = 20_000;
  const HOST_GRACE_MS = 5_000;
  const TICK_MS = 250;
  const SHEET_PEEK_PX = 58;
  const RADII = [300, 500, 800, 1200, 2000];
  const DURATIONS = [10, 15, 20, 30];
  const EMPTY_FC = { type: 'FeatureCollection', features: [] };
  const STORE = {
    name: 'geohunt:name',
    position: 'geohunt:last-position',
    supabase: 'geohunt:supabase',
    mode: 'geohunt:mode'
  };

  // Clé publishable Supabase : conçue pour être exposée dans le client.
  // Ne jamais utiliser une clé service_role ici.
  const SUPABASE_DEFAULT = {
    url: 'https://ktmhueqxbsxrmejrwvxe.supabase.co',
    key: 'sb_publishable_huJEwBNheUP8NHVghpQHdQ_8nCZJAW9'
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const el = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function uid() {
    if (window.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function randomCode(length = 6) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  }

  function cleanCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function randomToken() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  }

  function cleanName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18);
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
  }

  function shortName(name) {
    const value = String(name || 'Joueur');
    return value.length > 11 ? `${value.slice(0, 10)}…` : value;
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function fmtDistance(meters) {
    if (!Number.isFinite(meters)) return '—';
    if (meters < 1000) return `${Math.max(0, Math.round(meters))} m`;
    const km = meters / 1000;
    return `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`;
  }

  function fmtCoords(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }

  function fmtHour(ts = Date.now()) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function distanceMeters(a, b) {
    if (!a || !b) return null;
    if (window.turf?.distance) {
      return turf.distance(a, b, { units: 'meters' });
    }
    const toRad = (value) => value * Math.PI / 180;
    const R = 6_371_000;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function validLngLat(lng, lat) {
    return Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))
      && Math.abs(Number(lng)) <= 180 && Math.abs(Number(lat)) <= 90;
  }

  function readJSON(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible : la session reste en mémoire */
    }
  }

  function lucideIcons() {
    if (window.lucide?.createIcons) {
      try { lucide.createIcons(); } catch { /* icônes déjà rendues */ }
    }
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* non supporté */ }
    }
  }

  /* ------------------------------------------------------------------------
     État
     ------------------------------------------------------------------------ */

  const state = {
    view: 'home',
    mode: 'demo',
    config: null,
    supabaseClient: null,
    transport: null,
    transportKind: null,
    connection: 'idle',
    connectionNotified: false,
    hostMissingSince: null,
    playerId: uid(),
    name: '',
    role: 'hunter',
    room: null,
    players: new Map(),
    logs: [],
    gps: null,
    geoStatus: 'idle',
    geoError: '',
    watchId: null,
    map: null,
    mapLoaded: false,
    mapInitPromise: null,
    mapLoadTimer: null,
    mapErrorShown: false,
    hasFlown: false,
    markers: new Map(),
    extractionMarkers: [],
    extractionRevealed: false,
    radioMarkers: new Map(),
    radio: { index: null },
    centerMarker: null,
    picking: false,
    sheet: { collapsed: false, drag: null },
    extraction: { since: null, validated: false },
    present: { lastAt: 0 },
    timers: { presence: null, join: null, hello: null, tick: null, dbPoll: null },
    dbUnavailable: false,
    dbBusy: false,
    joinResolver: null,
    joinCode: null,
    joinRejecter: null,
    scanner: null,
    scannerActive: false,
    scanHandled: false,
    confirmAction: null,
    busy: false,
    endScheduled: false,
    announcedChase: false,
    lastBeepKey: null,
    statusModalShownFor: null,
    audio: null,
    fallbackAnnounce: false,
    removeListeners: []
  };

  const roleLabel = (role) => role === 'fugitive' ? 'FUGITIF' : 'CHERCHEUR';
  const statusLabel = (status) => ({
    active: 'EN JEU', out: 'ÉLIMINÉ', captured: 'NEUTRALISÉ', extracted: 'EXTRAIT'
  }[status] || 'EN JEU');
  const self = () => state.players.get(state.playerId) || null;
  const room = () => state.room;
  const isHost = () => Boolean(state.room && state.room.hostId === state.playerId);

  function playersArray() {
    return [...state.players.values()].sort((a, b) => {
      if (state.room?.hostId === a.id) return -1;
      if (state.room?.hostId === b.id) return 1;
      return a.joinedAt - b.joinedAt || a.name.localeCompare(b.name, 'fr');
    });
  }

  /* ------------------------------------------------------------------------
     Carte MapLibre
     ------------------------------------------------------------------------ */

  function zoomForRadius(radius) {
    return 15.9 - Math.log2(Math.max(1, radius / 500)) * 0.9;
  }

  function mapFlyDuration(duration) {
    return reducedMotion ? 0 : duration;
  }

  function ensureMap(center, zoom = 13.2) {
    if (state.map) return Promise.resolve(state.map);
    if (state.mapInitPromise) return state.mapInitPromise;
    if (!window.maplibregl) {
      const loading = el('map-loading');
      if (loading) loading.innerHTML = '<span class="mono">CARTE INDISPONIBLE</span>';
      toast('La carte 3D n’a pas pu être chargée. Vérifiez votre connexion.', 'danger');
      return Promise.resolve(null);
    }

    const map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLE,
      center,
      zoom,
      pitch: 45,
      bearing: -17.6,
      maxPitch: 70,
      minZoom: 1.4,
      maxZoom: 19,
      antialias: true,
      attributionControl: false
    });

    state.map = map;
    map.on('click', (event) => {
      if (state.picking) commitCenter([event.lngLat.lng, event.lngLat.lat]);
    });

    state.mapInitPromise = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        state.mapLoaded = true;
        if (state.mapLoadTimer) clearTimeout(state.mapLoadTimer);
        const loading = el('map-loading');
        if (loading) loading.classList.add('hidden');
        addMapLayers();
        updateZoneOnMap();
        syncMarkers();
        syncCenterMarker();
        syncExtractionMarkers();
        syncAccuracyCircle();
        const point = state.gps;
        if (state.room?.center) {
          fitZone({ instant: true });
          state.hasFlown = true;
        } else if (point) {
          map.flyTo({
            center: [point.lng, point.lat],
            zoom: 16.2,
            pitch: 45,
            bearing: -17.6,
            duration: mapFlyDuration(1500)
          });
          state.hasFlown = true;
        }
        resolve(map);
      };

      map.on('load', finish);
      map.on('error', (event) => {
        const message = String(event?.error?.message || '');
        if (!state.mapLoaded && !state.mapErrorShown && !/abort/i.test(message)) {
          state.mapErrorShown = true;
          const loading = el('map-loading');
          if (loading) loading.innerHTML = '<span class="mono">CARTE INDISPONIBLE</span>';
          toast('Fond de carte indisponible. Le jeu continue avec le GPS.', 'danger', 5000);
        }
      });

      state.mapLoadTimer = setTimeout(() => {
        if (done) return;
        const loading = el('map-loading');
        if (loading) loading.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="mono">CARTE LENTE</span>';
      }, 9_000);
    });

    return state.mapInitPromise;
  }

  function addMapLayers() {
    const map = state.map;
    if (!map) return;
    let style;
    try { style = map.getStyle(); } catch { return; }
    if (!style) return;

    const firstSymbol = style.layers?.find((layer) => layer.type === 'symbol')?.id;

    const vectorSource = style.sources?.protomaps
      ? 'protomaps'
      : Object.entries(style.sources || {}).find(([, source]) => source.type === 'vector')?.[0];

    if (vectorSource && !map.getLayer('gh-buildings-3d')) {
      try {
        map.addLayer({
          id: 'gh-buildings-3d',
          type: 'fill-extrusion',
          source: vectorSource,
          'source-layer': 'buildings',
          minzoom: 13.5,
          paint: {
            'fill-extrusion-color': [
              'interpolate', ['linear'], ['coalesce', ['get', 'height'], ['get', 'render_height'], 12],
              0, '#f1f5f9', 30, '#e8edf3', 120, '#dbe3ec'
            ],
            'fill-extrusion-height': ['coalesce', ['get', 'height'], ['get', 'render_height'], 12],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
            'fill-extrusion-opacity': 0.78,
            'fill-extrusion-vertical-gradient': true
          }
        }, firstSymbol);
      } catch { /* le style ne contient pas de bâtiments extrudables */ }
    }

    if (!map.getSource('gh-accuracy')) {
      map.addSource('gh-accuracy', { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer('gh-accuracy-fill')) {
      try {
        map.addLayer({
          id: 'gh-accuracy-fill', type: 'fill', source: 'gh-accuracy',
          paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.045 }
        }, firstSymbol);
      } catch { /* ignoré */ }
    }
    if (!map.getLayer('gh-accuracy-line')) {
      try {
        map.addLayer({
          id: 'gh-accuracy-line', type: 'line', source: 'gh-accuracy',
          paint: { 'line-color': '#0f172a', 'line-opacity': 0.14, 'line-width': 0.8 }
        }, firstSymbol);
      } catch { /* ignoré */ }
    }

    if (!map.getSource('gh-zone')) {
      map.addSource('gh-zone', { type: 'geojson', data: EMPTY_FC });
    }
    if (!map.getLayer('gh-zone-fill')) {
      try {
        map.addLayer({
          id: 'gh-zone-fill', type: 'fill', source: 'gh-zone',
          paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.045 }
        }, firstSymbol);
      } catch { /* ignoré */ }
    }
    if (!map.getLayer('gh-zone-halo')) {
      try {
        map.addLayer({
          id: 'gh-zone-halo', type: 'line', source: 'gh-zone',
          paint: {
            'line-color': '#ffffff', 'line-width': 5.5, 'line-opacity': 0.62,
            'line-dasharray': [1.8, 1.2]
          }
        }, firstSymbol);
      } catch { /* ignoré */ }
    }
    if (!map.getLayer('gh-zone-line')) {
      try {
        map.addLayer({
          id: 'gh-zone-line', type: 'line', source: 'gh-zone',
          paint: {
            'line-color': '#0f172a', 'line-width': 2, 'line-opacity': 0.9,
            'line-dasharray': [1.8, 1.2]
          }
        }, firstSymbol);
      } catch { /* ignoré */ }
    }

    updateZoneOnMap();
    syncAccuracyCircle();
  }

  function zoneFeature() {
    if (!state.room?.center || !window.turf?.circle) return null;
    return turf.circle(state.room.center, state.room.radius / 1000, {
      steps: 128,
      units: 'kilometers'
    });
  }

  function updateZoneOnMap() {
    const map = state.map;
    if (!map || !state.mapLoaded) return;
    const source = map.getSource('gh-zone');
    if (!source) return;
    const show = state.room && state.room.phase !== 'end';
    const feature = show ? zoneFeature() : null;
    source.setData(feature ? { type: 'FeatureCollection', features: [feature] } : EMPTY_FC);
    syncCenterMarker();
  }

  function syncAccuracyCircle() {
    const map = state.map;
    if (!map || !state.mapLoaded) return;
    const source = map.getSource('gh-accuracy');
    if (!source) return;
    if (!state.gps || !window.turf?.circle || state.gps.accuracy > 280) {
      source.setData(EMPTY_FC);
      return;
    }
    const feature = turf.circle([state.gps.lng, state.gps.lat], Math.max(state.gps.accuracy, 5) / 1000, {
      steps: 48,
      units: 'kilometers'
    });
    source.setData({ type: 'FeatureCollection', features: [feature] });
  }

  function fitZone({ instant = false } = {}) {
    const map = state.map;
    if (!map || !state.room?.center || !state.mapLoaded) return;
    const { center, radius } = state.room;
    if (window.innerWidth >= 1024) {
      if (!window.turf?.circle || !window.turf?.bbox) return;
      const circle = turf.circle(center, radius / 1000, { steps: 48, units: 'kilometers' });
      const box = turf.bbox(circle);
      map.fitBounds([[box[0], box[1]], [box[2], box[3]]], {
        padding: { top: 110, bottom: 90, left: 460, right: 90 },
        maxZoom: 16.5,
        pitch: 45,
        bearing: -17.6,
        duration: instant || reducedMotion ? 0 : 850
      });
    } else {
      map.flyTo({
        center,
        zoom: zoomForRadius(radius),
        pitch: 45,
        bearing: -17.6,
        duration: instant || reducedMotion ? 0 : 850
      });
    }
  }

  function flyToGps(duration = 900) {
    if (!state.map || !state.gps) return;
    state.map.flyTo({
      center: [state.gps.lng, state.gps.lat],
      zoom: 16.2,
      pitch: 45,
      bearing: -17.6,
      duration: mapFlyDuration(duration)
    });
  }

  /* ------------------------------------------------------------------------
     Marqueurs
     ------------------------------------------------------------------------ */

  function playerMarkerElement(player) {
    const wrapper = document.createElement('div');
    wrapper.className = `gh-marker gh-marker--${player.role}${player.id === state.playerId ? ' gh-marker--self' : ''}`;
    wrapper.innerHTML = '<span class="gh-dot"></span><span class="gh-label"></span>';
    wrapper.querySelector('.gh-label').textContent = player.id === state.playerId ? 'VOUS' : shortName(player.name);
    return wrapper;
  }

  function syncMarkers() {
    const map = state.map;
    if (!map || !state.room) {
      for (const { marker } of state.markers.values()) marker.remove();
      state.markers.clear();
      return;
    }

    const visible = new Map();
    const me = self();
    if (me && state.gps) {
      visible.set(me.id, me);
    }
    if (me && state.room.phase === 'game') {
      for (const player of state.players.values()) {
        if (player.id === me.id) continue;
        if (player.role !== me.role || player.status !== 'active') continue;
        if (!validLngLat(player.lng, player.lat)) continue;
        visible.set(player.id, player);
      }
    }

    for (const [id, player] of visible) {
      const lng = id === state.playerId && state.gps ? state.gps.lng : player.lng;
      const lat = id === state.playerId && state.gps ? state.gps.lat : player.lat;
      if (!validLngLat(lng, lat)) continue;
      let entry = state.markers.get(id);
      if (!entry) {
        const element = playerMarkerElement(player);
        const marker = new maplibregl.Marker({ element, anchor: 'left' })
          .setLngLat([lng, lat])
          .addTo(map);
        entry = { marker, element };
        state.markers.set(id, entry);
      } else {
        entry.marker.setLngLat([lng, lat]);
        entry.element.className = `gh-marker gh-marker--${player.role}${player.id === state.playerId ? ' gh-marker--self' : ''}`;
      }
      entry.element.classList.toggle('is-out', player.status !== 'active');
      const label = entry.element.querySelector('.gh-label');
      if (label) label.textContent = player.id === state.playerId ? 'VOUS' : shortName(player.name);
    }

    for (const [id, entry] of state.markers) {
      if (!visible.has(id)) {
        entry.marker.remove();
        state.markers.delete(id);
      }
    }
  }

  function syncCenterMarker() {
    const map = state.map;
    if (!map) return;
    const show = state.room?.phase === 'lobby' && state.room.center;
    if (!show) {
      state.centerMarker?.remove();
      state.centerMarker = null;
      return;
    }
    if (!state.centerMarker) {
      const element = document.createElement('div');
      element.className = 'gh-center-marker';
      element.innerHTML = '<span class="gh-center-cross"></span><span class="gh-center-label">CENTRE</span>';
      state.centerMarker = new maplibregl.Marker({ element, anchor: 'bottom', offset: [0, -3] })
        .setLngLat(state.room.center)
        .addTo(map);
    } else {
      state.centerMarker.setLngLat(state.room.center);
    }
  }

  function syncExtractionMarkers() {
    const map = state.map;
    for (const marker of state.extractionMarkers) marker.remove();
    state.extractionMarkers = [];
    if (!map || !state.room || state.room.phase !== 'game') return;
    // Les points restent invisibles pendant toute la cache initiale.
    if (Date.now() < (state.room.hideEndsAt || 0)) return;
    const points = state.room.extraction || [];
    points.forEach((point, index) => {
      const element = document.createElement('div');
      element.className = 'gh-extraction-marker';
      element.innerHTML = `<span class="gh-ex-dot"></span><span class="gh-ex-label">EX 0${index + 1}</span>`;
      const marker = new maplibregl.Marker({ element, anchor: 'left' })
        .setLngLat([point.lng, point.lat])
        .addTo(map);
      state.extractionMarkers.push(marker);
    });
  }

  function clearMapOverlays() {
    for (const { marker } of state.markers.values()) marker.remove();
    state.markers.clear();
    state.centerMarker?.remove();
    state.centerMarker = null;
    for (const marker of state.extractionMarkers) marker.remove();
    state.extractionMarkers = [];
    clearRadioMarkers();
    state.extractionRevealed = false;
    state.radio.index = null;
    el('radio-chip')?.classList.add('hidden');
    if (state.mapLoaded) {
      state.map?.getSource('gh-zone')?.setData(EMPTY_FC);
      state.map?.getSource('gh-accuracy')?.setData(EMPTY_FC);
    }
  }

  /* ------------------------------------------------------------------------
     GPS
     ------------------------------------------------------------------------ */

  function updateGpsUi() {
    const dot = el('gps-dot');
    const text = el('gps-text');
    const detail = el('gps-detail');
    const retry = el('btn-retry-gps');
    if (!dot || !text || !detail) return;

    dot.className = 'status-dot';
    if (state.gps) {
      dot.classList.add('is-ok');
      text.textContent = 'GPS VERROUILLÉ';
      detail.textContent = `± ${Math.max(1, Math.round(state.gps.accuracy || 0))} m`;
      retry?.classList.add('hidden');
    } else if (state.geoStatus === 'waiting') {
      dot.classList.add('is-waiting');
      text.textContent = 'ACQUISITION GPS';
      detail.textContent = '—';
      retry?.classList.add('hidden');
    } else if (state.geoStatus === 'error') {
      dot.classList.add('is-error');
      text.textContent = 'GPS INDISPONIBLE';
      detail.textContent = state.geoError === 'unsupported' ? 'NON SUPPORTÉ' : 'AUTORISEZ';
      retry?.classList.remove('hidden');
    } else {
      dot.classList.add('is-waiting');
      text.textContent = 'ACQUISITION GPS';
      detail.textContent = '—';
      retry?.classList.add('hidden');
    }
  }

  function geoErrorMessage(error) {
    if (!window.isSecureContext) {
      return 'Cette page doit être servie en HTTPS pour accéder au GPS. Ouvrez GEOHUNT depuis une origine sécurisée, puis réessayez.';
    }
    switch (error?.code) {
      case 1: return 'L’autorisation de localisation a été refusée. Autorisez le GPS pour GEOHUNT dans les réglages du navigateur, puis réessayez.';
      case 2: return 'Votre position est momentanément indisponible. Vérifiez que le GPS du téléphone est activé, puis réessayez.';
      case 3: return 'La recherche GPS a expiré. Sortez à l’air libre ou vérifiez le signal, puis réessayez.';
      default: return 'GEOHUNT n’a pas pu obtenir votre position. Vérifiez le GPS et l’autorisation du navigateur, puis réessayez.';
    }
  }

  function onGpsSuccess(position) {
    const { latitude, longitude, accuracy } = position.coords;
    state.gps = {
      lat: latitude,
      lng: longitude,
      accuracy: Number.isFinite(accuracy) ? accuracy : 30,
      at: Date.now()
    };
    state.geoStatus = 'ok';
    state.geoError = '';
    writeJSON(STORE.position, state.gps);
    closeModal('geo-modal');
    updateGpsUi();
    syncAccuracyCircle();

    const me = self();
    if (me) {
      me.lat = latitude;
      me.lng = longitude;
      me.accuracy = state.gps.accuracy;
      me.lastSeen = Date.now();
      if (!me.joinedAt) me.joinedAt = Date.now();
    }

    const firstFix = !state.map;
    const mapCenter = [longitude, latitude];
    ensureMap(mapCenter).then((map) => {
      if (!map) return;
      if (!state.hasFlown) {
        if (state.room?.center) {
          fitZone({ instant: firstFix });
        } else {
          map.flyTo({
            center: mapCenter, zoom: 16.2, pitch: 45, bearing: -17.6,
            duration: mapFlyDuration(1500)
          });
        }
        state.hasFlown = true;
      }
      syncMarkers();
    });

    syncMarkers();
    publishPresence();
    if (state.view === 'game') updateGameDynamic();
    checkSelfZone();
    startWatch();
  }

  function onGpsError(error, { interactive = false } = {}) {
    if (state.gps && Date.now() - state.gps.at < 30_000) {
      updateGpsUi();
      return;
    }
    const wasWaiting = state.geoStatus === 'waiting';
    state.geoStatus = 'error';
    state.geoError = error?.code === 1 ? 'denied' : 'unavailable';
    updateGpsUi();
    if (!state.map) {
      const saved = readJSON(STORE.position);
      const fallback = saved && validLngLat(saved.lng, saved.lat) && Date.now() - saved.at < 7 * 86400000
        ? [saved.lng, saved.lat]
        : [0, 20];
      ensureMap(fallback, saved ? 12 : 1.7);
    }
    if (interactive || wasWaiting) {
      el('geo-message').textContent = geoErrorMessage(error);
      openModal('geo-modal');
    }
  }

  function requestGps({ interactive = false } = {}) {
    if (!navigator.geolocation) {
      onGpsError({ code: 0 }, { interactive: true });
      state.geoError = 'unsupported';
      return;
    }
    state.geoStatus = 'waiting';
    updateGpsUi();
    navigator.geolocation.getCurrentPosition(
      onGpsSuccess,
      (error) => onGpsError(error, { interactive }),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 4_000 }
    );
  }

  function requestPositionSilent() {
    if (!navigator.geolocation || !state.room) return;
    navigator.geolocation.getCurrentPosition(
      onGpsSuccess,
      () => { /* le watch reprendra */ },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 2_000 }
    );
  }

  function startWatch() {
    if (state.watchId != null || !navigator.geolocation || !state.room) return;
    state.watchId = navigator.geolocation.watchPosition(
      onGpsSuccess,
      () => { /* on conserve la dernière position connue */ },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 2_500 }
    );
  }

  function stopWatch() {
    if (state.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.watchId);
    }
    state.watchId = null;
  }

  /* ------------------------------------------------------------------------
     Joueurs
     ------------------------------------------------------------------------ */

  function normalizePlayer(raw) {
    if (!raw || !raw.id) return null;
    const role = raw.role === 'fugitive' ? 'fugitive' : 'hunter';
    const status = ['active', 'out', 'captured', 'extracted'].includes(raw.status) ? raw.status : 'active';
    return {
      id: String(raw.id).slice(0, 64),
      name: cleanName(raw.name) || 'Joueur',
      role,
      status,
      token: String(raw.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
      joinedAt: Number(raw.joinedAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || 0,
      lat: validLngLat(raw.lng, raw.lat) ? Number(raw.lat) : null,
      lng: validLngLat(raw.lng, raw.lat) ? Number(raw.lng) : null,
      accuracy: Number.isFinite(Number(raw.accuracy)) ? Number(raw.accuracy) : null,
      lastSeen: Date.now(),
      outReason: raw.outReason || '',
      capturedBy: cleanName(raw.capturedBy) || '',
      extractedAt: Number(raw.extractedAt) || null,
      extractedPoint: raw.extractedPoint || ''
    };
  }

  function normalizeRoom(raw) {
    if (!raw || typeof raw.code !== 'string') return null;
    const code = cleanCode(raw.code);
    if (code.length !== 6) return null;
    const center = Array.isArray(raw.center) && validLngLat(raw.center[0], raw.center[1])
      ? [Number(raw.center[0]), Number(raw.center[1])]
      : null;
    const radius = RADII.includes(Number(raw.radius)) ? Number(raw.radius) : 500;
    const duration = DURATIONS.includes(Number(raw.duration)) ? Number(raw.duration) : 15;
    const phase = ['lobby', 'game', 'end'].includes(raw.phase) ? raw.phase : 'lobby';
    const extraction = Array.isArray(raw.extraction)
      ? raw.extraction.filter((point) => validLngLat(point.lng, point.lat)).slice(0, 2).map((point, index) => ({
        id: `EX 0${index + 1}`,
        lng: Number(point.lng),
        lat: Number(point.lat)
      }))
      : [];
    return {
      code,
      hostId: String(raw.hostId || ''),
      center,
      radius,
      duration,
      phase,
      round: Math.max(0, Number(raw.round) || 0),
      startsAt: Number(raw.startsAt) || null,
      hideEndsAt: Number(raw.hideEndsAt) || null,
      endsAt: Number(raw.endsAt) || null,
      extraction,
      endedReason: String(raw.endedReason || ''),
      endedAt: Number(raw.endedAt) || null
    };
  }

  function selfPayload() {
    const me = self();
    if (!me) return null;
    if (state.gps) {
      me.lat = state.gps.lat;
      me.lng = state.gps.lng;
      me.accuracy = state.gps.accuracy;
    }
    return { ...me };
  }

  function playersPayload() {
    return playersArray().map((player) => {
      if (player.id === state.playerId && state.gps) {
        return { ...player, lat: state.gps.lat, lng: state.gps.lng, accuracy: state.gps.accuracy };
      }
      return { ...player };
    });
  }

  function mergePlayers(list, { force = false } = {}) {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const incoming = normalizePlayer(raw);
      if (!incoming) continue;
      if (incoming.id === state.playerId) {
        let me = state.players.get(state.playerId);
        if (!me) {
          me = incoming;
          me.name = state.name || incoming.name;
          me.role = state.role;
          state.players.set(me.id, me);
        } else {
          me.name = state.name || me.name;
          me.role = state.role;
          if (force) me.status = incoming.status === 'active' ? 'active' : me.status;
          me.lastSeen = Date.now();
        }
        continue;
      }
      const existing = state.players.get(incoming.id);
      if (!existing) {
        state.players.set(incoming.id, incoming);
        continue;
      }
      const newer = incoming.updatedAt >= existing.updatedAt;
      existing.name = incoming.name;
      existing.role = incoming.role;
      existing.joinedAt = incoming.joinedAt;
      existing.token = incoming.token || existing.token;
      existing.lat = incoming.lat;
      existing.lng = incoming.lng;
      existing.accuracy = incoming.accuracy;
      existing.lastSeen = Date.now();
      if (force || newer) {
        existing.status = incoming.status;
        existing.updatedAt = incoming.updatedAt;
        existing.outReason = incoming.outReason;
        existing.capturedBy = incoming.capturedBy;
        existing.extractedAt = incoming.extractedAt;
        existing.extractedPoint = incoming.extractedPoint;
      }
    }
  }

  function ensureHost() {
    if (!state.room) return;
    const list = playersArray();
    if (!list.length) return;
    const hostExists = list.some((player) => player.id === state.room.hostId);
    if (hostExists) {
      state.hostMissingSince = null;
      if (state.room.hostId === state.playerId) {
        state.role = self()?.role || state.role;
      }
      return;
    }
    if (!state.hostMissingSince) {
      state.hostMissingSince = Date.now();
      return;
    }
    if (Date.now() - state.hostMissingSince < HOST_GRACE_MS) return;
    state.hostMissingSince = null;
    const next = list[0];
    state.room.hostId = next.id;
    if (next.id === state.playerId) {
      toast('Vous êtes désormais hôte du salon.', 'info');
      broadcastRoomState();
    }
    refreshHostUi();
    if (state.view === 'lobby') renderLobby();
    if (state.view === 'end') renderEnd();
  }

  function refreshHostUi() {
    const host = isHost();
    if (state.view === 'lobby') {
      el('host-zone')?.classList.toggle('hidden', !host);
      el('guest-zone')?.classList.toggle('hidden', host);
    }
    if (state.view === 'end') {
      el('btn-rematch')?.classList.toggle('hidden', !host);
      el('end-wait')?.classList.toggle('hidden', host);
    }
  }

  /* ------------------------------------------------------------------------
     Temps réel : messages et transports
     ------------------------------------------------------------------------ */

  function broadcastRoomState() {
    if (!state.room || !state.transport) return;
    persistRoomRecord();
    state.transport.send({ type: 'room-state', room: state.room, players: playersPayload() });
  }

  function publishPresence(force = false) {
    if (!state.transport || !state.room) return;
    const now = Date.now();
    if (!force && now - state.present.lastAt < 700) return;
    state.present.lastAt = now;
    state.transport.updatePresence();
  }

  function applyRoomState(rawRoom, rawPlayers, { authorative = false } = {}) {
    const incoming = normalizeRoom(rawRoom);
    if (!incoming || (state.room && incoming.code !== state.room.code)) return false;
    state.room = incoming;
    if (rawPlayers) mergePlayers(rawPlayers, { force: authorative });
    state.isHost = incoming.hostId === state.playerId;
    document.body.dataset.role = state.role;
    updateRoomChrome();
    refreshHostUi();
    updateZoneOnMap();
    syncMarkers();
    syncCenterMarker();
    syncExtractionMarkers();
    return true;
  }

  function completeJoin(message) {
    const resolver = state.joinResolver;
    const incoming = normalizeRoom(message.room);
    if (!resolver || !incoming) return;
    if (state.joinCode && incoming.code !== state.joinCode) return;
    state.joinResolver = null;
    state.joinRejecter = null;
    if (state.timers.join) clearTimeout(state.timers.join);
    if (state.timers.hello) clearInterval(state.timers.hello);
    state.joinCode = null;
    state.room = incoming;
    mergePlayers(message.players || [], { force: true });
    state.isHost = incoming.hostId === state.playerId;
    if (incoming.phase === 'game') {
      state.announcedChase = Date.now() >= (incoming.hideEndsAt || 0);
      state.logs = [];
      showView('game');
      renderGameStatic();
      updateGameDynamic();
    } else if (incoming.phase === 'end') {
      showView('end');
      renderEnd();
    } else {
      state.logs = [];
      showView('lobby');
      renderLobby();
      fitZone();
    }
    updateRoomChrome();
    updateModeUi();
    persistSelfPlayer();
    startDbPoll();
    addLog('Salon rejoint.');
    publishPresence(true);
    toast(`Salon ${incoming.code} rejoint.`, 'success');
    resolver(incoming);
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object' || !message.type) return;
    if (message.from === state.playerId) return;

    switch (message.type) {
      case 'hello': {
        if (!state.room) return;
        if (state.room.phase === 'game') {
          state.transport?.send({ type: 'join-refused', targetId: message.from, reason: 'Une manche est déjà en cours.' });
          return;
        }
        const guest = normalizePlayer(message.player);
        if (guest) {
          const exists = state.players.has(guest.id);
          state.players.set(guest.id, { ...guest, lastSeen: Date.now() });
          void dbUpsertPlayer(guest, state.room.code);
          if (!exists) addLog(`${guest.name} a rejoint le salon.`);
          renderLobby();
        }
        ensureHost();
        if (isHost()) {
          state.transport?.send({
            type: 'room-state',
            room: state.room,
            players: playersPayload()
          });
          state.transport?.updatePresence();
        }
        return;
      }

      case 'join-refused': {
        if (message.targetId && message.targetId !== state.playerId) return;
        if (state.joinRejecter) state.joinRejecter(new Error(message.reason || 'Salon indisponible.'));
        return;
      }

      case 'room-state': {
        if (!state.room) {
          if (state.joinResolver) completeJoin(message);
          return;
        }
        const senderWasHost = message.from === state.room.hostId;
        const nextHost = message.room?.hostId;
        if (!senderWasHost && nextHost !== message.from) return;
        applyRoomState(message.room, message.players, { authorative: false });
        if (state.view === 'lobby') renderLobby();
        if (state.view === 'end') renderEnd();
        return;
      }

      case 'presence': {
        if (!state.room) return;
        const player = normalizePlayer(message.player);
        if (!player) return;
        const isNew = !state.players.has(player.id);
        mergePlayers([player]);
        playerPlaced(player);
        if (isNew) addLog(`${player.name} a rejoint le salon.`);
        ensureHost();
        syncMarkers();
        if (state.view === 'lobby') renderLobby();
        if (state.view === 'game') renderGameStatic();
        if (isHost() && isNew) broadcastRoomState();
        return;
      }

      case 'start': {
        if (!state.room || message.from !== state.room.hostId) return;
        applyStart(message.room, message.players, false);
        return;
      }

      case 'status': {
        if (!state.room) return;
        const allowed = message.from === message.playerId || message.from === state.room.hostId;
        if (!allowed) return;
        applyRemoteStatus(message.playerId, message.status, {
          reason: message.reason,
          by: message.by,
          point: message.point
        });
        return;
      }

      case 'capture': {
        if (!state.room) return;
        const target = state.players.get(message.targetId);
        if (!target || target.role !== 'fugitive' || target.status !== 'active') return;
        if (String(target.token).toUpperCase() !== String(message.token).toUpperCase()) return;
        applyRemoteStatus(message.targetId, 'captured', { by: message.by });
        return;
      }

      case 'extraction': {
        if (!state.room) return;
        applyRemoteStatus(message.playerId, 'extracted', { point: message.point });
        return;
      }

      case 'end': {
        if (!state.room) return;
        if (message.from !== state.room.hostId && message.room?.hostId !== message.from) return;
        applyEndState(message.room, message.players);
        return;
      }

      case 'rematch': {
        if (!state.room) return;
        if (message.from !== state.room.hostId) return;
        applyRematch(message.room, message.players);
        return;
      }

      case 'leave': {
        if (!state.room) return;
        const leaving = state.players.get(message.playerId);
        if (!leaving) return;
        state.players.delete(message.playerId);
        addLog(`${leaving.name} a quitté le salon.`);
        ensureHost();
        syncMarkers();
        if (state.view === 'lobby') renderLobby();
        if (state.view === 'game') renderGameStatic();
        return;
      }

      default:
        return;
    }
  }

  function playerPlaced(player) {
    if (!state.room || state.room.phase !== 'game') return;
    if (isHost() && player.role === 'fugitive' && player.status === 'active') {
      if (player.id === state.playerId) return;
      const center = state.room.center;
      if (!center || !validLngLat(player.lng, player.lat)) return;
      const distance = distanceMeters([player.lng, player.lat], center);
      if (distance != null && distance > state.room.radius) {
        markRemoteOut(player.id, 'zone');
      }
    }
  }

  function presenceSnapshot(presenceState) {
    const incoming = [];
    for (const entries of Object.values(presenceState || {})) {
      for (const entry of entries || []) {
        if (entry?.id) incoming.push(entry);
      }
    }
    return incoming;
  }

  function refreshPresenceUi({ broadcast = false } = {}) {
    ensureHost();
    syncMarkers();
    if (state.view === 'lobby') renderLobby();
    if (state.view === 'game') renderGameStatic();
    if (broadcast && isHost()) broadcastRoomState();
  }

  function absorbPresence(entries, { removeMissing = false, broadcast = false } = {}) {
    if (!state.room) return;
    const incoming = (entries || []).filter((entry) => entry?.id);
    const previous = new Set(state.players.keys());
    mergePlayers(incoming);
    for (const raw of incoming) {
      const player = normalizePlayer(raw);
      if (!player) continue;
      if (!previous.has(player.id) && player.id !== state.playerId) {
        addLog(`${player.name} a rejoint le salon.`);
      }
      playerPlaced(player);
    }
    if (removeMissing) {
      const present = new Set(incoming.map((entry) => String(entry.id)));
      for (const [id, player] of state.players) {
        if (id === state.playerId || present.has(id)) continue;
        state.players.delete(id);
        addLog(`${player.name} a quitté le salon.`);
      }
    }
    refreshPresenceUi({ broadcast });
  }

  function handlePresenceSync(presenceState) {
    absorbPresence(presenceSnapshot(presenceState), { removeMissing: true, broadcast: true });
  }

  function handlePresenceJoin(entries) {
    if (!state.room || !Array.isArray(entries) || !entries.length) return;
    absorbPresence(entries, { broadcast: true });
  }

  function handlePresenceLeave(entries) {
    if (!state.room || !Array.isArray(entries)) return;
    let changed = false;
    for (const entry of entries) {
      if (!entry?.id || entry.id === state.playerId) continue;
      const player = state.players.get(entry.id);
      if (!player) continue;
      state.players.delete(entry.id);
      addLog(`${player.name} a quitté le salon.`);
      changed = true;
    }
    if (!changed) return;
    refreshPresenceUi({ broadcast: true });
  }

  function createLocalTransport(code) {
    const channel = new BroadcastChannel(`geohunt_room_${code}`);
    let closed = false;
    channel.onmessage = (event) => {
      if (!closed) handleMessage(event.data);
    };
    return {
      kind: 'local',
      async connect() {
        state.connection = 'connected';
        updateModeUi();
      },
      send(message) {
        if (closed) return;
        try { channel.postMessage({ ...message, from: state.playerId, sentAt: Date.now() }); } catch { /* canal fermé */ }
      },
      updatePresence() {
        this.send({ type: 'presence', player: selfPayload() });
      },
      async close() {
        if (closed) return;
        try {
          channel.postMessage({ type: 'leave', from: state.playerId, playerId: state.playerId, sentAt: Date.now() });
        } catch { /* ignoré */ }
        closed = true;
        channel.close();
      }
    };
  }

  function getSupabaseClient() {
    if (!window.supabase) throw new Error('Bibliothèque Supabase indisponible.');
    if (!state.config?.url || !state.config?.key) throw new Error('Configuration Supabase manquante.');
    if (!state.supabaseClient) {
      state.supabaseClient = window.supabase.createClient(state.config.url, state.config.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
    }
    return state.supabaseClient;
  }

  function createSupabaseTransport(code) {
    const client = getSupabaseClient();
    const channel = client.channel(`geohunt_room_${code}`, {
      config: {
        broadcast: { self: false },
        presence: { key: state.playerId }
      }
    });
    let closed = false;
    let settled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectReady(new Error('Délai de connexion Supabase dépassé.'));
      }
    }, 9_000);

    channel.on('broadcast', { event: 'gh' }, ({ payload }) => {
      if (!closed) handleMessage(payload);
    });
    channel.on('presence', { event: 'sync' }, () => {
      if (!closed) handlePresenceSync(channel.presenceState());
    });
    channel.on('presence', { event: 'join' }, ({ newPresences }) => {
      if (!closed) handlePresenceJoin(newPresences);
    });
    channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      if (!closed) handlePresenceLeave(leftPresences);
    });
    channel.subscribe((status) => {
      if (closed) return;
      if (status === 'SUBSCRIBED') {
        state.connection = 'connected';
        updateModeUi();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolveReady();
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        state.connection = 'error';
        updateModeUi();
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          rejectReady(new Error('Connexion Supabase impossible.'));
        } else if (!state.connectionNotified) {
          state.connectionNotified = true;
          toast('Connexion temps réel interrompue. Vérifiez le réseau.', 'danger', 5000);
        }
      }
    });

    return {
      kind: 'supabase',
      connect: () => ready,
      send(message) {
        if (closed) return;
        channel.send({
          type: 'broadcast',
          event: 'gh',
          payload: { ...message, from: state.playerId, sentAt: Date.now() }
        }).catch(() => { /* reconnexion gérée par Supabase */ });
      },
      updatePresence() {
        if (closed) return;
        const player = selfPayload();
        channel.track(player || {}).catch(() => { /* présence indisponible */ });
        if (player) this.send({ type: 'presence', player });
      },
      async close() {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        try { await channel.unsubscribe(); } catch { /* ignoré */ }
        try { await client.removeChannel(channel); } catch { /* ignoré */ }
      }
    };
  }

  async function openTransport(code) {
    if (state.mode === 'supabase') {
      if (!state.config) throw new Error('Aucune configuration Supabase enregistrée.');
      return createSupabaseTransport(code);
    }
    return createLocalTransport(code);
  }

  function startPresenceLoop() {
    if (state.timers.presence) clearInterval(state.timers.presence);
    state.timers.presence = setInterval(() => {
      if (!state.room || !state.transport) return;
      state.transport.updatePresence();
      prunePresence();
    }, HEARTBEAT_MS);
  }

  function prunePresence() {
    if (!state.room) return;
    const now = Date.now();
    const ttl = state.transportKind === 'supabase' ? PRESENCE_TTL_MS + 2_000 : PRESENCE_TTL_MS;
    let changed = false;
    for (const [id, player] of state.players) {
      if (id === state.playerId) continue;
      if (now - player.lastSeen > ttl) {
        state.players.delete(id);
        addLog(`${player.name} a quitté le salon.`);
        changed = true;
      }
    }
    if (!changed) return;
    ensureHost();
    syncMarkers();
    if (state.view === 'lobby') renderLobby();
    if (state.view === 'game') renderGameStatic();
  }

  function closeTransport() {
    const transport = state.transport;
    state.transport = null;
    state.transportKind = null;
    if (state.timers.presence) clearInterval(state.timers.presence);
    state.timers.presence = null;
    if (transport) transport.close().catch(() => {});
  }

  /* ------------------------------------------------------------------------
     Salons persistants : tables Supabase rooms / room_players
     ------------------------------------------------------------------------ */

  const ROOMS_TABLE = 'rooms';
  const PLAYERS_TABLE = 'room_players';
  const DB_POLL_MS = 2_500;

  function dbEnabled() {
    return state.mode === 'supabase' && Boolean(state.config) && !state.dbUnavailable;
  }

  function dbClient() {
    if (!dbEnabled()) return null;
    try { return getSupabaseClient(); } catch { return null; }
  }

  function dbErrorCode(error) {
    return String(error?.code || '');
  }

  function dbTableMissing(error) {
    return ['42P01', 'PGRST205', 'PGRST204'].includes(dbErrorCode(error))
      || /does not exist|could not find the table|schema cache/i.test(error?.message || '');
  }

  function dbErrorMessage(error) {
    if (dbTableMissing(error)) {
      return 'Les tables rooms/room_players ne sont pas créées. Exécutez supabase.sql dans l’éditeur SQL Supabase.';
    }
    if (/row-level security|permission denied/i.test(error?.message || '')) {
      return 'RLS Supabase bloque les salons. Exécutez la partie SQL fournie (RLS désactivé).';
    }
    return error?.message || 'Erreur de synchronisation du salon.';
  }

  function reportDbError(error) {
    if (!error) return;
    const missing = dbTableMissing(error);
    if (missing) state.dbUnavailable = true;
    const message = dbErrorMessage(error);
    if (state.view === 'home') setHomeError(message);
    if (missing || state.view !== 'home') toast(message, 'danger', 6_000);
  }

  function isoDate(value) {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }

  function roomToDbRow(room) {
    const center = room.center && validLngLat(room.center[0], room.center[1]) ? room.center : [null, null];
    return {
      code: room.code,
      host_id: room.hostId,
      center_lng: center[0],
      center_lat: center[1],
      radius: room.radius,
      duration: room.duration,
      phase: room.phase,
      round_number: room.round || 0,
      starts_at: isoDate(room.startsAt),
      hide_ends_at: isoDate(room.hideEndsAt),
      ends_at: isoDate(room.endsAt),
      extraction: Array.isArray(room.extraction) ? room.extraction : [],
      ended_reason: room.endedReason || '',
      ended_at: isoDate(room.endedAt),
      updated_at: new Date().toISOString()
    };
  }

  function roomFromDbRow(row) {
    if (!row?.code) return null;
    return normalizeRoom({
      code: row.code,
      hostId: row.host_id,
      center: row.center_lng != null && row.center_lat != null
        ? [Number(row.center_lng), Number(row.center_lat)]
        : null,
      radius: row.radius,
      duration: row.duration,
      phase: row.phase,
      round: row.round_number || 0,
      startsAt: row.starts_at ? Date.parse(row.starts_at) : null,
      hideEndsAt: row.hide_ends_at ? Date.parse(row.hide_ends_at) : null,
      endsAt: row.ends_at ? Date.parse(row.ends_at) : null,
      extraction: Array.isArray(row.extraction) ? row.extraction : [],
      endedReason: row.ended_reason || '',
      endedAt: row.ended_at ? Date.parse(row.ended_at) : null
    });
  }

  function playerToDbRow(player, roomCode) {
    return {
      id: player.id,
      room_code: roomCode,
      name: player.name,
      role: player.role,
      status: player.status || 'active',
      token: player.token || '',
      lat: Number.isFinite(player.lat) ? player.lat : null,
      lng: Number.isFinite(player.lng) ? player.lng : null,
      accuracy: Number.isFinite(player.accuracy) ? player.accuracy : null,
      out_reason: player.outReason || '',
      captured_by: player.capturedBy || '',
      extracted_at: isoDate(player.extractedAt),
      extracted_point: player.extractedPoint || '',
      joined_at: isoDate(player.joinedAt) || new Date().toISOString(),
      updated_at: isoDate(player.updatedAt) || new Date().toISOString(),
      last_seen: new Date().toISOString()
    };
  }

  function playerFromDbRow(row) {
    if (!row?.id) return null;
    return normalizePlayer({
      id: row.id,
      name: row.name,
      role: row.role,
      status: row.status,
      token: row.token || '',
      lat: row.lat,
      lng: row.lng,
      accuracy: row.accuracy,
      joinedAt: row.joined_at ? Date.parse(row.joined_at) : Date.now(),
      updatedAt: row.updated_at ? Date.parse(row.updated_at) : 0,
      outReason: row.out_reason || '',
      capturedBy: row.captured_by || '',
      extractedAt: row.extracted_at ? Date.parse(row.extracted_at) : null,
      extractedPoint: row.extracted_point || ''
    });
  }

  async function dbUpsertRoom(room) {
    const client = dbClient();
    if (!client || !room) return false;
    const { error } = await client.from(ROOMS_TABLE).upsert(roomToDbRow(room), { onConflict: 'code' });
    if (error) { reportDbError(error); return false; }
    return true;
  }

  async function dbUpsertPlayer(player, roomCode) {
    const client = dbClient();
    if (!client || !player || !roomCode) return false;
    const { error } = await client.from(PLAYERS_TABLE).upsert(playerToDbRow(player, roomCode), { onConflict: 'id' });
    if (error) { reportDbError(error); return false; }
    return true;
  }

  async function dbDeletePlayer(playerId) {
    const client = dbClient();
    if (!client || !playerId) return false;
    const { error } = await client.from(PLAYERS_TABLE).delete().eq('id', playerId);
    if (error && !dbTableMissing(error)) reportDbError(error);
    return !error;
  }

  async function dbDeleteRoom(code) {
    const client = dbClient();
    if (!client || !code) return false;
    const { error } = await client.from(ROOMS_TABLE).delete().eq('code', code);
    if (error && !dbTableMissing(error)) reportDbError(error);
    return !error;
  }

  async function dbFetchRoom(code) {
    const client = dbClient();
    if (!client) return { data: null, error: null };
    const { data, error } = await client.from(ROOMS_TABLE).select('*').eq('code', code).maybeSingle();
    return { data, error };
  }

  async function dbFetchPlayers(code) {
    const client = dbClient();
    if (!client) return { data: [], error: null };
    const { data, error } = await client.from(PLAYERS_TABLE).select('*').eq('room_code', code);
    return { data: data || [], error };
  }

  function persistSelfPlayer() {
    if (!dbEnabled() || !state.room || !self()) return;
    void dbUpsertPlayer(self(), state.room.code);
  }

  function persistRoomRecord() {
    if (!dbEnabled() || !state.room || !isHost()) return;
    void dbUpsertRoom(state.room);
  }

  function persistAllPlayers() {
    if (!dbEnabled() || !state.room) return;
    const code = state.room.code;
    for (const player of state.players.values()) void dbUpsertPlayer(player, code);
  }

  function stopDbPoll() {
    if (state.timers.dbPoll) clearInterval(state.timers.dbPoll);
    state.timers.dbPoll = null;
    state.dbBusy = false;
  }

  function startDbPoll() {
    stopDbPoll();
    if (!dbEnabled() || !state.room) return;
    state.timers.dbPoll = setInterval(() => {
      if (!dbEnabled()) { stopDbPoll(); return; }
      void refreshRoomFromDb();
    }, DB_POLL_MS);
    void refreshRoomFromDb();
  }

  async function refreshRoomFromDb() {
    if (!dbEnabled() || !state.room || state.dbBusy) return;
    const code = state.room.code;
    state.dbBusy = true;
    try {
      const [roomResult, playersResult] = await Promise.all([
        dbFetchRoom(code),
        dbFetchPlayers(code)
      ]);
      if (!state.room || state.room.code !== code) return;
      if (roomResult.error) { reportDbError(roomResult.error); return; }
      if (playersResult.error) { reportDbError(playersResult.error); return; }

      const incoming = roomResult.data ? roomFromDbRow(roomResult.data) : null;
      const players = playersResult.data.map(playerFromDbRow).filter(Boolean);
      const previousPhase = state.room.phase;

      if (incoming) {
        if (!isHost()) {
          state.isHost = incoming.hostId === state.playerId;
          if (incoming.phase === 'game' && previousPhase !== 'game') {
            applyStart(incoming, players, { broadcast: false });
          } else if (incoming.phase === 'end' && previousPhase !== 'end') {
            state.room = incoming;
            applyEndState(incoming, players, { announce: true });
          } else {
            state.room = incoming;
            updateRoomChrome();
            updateZoneOnMap();
            syncCenterMarker();
            syncExtractionMarkers();
            if (state.view === 'lobby') renderLobby();
          }
        } else if (incoming.hostId !== state.room.hostId && incoming.hostId !== state.playerId) {
          state.room.hostId = incoming.hostId;
          state.isHost = false;
          updateRoomChrome();
        }
      }

      mergePlayers(players, { force: false });
      const ids = new Set(players.map((player) => player.id));
      for (const id of [...state.players.keys()]) {
        if (id !== state.playerId && !ids.has(id)) state.players.delete(id);
      }
      ensureHost();
      updateRoomChrome();
      refreshHostUi();
      syncMarkers();
      if (state.view === 'lobby') renderLobby();
      if (state.view === 'game') { renderTeam(); updateGameDynamic(); }
    } catch (error) {
      reportDbError(error);
    } finally {
      state.dbBusy = false;
    }
  }

  /* ------------------------------------------------------------------------
     Session : création / connexion / sortie
     ------------------------------------------------------------------------ */

  function resetSessionData() {
    stopDbPoll();
    closeTransport();
    stopWatch();
    stopScanner();
    closeAllModals();
    state.room = null;
    state.players = new Map();
    state.logs = [];
    state.isHost = false;
    state.extraction = { since: null, validated: false };
    state.extractionRevealed = false;
    state.radio.index = null;
    el('radio-chip')?.classList.add('hidden');
    state.endScheduled = false;
    state.announcedChase = false;
    state.lastBeepKey = null;
    state.statusModalShownFor = null;
    state.joinCode = null;
    state.hostMissingSince = null;
    state.dbUnavailable = false;
    state.picking = false;
    document.getElementById('app')?.classList.remove('is-picking');
    el('pick-banner')?.classList.add('hidden');
    clearMapOverlays();
    updateRoomChrome();
  }

  function updateRoomChrome() {
    const pill = el('btn-room-code');
    if (!pill) return;
    if (state.room) {
      pill.classList.remove('hidden');
      el('top-room-code').textContent = state.room.code;
    } else {
      pill.classList.add('hidden');
      el('top-room-code').textContent = '------';
    }
  }

  async function createRoom(event) {
    event?.preventDefault();
    if (state.busy) return;
    setHomeError('');
    const name = cleanName(el('input-name').value);
    if (name.length < 2) {
      setHomeError('Indiquez un nom de joueur (2 caractères minimum).');
      el('input-name').focus();
      return;
    }
    if (!ensureGpsForAction()) return;

    state.busy = true;
    const code = randomCode();
    let dbCreated = false;
    showLoading('OUVERTURE DU SALON', `SALON ${code}`);
    try {
      resetSessionData();
      state.name = name;
      state.role = 'hunter';
      writeJSON(STORE.name, name);
      const me = normalizePlayer({
        id: state.playerId,
        name,
        role: 'hunter',
        token: randomToken(),
        joinedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        lat: state.gps?.lat,
        lng: state.gps?.lng,
        accuracy: state.gps?.accuracy
      });
      state.players.set(me.id, me);
      state.room = {
        code,
        hostId: state.playerId,
        center: state.gps ? [state.gps.lng, state.gps.lat] : null,
        radius: 500,
        duration: 15,
        phase: 'lobby',
        round: 0,
        startsAt: null,
        hideEndsAt: null,
        endsAt: null,
        extraction: [],
        endedReason: '',
        endedAt: null
      };
      state.isHost = true;

      if (state.mode === 'supabase' && !state.dbUnavailable) {
        const roomSaved = await dbUpsertRoom(state.room);
        if (roomSaved) {
          const playerSaved = await dbUpsertPlayer(me, code);
          if (playerSaved) {
            dbCreated = true;
          } else {
            await dbDeleteRoom(code);
          }
        }
      }

      const transport = await openTransport(code);
      state.transport = transport;
      state.transportKind = transport.kind;
      await transport.connect();
      state.connection = 'connected';
      startPresenceLoop();
      document.body.dataset.role = state.role;
      updateRoomChrome();
      updateModeUi();
      addLog('Salon créé. Invitez vos joueurs.');
      showView('lobby');
      renderLobby();
      updateZoneOnMap();
      fitZone();
      transport.send({ type: 'room-state', room: state.room, players: playersPayload() });
      transport.updatePresence();
      if (dbCreated) startDbPoll();
      toast(`Salon ${code} ouvert.`, 'success');
      el('input-code').value = '';
    } catch (error) {
      if (dbCreated) void dbDeleteRoom(code);
      resetSessionData();
      setHomeError(error?.message || 'Impossible d’ouvrir le salon.');
      toast('Ouverture du salon impossible. Vérifiez la configuration temps réel.', 'danger', 5000);
    } finally {
      state.busy = false;
      hideLoading();
    }
  }

  async function joinRoom(event) {
    event?.preventDefault();
    if (state.busy) return;
    setHomeError('');
    const name = cleanName(el('input-name').value);
    const code = cleanCode(el('input-code').value);
    if (name.length < 2) {
      setHomeError('Indiquez un nom de joueur (2 caractères minimum).');
      el('input-name').focus();
      return;
    }
    if (code.length !== 6) {
      setHomeError('Le code du salon doit contenir 6 caractères.');
      el('input-code').focus();
      return;
    }
    if (!ensureGpsForAction()) return;

    state.busy = true;
    let dbJoined = false;
    let dbPlayerSaved = false;
    showLoading('CONNEXION AU SALON', `SALON ${code}`);
    try {
      resetSessionData();
      state.name = name;
      state.role = 'fugitive';
      state.joinCode = code;
      writeJSON(STORE.name, name);
      const me = normalizePlayer({
        id: state.playerId,
        name,
        role: 'fugitive',
        token: randomToken(),
        joinedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        lat: state.gps?.lat,
        lng: state.gps?.lng,
        accuracy: state.gps?.accuracy
      });
      state.players.set(me.id, me);

      if (state.mode === 'supabase' && !state.dbUnavailable) {
        const roomResult = await dbFetchRoom(code);
        if (roomResult.error) {
          if (dbTableMissing(roomResult.error)) {
            state.dbUnavailable = true;
          } else {
            throw new Error(dbErrorMessage(roomResult.error));
          }
        } else if (!roomResult.data) {
          throw new Error('Aucun salon trouvé avec ce code. Vérifiez le code auprès de l’hôte.');
        } else {
          const room = roomFromDbRow(roomResult.data);
          if (!room) throw new Error('Ce salon est invalide.');
          if (room.phase !== 'lobby') throw new Error('Une manche est déjà en cours dans ce salon.');
          const playersResult = await dbFetchPlayers(code);
          if (playersResult.error) {
            if (dbTableMissing(playersResult.error)) {
              state.dbUnavailable = true;
            } else {
              throw new Error(dbErrorMessage(playersResult.error));
            }
          }
          if (!state.dbUnavailable) {
            state.room = room;
            state.isHost = room.hostId === state.playerId;
            mergePlayers(playersResult.data.map(playerFromDbRow).filter(Boolean), { force: false });
            state.players.set(me.id, me);
            const playerSaved = await dbUpsertPlayer(me, code);
            if (!playerSaved) throw new Error('Impossible de vous enregistrer dans ce salon.');
            dbPlayerSaved = true;
            dbJoined = true;
          }
        }
      }

      const transport = await openTransport(code);
      state.transport = transport;
      state.transportKind = transport.kind;
      await transport.connect();
      state.connection = 'connected';
      updateModeUi();

      if (dbJoined) {
        const hello = () => transport.send({
          type: 'hello',
          player: selfPayload(),
          roomCode: code
        });
        hello();
        state.timers.hello = setInterval(hello, 1_200);
        setTimeout(() => {
          if (state.timers.hello) clearInterval(state.timers.hello);
          state.timers.hello = null;
        }, 5_000);
        startPresenceLoop();
        startDbPoll();
        showView('lobby');
        renderLobby();
        updateZoneOnMap();
        fitZone();
        updateRoomChrome();
        addLog('Salon rejoint.');
        transport.updatePresence();
        toast(`Salon ${code} rejoint.`, 'success');
      } else {
        const joined = new Promise((resolve, reject) => {
          state.joinResolver = resolve;
          state.joinRejecter = reject;
          state.timers.join = setTimeout(() => {
            reject(new Error('Aucun salon trouvé avec ce code. Vérifiez le code et que l’hôte est en ligne.'));
          }, 8_000);
          const hello = () => transport.send({
            type: 'hello',
            player: selfPayload(),
            roomCode: code
          });
          hello();
          state.timers.hello = setInterval(hello, 900);
        });

        startPresenceLoop();
        transport.updatePresence();
        await joined;
      }
    } catch (error) {
      if (state.timers.join) clearTimeout(state.timers.join);
      if (state.timers.hello) clearInterval(state.timers.hello);
      state.joinResolver = null;
      state.joinRejecter = null;
      if (dbPlayerSaved) void dbDeletePlayer(state.playerId);
      resetSessionData();
      showView('home');
      setHomeError(error?.message || 'Impossible de rejoindre le salon.');
      toast('Connexion au salon impossible.', 'danger', 4500);
    } finally {
      state.busy = false;
      hideLoading();
    }
  }

  function leaveRoom() {
    if (!state.room) return;
    const code = state.room.code;
    const wasHost = isHost();
    const others = playersArray().filter((player) => player.id !== state.playerId);
    if (wasHost) {
      if (others.length) {
        state.room.hostId = others[0].id;
        state.transport?.send({ type: 'room-state', room: state.room, players: others });
      }
    }
    state.transport?.send({ type: 'leave', playerId: state.playerId });
    if (state.mode === 'supabase') {
      void dbDeletePlayer(state.playerId);
      if (wasHost) {
        if (others.length) void dbUpsertRoom(state.room);
        else void dbDeleteRoom(code);
      }
    }
    resetSessionData();
    state.role = 'hunter';
    document.body.dataset.role = 'hunter';
    showView('home');
    renderHome();
    updateModeUi();
    if (state.gps) flyToGps(900);
    toast('Vous avez quitté le salon.');
  }

  function requestLeave() {
    if (!state.room) {
      showView('home');
      return;
    }
    const message = state.room.phase === 'game'
      ? 'La manche est en cours. En quittant maintenant, vous abandonnez votre rôle et les autres joueurs continuent sans vous.'
      : 'Vous quitterez ce salon. Vous pourrez en créer ou en rejoindre un autre immédiatement.';
    openConfirm(message, leaveRoom);
  }

  function ensureGpsForAction() {
    if (state.gps) return true;
    if (!window.isSecureContext) {
      setHomeError('Le GPS exige une origine sécurisée (HTTPS ou localhost).');
      openModal('geo-modal');
      return false;
    }
    if (state.geoStatus === 'waiting') {
      setHomeError('Acquisition GPS en cours — patientez un instant.');
      return false;
    }
    setHomeError('Autorisez la localisation pour continuer.');
    requestGps({ interactive: true });
    return false;
  }

  /* ------------------------------------------------------------------------
     Manche : préparation, chronos, zone, extraction, fin
     ------------------------------------------------------------------------ */

  function readiness() {
    const list = playersArray();
    if (!state.room?.center) {
      return { ready: false, hint: 'Placez le centre de la zone sur la carte.' };
    }
    if (list.length < 2) {
      return { ready: false, hint: 'Invitez au moins un second joueur avec le code.' };
    }
    const fugitives = list.filter((player) => player.role === 'fugitive').length;
    const hunters = list.filter((player) => player.role === 'hunter').length;
    if (!fugitives) return { ready: false, hint: 'Désignez au moins un fugitif.' };
    if (!hunters) return { ready: false, hint: 'Désignez au moins un chercheur.' };
    const outside = list.filter((player) => {
      if (!validLngLat(player.lng, player.lat)) return false;
      return distanceMeters([player.lng, player.lat], state.room.center) > state.room.radius;
    }).length;
    return {
      ready: true,
      hint: outside
        ? `Prêt · ${outside} joueur${outside > 1 ? 's' : ''} hors zone au lancement.`
        : `Prêt · ${list.length} joueurs · ${fugitives} fugitif${fugitives > 1 ? 's' : ''}.`
    };
  }

  function generateExtractionPoints(center, radius) {
    if (!window.turf?.circle || !window.turf?.randomPoint || !window.turf?.booleanPointInPolygon) {
      throw new Error('Turf.js est requis pour calculer la zone.');
    }
    const circle = turf.circle(center, radius / 1000, { steps: 96, units: 'kilometers' });
    const box = turf.bbox(circle);
    let first = null;
    let second = null;

    for (let attempt = 0; attempt < 500 && !second; attempt += 1) {
      const candidate = turf.randomPoint(1, { bbox: box }).features[0];
      if (!candidate || !turf.booleanPointInPolygon(candidate, circle)) continue;
      if (!first) {
        first = candidate;
        continue;
      }
      const gap = turf.distance(first, candidate, { units: 'kilometers' }) * 1000;
      if (gap >= radius * 0.6) second = candidate;
    }

    if (!first || !second) {
      const distance = radius * 0.55;
      first = turf.destination(center, distance / 1000, 35, { units: 'kilometers' });
      second = turf.destination(center, distance / 1000, 215, { units: 'kilometers' });
    }

    return [first, second].map((feature, index) => ({
      id: `EX 0${index + 1}`,
      lng: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1]
    }));
  }

  /* Signal radio : toutes les (durée / 5) minutes, la position des fugitifs
     apparaît brièvement sur la carte des chercheurs. */

  function radioIntervalMs(durationMin) {
    const total = Math.max(1, Number(durationMin) || 15) * 60_000;
    return Math.max(60_000, Math.round(total / RADIO_PINGS_PER_ROUND));
  }

  function radioWindow(now = Date.now()) {
    const current = state.room;
    if (!current || current.phase !== 'game') return null;
    const hideEndsAt = Number(current.hideEndsAt) || 0;
    const endsAt = Number(current.endsAt) || 0;
    if (!hideEndsAt || !endsAt || now < hideEndsAt || now >= endsAt) return null;
    const interval = radioIntervalMs(current.duration);
    const sinceHide = now - hideEndsAt;
    const index = Math.floor(sinceHide / interval);
    if (index < 1) return null;
    const startsAt = hideEndsAt + index * interval;
    if (startsAt >= endsAt) return null;
    const elapsed = now - startsAt;
    if (elapsed >= RADIO_PING_MS) return null;
    return {
      index,
      interval,
      startsAt,
      remaining: Math.max(0, Math.min(RADIO_PING_MS - elapsed, endsAt - now))
    };
  }

  function nextRadioAt(now = Date.now()) {
    const current = state.room;
    if (!current || current.phase !== 'game') return null;
    const hideEndsAt = Number(current.hideEndsAt) || 0;
    const endsAt = Number(current.endsAt) || 0;
    if (!hideEndsAt || !endsAt) return null;
    const interval = radioIntervalMs(current.duration);
    const index = now < hideEndsAt
      ? 1
      : Math.floor((now - hideEndsAt) / interval) + 1;
    const next = hideEndsAt + index * interval;
    return next < endsAt ? next : null;
  }

  function clearRadioMarkers() {
    for (const marker of state.radioMarkers.values()) marker.remove();
    state.radioMarkers.clear();
  }

  function radioChipText(win, now) {
    if (win) return `SIGNAL ACTIF · ${Math.max(1, Math.ceil(win.remaining / 1000))} s`;
    const next = nextRadioAt(now);
    return next ? `PROCHAIN SIGNAL · ${fmtClock(next - now)}` : '';
  }

  function syncRadioMarkers(now = Date.now()) {
    const me = self();
    const canHunt = Boolean(me && me.role === 'hunter' && me.status === 'active'
      && state.room?.phase === 'game');
    const win = canHunt ? radioWindow(now) : null;
    const chip = el('radio-chip');
    const label = el('radio-chip-label');

    if (chip) {
      const chaseStarted = Boolean(state.room?.hideEndsAt && now >= state.room.hideEndsAt);
      const visible = canHunt && chaseStarted;
      chip.classList.toggle('hidden', !visible);
      chip.classList.toggle('is-active', Boolean(win));
      if (label && visible) label.textContent = radioChipText(win, now);
    }

    const map = state.map;
    if (!map || !win) {
      clearRadioMarkers();
      state.radio.index = null;
      return;
    }

    const wanted = new Map();
    for (const player of state.players.values()) {
      if (player.role !== 'fugitive' || player.status !== 'active') continue;
      if (!validLngLat(player.lng, player.lat)) continue;
      wanted.set(player.id, player);
    }

    for (const [id, player] of wanted) {
      let marker = state.radioMarkers.get(id);
      if (!marker) {
        const element = document.createElement('div');
        element.className = 'gh-radio-marker';
        element.innerHTML = '<span class="gh-radio-ring"></span><span class="gh-radio-dot"></span><span class="gh-radio-label"></span>';
        marker = new maplibregl.Marker({ element, anchor: 'left' })
          .setLngLat([player.lng, player.lat])
          .addTo(map);
        state.radioMarkers.set(id, marker);
      } else {
        marker.setLngLat([player.lng, player.lat]);
      }
      const tag = marker.getElement()?.querySelector('.gh-radio-label');
      if (tag) tag.textContent = `SIGNAL · ${shortName(player.name)}`;
    }

    for (const [id, marker] of [...state.radioMarkers]) {
      if (wanted.has(id)) continue;
      marker.remove();
      state.radioMarkers.delete(id);
    }

    if (state.radio.index !== win.index) {
      state.radio.index = win.index;
      addLog('Signal radio : position des fugitifs détectée.', 'strong');
      toast('Signal radio reçu. Position des fugitifs révélée 12 s.', 'info', 4000);
      beep(1040, 0.06);
      setTimeout(() => beep(1320, 0.06), 110);
      vibrate([30, 40, 30]);
    }
  }

  function startRound() {
    if (!isHost() || !state.room || state.room.phase !== 'lobby') return;
    const check = readiness();
    if (!check.ready) {
      toast(check.hint, 'danger');
      return;
    }
    if (!window.turf) {
      toast('Turf.js n’a pas pu être chargé. La zone ne peut pas être calculée.', 'danger');
      return;
    }

    try {
      const extraction = generateExtractionPoints(state.room.center, state.room.radius);
      const now = Date.now();
      const nextRoom = {
        ...state.room,
        phase: 'game',
        round: state.room.round + 1,
        startsAt: now,
        hideEndsAt: now + HIDE_MS,
        endsAt: now + HIDE_MS + state.room.duration * 60_000,
        extraction,
        endedReason: '',
        endedAt: null,
        hostId: state.playerId
      };
      for (const player of state.players.values()) {
        player.status = 'active';
        player.outReason = '';
        player.capturedBy = '';
        player.extractedAt = null;
        player.extractedPoint = '';
        player.updatedAt = now;
      }
      const me = self();
      if (me) me.token = randomToken();
      applyStart(nextRoom, playersPayload(), { broadcast: true });
    } catch (error) {
      toast(error?.message || 'Impossible de lancer la manche.', 'danger');
    }
  }

  function applyStart(rawRoom, rawPlayers, { broadcast = false } = {}) {
    const incoming = normalizeRoom(rawRoom);
    if (!incoming || incoming.phase !== 'game') return;
    state.room = incoming;
    mergePlayers(rawPlayers || [], { force: true });
    const me = self();
    if (me) {
      me.status = 'active';
      me.outReason = '';
      me.capturedBy = '';
      me.extractedAt = null;
      me.extractedPoint = '';
      me.token = randomToken();
      me.updatedAt = Date.now();
    }
    state.isHost = incoming.hostId === state.playerId;
    if (state.isHost) { persistRoomRecord(); persistAllPlayers(); }
    state.logs = [];
    state.extraction = { since: null, validated: false, pointId: null };
    state.extractionRevealed = false;
    state.radio.index = null;
    clearRadioMarkers();
    state.endScheduled = false;
    state.completionScheduled = false;
    state.fallbackAnnounce = false;
    state.statusModalShownFor = null;
    state.lastBeepKey = null;
    state.announcedChase = Date.now() >= (incoming.hideEndsAt || 0);
    state.hasFlown = true;
    document.body.dataset.role = state.role;
    addLog(`Manche ${String(incoming.round).padStart(2, '0')} lancée.`);
    addLog('Cache initiale de 60 secondes.');
    showView('game');
    renderGameStatic();
    updateGameDynamic();
    updateZoneOnMap();
    syncMarkers();
    syncCenterMarker();
    syncExtractionMarkers();
    fitZone();
    updateRoomChrome();
    refreshHostUi();
    publishPresence(true);
    if (broadcast && state.transport) {
      state.transport.send({ type: 'start', room: state.room, players: playersPayload() });
    }
    beep(720, 0.09);
    setTimeout(() => beep(960, 0.09), 110);
    vibrate([30, 40, 30]);
    if (!state.isHost) toast('La manche commence.', 'success');
  }

  function updateGameDynamic() {
    if (state.view !== 'game' || !state.room) return;
    const now = Date.now();
    const current = state.room;
    const me = self() || { role: state.role, status: 'active' };
    const center = current.center;
    const hideEndsAt = current.hideEndsAt || now;
    const endsAt = current.endsAt || now;
    const hiding = now < hideEndsAt;
    const remaining = hiding ? hideEndsAt - now : Math.max(0, endsAt - now);

    el('game-phase').textContent = hiding ? 'CACHE INITIALE' : 'CHASSE EN COURS';
    el('game-timer-label').textContent = hiding ? 'TEMPS DE CACHE' : 'TEMPS RESTANT';
    el('game-timer').textContent = fmtClock(remaining);

    if (!hiding && !state.announcedChase) {
      state.announcedChase = true;
      toast('La chasse est ouverte. Les points d’extraction sont actifs.', 'success', 4200);
      beep(980, 0.08);
      setTimeout(() => beep(1180, 0.08), 130);
      vibrate([25, 30, 25]);
    }

    if (!document.hidden) {
      const seconds = Math.ceil(remaining / 1000);
      if (seconds > 0 && seconds <= 5) {
        const key = `${hiding ? 'hide' : 'chase'}-${seconds}`;
        if (state.lastBeepKey !== key) {
          state.lastBeepKey = key;
          beep(seconds === 1 ? 1080 : 820, 0.045);
        }
      }
    }

    if (state.gps) {
      el('game-coords').textContent = fmtCoords(state.gps.lat, state.gps.lng);
      el('game-accuracy').textContent = `± ${Math.max(1, Math.round(state.gps.accuracy))} m · GPS`;
    } else {
      el('game-coords').textContent = '—';
      el('game-accuracy').textContent = 'GPS EN ATTENTE';
    }

    const zoneStatus = el('zone-status');
    const zoneDetail = el('zone-detail');
    zoneStatus.className = 'zone-status';
    if (!state.gps) {
      zoneStatus.textContent = 'SIGNAL GPS REQUIS';
      zoneStatus.classList.add('is-muted');
      zoneDetail.textContent = 'Autorisez la localisation';
    } else if (!center) {
      zoneStatus.textContent = 'ZONE NON DÉFINIE';
      zoneStatus.classList.add('is-muted');
      zoneDetail.textContent = '—';
    } else if (me.status === 'out') {
      zoneStatus.textContent = 'ÉLIMINÉ';
      zoneStatus.classList.add('is-warning');
      zoneDetail.textContent = 'Sortie de zone';
    } else if (me.status === 'captured') {
      zoneStatus.textContent = 'NEUTRALISÉ';
      zoneStatus.classList.add('is-warning');
      zoneDetail.textContent = me.capturedBy ? `QR scanné · ${me.capturedBy}` : 'QR vie scanné';
    } else if (me.status === 'extracted') {
      zoneStatus.textContent = 'EXTRAIT';
      zoneDetail.textContent = me.extractedPoint || 'Extraction validée';
    } else {
      const dist = distanceMeters([state.gps.lng, state.gps.lat], center);
      if (dist <= current.radius) {
        zoneStatus.textContent = 'DANS LA ZONE';
        zoneDetail.textContent = `${fmtDistance(current.radius - dist)} du bord`;
      } else {
        zoneStatus.textContent = 'HORS ZONE';
        zoneStatus.classList.add('is-warning');
        zoneDetail.textContent = `${fmtDistance(dist - current.radius)} au-delà`;
      }
    }

    const activeCount = [...state.players.values()].filter((player) => player.status === 'active').length;
    el('game-count').textContent = `${activeCount} EN JEU`;
    el('game-role').textContent = roleLabel(me.role);

    const notice = el('hiding-note');
    if (hiding && me.status === 'active') {
      notice.classList.remove('hidden');
      el('hiding-title').textContent = 'CACHE EN COURS';
      el('hiding-text').textContent = me.role === 'fugitive'
        ? `Restez dans le cercle. L’extraction ouvre dans ${fmtClock(remaining)}.`
        : `Les fugitifs se cachent. L’extraction ouvre dans ${fmtClock(remaining)}.`;
    } else {
      notice.classList.add('hidden');
    }

    const canAct = me.status === 'active' && current.phase === 'game';
    const scan = el('btn-scan');
    const qr = el('btn-show-qr');
    if (scan) scan.disabled = !(canAct && me.role === 'hunter');
    if (qr) qr.disabled = !(canAct && me.role === 'fugitive');

    if (state.extractionRevealed !== !hiding) {
      state.extractionRevealed = !hiding;
      syncExtractionMarkers();
    }

    updateExtractionDisplay(now);
    updateGameHint(now, hiding, remaining);
    syncRadioMarkers(now);
  }

  function updateGameHint(now, hiding, remaining) {
    const me = self();
    const hint = el('game-hint');
    if (!hint || !me) return;
    if (me.status === 'out') {
      hint.textContent = 'Vous êtes éliminé. La manche continue en mode spectateur.';
    } else if (me.status === 'captured') {
      hint.textContent = 'Votre QR vie a été scanné. Vous suivez la manche en spectateur.';
    } else if (me.status === 'extracted') {
      hint.textContent = 'Extraction validée. Attendez la fin de la manche.';
    } else if (me.role === 'hunter') {
      hint.textContent = hiding
        ? 'Repérez les fugitifs. Leurs QR vie restent scannables.'
        : 'Scannez le QR vie d’un fugitif pour le neutraliser.';
    } else if (hiding) {
      hint.textContent = `Restez dans la zone. Ouverture dans ${fmtClock(remaining)}.`;
    } else if (!state.gps) {
      hint.textContent = 'Autorisez le GPS pour rejoindre un point d’extraction.';
    } else {
      hint.textContent = 'Rejoignez EX 01 ou EX 02 et restez 5 s à moins de 10 m.';
    }
  }

  function nearestExtraction(center = null) {
    const points = state.room?.extraction || [];
    if (!points.length) return null;
    const origin = center || (state.gps ? [state.gps.lng, state.gps.lat] : null);
    if (!origin) return { point: points[0], distance: null };
    let best = { point: points[0], distance: Infinity };
    for (const point of points) {
      const distance = distanceMeters(origin, [point.lng, point.lat]);
      if (distance < best.distance) best = { point, distance };
    }
    return best;
  }

  function updateExtractionDisplay(now) {
    const card = el('extraction-card');
    const me = self();
    if (!card || !me || !state.room) return;
    const active = me.role === 'fugitive' && me.status === 'active'
      && state.room.phase === 'game' && now >= (state.room.hideEndsAt || 0)
      && now < (state.room.endsAt || 0);

    if (!active || !(state.room.extraction || []).length) {
      card.classList.add('hidden');
      state.extraction.since = null;
      return;
    }
    card.classList.remove('hidden');

    const near = nearestExtraction();
    const point = near?.point;
    const label = point?.id || '—';
    el('extraction-point').textContent = label;
    const text = card.querySelector('p');
    const time = el('extraction-time');
    const bar = el('extraction-bar');

    if (!state.gps || !point) {
      state.extraction.since = null;
      time.textContent = '5.0 s';
      bar.style.width = '0%';
      if (text) text.textContent = 'Signal GPS requis pour valider l’extraction.';
      return;
    }
    if (Date.now() - state.gps.at > 10_000) {
      state.extraction.since = null;
      time.textContent = '5.0 s';
      bar.style.width = '0%';
      if (text) text.textContent = 'Signal GPS perdu. Reprenez la localisation.';
      return;
    }

    if (state.extraction.pointId !== point.id) {
      state.extraction.pointId = point.id;
      state.extraction.since = null;
    }
    const gap = distanceMeters([state.gps.lng, state.gps.lat], [point.lng, point.lat]);
    if (gap <= EXTRACTION_METERS) {
      if (!state.extraction.since) state.extraction.since = now;
      const elapsed = now - state.extraction.since;
      const left = Math.max(0, HOLD_MS - elapsed);
      time.textContent = `${(left / 1000).toFixed(1)} s`;
      bar.style.width = `${Math.min(100, elapsed / HOLD_MS * 100)}%`;
      if (text) text.textContent = `Validation en cours sur ${label}. Ne bougez pas.`;
      if (elapsed >= HOLD_MS) {
        transitionPlayer(me.id, 'extracted', { point: label }, { broadcast: true });
      }
    } else {
      state.extraction.since = null;
      time.textContent = '5.0 s';
      bar.style.width = '0%';
      if (text) text.textContent = `Approchez-vous à moins de 10 m de ${label} (${fmtDistance(gap)}).`;
    }
  }

  function resetExtraction() {
    state.extraction = { since: null, validated: false, pointId: null };
    const card = el('extraction-card');
    card?.classList.add('hidden');
    const bar = el('extraction-bar');
    if (bar) bar.style.width = '0%';
  }

  function transitionPlayer(playerId, status, meta = {}, { broadcast = false, remote = false } = {}) {
    const player = state.players.get(playerId);
    if (!player || player.status === status) return false;
    player.status = status;
    player.updatedAt = Date.now();
    if (meta.by) player.capturedBy = meta.by;
    if (meta.reason) player.outReason = meta.reason;
    if (meta.point) player.extractedPoint = meta.point;
    if (status === 'extracted') player.extractedAt = Date.now();
    if (state.mode === 'supabase' && state.room) void dbUpsertPlayer(player, state.room.code);

    const mine = player.id === state.playerId;
    if (mine) {
      resetExtraction();
      if (status === 'out') {
        addLog('Vous êtes sorti de la zone — éliminé.', 'danger');
        showStatusModal('out', player);
      } else if (status === 'captured') {
        addLog('Votre QR vie a été scanné — neutralisé.', 'danger');
        showStatusModal('captured', player);
      } else if (status === 'extracted') {
        addLog(`Extraction validée sur ${player.extractedPoint || 'un point'}.`, 'strong');
        toast('Extraction réussie. Vous êtes hors jeu.', 'success', 4200);
        beep(880, 0.08);
        setTimeout(() => beep(1180, 0.1), 140);
        vibrate([40, 35, 40]);
      }
    } else if (status === 'out') {
      addLog(`${player.name} a été éliminé (hors zone).`, 'danger');
    } else if (status === 'extracted') {
      addLog(`${player.name} a réussi son extraction.`, 'strong');
    } else if (status === 'captured') {
      addLog(`${player.name} a été neutralisé.`, 'strong');
    }

    if (broadcast && state.transport) {
      state.transport.send({
        type: 'status',
        playerId,
        status,
        by: meta.by || '',
        reason: meta.reason || '',
        point: meta.point || ''
      });
    }
    if (remote && (status === 'out' || status === 'captured') && mine) {
      showStatusModal(status, player);
    }

    syncMarkers();
    if (state.view === 'game') {
      renderTeam();
      updateGameDynamic();
    }
    if (state.view === 'lobby') renderLobby();
    if (isHost()) checkRoundCompletion();
    return true;
  }

  function applyRemoteStatus(playerId, status, meta = {}) {
    if (!['out', 'captured', 'extracted'].includes(status)) return;
    transitionPlayer(playerId, status, meta, { broadcast: false, remote: true });
  }

  function markRemoteOut(playerId, reason = 'zone') {
    if (!isHost()) return;
    const player = state.players.get(playerId);
    if (!player || player.role !== 'fugitive' || player.status !== 'active') return;
    transitionPlayer(playerId, 'out', { reason }, { broadcast: true });
  }

  function markSelfOut() {
    const me = self();
    if (!me || me.role !== 'fugitive' || me.status !== 'active') return;
    transitionPlayer(me.id, 'out', { reason: 'zone' }, { broadcast: true });
  }

  function checkSelfZone() {
    const me = self();
    if (!me || !state.room || state.room.phase !== 'game') return;
    if (me.role !== 'fugitive' || me.status !== 'active') return;
    if (!state.room.center || !state.gps) return;
    if (Date.now() - state.gps.at > 15_000) return;
    const gap = distanceMeters([state.gps.lng, state.gps.lat], state.room.center);
    if (gap != null && gap > state.room.radius) markSelfOut();
  }

  function validateAllZones() {
    if (!isHost() || !state.room || state.room.phase !== 'game' || !state.room.center) return;
    const now = Date.now();
    for (const player of state.players.values()) {
      if (player.id === state.playerId) continue;
      if (player.role !== 'fugitive' || player.status !== 'active') continue;
      if (!validLngLat(player.lng, player.lat)) continue;
      if (now - player.lastSeen > 7_000) continue;
      const gap = distanceMeters([player.lng, player.lat], state.room.center);
      if (gap != null && gap > state.room.radius) {
        markRemoteOut(player.id, 'zone');
      }
    }
  }

  function checkRoundCompletion() {
    if (!isHost() || !state.room || state.room.phase !== 'game') return;
    if (state.completionScheduled || state.endScheduled) return;
    const fugitives = [...state.players.values()].filter((player) => player.role === 'fugitive');
    if (!fugitives.length) return;
    if (!fugitives.every((player) => player.status !== 'active')) return;
    state.completionScheduled = true;
    setTimeout(() => {
      if (!state.room || state.room.phase !== 'game') return;
      finishRound('all-resolved');
    }, 900);
  }

  function finishRound(reason = 'timer') {
    if (!state.room || state.room.phase !== 'game') return;
    if (!isHost()) return;
    if (state.endScheduled) return;
    state.endScheduled = true;
    const ended = {
      ...state.room,
      phase: 'end',
      endedReason: reason,
      endedAt: Date.now()
    };
    applyEndState(ended, playersPayload(), { announce: true });
    if (state.transport) {
      state.transport.send({ type: 'end', room: state.room, players: playersPayload() });
    }
  }

  function applyEndState(rawRoom, rawPlayers, { announce = true } = {}) {
    const incoming = normalizeRoom(rawRoom) || state.room;
    if (!incoming) return;
    state.room = { ...incoming, phase: 'end' };
    mergePlayers(rawPlayers || [], { force: true });
    state.endScheduled = true;
    state.isHost = state.room.hostId === state.playerId;
    if (state.isHost) { persistRoomRecord(); persistAllPlayers(); }
    state.extraction.since = null;
    state.extractionRevealed = false;
    state.radio.index = null;
    clearRadioMarkers();
    el('radio-chip')?.classList.add('hidden');
    stopScanner();
    closeModal('scan-modal');
    closeModal('qr-modal');
    closeModal('confirm-modal');
    closeModal('status-modal');
    addLog(`Manche terminée · ${reasonLabel(state.room.endedReason)}.`, 'strong');
    showView('end');
    renderEnd();
    updateZoneOnMap();
    syncMarkers();
    syncCenterMarker();
    syncExtractionMarkers();
    updateRoomChrome();
    refreshHostUi();
    if (announce) {
      toast('Manche terminée.', 'success', 4200);
      beep(760, 0.09);
      setTimeout(() => beep(600, 0.1), 160);
      setTimeout(() => beep(440, 0.12), 320);
      vibrate([40, 50, 60]);
    }
  }

  function reasonLabel(reason) {
    return ({
      timer: 'temps écoulé',
      'all-resolved': 'toutes les cibles résolues',
      host: 'arrêt de l’hôte',
      empty: 'terrain vide'
    }[reason] || 'fin de manche');
  }

  function hostRematch() {
    if (!isHost() || !state.room || state.room.phase !== 'end') return;
    const now = Date.now();
    const next = {
      ...state.room,
      phase: 'lobby',
      startsAt: null,
      hideEndsAt: null,
      endsAt: null,
      extraction: [],
      endedReason: '',
      endedAt: null
    };
    for (const player of state.players.values()) {
      player.status = 'active';
      player.outReason = '';
      player.capturedBy = '';
      player.extractedAt = null;
      player.extractedPoint = '';
      player.updatedAt = now;
    }
    applyRematch(next, playersPayload());
    if (state.transport) {
      state.transport.send({ type: 'rematch', room: state.room, players: playersPayload() });
    }
  }

  function applyRematch(rawRoom, rawPlayers) {
    const incoming = normalizeRoom(rawRoom);
    if (!incoming) return;
    state.room = { ...incoming, phase: 'lobby' };
    mergePlayers(rawPlayers || [], { force: true });
    for (const player of state.players.values()) {
      player.status = 'active';
      player.outReason = '';
      player.capturedBy = '';
      player.extractedAt = null;
      player.extractedPoint = '';
    }
    state.isHost = state.room.hostId === state.playerId;
    if (state.isHost) { persistRoomRecord(); persistAllPlayers(); }
    state.endScheduled = false;
    state.completionScheduled = false;
    state.announcedChase = false;
    state.extractionRevealed = false;
    state.radio.index = null;
    clearRadioMarkers();
    el('radio-chip')?.classList.add('hidden');
    state.logs = [];
    state.extraction = { since: null, validated: false, pointId: null };
    closeModal('status-modal');
    closeModal('scan-modal');
    closeModal('qr-modal');
    showView('lobby');
    renderLobby();
    updateZoneOnMap();
    syncMarkers();
    syncCenterMarker();
    syncExtractionMarkers();
    fitZone();
    updateRoomChrome();
    refreshHostUi();
    publishPresence(true);
    addLog('Nouvelle manche : réglages du salon.');
    toast('Salon prêt pour une nouvelle manche.', 'success');
  }

  function tick() {
    if (!state.room) return;
    if (state.room.phase === 'game') {
      updateGameDynamic();
      checkSelfZone();
      validateAllZones();
      const now = Date.now();
      if (state.room.endsAt && now >= state.room.endsAt) {
        if (isHost()) {
          finishRound('timer');
        } else if (now >= state.room.endsAt + 2_500 && !state.fallbackAnnounce) {
          state.fallbackAnnounce = true;
          applyEndState({ ...state.room, phase: 'end', endedReason: 'timer', endedAt: now }, null, { announce: true });
        }
      }
    } else if (state.room.phase === 'end') {
      if (state.fallbackAnnounce) state.fallbackAnnounce = false;
    }
  }

  function updateLobbyLive() {
    if (state.view !== 'lobby' || !state.room) return;
    const list = playersArray();
    el('lobby-count').textContent = `${list.length} JOUEUR${list.length > 1 ? 'S' : ''}`;
    const check = readiness();
    el('btn-start').disabled = !check.ready;
    el('start-hint').textContent = check.hint;
  }

  /* ------------------------------------------------------------------------
     Rendu de l’interface
     ------------------------------------------------------------------------ */

  function setHomeError(message) {
    const node = el('home-error');
    if (node) node.textContent = message || '';
  }

  function renderHome() {
    updateGpsUi();
    const nameInput = el('input-name');
    if (nameInput && !nameInput.value && state.name) nameInput.value = state.name;
  }

  function showView(view) {
    const target = ['home', 'lobby', 'game', 'end'].includes(view) ? view : 'home';
    const changed = state.view !== target;
    state.view = target;
    for (const name of ['home', 'lobby', 'game', 'end']) {
      const node = el(`view-${name}`);
      if (!node) continue;
      node.classList.toggle('is-active', name === target);
      node.classList.toggle('hidden', name !== target);
    }
    document.body.dataset.view = target;
    document.body.dataset.role = state.role;
    if (changed) el('sheet-scroll').scrollTop = 0;
    updateRoomChrome();
    if (target === 'home') renderHome();
    if (target === 'lobby') renderLobby();
    if (target === 'game') {
      renderGameStatic();
      updateGameDynamic();
      startWatch();
    }
    if (target === 'end') renderEnd();
    if (target !== 'home') startWatch();
    refreshHostUi();
  }

  function lobbyPlayerRow(player, hostId) {
    const mine = player.id === state.playerId;
    const host = player.id === hostId;
    const gps = validLngLat(player.lng, player.lat);
    return `
      <div class="player${mine ? ' is-self' : ''}">
        <div class="player-avatar${player.role === 'fugitive' ? ' is-guest' : ''}">${esc(initials(player.name))}</div>
        <div class="player-main">
          <div class="player-name">
            ${esc(player.name)}
            ${host ? '<span class="badge badge-host">HÔTE</span>' : ''}
            ${mine ? '<span class="badge">VOUS</span>' : ''}
          </div>
          <div class="player-meta">${host ? 'HÔTE' : 'JOUEUR'}<span class="dot"></span>${gps ? 'GPS OK' : 'GPS EN ATTENTE'}</div>
        </div>
        <span class="player-role is-${player.role}">${roleLabel(player.role)}</span>
      </div>`;
  }

  function renderLobby() {
    const current = state.room;
    if (!current || state.view !== 'lobby') return;
    const list = playersArray();
    el('lobby-code').textContent = current.code;
    el('top-room-code').textContent = current.code;
    el('lobby-mode').textContent = state.transportKind === 'supabase' ? 'SUPABASE REALTIME' : 'DÉMO LOCALE';
    el('lobby-count').textContent = `${list.length} JOUEUR${list.length > 1 ? 'S' : ''}`;
    const host = state.players.get(current.hostId);
    el('host-hint').textContent = isHost() ? 'Vous êtes hôte' : host ? `Hôte · ${host.name}` : 'Hôte hors ligne';

    for (const button of $$('#role-switch .role-card')) {
      const selected = button.dataset.role === state.role;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    el('players-list').innerHTML = list.map((player) => lobbyPlayerRow(player, current.hostId)).join('');

    el('host-zone').classList.toggle('hidden', !isHost());
    el('guest-zone').classList.toggle('hidden', isHost());
    el('center-coords').textContent = current.center ? fmtCoords(current.center[1], current.center[0]) : 'Appuyez sur la carte';
    el('guest-center').textContent = current.center ? fmtCoords(current.center[1], current.center[0]) : 'En attente de l’hôte';
    el('guest-radius').textContent = fmtDistance(current.radius);
    el('guest-duration').textContent = `${current.duration} min`;
    el('btn-center-me').disabled = !state.gps;

    for (const button of $$('#radius-seg button')) {
      button.classList.toggle('is-selected', Number(button.dataset.radius) === current.radius);
    }
    for (const button of $$('#duration-seg button')) {
      button.classList.toggle('is-selected', Number(button.dataset.duration) === current.duration);
    }

    const check = readiness();
    el('btn-start').disabled = !check.ready;
    el('start-hint').textContent = check.hint;
    updateRoomChrome();
    refreshHostUi();
  }

  function renderGameStatic() {
    const current = state.room;
    const me = self();
    if (!current || !me || state.view !== 'game') return;
    el('game-role').textContent = roleLabel(me.role);
    el('game-role').classList.toggle('chip-dark', me.status === 'active');
    el('game-role').classList.toggle('chip-outline', me.status !== 'active');
    const activeCount = [...state.players.values()].filter((player) => player.status === 'active').length;
    el('game-count').textContent = `${activeCount} EN JEU`;
    document.body.dataset.role = me.role;
    renderTeam();
    renderLog();
    updateRoomChrome();
    updateGameDynamic();
  }

  function renderTeam() {
    const me = self();
    if (!me || !state.room || state.view !== 'game') return;
    const mates = playersArray().filter((player) => player.role === me.role);
    el('team-list').innerHTML = mates.map((player) => {
      const name = player.id === state.playerId ? 'Vous' : player.name;
      const gps = validLngLat(player.lng, player.lat) || (player.id === state.playerId && state.gps);
      const note = player.status === 'active' ? (gps ? 'EN JEU' : 'GPS…') : statusLabel(player.status);
      return `<span class="team-chip${player.status !== 'active' ? ' is-out' : ''}">
        <span class="team-dot"></span>${esc(shortName(name))} · ${note}
      </span>`;
    }).join('');
  }

  function addLog(text, type = '') {
    state.logs.unshift({ at: Date.now(), text, type });
    state.logs = state.logs.slice(0, 10);
    if (state.view === 'game') renderLog();
  }

  function renderLog() {
    const node = el('event-log');
    if (!node) return;
    if (!state.logs.length) {
      node.innerHTML = '<p class="hint-text">Aucun événement pour le moment.</p>';
      return;
    }
    node.innerHTML = state.logs.slice(0, 7).map((entry) => `
      <div class="log-item${entry.type === 'danger' ? ' is-danger' : entry.type === 'strong' ? ' is-strong' : ''}">
        <span class="log-time">${fmtHour(entry.at)}</span>
        <span>${esc(entry.text)}</span>
      </div>`).join('');
  }

  function renderEnd() {
    const current = state.room;
    if (!current || state.view !== 'end') return;
    const list = playersArray();
    const fugitives = list.filter((player) => player.role === 'fugitive');
    const extracted = fugitives.filter((player) => player.status === 'extracted');
    const captured = fugitives.filter((player) => player.status === 'captured');
    const out = fugitives.filter((player) => player.status === 'out');
    let title = 'Manche terminée.';
    let reason = 'La manche est close. Consultez le bilan des joueurs.';

    if (current.endedReason === 'timer') {
      title = 'Temps écoulé.';
      reason = extracted.length
        ? `${extracted.length} fugitif${extracted.length > 1 ? 's se sont extraits' : ' s’est extrait'} avant la fin du chrono.`
        : 'Le chrono est arrivé à zéro. Les fugitifs encore en jeu l’emportent.';
    } else if (current.endedReason === 'all-resolved') {
      if (extracted.length && !captured.length && !out.length) {
        title = 'Extraction réussie.';
        reason = 'Tous les fugitifs ont rejoint un point d’extraction.';
      } else if (!extracted.length) {
        title = 'Toutes les cibles neutralisées.';
        reason = 'Les chercheurs ont mis fin à la manche avant le chrono.';
      } else {
        title = 'Manche terminée.';
        reason = 'Toutes les cibles ont été résolues : extraction, capture ou sortie de zone.';
      }
    } else if (current.endedReason === 'host') {
      title = 'Manche interrompue.';
      reason = 'L’hôte a mis fin à la manche avant le terme du chrono.';
    } else if (current.endedReason === 'empty') {
      title = 'Terrain vide.';
      reason = 'Il ne reste plus assez de joueurs pour poursuivre.';
    }

    el('end-kicker').textContent = 'FIN DE MANCHE';
    el('end-title').textContent = title;
    el('end-reason').textContent = reason;
    const duration = current.startsAt && current.endedAt
      ? `${Math.max(1, Math.ceil((current.endedAt - current.startsAt) / 60_000))} min`
      : '—';
    el('end-stats').innerHTML = `
      <div class="stat"><strong>${extracted.length}</strong><span>EXTRAITS</span></div>
      <div class="stat"><strong>${captured.length + out.length}</strong><span>NEUTRALISÉS</span></div>
      <div class="stat"><strong>${duration}</strong><span>DURÉE</span></div>`;

    el('end-players').innerHTML = list.map((player) => {
      let status = 'Encore en jeu';
      if (player.status === 'extracted') status = `Extrait${player.extractedPoint ? ` · ${player.extractedPoint}` : ''}`;
      if (player.status === 'captured') status = `Neutralisé${player.capturedBy ? ` · ${player.capturedBy}` : ''}`;
      if (player.status === 'out') status = 'Éliminé · zone';
      return `
        <div class="end-player">
          <div class="end-player-name">
            <span>${esc(player.name)}</span>
            ${player.id === current.hostId ? '<span class="badge badge-host">HÔTE</span>' : ''}
            ${player.id === state.playerId ? '<span class="badge">VOUS</span>' : ''}
          </div>
          <span class="end-status is-${player.status}">${esc(status)}</span>
        </div>`;
    }).join('');
    el('end-room-label').textContent = `${current.code} · M${String(current.round).padStart(2, '0')}`;
    refreshHostUi();
    updateRoomChrome();
  }

  /* ------------------------------------------------------------------------
     Modales, statuts, notifications
     ------------------------------------------------------------------------ */

  function openModal(id) {
    const node = el(id);
    if (!node) return;
    node.classList.remove('hidden');
    setTimeout(() => {
      const focusable = node.querySelector('button:not([disabled]), input, [tabindex="0"]');
      focusable?.focus({ preventScroll: true });
    }, 40);
  }

  function closeModal(id) {
    const node = el(id);
    if (!node || node.classList.contains('hidden')) return;
    node.classList.add('hidden');
    if (id === 'scan-modal') stopScanner();
    if (id === 'confirm-modal') state.confirmAction = null;
  }

  function closeAllModals() {
    for (const node of $$('.modal:not(.hidden)')) node.classList.add('hidden');
    state.confirmAction = null;
    stopScanner();
  }

  function showStatusModal(kind, player) {
    if (state.statusModalShownFor === `${kind}:${player.updatedAt}`) return;
    state.statusModalShownFor = `${kind}:${player.updatedAt}`;
    closeModal('qr-modal');
    closeModal('scan-modal');
    const modal = el('status-modal');
    const icon = el('status-icon');
    modal.classList.remove('is-neutral');
    icon.className = 'modal-icon modal-icon--danger';
    icon.innerHTML = `<i data-lucide="${kind === 'out' ? 'map-pin-off' : 'scan-line'}" aria-hidden="true"></i>`;
    if (kind === 'out') {
      el('status-kicker').textContent = 'HORS ZONE';
      el('status-title').textContent = 'Éliminé.';
      el('status-message').textContent = 'Vous êtes sorti du cercle de jeu. La manche continue sans vous ; suivez la fin en spectateur.';
    } else {
      el('status-kicker').textContent = 'QR VIE SCANNÉ';
      el('status-title').textContent = 'Neutralisé.';
      el('status-message').textContent = `${player.capturedBy ? `${player.capturedBy} a scanné` : 'Un chercheur a scanné'} votre QR vie. Vous suivez la manche en spectateur.`;
    }
    lucideIcons();
    openModal('status-modal');
    vibrate([60, 50, 90]);
    beep(320, 0.12, 0.045);
  }

  function toast(message, type = 'info', duration = 3_200) {
    const stack = el('toast-stack');
    if (!stack) return;
    while (stack.children.length >= 3) stack.firstElementChild?.remove();
    const node = document.createElement('div');
    node.className = `toast${type === 'danger' ? ' is-danger' : ''}`;
    const icon = type === 'danger' ? 'alert-circle' : type === 'success' ? 'check' : 'info';
    node.innerHTML = `<i data-lucide="${icon}" aria-hidden="true"></i><span>${esc(message)}</span>`;
    stack.appendChild(node);
    lucideIcons();
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 200);
    }, duration);
  }

  function showLoading(title, subtitle) {
    el('loading-title').textContent = title;
    el('loading-sub').textContent = subtitle || '';
    el('loading-overlay').classList.remove('hidden');
  }

  function hideLoading() {
    el('loading-overlay').classList.add('hidden');
  }

  function openConfirm(message, action) {
    el('confirm-message').textContent = message;
    state.confirmAction = action;
    openModal('confirm-modal');
  }

  function audioContext() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return null;
    if (!state.audio) state.audio = new Audio();
    if (state.audio.state === 'suspended') state.audio.resume().catch(() => {});
    return state.audio;
  }

  function beep(frequency = 880, duration = 0.06, volume = 0.035) {
    if (document.hidden) return;
    try {
      const ctx = audioContext();
      if (!ctx) return;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + duration + 0.02);
    } catch { /* audio indisponible */ }
  }

  /* ------------------------------------------------------------------------
     Temps réel : mode, réglages
     ------------------------------------------------------------------------ */

  function updateModeUi() {
    const supabase = state.mode === 'supabase';
    const error = supabase && state.connection === 'error';

    const settingsDot = el('settings-status-dot');
    if (settingsDot) settingsDot.className = `status-dot${error ? ' is-error' : supabase ? ' is-ok' : ' is-waiting'}`;
    const settingsTitle = el('settings-status-title');
    const settingsText = el('settings-status-text');
    if (settingsTitle) settingsTitle.textContent = error ? 'Connexion interrompue' : supabase ? 'Supabase configuré' : 'Mode démo local';
    if (settingsText) {
      settingsText.textContent = error
        ? 'Vérifiez le réseau et les clés du projet.'
        : supabase
          ? 'Les salons utilisent le canal Realtime de votre projet.'
          : 'Les onglets de ce navigateur partagent le salon.';
    }

    el('btn-use-demo')?.classList.toggle('hidden', !supabase);
  }

  function openSettings() {
    el('settings-error').textContent = '';
    const source = state.config || SUPABASE_DEFAULT;
    el('supabase-url').value = source.url || '';
    el('supabase-key').value = source.key || '';
    updateModeUi();
    openModal('settings-modal');
  }

  function normalizeSupabaseUrl(value) {
    let parsed;
    try { parsed = new URL(String(value).trim()); } catch { throw new Error('URL Supabase invalide.'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('L’URL doit commencer par https://.');
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error('Utilisez HTTPS pour un projet distant.');
    }
    return parsed.origin;
  }

  function saveSupabaseConfig(event) {
    event?.preventDefault();
    const errorNode = el('settings-error');
    errorNode.textContent = '';
    if (state.room) {
      errorNode.textContent = 'Quittez le salon avant de changer de mode temps réel.';
      return;
    }
    try {
      if (!window.supabase) throw new Error('Bibliothèque Supabase indisponible.');
      const url = normalizeSupabaseUrl(el('supabase-url').value);
      const key = el('supabase-key').value.trim();
      if (key.length < 10) throw new Error('Clé anon / publishable invalide.');
      const client = window.supabase.createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      state.config = { url, key };
      state.supabaseClient = client;
      state.mode = 'supabase';
      state.connection = 'idle';
      writeJSON(STORE.supabase, state.config);
      writeJSON(STORE.mode, 'supabase');
      updateModeUi();
      toast('Supabase configuré. Créez ou rejoignez un salon.', 'success', 4200);
      closeModal('settings-modal');
    } catch (error) {
      errorNode.textContent = error?.message || 'Configuration invalide.';
    }
  }

  function useDemoMode() {
    if (state.room) {
      el('settings-error').textContent = 'Quittez le salon avant de changer de mode temps réel.';
      return;
    }
    state.mode = 'demo';
    state.config = null;
    state.supabaseClient = null;
    state.connection = 'idle';
    try { localStorage.removeItem(STORE.supabase); } catch { /* ignoré */ }
    writeJSON(STORE.mode, 'demo');
    updateModeUi();
    closeModal('settings-modal');
    toast('Mode démo local activé.', 'success');
  }

  /* ------------------------------------------------------------------------
     Zone : placement du centre
     ------------------------------------------------------------------------ */

  function startPicking() {
    if (!isHost() || !state.room || state.room.phase !== 'lobby') return;
    state.picking = true;
    document.getElementById('app')?.classList.add('is-picking');
    el('pick-banner').classList.remove('hidden');
    el('map').classList.add('picking');
    toast('Touchez la carte pour déplacer le centre.', 'info');
  }

  function exitPicking() {
    state.picking = false;
    document.getElementById('app')?.classList.remove('is-picking');
    el('pick-banner').classList.add('hidden');
    el('map').classList.remove('picking');
  }

  function commitCenter(center) {
    if (!state.picking || !isHost() || !state.room || state.room.phase !== 'lobby') return;
    if (!validLngLat(center[0], center[1])) return;
    state.room.center = center;
    exitPicking();
    broadcastRoomState();
    updateZoneOnMap();
    fitZone();
    renderLobby();
    toast('Centre de zone mis à jour.', 'success');
  }

  function copyRoomCode() {
    if (!state.room) return;
    const code = state.room.code;
    const done = () => toast(`Code ${code} copié.`, 'success');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
    } else {
      fallbackCopy(code, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      done();
    } catch {
      toast('Copie impossible. Notez le code manuellement.', 'danger');
    }
  }

  /* ------------------------------------------------------------------------
     QR vie & scanner
     ------------------------------------------------------------------------ */

  function openQrModal() {
    const me = self();
    if (!me || !state.room) return;
    if (me.role !== 'fugitive') { toast('Le QR vie est réservé aux fugitifs.', 'danger'); return; }
    if (state.room.phase !== 'game' || me.status !== 'active') {
      toast('Le QR vie est désactivé lorsque vous êtes hors jeu.', 'danger');
      return;
    }
    if (!me.token) me.token = randomToken();
    el('qr-name').textContent = `${me.name.toUpperCase()} · ${state.room.code}`;
    el('qr-token').textContent = me.token;
    const container = el('qr-container');
    container.innerHTML = '';
    openModal('qr-modal');
    try {
      if (!window.QRCode) throw new Error('QRCode indisponible');
      new QRCode(container, {
        text: `GEOHUNT|${state.room.code}|${me.id}|${me.token}`,
        width: 208,
        height: 208,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel?.M ?? 1
      });
    } catch {
      container.innerHTML = '<p class="fine-print">QR indisponible hors connexion.<br>Présentez le code de secours.</p>';
    }
  }

  async function openScanner() {
    const me = self();
    if (!me || !state.room) return;
    if (me.role !== 'hunter') { toast('Seuls les chercheurs scannent les QR vie.', 'danger'); return; }
    if (state.room.phase !== 'game' || me.status !== 'active') {
      toast('Le scanner est désactivé lorsque vous êtes hors jeu.', 'danger');
      return;
    }
    openModal('scan-modal');
    state.scanHandled = false;
    el('scan-result').textContent = '';
    el('scan-result').className = 'scan-result';
    el('scan-status').className = 'scanner-status mono';
    el('scan-status').textContent = 'INITIALISATION DE LA CAMÉRA…';

    if (state.scannerActive) return;
    if (!window.Html5Qrcode) {
      el('scan-status').textContent = 'SCANNER INDISPONIBLE — SAISIE MANUELLE';
      el('scan-status').classList.add('is-error');
      return;
    }
    try {
      state.scanner = new Html5Qrcode('qr-reader', { verbose: false });
      await state.scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 }, aspectRatio: 1 },
        onScanSuccess,
        () => { /* image sans QR : on ignore */ }
      );
      state.scannerActive = true;
      if (el('scan-modal').classList.contains('hidden')) {
        stopScanner();
        return;
      }
      el('scan-status').textContent = 'CAMÉRA ACTIVE · CADREZ LE QR VIE';
    } catch {
      state.scannerActive = false;
      el('scan-status').textContent = window.isSecureContext
        ? 'CAMÉRA INDISPONIBLE — SAISIE MANUELLE'
        : 'CAMÉRA BLOQUÉE HORS HTTPS — SAISIE MANUELLE';
      el('scan-status').classList.add('is-error');
      el('scan-manual-input')?.focus();
    }
  }

  function stopScanner() {
    const scanner = state.scanner;
    state.scanner = null;
    state.scannerActive = false;
    if (!scanner) return;
    try {
      scanner.stop().then(() => scanner.clear()).catch(() => {});
    } catch { /* déjà arrêté */ }
  }

  function onScanSuccess(text) {
    if (state.scanHandled) return;
    state.scanHandled = true;
    stopScanner();
    handleScan(text);
  }

  function handleScan(raw) {
    const me = self();
    const result = el('scan-result');
    const status = el('scan-status');
    const fail = (message) => {
      result.textContent = message;
      result.className = 'scan-result is-error';
      status.textContent = 'QR REFUSÉ';
      status.className = 'scanner-status mono is-error';
      beep(260, 0.1, 0.03);
      vibrate([40, 40, 40]);
    };
    if (!me || !state.room || me.role !== 'hunter' || me.status !== 'active') {
      fail('Vous ne pouvez pas scanner dans cet état.');
      return;
    }

    const value = String(raw || '').trim().toUpperCase();
    let token = '';
    let claimedRoom = '';
    let claimedPlayer = '';
    if (value.startsWith('GEOHUNT|')) {
      const parts = value.split('|');
      claimedRoom = parts[1] || '';
      claimedPlayer = parts[2] || '';
      token = parts[3] || '';
    } else {
      token = value;
    }
    token = token.replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (!token) { fail('Aucun code lisible.'); return; }
    if (claimedRoom && claimedRoom !== state.room.code) {
      fail('Ce QR vie appartient à un autre salon.');
      return;
    }

    let target = claimedPlayer ? state.players.get(claimedPlayer) : null;
    if (!target) {
      target = [...state.players.values()].find((player) => player.token === token) || null;
    }
    if (!target) { fail('QR inconnu ou cible déjà neutralisée.'); return; }
    if (target.id === me.id) { fail('Vous ne pouvez pas scanner votre propre QR.'); return; }
    if (target.role !== 'fugitive') { fail('Cette cible n’est pas un fugitif.'); return; }
    if (target.status !== 'active') { fail(`${target.name} est déjà hors jeu.`); return; }
    if (String(target.token).toUpperCase() !== token) { fail('Code de vie invalide.'); return; }

    transitionPlayer(target.id, 'captured', { by: me.name }, { broadcast: false });
    state.transport?.send({ type: 'capture', targetId: target.id, token, by: me.name });
    result.textContent = `CIBLE NEUTRALISÉE · ${target.name.toUpperCase()}`;
    result.className = 'scan-result';
    status.textContent = 'QR VIE VALIDÉ';
    status.className = 'scanner-status mono';
    beep(920, 0.08);
    setTimeout(() => beep(1240, 0.1), 130);
    vibrate([50, 40, 70]);
    toast(`${target.name} est neutralisé.`, 'success', 4200);
    setTimeout(() => closeModal('scan-modal'), 1_200);
  }

  /* ------------------------------------------------------------------------
     Tiroir mobile
     ------------------------------------------------------------------------ */

  function sheetCurrentOffset(sheet) {
    try {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
      return Number.isFinite(matrix.m42) ? matrix.m42 : 0;
    } catch {
      return 0;
    }
  }

  function setSheetCollapsed(collapsed, { keepOffset = false } = {}) {
    const sheet = el('sheet');
    if (!sheet) return;
    const handle = el('sheet-handle');
    const scroll = el('sheet-scroll');
    const next = window.matchMedia('(min-width: 1024px)').matches ? false : Boolean(collapsed);
    if (!keepOffset) sheet.style.removeProperty('--sheet-y');
    sheet.classList.toggle('is-collapsed', next);
    state.sheet.collapsed = next;
    if (handle) {
      handle.setAttribute('aria-expanded', String(!next));
      handle.setAttribute('aria-label', next ? 'Agrandir le panneau' : 'Réduire le panneau');
    }
    if (scroll) scroll.inert = next;
  }

  function beginSheetDrag(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (window.matchMedia('(min-width: 1024px)').matches) return;
    const sheet = el('sheet');
    const handle = el('sheet-handle');
    if (!sheet || !handle) return;
    const rect = sheet.getBoundingClientRect();
    const maxHide = Math.max(0, rect.height - SHEET_PEEK_PX);
    if (maxHide < 24) return;
    const startOffset = Math.min(maxHide, Math.max(0, sheetCurrentOffset(sheet)));
    state.sheet.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset,
      offset: startOffset,
      maxHide,
      moved: false
    };
    sheet.classList.add('is-dragging');
    sheet.style.setProperty('--sheet-y', `${startOffset}px`);
    try { handle.setPointerCapture(event.pointerId); } catch { /* pointeur non capturable */ }
  }

  function moveSheetDrag(event) {
    const drag = state.sheet.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (Math.abs(delta) > 4) drag.moved = true;
    drag.offset = Math.min(drag.maxHide, Math.max(0, drag.startOffset + delta));
    el('sheet')?.style.setProperty('--sheet-y', `${drag.offset}px`);
  }

  function endSheetDrag(event) {
    const drag = state.sheet.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const sheet = el('sheet');
    const threshold = Math.min(90, drag.maxHide * 0.22);
    const movedBy = drag.offset - drag.startOffset;
    const startedCollapsed = drag.startOffset > drag.maxHide / 2;
    const shouldCollapse = drag.moved
      ? startedCollapsed
        ? movedBy > -threshold
        : movedBy > threshold
      : !state.sheet.collapsed;
    state.sheet.drag = null;
    try { el('sheet-handle')?.releasePointerCapture(event.pointerId); } catch { /* déjà libéré */ }
    if (!sheet) return;
    const target = shouldCollapse ? drag.maxHide : 0;
    sheet.classList.remove('is-dragging');
    sheet.style.setProperty('--sheet-y', `${target}px`);
    setSheetCollapsed(shouldCollapse, { keepOffset: true });
    setTimeout(() => {
      if (state.sheet.drag || sheet.classList.contains('is-dragging')) return;
      sheet.style.removeProperty('--sheet-y');
    }, 320);
  }

  function cancelSheetDrag(event) {
    const drag = state.sheet.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    state.sheet.drag = null;
    setSheetCollapsed(state.sheet.collapsed);
    try { el('sheet-handle')?.releasePointerCapture(event.pointerId); } catch { /* déjà libéré */ }
  }

  /* ------------------------------------------------------------------------
     Événements & démarrage
     ------------------------------------------------------------------------ */

  function bindEvents() {
    el('form-create')?.addEventListener('submit', createRoom);
    el('form-join')?.addEventListener('submit', joinRoom);
    el('input-name')?.addEventListener('input', () => setHomeError(''));
    el('input-code')?.addEventListener('input', (event) => {
      event.target.value = cleanCode(event.target.value);
      setHomeError('');
    });
    el('scan-manual-input')?.addEventListener('input', (event) => {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    const sheetHandle = el('sheet-handle');
    sheetHandle?.addEventListener('pointerdown', beginSheetDrag);
    sheetHandle?.addEventListener('pointermove', moveSheetDrag);
    sheetHandle?.addEventListener('pointerup', endSheetDrag);
    sheetHandle?.addEventListener('pointercancel', cancelSheetDrag);
    sheetHandle?.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      setSheetCollapsed(!state.sheet.collapsed);
    });

    el('btn-home')?.addEventListener('click', requestLeave);
    el('btn-room-code')?.addEventListener('click', copyRoomCode);
    el('lobby-code-display')?.addEventListener('click', copyRoomCode);
    el('btn-settings')?.addEventListener('click', openSettings);
    el('form-supabase')?.addEventListener('submit', saveSupabaseConfig);
    el('btn-use-demo')?.addEventListener('click', useDemoMode);

    el('role-switch')?.addEventListener('click', (event) => {
      const button = event.target.closest('.role-card');
      if (!button) return;
      if (!state.room || state.room.phase !== 'lobby') {
        toast('Le rôle est verrouillé pendant la manche.', 'danger');
        return;
      }
      const me = self();
      if (!me) return;
      state.role = button.dataset.role === 'fugitive' ? 'fugitive' : 'hunter';
      me.role = state.role;
      me.updatedAt = Date.now();
      document.body.dataset.role = state.role;
      persistSelfPlayer();
      publishPresence(true);
      renderLobby();
    });

    el('radius-seg')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-radius]');
      if (!button || !isHost() || state.room?.phase !== 'lobby') return;
      const radius = Number(button.dataset.radius);
      if (!RADII.includes(radius)) return;
      state.room.radius = radius;
      broadcastRoomState();
      updateZoneOnMap();
      fitZone();
      renderLobby();
    });

    el('duration-seg')?.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-duration]');
      if (!button || !isHost() || state.room?.phase !== 'lobby') return;
      const duration = Number(button.dataset.duration);
      if (!DURATIONS.includes(duration)) return;
      state.room.duration = duration;
      broadcastRoomState();
      renderLobby();
    });

    el('btn-center-me')?.addEventListener('click', () => {
      if (!isHost() || !state.room || state.room.phase !== 'lobby') return;
      if (!state.gps) { toast('Position GPS indisponible.', 'danger'); requestGps({ interactive: true }); return; }
      state.room.center = [state.gps.lng, state.gps.lat];
      broadcastRoomState();
      updateZoneOnMap();
      fitZone();
      renderLobby();
      toast('Centre placé sur votre position.', 'success');
    });
    el('btn-center-map')?.addEventListener('click', startPicking);
    el('btn-cancel-pick')?.addEventListener('click', exitPicking);

    el('btn-start')?.addEventListener('click', startRound);
    el('btn-locate')?.addEventListener('click', () => {
      if (state.gps) flyToGps(800);
      else { toast('Recherche de votre position…', 'info'); requestGps({ interactive: true }); }
    });
    el('btn-zoom-in')?.addEventListener('click', () => state.map?.zoomIn());
    el('btn-zoom-out')?.addEventListener('click', () => state.map?.zoomOut());

    el('btn-leave-lobby')?.addEventListener('click', requestLeave);
    el('btn-leave-lobby-bottom')?.addEventListener('click', requestLeave);
    el('btn-leave-game')?.addEventListener('click', requestLeave);
    el('btn-leave-end')?.addEventListener('click', requestLeave);
    el('btn-rematch')?.addEventListener('click', hostRematch);

    el('btn-scan')?.addEventListener('click', openScanner);
    el('btn-show-qr')?.addEventListener('click', openQrModal);
    el('scan-close')?.addEventListener('click', () => closeModal('scan-modal'));
    el('scan-manual-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = el('scan-manual-input').value.trim();
      if (!value) return;
      handleScan(value);
    });

    el('geo-retry')?.addEventListener('click', () => requestGps({ interactive: true }));
    el('btn-retry-gps')?.addEventListener('click', () => requestGps({ interactive: true }));
    el('confirm-accept')?.addEventListener('click', () => {
      const action = state.confirmAction;
      state.confirmAction = null;
      closeModal('confirm-modal');
      if (typeof action === 'function') action();
    });

    document.addEventListener('click', (event) => {
      const closer = event.target.closest('[data-close]');
      if (!closer) return;
      closeModal(closer.dataset.close);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const visible = $$('.modal:not(.hidden)');
      if (visible.length) {
        closeModal(visible[visible.length - 1].id);
        return;
      }
      if (state.picking) exitPicking();
    });

    document.addEventListener('pointerdown', () => {
      try { audioContext(); } catch { /* audio indisponible */ }
    }, { once: true, capture: true });

    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.room) requestPositionSilent();
    });
    window.addEventListener('online', () => toast('Réseau rétabli.', 'success'));
    window.addEventListener('offline', () => toast('Réseau hors ligne — la synchronisation peut être interrompue.', 'danger', 5000));
    window.addEventListener('pagehide', () => {
      state.transport?.send({ type: 'leave', playerId: state.playerId });
      try { state.transport?.close(); } catch { /* ignoré */ }
      stopWatch();
      stopScanner();
    });
  }

  function init() {
    state.name = cleanName(readJSON(STORE.name, ''));
    el('input-name').value = state.name;
    document.body.dataset.role = state.role;
    document.body.dataset.view = 'home';

    const savedMode = readJSON(STORE.mode, '');
    const savedConfig = readJSON(STORE.supabase);
    if (savedMode === 'demo') {
      state.mode = 'demo';
    } else if (savedConfig?.url && savedConfig?.key) {
      state.config = { url: savedConfig.url, key: savedConfig.key };
      state.mode = 'supabase';
    } else if (SUPABASE_DEFAULT.url && SUPABASE_DEFAULT.key) {
      state.config = { ...SUPABASE_DEFAULT };
      state.mode = 'supabase';
    }

    bindEvents();
    updateModeUi();
    updateGpsUi();
    renderHome();
    lucideIcons();
    requestGps({ interactive: true });

    if (!window.isSecureContext) {
      setHomeError('Le GPS nécessite HTTPS. Ouvrez GEOHUNT depuis une origine sécurisée.');
    }

    state.timers.tick = setInterval(tick, TICK_MS);
  }

  init();
})();
