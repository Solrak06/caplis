// Caplis - lógica del renderer. Sin dependencias externas.
import * as FX from './fx.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const icon = (name, cls = '') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Estado ----------
const state = {
  name: 'Proyecto sin título',
  settings: { width: 1920, height: 1080, fps: 30, fit: 'contain' },
  media: {},            // id (ruta) -> info del archivo
  video: [],            // clips de la pista principal (en orden)
  audioLanes: [[], []], // pistas de audio: listas de clips con start
  texts: [],            // títulos / texto en pantalla
  captions: null,       // subtítulos { items, style, burn }
  fx: [],               // efectos de impacto en el tiempo { id, type, start, dur, intensity }
  sel: null,            // { kind:'video'|'audio'|'fx'|'text', lane, id }
  filePath: null,
  version: null,        // versión guardada actual (historial)
  viralis: null,        // origen en Viralis (si el proyecto viene de allí)
};
let CAT = null;          // repertorio (looks, transiciones, efectos…) desde lib/catalog.js
let previewingVersion = null; // viendo una versión antigua (sin guardar nada)
let PPS = 60;            // píxeles por segundo en la línea de tiempo
let playing = false, playT = 0, rafId = null, lastTick = 0, snap = true;
let previewVol = 1, previewMuted = false;
const history = []; let hIdx = -1;

const clipDur = (c) => (c.out - c.in) / (c.speed || 1);
// Posición de cada clip de vídeo en el tiempo. Con transición, el clip empieza antes y se solapa con el anterior
// (mismo cálculo que la exportación, para que vista previa y MP4 coincidan).
function videoLayout() {
  const items = []; let acc = 0;
  state.video.forEach((c, i) => {
    const d = clipDur(c); let td = 0;
    if (i > 0 && c.transition && c.transition.type && c.transition.type !== 'none') { td = Math.min(c.transition.dur || 0.5, d - 0.05, acc - 0.05); if (td <= 0.02) td = 0; }
    const start = acc - td; items.push({ c, start, d, td }); acc = start + d;
  });
  return { items, end: acc };
}
const videoDur = () => videoLayout().end;
const audioEnd = () => Math.max(0, ...state.audioLanes.flat().map((c) => c.start + (c.out - c.in)));
const totalDur = () => Math.max(videoDur(), audioEnd(), 0.001);
function videoStart(id) { const it = videoLayout().items.find((x) => x.c.id === id); return it ? it.start : 0; }
function clipAt(t) {
  let hit = null;
  for (const it of videoLayout().items) if (t >= it.start && t < it.start + it.d) hit = it; // en un solape gana el clip entrante
  return hit ? { c: hit.c, local: (t - hit.start) * (hit.c.speed || 1) + hit.c.in } : null;
}
const roleOf = (c) => c.role || (state.media[c.mediaId] && state.media[c.mediaId].isVoice ? 'voice' : 'sfx');

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function fmtShort(t) {
  t = Math.max(0, t); const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

// ---------- Historial ----------
function snapshot(noSave) {
  const copy = JSON.parse(JSON.stringify({ media: state.media, video: state.video, audioLanes: state.audioLanes, settings: state.settings, name: state.name, captions: state.captions || null, script: state.script || null, texts: state.texts || [], fx: state.fx || [] }));
  history.splice(hIdx + 1); history.push(copy); if (history.length > 100) history.shift(); hIdx = history.length - 1;
  if (!noSave) { setSaved('Sin guardar…'); autosave(); }
}
function restore(snap) {
  Object.assign(state, JSON.parse(JSON.stringify(snap)));
  renderAll(); renderSubList(); renderTextList(); renderTextLayer(); renderFxPanel(); setSaved('Sin guardar…'); autosave();
}
function undo() { if (hIdx > 0) restore(history[--hIdx]); }
function redo() { if (hIdx < history.length - 1) restore(history[++hIdx]); }

// ---------- Avisos ----------
let toastT;
function toast(msg, { err = false, link = null, action = null, claude = false, ms = null } = {}) {
  const el = $('#toast'); el.className = 'toast' + (err ? ' err' : '') + (claude ? ' claude' : ''); el.innerHTML = '';
  el.append(document.createTextNode(msg));
  if (link) { const a = document.createElement('a'); a.textContent = 'Abrir carpeta'; a.onclick = () => caplis.showInFolder(link); el.append(a); }
  if (action) { const a = document.createElement('a'); a.textContent = action.label; a.onclick = () => { el.classList.add('hidden'); action.fn(); }; el.append(a); }
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), ms || (err ? 9000 : 5000));
  el.classList.remove('hidden');
}
function setSaved(txt) { const el = $('#tbSaved'); if (el) el.textContent = inEditor ? txt : ''; }

// ---------- Importar medios ----------
async function importFiles(paths) {
  if (!paths || !paths.length) return;
  let n = 0;
  for (const p of paths) {
    try { const info = await caplis.importMedia(p); state.media[info.path] = info; n++; }
    catch (e) { toast('No se pudo importar ' + p.split(/[\\/]/).pop() + ': ' + e.message, { err: true }); }
  }
  renderMedia(); snapshot();
  if (n) toast(n === 1 ? 'Archivo importado. Pulsa + o arrástralo a la línea de tiempo.' : n + ' archivos importados.');
}

function mediaClass(m) { return m.kind === 'audio' ? (m.isVoice ? 'voice' : m.isMusic ? 'music' : 'audio') : ''; }
function renderMedia() {
  const grid = $('#mediaGrid'); grid.innerHTML = '';
  const items = Object.values(state.media);
  $('#dropHint').classList.toggle('hidden', items.length > 0);
  for (const m of items) {
    const el = document.createElement('div'); el.className = 'media-item'; el.draggable = true; el.dataset.id = m.path;
    const ic = m.kind === 'audio' ? icon(m.isVoice ? 'mic' : 'sound') : icon('media');
    el.innerHTML = `<div class="thumb ${mediaClass(m)}" ${m.thumb ? `style="background-image:url('${m.thumb}')"` : ''}>${m.thumb ? '' : ic}</div>
      <div class="dur">${fmtShort(m.duration)}</div><button class="add" title="Añadir a la línea de tiempo">+</button>
      <div class="meta" title="${esc(m.name)}">${esc(m.name)}</div>`;
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/media', m.path); });
    $('.add', el).onclick = () => appendMedia(m.path);
    el.ondblclick = () => appendMedia(m.path);
    grid.append(el);
  }
}

// Añadir medio: vídeo/imagen a la pista principal; audio a la primera pista de audio libre en el cursor.
function appendMedia(id, atTime = null) {
  const m = state.media[id]; if (!m) return;
  if (m.kind === 'audio') {
    const start = atTime == null ? (state.audioLanes.flat().length ? snapTime(playT) : 0) : atTime;
    const lane = freeLaneAt(start, m.duration);
    state.audioLanes[lane].push({ id: uid(), mediaId: id, in: 0, out: m.duration, start, volume: 1, fadeIn: 0, fadeOut: 0, role: m.isVoice ? 'voice' : m.isMusic ? 'music' : undefined });
  } else {
    state.video.push({ id: uid(), mediaId: id, in: 0, out: m.duration, speed: 1, volume: 1, muted: false });
    autoFitIfNeeded(m);
  }
  renderAll(); snapshot();
}
function freeLaneAt(start, dur) {
  for (let i = 0; i < state.audioLanes.length; i++) {
    const busy = state.audioLanes[i].some((c) => start < c.start + (c.out - c.in) && start + dur > c.start);
    if (!busy) return i;
  }
  state.audioLanes.push([]); return state.audioLanes.length - 1;
}
// Reencuadre automático: vídeo horizontal en proyecto vertical (o al revés) -> rellenar recortando.
function autoFitIfNeeded(m) {
  if (!m.width || !m.height) return;
  const projV = state.settings.height > state.settings.width, mediaV = m.height > m.width;
  if (projV !== mediaV && state.settings.fit !== 'cover') {
    state.settings.fit = 'cover'; applyFit();
    toast('Reencuadre automático: el vídeo se recorta para llenar el formato ' + aspectName() + '. Ajusta el centro en Propiedades.');
  }
}
function aspectName() { const { width: w, height: h } = state.settings; return w === h ? '1:1' : h > w ? (Math.abs(w / h - 0.8) < 0.01 ? '4:5' : '9:16') : '16:9'; }
function applyFit() { $('#stage').classList.toggle('fill', state.settings.fit === 'cover'); fitStage(); }
// Ajusta el visor al hueco disponible manteniendo el formato del proyecto.
function fitStage() {
  const wrap = $('#stageWrap'), st = $('#stage'); if (!wrap || !st) return;
  const pad = document.body.classList.contains('fullscreen') ? 0 : 16;
  const W = wrap.clientWidth - pad * 2, H = wrap.clientHeight - pad * 2; if (W <= 0 || H <= 0) return;
  const ratio = state.settings.width / state.settings.height;
  let w = W, h = W / ratio; if (h > H) { h = H; w = H * ratio; }
  st.style.width = Math.floor(w) + 'px'; st.style.height = Math.floor(h) + 'px';
  renderCaptionOverlay(); renderTextLayer();
}

// ---------- Línea de tiempo ----------
const hasOverlayTracks = () => ({ text: (state.texts || []).length > 0, fx: (state.fx || []).length > 0 });
function renderHeads() {
  const h = $('#tlHeads'); h.innerHTML = '';
  const ov = hasOverlayTracks();
  if (ov.text) { const d = document.createElement('div'); d.className = 'tl-head thin'; d.innerHTML = `${icon('text')}<span>Texto</span>`; h.append(d); }
  if (ov.fx) { const d = document.createElement('div'); d.className = 'tl-head thin'; d.innerHTML = `${icon('fx')}<span>Efectos</span>`; h.append(d); }
  const main = document.createElement('div'); main.className = 'tl-head main'; main.innerHTML = `${icon('media')}<span>Vídeo</span>`; h.append(main);
  state.audioLanes.forEach((lane, i) => {
    const d = document.createElement('div'); d.className = 'tl-head';
    d.innerHTML = `${icon('sound')}<span>Audio ${i + 1}</span>`;
    h.append(d);
  });
}

function renderRuler() {
  const ruler = $('#ruler'); ruler.innerHTML = '';
  const dur = totalDur() + 4;
  const inner = $('#tlInner'); inner.style.width = Math.max($('#tlScroll').clientWidth, dur * PPS + 40) + 'px';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * PPS >= 70) || 600;
  const minor = step >= 10 ? step / 5 : step / 2;
  for (let t = 0; t <= dur; t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const tick = document.createElement('div'); tick.className = 'tick' + (isMajor ? ' major' : ''); tick.style.left = t * PPS + 'px'; ruler.append(tick);
    if (isMajor) { const l = document.createElement('div'); l.className = 'lbl'; l.style.left = t * PPS + 'px'; l.textContent = fmtShort(t); ruler.append(l); }
  }
}

function makeClipEl(clip, kind, lane) {
  const m = state.media[clip.mediaId] || {};
  const el = document.createElement('div');
  const role = kind === 'audio' ? roleOf(clip) : null;
  const cls = role === 'voice' ? ' voice' : role === 'music' ? ' music' : '';
  el.className = `clip ${kind}${cls}` + (state.sel && state.sel.id === clip.id ? ' sel' : '') + (clip.muted ? ' muted' : '');
  el.dataset.id = clip.id;
  const dur = kind === 'video' ? clipDur(clip) : (clip.out - clip.in);
  const left = kind === 'video' ? videoStart(clip.id) : clip.start;
  el.style.left = left * PPS + 'px'; el.style.width = Math.max(8, dur * PPS) + 'px';
  let inner = '';
  if (m.thumb && kind === 'video') inner += `<div class="strip" style="background-image:url('${m.thumb}')"></div>`;
  if (m.wave) inner += `<div class="wave" style="background-image:url('${m.wave}')"></div>`;
  if (kind === 'video' && clip.transition && clip.transition.type) inner += `<div class="trans" style="width:${Math.max(6, clip.transition.dur * PPS)}px" title="Transición"></div>`;
  const badges = [];
  if (clip.speed && clip.speed !== 1) badges.push(clip.speed + '×');
  if (clip.enhanced) badges.push('✦ mejorado');
  if (role === 'music' && clip.ducking) badges.push('ducking');
  if (clip.fx && CAT) { if (clip.fx.look && clip.fx.look !== 'none') badges.push(CAT.looks[clip.fx.look] || clip.fx.look); const mt = clip.fx.motion && (clip.fx.motion.type || clip.fx.motion); if (mt && mt !== 'none') badges.push('↗ ' + (CAT.motions[mt] ? CAT.motions[mt].name : mt)); }
  if (clip.afx && CAT) { const pr = clip.afx.preset || clip.afx; if (pr && pr !== 'none' && typeof pr === 'string') badges.push('♪ ' + (CAT.audioFx[pr] || pr)); }
  inner += `<div class="label">${esc(m.name || 'clip')}</div>`;
  if (badges.length && dur * PPS > 120) inner += `<div class="badge">${badges.join(' · ')}</div>`;
  if (dur * PPS > 70) inner += `<div class="cdur">${fmtShort(dur)}</div>`;
  if (kind === 'audio') {
    if (clip.fadeIn > 0) inner += `<div class="fade" style="width:${clip.fadeIn * PPS}px"></div>`;
    if (clip.fadeOut > 0) inner += `<div class="fade out" style="right:0;width:${clip.fadeOut * PPS}px"></div>`;
  }
  inner += '<div class="h l"></div><div class="h r"></div>';
  el.innerHTML = inner;
  attachClipEvents(el, clip, kind, lane);
  return el;
}

// Pistas de texto y efectos (encima del vídeo): barras que se arrastran para moverlas en el tiempo.
function makeOverlayEl(item, kind) {
  const el = document.createElement('div');
  const sel = state.sel && state.sel.kind === kind && state.sel.id === item.id;
  const dur = kind === 'text' ? item.end - item.start : (item.dur ?? (CAT && CAT._raw.IMPACTS[item.type] ? CAT._raw.IMPACTS[item.type].dur : 0.3));
  el.className = `clip ov ${kind}` + (sel ? ' sel' : '');
  el.style.left = item.start * PPS + 'px'; el.style.width = Math.max(10, dur * PPS) + 'px';
  const label = kind === 'text' ? item.text : (CAT && CAT.impacts[item.type] ? CAT.impacts[item.type].name : item.type);
  el.title = label + ' · ' + fmt(item.start);
  el.innerHTML = `<div class="label">${esc(label)}</div>`;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    state.sel = { kind, id: item.id }; if (kind === 'text') selectText(item.id); else { openTab('fx'); renderFxPanel(); }
    const startX = e.clientX, orig = item.start; let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return; moved = true;
      const ns = snapTime(Math.max(0, orig + (ev.clientX - startX) / PPS));
      if (kind === 'text') { const d = item.end - item.start; item.start = ns; item.end = ns + d; } else item.start = ns;
      renderTracks(); renderTextLayer();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) { snapshot(); if (kind === 'text') selectText(item.id); else renderFxPanel(); } renderTracks(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  el.addEventListener('dblclick', () => seek(item.start + 0.01));
  return el;
}
function renderTracks() {
  const tr = $('#tracks'); tr.innerHTML = '';
  const ov = hasOverlayTracks();
  if (ov.text) { const t = document.createElement('div'); t.className = 'track thin'; t.dataset.kind = 'text'; (state.texts || []).forEach((x) => t.append(makeOverlayEl(x, 'text'))); tr.append(t); }
  if (ov.fx) { const t = document.createElement('div'); t.className = 'track thin'; t.dataset.kind = 'fx'; (state.fx || []).forEach((x) => t.append(makeOverlayEl(x, 'fx'))); tr.append(t); }
  const vt = document.createElement('div'); vt.className = 'track main' + (state.video.length ? '' : ' empty'); vt.dataset.kind = 'video';
  vt.dataset.empty = 'Arrastra aquí tus vídeos o imágenes';
  state.video.forEach((c) => vt.append(makeClipEl(c, 'video')));
  tr.append(vt);
  state.audioLanes.forEach((lane, i) => {
    const at = document.createElement('div'); at.className = 'track' + (lane.length ? '' : ' empty'); at.dataset.kind = 'audio'; at.dataset.lane = i;
    at.dataset.empty = 'Arrastra aquí música, voz o efectos';
    lane.forEach((c) => at.append(makeClipEl(c, 'audio', i)));
    tr.append(at);
  });
  setupDrop(vt, 'video');
  $$('.track[data-kind=audio]', tr).forEach((t) => setupDrop(t, 'audio', +t.dataset.lane));
  // Clic en zona vacía de una pista: mueve el cursor y quita la selección
  $$('.track', tr).forEach((t) => t.addEventListener('mousedown', (e) => {
    if (e.target !== t) return;
    seek((e.clientX - t.getBoundingClientRect().left) / PPS); select(null);
  }));
}

function setupDrop(trackEl, kind, lane) {
  trackEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/media')) return;
    e.preventDefault();
    let mk = $('#dropMarker'); if (!mk) { mk = document.createElement('div'); mk.id = 'dropMarker'; mk.className = 'drop-marker'; $('#tlInner').append(mk); }
    mk.style.left = Math.max(0, e.clientX - trackEl.getBoundingClientRect().left) + 'px';
  });
  trackEl.addEventListener('drop', (e) => {
    e.preventDefault(); $('#dropMarker')?.remove();
    const mediaId = e.dataTransfer.getData('text/media'); if (!mediaId) return;
    const m = state.media[mediaId]; if (!m) return;
    const t = Math.max(0, (e.clientX - trackEl.getBoundingClientRect().left) / PPS);
    if ((kind === 'audio') !== (m.kind === 'audio')) { toast(m.kind === 'audio' ? 'El audio va en una pista de audio.' : 'Los vídeos e imágenes van en la pista de vídeo.', { err: true }); return; }
    if (kind === 'audio') { state.audioLanes[lane].push({ id: uid(), mediaId, in: 0, out: m.duration, start: snapTime(t), volume: 1, fadeIn: 0, fadeOut: 0, role: m.isVoice ? 'voice' : m.isMusic ? 'music' : undefined }); renderAll(); snapshot(); }
    else appendMedia(mediaId);
  });
  trackEl.addEventListener('dragleave', () => $('#dropMarker')?.remove());
}

function snapTime(t) {
  if (!snap) return Math.max(0, t);
  const points = [0, playT, videoDur()];
  for (const it of videoLayout().items) points.push(it.start, it.start + it.d);
  state.audioLanes.flat().forEach((c) => { points.push(c.start, c.start + (c.out - c.in)); });
  let best = t, bd = 10 / PPS;
  for (const p of points) if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; }
  return Math.max(0, best);
}

// Arrastre y recorte de clips.
function attachClipEvents(el, clip, kind, lane) {
  el.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('h')) return;
    select(kind, clip.id, lane); e.preventDefault();
    if (kind === 'video') { startReorder(e, clip); return; }
    const startX = e.clientX, startY = e.clientY, orig = clip.start; let curLane = lane; let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return; moved = true;
      clip.start = snapTime(Math.max(0, orig + (ev.clientX - startX) / PPS));
      // Cambiar de pista arrastrando en vertical
      const over = document.elementsFromPoint(ev.clientX, ev.clientY).find((x) => x.classList && x.classList.contains('track') && x.dataset.kind === 'audio');
      if (over && +over.dataset.lane !== curLane) {
        const nl = +over.dataset.lane; state.audioLanes[curLane] = state.audioLanes[curLane].filter((c) => c !== clip); state.audioLanes[nl].push(clip); curLane = nl; state.sel.lane = nl;
      }
      renderTracks();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) { renderRuler(); snapshot(); } };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
  $$('.h', el).forEach((h) => h.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault(); select(kind, clip.id, lane);
    const left = h.classList.contains('l'); const startX = e.clientX; const inO = clip.in, outO = clip.out, stO = clip.start || 0;
    const m = state.media[clip.mediaId];
    const max = m && m.kind !== 'image' ? m.duration : 3600;
    const move = (ev) => {
      const d = (ev.clientX - startX) / PPS * (clip.speed || 1);
      if (left) { clip.in = clamp(inO + d, 0, clip.out - 0.1); if (kind === 'audio') clip.start = Math.max(0, stO + (clip.in - inO) / (clip.speed || 1)); }
      else clip.out = clamp(outO + d, clip.in + 0.1, max);
      renderTracks(); renderInspector();
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); renderRuler(); snapshot(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }));
}

// Reordenar clips de vídeo arrastrando.
function startReorder(e, clip) {
  const startX = e.clientX; let moved = false;
  const move = (ev) => {
    if (Math.abs(ev.clientX - startX) < 6 && !moved) return; moved = true;
    const idx = state.video.findIndex((c) => c.id === clip.id);
    const centers = state.video.map((c) => videoStart(c.id) + clipDur(c) / 2);
    const mouseT = (ev.clientX - $('#tracks').getBoundingClientRect().left) / PPS;
    let target = centers.findIndex((c) => mouseT < c); if (target === -1) target = state.video.length - 1;
    if (target !== idx && target >= 0) { const [x] = state.video.splice(idx, 1); state.video.splice(target, 0, x); renderTracks(); }
  };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); if (moved) snapshot(); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}

function select(kind, id, lane) { state.sel = id ? { kind, id, lane } : null; renderTracks(); renderInspector(); updateEnhanceTarget(); if (!$('[data-panel=fx]').classList.contains('hidden')) renderFxPanel(); }
function selectedClip() {
  if (!state.sel) return null;
  if (state.sel.kind === 'video') return state.video.find((c) => c.id === state.sel.id);
  return state.audioLanes[state.sel.lane]?.find((c) => c.id === state.sel.id);
}

// ---------- Inspector ----------
const panLabel = (v) => Math.abs(v) < 0.03 ? 'Centro' : (v < 0 ? 'I ' : 'D ') + Math.round(Math.abs(v) * 100) + '%';
function fxSummary(fx) {
  if (!fx || !CAT) return '<span class="muted small">Natural, sin movimiento</span>';
  const p = [];
  if (fx.look && fx.look !== 'none') p.push(CAT.looks[fx.look] || fx.look);
  for (const [k, d] of Object.entries(CAT.adjust)) if (fx[k] != null && fx[k] !== d.def) p.push(d.name);
  const mt = fx.motion && (fx.motion.type || fx.motion); if (mt && mt !== 'none') p.push(CAT.motions[mt] ? CAT.motions[mt].name : mt);
  if (fx.fadeIn) p.push('aparece de negro'); if (fx.fadeOut) p.push('se funde a negro');
  return p.length ? p.map((x) => `<span class="chip">${esc(x)}</span>`).join('') : '<span class="muted small">Natural, sin movimiento</span>';
}
function openTab(name) { const b = $(`.tabs button[data-tab="${name}"]`); if (b && !b.classList.contains('active')) b.click(); }
const ASPECTS = [['1920x1080', '16:9', 'YouTube'], ['1080x1920', '9:16', 'Shorts'], ['1080x1080', '1:1', 'Cuadrado'], ['1080x1350', '4:5', 'Instagram']];
function renderInspector() {
  const box = $('#inspector'); const c = selectedClip();
  if (!c) { renderProjectInspector(box); return; }
  const m = state.media[c.mediaId] || {};
  const isV = state.sel.kind === 'video';
  $('#inspTitle').textContent = isV ? 'Clip de vídeo' : 'Clip de audio';
  const dur = isV ? clipDur(c) : (c.out - c.in);
  const role = isV ? null : roleOf(c);
  const idx = state.video.indexOf(c);
  box.innerHTML = `
    <div class="group">
      <div class="title">${esc(m.name || 'clip')}</div>
      <span class="chip">${fmtShort(dur)}</span>${c.enhanced ? '<span class="chip ok">voz mejorada</span>' : ''}
    </div>
    ${!isV ? `<div class="group">
      <div class="lbl">Tipo de audio</div>
      <div class="seg" id="insRole"><button data-v="voice">Voz</button><button data-v="music">Música</button><button data-v="sfx">Efecto</button></div>
      ${role === 'music' ? `<label class="check" title="La música baja de volumen automáticamente cuando hay voz"><input type="checkbox" id="insDuck" ${c.ducking ? 'checked' : ''}> Bajar cuando hablo (ducking)</label>` : ''}
    </div>` : ''}
    <div class="group">
      <div class="row"><span>Volumen</span><input type="range" id="insVol" min="0" max="2" step="0.05" value="${c.volume ?? 1}"><span class="val" id="insVolV">${Math.round((c.volume ?? 1) * 100)}%</span></div>
      ${m.hasAudio || !isV ? `<label class="check"><input type="checkbox" id="insMute" ${c.muted ? 'checked' : ''}> Silenciar</label>` : ''}
    </div>
    ${isV ? `<div class="group">
      <div class="row"><span>Velocidad</span><input type="range" id="insSpeed" min="0.25" max="4" step="0.05" value="${c.speed || 1}"><span class="val" id="insSpeedV">${(c.speed || 1).toFixed(2)}×</span></div>
      ${state.settings.fit === 'cover' ? `<div class="row" title="Qué parte del vídeo se ve al recortar"><span>Encuadre</span><input type="range" id="insCropX" min="0" max="1" step="0.01" value="${c.cropX ?? 0.5}"><span class="val" id="insCropXV">${Math.round((c.cropX ?? 0.5) * 100)}%</span></div>` : ''}
    </div>
    ${idx > 0 ? `<div class="group">
      <div class="lbl">Transición de entrada</div>
      <select id="insTrans" style="width:100%">${Object.entries((CAT && CAT.transitions) || { none: 'Corte' }).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <div class="row" style="margin-top:8px"><span>Duración</span><input type="range" id="insTransDur" min="0.2" max="2" step="0.1" value="${(c.transition && c.transition.dur) || 0.6}"><span class="val" id="insTransDurV">${((c.transition && c.transition.dur) || 0.6).toFixed(1)}s</span></div>
    </div>` : ''}
    <div class="group">
      <div class="lbl">Efectos del clip</div>
      <div class="fx-summary">${fxSummary(c.fx)}</div>
      <button id="insFx" class="ghost small wide">${icon('fx')} Editar look y movimiento</button>
    </div>` : `<div class="group">
      <div class="lbl">Efecto de sonido</div>
      <select id="insAfx" style="width:100%">${Object.entries((CAT && CAT.audioFx) || { none: 'Sin efecto' }).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
      <div class="row" style="margin-top:8px" title="Izquierda / derecha"><span>Panorama</span><input type="range" id="insPan" min="-1" max="1" step="0.05" value="${(c.afx && c.afx.pan) || 0}"><span class="val" id="insPanV">${panLabel((c.afx && c.afx.pan) || 0)}</span></div>
    </div>
    <div class="group">
      <div class="row"><span>Aparición</span><input type="range" id="insFin" min="0" max="5" step="0.1" value="${c.fadeIn || 0}"><span class="val" id="insFinV">${(c.fadeIn || 0).toFixed(1)}s</span></div>
      <div class="row"><span>Desaparición</span><input type="range" id="insFout" min="0" max="5" step="0.1" value="${c.fadeOut || 0}"><span class="val" id="insFoutV">${(c.fadeOut || 0).toFixed(1)}s</span></div>
    </div>`}
    <div class="group hint">${icon('cut')} <span class="kbd">S</span> dividir · <span class="kbd">Supr</span> eliminar</div>`;
  const bind = (id, vid, fn, suf, live) => { const r = $('#' + id); if (!r) return; r.oninput = () => { fn(parseFloat(r.value)); $('#' + vid).textContent = suf(parseFloat(r.value)); renderTracks(); if (live) setPlayhead(); }; r.onchange = () => { renderRuler(); snapshot(); }; };
  bind('insVol', 'insVolV', (v) => c.volume = v, (v) => Math.round(v * 100) + '%', true);
  if ($('#insMute')) $('#insMute').onchange = (e) => { c.muted = e.target.checked; renderTracks(); setPlayhead(); snapshot(); };
  if (isV) {
    bind('insSpeed', 'insSpeedV', (v) => c.speed = v, (v) => v.toFixed(2) + '×');
    bind('insCropX', 'insCropXV', (v) => c.cropX = v, (v) => Math.round(v * 100) + '%', true);
  } else {
    bind('insFin', 'insFinV', (v) => c.fadeIn = v, (v) => v.toFixed(1) + 's');
    bind('insFout', 'insFoutV', (v) => c.fadeOut = v, (v) => v.toFixed(1) + 's');
    $$('#insRole button').forEach((b) => {
      b.classList.toggle('on', b.dataset.v === role);
      b.onclick = () => { c.role = b.dataset.v; if (c.role === 'music' && c.ducking == null) c.ducking = true; renderTracks(); renderInspector(); snapshot(); };
    });
    if ($('#insDuck')) $('#insDuck').onchange = (e) => { c.ducking = e.target.checked; renderTracks(); snapshot(); };
    const setAfx = (preset, pan) => { const a = { preset, pan }; c.afx = (preset === 'none' && !pan) ? undefined : a; };
    $('#insAfx').value = (c.afx && (c.afx.preset || c.afx)) || 'none';
    $('#insAfx').onchange = (e) => { setAfx(e.target.value, (c.afx && c.afx.pan) || 0); renderTracks(); setPlayhead(); snapshot(); };
    $('#insPan').oninput = (e) => { setAfx((c.afx && c.afx.preset) || 'none', +e.target.value); $('#insPanV').textContent = panLabel(+e.target.value); setPlayhead(); };
    $('#insPan').onchange = () => snapshot();
  }
  if ($('#insFx')) $('#insFx').onclick = () => { openTab('fx'); renderFxPanel(); };
  if ($('#insTrans')) {
    $('#insTrans').value = (c.transition && c.transition.type) || 'none';
    if (c.transition && c.transition.type === 'crossfade') $('#insTrans').value = 'fade';
    $('#insTrans').onchange = (e) => { if (e.target.value === 'none') c.transition = null; else { c.transition = c.transition || { dur: 0.6 }; c.transition.type = e.target.value; } renderTracks(); renderRuler(); snapshot(); if (c.transition) seek(Math.max(0, videoStart(c.id) - 0.4)); };
    bind('insTransDur', 'insTransDurV', (v) => { if (c.transition) c.transition.dur = v; }, (v) => v.toFixed(1) + 's');
  }
}
function renderProjectInspector(box) {
  $('#inspTitle').textContent = 'Proyecto';
  const nTexts = (state.texts || []).length, nCaps = (state.captions && state.captions.items || []).length;
  box.innerHTML = `
    <div class="group">
      <div class="lbl">Nombre</div>
      <input type="text" id="prjName" value="${esc(state.name)}" style="width:100%" spellcheck="false">
    </div>
    <div class="group">
      <div class="lbl">Formato</div>
      <div class="aspect-pick" id="prjAspect">${ASPECTS.map(([v, a, s]) => { const [w, h] = v.split('x'); return `<button data-v="${v}"><span class="ar" style="aspect-ratio:${w}/${h}"></span>${a}<small>${s}</small></button>`; }).join('')}</div>
      <div class="lbl">Encuadre del vídeo</div>
      <div class="seg" id="prjFit"><button data-v="contain" title="Se ve entero, con barras si no encaja">Ajustar</button><button data-v="cover" title="Llena la pantalla recortando los bordes">Rellenar</button></div>
    </div>
    <div class="group">
      <div class="stat"><span>Duración</span><b>${fmtShort(totalDur())}</b></div>
      <div class="stat"><span>Clips de vídeo</span><b>${state.video.length}</b></div>
      <div class="stat"><span>Clips de audio</span><b>${state.audioLanes.flat().length}</b></div>
      <div class="stat"><span>Textos</span><b>${nTexts}</b></div>
      <div class="stat"><span>Subtítulos</span><b>${nCaps ? nCaps + ' líneas' : '—'}</b></div>
      <div class="stat"><span>Efectos de impacto</span><b>${(state.fx || []).length || '—'}</b></div>
      ${state.version ? `<div class="stat"><span>Versión</span><b>v${state.version}</b></div>` : ''}
      ${state.viralis ? `<div class="stat"><span>Origen</span><b>Viralis</b></div>` : ''}
    </div>
    <div class="group">
      <div class="lbl">Look para todo el vídeo</div>
      <select id="prjLook" style="width:100%"><option value="">— (cada clip el suyo)</option>${Object.entries((CAT && CAT.looks) || {}).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
    </div>
    <div class="group hint">
      <span class="kbd">Espacio</span> reproducir · <span class="kbd">F</span> pantalla completa<br>
      <span class="kbd">←</span><span class="kbd">→</span> fotograma · <span class="kbd">J</span><span class="kbd">L</span> ±5 s<br>
      <span class="kbd">S</span> dividir · <span class="kbd">Z</span> ver todo · <span class="kbd">M</span> silenciar
    </div>`;
  const cur = `${state.settings.width}x${state.settings.height}`;
  $$('#prjAspect button').forEach((b) => { b.classList.toggle('on', b.dataset.v === cur); b.onclick = () => setAspect(b.dataset.v); });
  $$('#prjFit button').forEach((b) => { b.classList.toggle('on', b.dataset.v === (state.settings.fit || 'contain')); b.onclick = () => { state.settings.fit = b.dataset.v; applyFit(); renderInspector(); setPlayhead(); snapshot(); }; });
  const looks = new Set(state.video.map((c) => (c.fx && c.fx.look) || 'none'));
  $('#prjLook').value = looks.size === 1 && state.video.length ? [...looks][0] : '';
  $('#prjLook').onchange = (e) => { if (!e.target.value) return; state.video.forEach((c) => { c.fx = { ...(c.fx || {}), look: e.target.value }; }); renderTracks(); setPlayhead(); snapshot(); toast('Look «' + CAT.looks[e.target.value] + '» aplicado a todos los clips.'); };
  const nm = $('#prjName');
  nm.onchange = async () => {
    const v = nm.value.trim() || 'Proyecto'; if (v === state.name) return;
    const old = state.filePath; state.name = v; $('#tbProject').textContent = v;
    const p = await saveProject(true, true); if (old && p && old !== p) caplis.deleteProject(old);
    toast('Proyecto renombrado.');
  };
}
function setAspect(v) {
  const [w, h] = v.split('x').map(Number);
  state.settings.width = w; state.settings.height = h;
  $('#stage').style.aspectRatio = `${w}/${h}`;
  const first = state.video[0] && state.media[state.video[0].mediaId];
  if (first) { state.settings.fit = 'contain'; autoFitIfNeeded(first); }
  applyFit(); renderInspector(); setPlayhead(); snapshot();
}

// ---------- Reproducción ----------
const preview = $('#preview');
let activeClipId = null;
function setPlayhead() {
  const t = playT, total = totalDur();
  $('#playhead').style.left = t * PPS + 'px';
  $('#tc').textContent = fmt(t); $('#tcTotal').textContent = fmt(total);
  $('#scrubCur').textContent = fmtShort(t); $('#scrubTot').textContent = fmtShort(total);
  const pct = clamp(t / total, 0, 1) * 100;
  $('#scrubFill').style.width = pct + '%'; $('#scrubKnob').style.left = pct + '%';
  renderCaptionOverlay(); renderTextLayer();
  const hit = clipAt(t);
  $('#stageEmpty').classList.toggle('hidden', state.video.length > 0);
  previewEffects(t, hit);
  if (hit) {
    const m = state.media[hit.c.mediaId] || {};
    if (activeClipId !== hit.c.id) {
      activeClipId = hit.c.id;
      if (m.url && preview.dataset.src !== m.url) { preview.src = m.url; preview.dataset.src = m.url; if (playing) preview.play().catch(() => {}); }
    }
    if (m.kind !== 'image') {
      const want = hit.local;
      if (Math.abs(preview.currentTime - want) > (playing ? 0.3 : 0.04)) preview.currentTime = want;
    }
    preview.playbackRate = hit.c.speed || 1;
    preview.style.objectPosition = `${(hit.c.cropX ?? 0.5) * 100}% 50%`;
    const useOverride = !!hit.c.audioOverride;
    preview.muted = previewMuted || !!hit.c.muted || useOverride;
    preview.volume = clamp((hit.c.volume ?? 1) * previewVol, 0, 1);
    if (m.kind === 'image') { preview.poster = m.thumb || ''; }
  } else { activeClipId = null; if (preview.dataset.src) { preview.removeAttribute('src'); preview.load(); preview.dataset.src = ''; } }
  syncPreviewAudio();
  highlightCurrentSub();
}

// ---------- Efectos en la vista previa (sin renderizar) ----------
const previewB = $('#previewB');
let activeBId = null;
function clipVisual(c, local, d, stageH) {
  const mt = FX.motionTransform(c.fx, local, d, state.settings.fps);
  return {
    filter: FX.cssFilter(c.fx, stageH, state.settings.height),
    opacity: FX.clipFadeOpacity(c.fx, local, d),
    scale: mt ? mt.scale : 1, origin: mt ? `${(mt.ox * 100).toFixed(2)}% ${(mt.oy * 100).toFixed(2)}%` : '50% 50%',
    pos: `${(c.cropX ?? 0.5) * 100}% ${(c.cropY ?? 0.5) * 100}%`,
  };
}
function styleVideo(el, v, tr) {
  el.style.filter = [v.filter, tr && tr.filter].filter(Boolean).join(' ') || '';
  el.style.opacity = String(v.opacity * (tr ? tr.opacity : 1));
  el.style.transformOrigin = v.origin;
  el.style.transform = [tr && tr.transform, v.scale !== 1 ? `scale(${v.scale.toFixed(4)})` : ''].filter(Boolean).join(' ');
  el.style.clipPath = (tr && tr.clipPath) || '';
  el.style.zIndex = tr && tr.z != null ? String(tr.z) : '';
  el.style.objectPosition = v.pos;
}
function previewEffects(t, hit) {
  const stageH = $('#stage').clientHeight || 500;
  const L = videoLayout();
  const it = hit ? L.items.find((x) => x.c === hit.c) : null;
  let showB = false, trOverlay = null;
  if (it) {
    const local = t - it.start;
    const v = clipVisual(it.c, local, it.d, stageH);
    const idx = L.items.indexOf(it);
    let trIn = null;
    if (it.td > 0 && local < it.td && idx > 0) {
      // Transición: el clip saliente se ve debajo (previewB) y el entrante encima con su máscara/fundido.
      const prev = L.items[idx - 1]; const pm = state.media[prev.c.mediaId] || {};
      const type = it.c.transition.type === 'crossfade' ? 'fade' : it.c.transition.type;
      const s = FX.transitionStyle(type, clamp(local / it.td, 0, 1));
      trIn = s.inc; showB = true;
      if (activeBId !== prev.c.id) { activeBId = prev.c.id; if (pm.url && previewB.dataset.src !== pm.url) { previewB.src = pm.url; previewB.dataset.src = pm.url; } }
      previewB.poster = pm.kind === 'image' ? (pm.thumb || '') : '';
      if (pm.kind !== 'image') {
        const want = prev.c.in + (t - prev.start) * (prev.c.speed || 1);
        if (Math.abs(previewB.currentTime - want) > (playing ? 0.3 : 0.04)) previewB.currentTime = want;
        previewB.playbackRate = prev.c.speed || 1;
        if (playing && previewB.paused) previewB.play().catch(() => {}); else if (!playing && !previewB.paused) previewB.pause();
      }
      styleVideo(previewB, clipVisual(prev.c, t - prev.start, prev.d, stageH), s.out);
      trOverlay = s.overlay;
    }
    styleVideo(preview, v, trIn);
    const ol = FX.overlayLevels(it.c.fx);
    $('#fxVignette').style.opacity = ol.vignette; $('#fxGrain').style.opacity = (ol.grain * 0.55).toFixed(3);
    if (ol.grain) $('#fxGrain').style.backgroundPosition = `${Math.floor(Math.random() * 200)}px ${Math.floor(Math.random() * 200)}px`;
  }
  if (!showB) { previewB.classList.add('off'); if (!previewB.paused) previewB.pause(); activeBId = null; } else previewB.classList.remove('off');
  // Impactos sobre toda la imagen
  const st = FX.impactState(state.fx, t);
  const wrap = $('#vidWrap');
  if (st.rgb) {
    // Separación RGB real (filtro SVG): el canal rojo y el azul se desplazan en sentidos opuestos.
    const k = stageH / state.settings.height;
    $('#fxRgbR').setAttribute('dx', (st.rgb * k).toFixed(1)); $('#fxRgbB').setAttribute('dx', (-st.rgb * k).toFixed(1));
    st.filter.unshift('url(#fxRgb)');
  }
  wrap.style.filter = st.filter.join(' ');
  wrap.style.transform = (st.scale !== 1 || st.tx || st.ty) ? `translate(${st.tx.toFixed(2)}%, ${st.ty.toFixed(2)}%) scale(${st.scale.toFixed(4)})` : '';
  const fl = $('#fxFlash'), imp = Math.max(st.flash, st.black);
  if (trOverlay && trOverlay.opacity > imp) { fl.style.background = trOverlay.color; fl.style.opacity = String(trOverlay.opacity); }
  else { fl.style.background = st.black > st.flash ? '#000' : '#fff'; fl.style.opacity = String(imp); }
  if (st.vignette) $('#fxVignette').style.opacity = Math.max(+$('#fxVignette').style.opacity || 0, st.vignette);
}

// Mezcla de audio en la vista previa: pistas de audio + voz mejorada de clips de vídeo + ducking.
const audioPool = new Map();
function syncPreviewAudio() {
  const clips = [];
  state.audioLanes.forEach((lane) => lane.forEach((c) => clips.push({ key: c.id, start: c.start, inPt: c.in, dur: c.out - c.in, vol: c.volume ?? 1, muted: c.muted, path: c.mediaId, role: roleOf(c), ducking: c.ducking, fadeIn: c.fadeIn, fadeOut: c.fadeOut, afx: c.afx })));
  for (const it of videoLayout().items) {
    const c = it.c;
    if (c.audioOverride && !c.muted) clips.push({ key: c.id + ':ov', start: it.start, inPt: c.in, dur: it.d, vol: c.volume ?? 1, path: c.audioOverride, role: 'voice', rate: c.speed || 1 });
  }
  const voiceActive = clips.some((c) => c.role === 'voice' && !c.muted && playT >= c.start && playT < c.start + c.dur);
  const activeKeys = new Set();
  for (const c of clips) {
    const active = playing && playT >= c.start && playT < c.start + c.dur && !c.muted;
    if (!active) continue;
    const m = state.media[c.path]; if (!m || !m.url) continue;
    activeKeys.add(c.key);
    let el = audioPool.get(c.key);
    if (!el) { el = new Audio(); el.preload = 'auto'; audioPool.set(c.key, el); }
    if (el._url !== m.url) { el.src = m.url; el._url = m.url; }
    try { FX.routeAudio(el, c.afx); } catch {}
    let g = c.vol;
    const local = playT - c.start;
    if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
    if (c.fadeOut > 0 && c.dur - local < c.fadeOut) g *= (c.dur - local) / c.fadeOut;
    if (c.role === 'music' && c.ducking && voiceActive) g *= 0.25;
    el.volume = clamp(g * previewVol, 0, 1); el.muted = previewMuted;
    el.playbackRate = c.rate || 1;
    const want = c.inPt + local * (c.rate || 1);
    if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
    if (el.paused) el.play().catch(() => {});
  }
  for (const [key, el] of audioPool) if (!activeKeys.has(key) && !el.paused) el.pause();
}
function stopPreviewAudio() { for (const [, el] of audioPool) { try { el.pause(); } catch {} } }
function tick(ts) {
  if (!playing) return;
  const dt = Math.min(0.1, (ts - lastTick) / 1000); lastTick = ts;
  playT += dt;
  if (playT >= totalDur()) { playT = totalDur(); pause(); }
  setPlayhead(); followPlayhead(); rafId = requestAnimationFrame(tick);
}
function followPlayhead() {
  const sc = $('#tlScroll'); const x = playT * PPS;
  if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 60) sc.scrollLeft = Math.max(0, x - 80);
}
function play() {
  if (playing || !state.video.length && !state.audioLanes.flat().length) return;
  if (playT >= totalDur() - 0.01) playT = 0;
  playing = true; $('#btnPlay').classList.add('playing'); $('#stage').classList.remove('paused-hint'); flashBigPlay();
  lastTick = performance.now(); setPlayhead(); preview.play().catch(() => {}); rafId = requestAnimationFrame(tick);
}
function pause() { $('#stage').classList.add('paused-hint'); if (!playing) { stopPreviewAudio(); return; } playing = false; $('#btnPlay').classList.remove('playing'); cancelAnimationFrame(rafId); preview.pause(); previewB.pause(); stopPreviewAudio(); flashBigPlay(); }
function togglePlay() { playing ? pause() : play(); }
function seek(t) { playT = clamp(t, 0, totalDur()); setPlayhead(); }
let bigT;
function flashBigPlay() {
  const b = $('#bigPlay'); b.innerHTML = icon(playing ? 'play' : 'pause'); b.classList.add('show');
  clearTimeout(bigT); bigT = setTimeout(() => b.classList.remove('show'), 450);
}
function setPreviewMute(m) { previewMuted = m; $('#btnMute').classList.toggle('muted', m); setPlayhead(); }

// Barra de reproducción sobre el vídeo (aparece al pasar el ratón)
function initScrub() {
  const track = $('#scrubTrack'), scrub = $('#scrub');
  const tAt = (x) => clamp((x - track.getBoundingClientRect().left) / track.clientWidth, 0, 1) * totalDur();
  track.addEventListener('mousemove', (e) => {
    const t = tAt(e.clientX), pct = t / totalDur() * 100;
    $('#scrubHover').style.width = pct + '%'; $('#scrubTip').style.left = pct + '%'; $('#scrubTip').textContent = fmtShort(t);
  });
  track.addEventListener('mouseleave', () => { $('#scrubHover').style.width = '0'; });
  track.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    const wasPlaying = playing; if (wasPlaying) pause();
    scrub.classList.add('dragging'); seek(tAt(e.clientX));
    const mv = (ev) => { const t = tAt(ev.clientX); seek(t); $('#scrubTip').style.left = (t / totalDur() * 100) + '%'; $('#scrubTip').textContent = fmtShort(t); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); scrub.classList.remove('dragging'); if (wasPlaying) play(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  scrub.addEventListener('click', (e) => e.stopPropagation());
  // Clic en el vídeo: reproducir/pausar. Doble clic: pantalla completa.
  $('#stage').addEventListener('click', (e) => { if (e.target.closest('.text-item, .scrub, .fs-exit, .ver-banner')) return; togglePlay(); });
  $('#stage').addEventListener('dblclick', (e) => { if (e.target.closest('.text-item, .scrub')) return; caplis.winFullscreen(); });
}

// Línea de tiempo: cursor fantasma con tiempo al pasar el ratón + clic/arrastre en la regla.
function initTimelineHover() {
  const sc = $('#tlScroll'), hl = $('#hoverline');
  sc.addEventListener('mousemove', (e) => {
    const x = e.clientX - $('#tlInner').getBoundingClientRect().left;
    if (x < 0) { hl.style.display = 'none'; return; }
    hl.style.display = 'block'; hl.style.left = x + 'px'; $('#hoverTime').textContent = fmt(x / PPS);
  });
  sc.addEventListener('mouseleave', () => { hl.style.display = 'none'; });
  const ruler = $('#ruler');
  const seekFromEvent = (e) => seek((e.clientX - ruler.getBoundingClientRect().left) / PPS);
  ruler.addEventListener('mousedown', (e) => { seekFromEvent(e); const mv = (ev) => seekFromEvent(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  $('.ph-knob').addEventListener('mousedown', (e) => { e.preventDefault(); const mv = (ev) => seekFromEvent(ev); const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  // Ctrl + rueda = zoom
  sc.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(PPS * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX); }, { passive: false });
}
function setZoom(v, anchorX) {
  const sc = $('#tlScroll');
  const ax = anchorX != null ? anchorX - sc.getBoundingClientRect().left : sc.clientWidth / 2;
  const tAnchor = (sc.scrollLeft + ax) / PPS;
  PPS = clamp(v, 2, 400); $('#zoom').value = PPS;
  renderRuler(); renderTracks(); setPlayhead();
  sc.scrollLeft = Math.max(0, tAnchor * PPS - ax);
}
function zoomFit() { setZoom(Math.max(2, ($('#tlScroll').clientWidth - 60) / totalDur())); $('#tlScroll').scrollLeft = 0; }

// ---------- Edición ----------
function splitAtPlayhead() {
  const sel = selectedClip();
  let did = false;
  if (sel && state.sel.kind === 'video') {
    const start = videoStart(sel.id), d = clipDur(sel);
    if (playT > start + 0.05 && playT < start + d - 0.05) {
      const localCut = sel.in + (playT - start) * (sel.speed || 1);
      const idx = state.video.findIndex((c) => c.id === sel.id);
      state.video.splice(idx + 1, 0, { ...sel, id: uid(), in: localCut, transition: null }); sel.out = localCut; did = true;
    }
  } else {
    // Sin selección: corta el clip de vídeo bajo el cursor y los audios que crucen
    const hit = !sel ? clipAt(playT) : null;
    if (hit) {
      const start = videoStart(hit.c.id);
      if (playT > start + 0.05 && playT < start + clipDur(hit.c) - 0.05) {
        const idx = state.video.indexOf(hit.c);
        state.video.splice(idx + 1, 0, { ...hit.c, id: uid(), in: hit.local, transition: null }); hit.c.out = hit.local; did = true;
      }
    }
    for (const lane of state.audioLanes) for (const c of [...lane]) {
      if (sel && c.id !== sel.id) continue;
      const s = c.start, e = c.start + (c.out - c.in);
      if (playT > s + 0.05 && playT < e - 0.05) { const cut = c.in + (playT - s); lane.push({ ...c, id: uid(), in: cut, start: playT, fadeIn: 0 }); c.out = cut; c.fadeOut = 0; did = true; }
    }
  }
  if (did) { renderAll(); snapshot(); } else toast('Coloca el cursor dentro de un clip para dividirlo.');
}
function deleteSelected() {
  const s = state.sel; if (!s) { toast('Selecciona un clip para eliminarlo.'); return; }
  if (s.kind === 'video') state.video = state.video.filter((c) => c.id !== s.id);
  else if (s.kind === 'fx') { state.fx = state.fx.filter((f) => f.id !== s.id); renderFxPanel(); }
  else if (s.kind === 'text') { selText = s.id; deleteText(); return; }
  else state.audioLanes[s.lane] = state.audioLanes[s.lane].filter((c) => c.id !== s.id);
  state.sel = null; renderAll(); snapshot();
}

// ---------- Mejorar voz ----------
async function initEnhancePanel() {
  const av = await caplis.enhanceAvailable();
  const sel = $('#enhMode'); sel.innerHTML = '';
  const add = (v, t, on = true) => { if (!on) return; const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  add('auto', 'Automático');
  add('ia-local', 'IA local · DeepFilterNet', av.iaLocal);
  add('local', 'Filtros locales (rápido)');
  $('#enhNote').textContent = 'Baja: limpieza suave, conserva el ambiente. Media: equilibrio recomendado. Alta: elimina más ruido (puede sonar más procesado).';
  $$('#enhLevel button').forEach((b) => b.onclick = () => { $$('#enhLevel button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); });
}
function updateEnhanceTarget() {
  const c = selectedClip(); const btn = $('#btnEnhance'); const t = $('#enhTarget');
  const ok = c && (state.sel.kind === 'audio' || (state.media[c.mediaId] && state.media[c.mediaId].hasAudio));
  btn.disabled = !ok; t.classList.toggle('ok', !!ok);
  if (!c) { t.textContent = 'Selecciona un clip con voz en la línea de tiempo'; return; }
  const m = state.media[c.mediaId];
  t.textContent = ok ? m.name : `«${m.name}» no tiene audio`;
}
async function runEnhance() {
  const c = selectedClip(); if (!c) return;
  const m = state.media[c.mediaId];
  const mode = $('#enhMode').value, level = $$('#enhLevel button').find((b) => b.classList.contains('on')).dataset.v, loudness = +$('#enhLoud').value;
  try {
    showJob('Mejorando voz…', false);
    const res = await caplis.enhance({ file: c.originalMediaId || m.path, mode, level, loudness });
    const info = await caplis.importMedia(res.path); info.isVoice = true; state.media[info.path] = info;
    c.originalMediaId = c.originalMediaId || m.path;
    if (state.sel.kind === 'audio') { c.mediaId = info.path; c.in = 0; c.out = info.duration; c.role = c.role || 'voice'; }
    else c.audioOverride = info.path;
    c.enhanced = level;
    hideJob(); renderAll(); snapshot();
    toast('Voz mejorada (' + ({ suave: 'baja', medio: 'media', fuerte: 'alta' }[level]) + '). Pulsa ▶ para escucharla.', { link: res.path });
  } catch (e) { hideJob(); toast('Error al mejorar: ' + e.message, { err: true }); }
}

// ---------- Narración (TTS) ----------
async function initTtsPanel() {
  const engines = await caplis.ttsEngines();
  const es = $('#ttsEngine'); es.innerHTML = '';
  engines.forEach((e) => { const o = document.createElement('option'); o.value = e.id; o.textContent = e.name; es.append(o); });
  es.onchange = loadVoices;
  if (engines.length) await loadVoices();
  $('#ttsText').addEventListener('input', (e) => $('#ttsCount').textContent = e.target.value.length);
  $('#ttsSpeed').addEventListener('input', (e) => $('#ttsSpeedLbl').textContent = (+e.target.value).toFixed(2) + '×');
}
async function loadVoices() {
  const vs = $('#ttsVoice'); vs.innerHTML = '<option>Cargando…</option>';
  try {
    const voices = await caplis.ttsVoices($('#ttsEngine').value);
    vs.innerHTML = '';
    const pref = voices.filter((v) => /es|spanish|español/i.test(v.lang + v.name));
    const rest = voices.filter((v) => !pref.includes(v));
    [...pref, ...rest].forEach((v) => { const o = document.createElement('option'); o.value = v.id; o.textContent = `${v.name}${v.lang ? ' · ' + v.lang : ''}`; vs.append(o); });
    if (!voices.length) vs.innerHTML = '<option value="">(sin voces)</option>';
  } catch (e) { vs.innerHTML = '<option value="">error</option>'; toast('No se pudieron cargar las voces: ' + e.message, { err: true }); }
}
async function runTts() {
  const text = $('#ttsText').value.trim(); if (!text) { toast('Escribe el texto a narrar.', { err: true }); return; }
  const engine = $('#ttsEngine').value, voice = $('#ttsVoice').value, speed = +$('#ttsSpeed').value;
  try {
    showJob('Generando narración…', false);
    let p = await caplis.ttsSpeak({ engine, voice, text, speed });
    if ($('#ttsEnhance').checked) { const r = await caplis.enhance({ file: p, mode: 'local', level: 'suave', loudness: -16 }); p = r.path; }
    const info = await caplis.importMedia(p); info.isVoice = true; state.media[info.path] = info;
    const start = snapTime(playT); const lane = freeLaneAt(start, info.duration);
    state.audioLanes[lane].push({ id: uid(), mediaId: info.path, in: 0, out: info.duration, start, volume: 1, fadeIn: 0, fadeOut: 0, role: 'voice' });
    hideJob(); renderAll(); snapshot();
    toast('Narración añadida en el cursor.', { link: p });
  } catch (e) { hideJob(); toast('Error al narrar: ' + e.message, { err: true }); }
}

// ---------- Trabajos / exportar ----------
function showJob(label, cancelable) { $('#jobLabel').textContent = label; $('#jobBar').style.width = '0%'; $('#jobCancel').classList.toggle('hidden', !cancelable); $('#job').classList.remove('hidden'); }
function hideJob() { $('#job').classList.add('hidden'); }
caplis.onProgress((d) => { $('#jobBar').style.width = Math.round(d.p * 100) + '%'; if (d.label) $('#jobLabel').textContent = d.label + ` · ${Math.round(d.p * 100)}%`; });

function openExportDialog() {
  if (!state.video.length) { toast('Añade al menos un clip de vídeo.', { err: true }); return; }
  const parts = [fmtShort(totalDur()), aspectName() + ' · ' + state.settings.width + '×' + state.settings.height];
  if ((state.texts || []).length) parts.push(state.texts.length + ' textos');
  if (state.captions && state.captions.burn && (state.captions.items || []).length) parts.push('con subtítulos');
  $('#expSummary').textContent = parts.join(' · ');
  $('#exportDialog').classList.remove('hidden');
}
async function doExport() {
  const quality = $('#expQuality').value;
  $('#exportDialog').classList.add('hidden');
  pause();
  try {
    showJob('Preparando descarga…', true);
    const r = await caplis.exportVideo(exportProject(), quality);
    hideJob();
    if (r.canceled) return;
    toast('MP4 listo: ' + r.path.split(/[\\/]/).pop(), { link: r.path });
  } catch (e) { hideJob(); toast(/SIGKILL|abort/i.test(e.message) ? 'Exportación cancelada.' : 'Error al exportar: ' + e.message, { err: !/SIGKILL|abort/i.test(e.message) }); }
}
function exportProject() {
  const audio = [];
  state.audioLanes.forEach((lane) => lane.forEach((c) => audio.push({ ...c, role: roleOf(c) })));
  return { name: state.name, settings: state.settings, media: state.media, video: state.video, audio, captions: state.captions || null, texts: state.texts || [], fx: state.fx || [] };
}

// ---------- Guardar ----------
function projectThumb() { const c = state.video[0]; const m = c && state.media[c.mediaId]; return m && m.thumb || null; }
function exportProjectState() {
  const o = { name: state.name, settings: state.settings, media: state.media, video: state.video, audioLanes: state.audioLanes, captions: state.captions || null, script: state.script || null, texts: state.texts || [], fx: state.fx || [], _thumb: projectThumb() };
  if (state.version) o.version = state.version;
  if (state.viralis) o.viralis = state.viralis;
  return o;
}
async function saveProject(silent, rename = false) {
  if (previewingVersion) { if (!silent) toast('Estás viendo una versión antigua: restáurala o vuelve a la actual para guardar.'); return null; }
  const p = await caplis.saveProjectAs(exportProjectState(), state.name, state.filePath, rename);
  if (p) { state.filePath = p; setSaved('Guardado ✓'); if (!silent) toast('Proyecto guardado.'); }
  return p;
}
let autosaveT;
function autosave() { clearTimeout(autosaveT); autosaveT = setTimeout(() => { if (inEditor && !previewingVersion && state.video.length + state.audioLanes.flat().length > 0) saveProject(true); }, 1200); }

// Rehidrata los medios cargados desde disco (URL file://, miniatura y forma de onda).
async function hydrateMedia() {
  const entries = Object.values(state.media || {});
  await Promise.all(entries.map(async (m) => {
    if (m.url && (m.thumb || m.kind === 'audio')) return;
    try { const fresh = await caplis.importMedia(m.path); Object.assign(m, fresh, { isVoice: m.isVoice || fresh.isVoice, isMusic: m.isMusic || fresh.isMusic }); } catch {}
  }));
  activeClipId = null; preview.dataset.src = ''; setPlayhead(); renderMedia(); renderTracks();
}
function loadProjectObject(project, filePath, { keepView = false } = {}) {
  const keepT = playT, keepPPS = PPS, keepScroll = $('#tlScroll').scrollLeft;
  pause();
  Object.assign(state, { texts: [], captions: null, script: null, fx: [], version: null, viralis: null, ...project, sel: null, filePath: filePath || null });
  delete state._thumb; delete state._previewOf;
  if (!state.audioLanes || !state.audioLanes.length) state.audioLanes = [[], []];
  if (!state.video) state.video = [];
  if (!state.settings.fit) state.settings.fit = 'contain';
  hydrateMedia();
  $('#stage').style.aspectRatio = `${state.settings.width}/${state.settings.height}`; applyFit();
  $('#tbProject').textContent = state.name || '';
  history.length = 0; hIdx = -1; selText = null;
  const hasCaps = state.captions && (state.captions.items || []).length;
  $('#subStyle').classList.toggle('hidden', !hasCaps);
  if (hasCaps && state.captions.style) {
    const st = state.captions.style;
    $('#styleSize').value = Math.round((st.size || 56) * 1080 / state.settings.height);
    if (st.pos) $('#stylePos').value = st.pos;
    if (st.color) $('#styleColor').value = '#' + st.color;
    if (st.outline) $('#styleOutline').value = '#' + st.outline;
    $('#styleBox').checked = !!st.box;
    $('#subBurn').checked = state.captions.burn !== false;
  }
  $('#textEditor').classList.add('hidden');
  renderSubList(); refreshSubSources(); renderTextList();
  $('#btnScript').classList.toggle('hidden', !state.script);
  renderFxPanel(); updateVersionChip();
  if (keepView) { playT = Math.min(keepT, totalDur()); PPS = keepPPS; renderAll(); snapshot(true); setSaved('Guardado ✓'); $('#tlScroll').scrollLeft = keepScroll; }
  else { playT = 0; renderAll(); snapshot(true); setSaved('Guardado ✓'); setTimeout(zoomFit, 50); }
  if ($('[data-panel=versions]') && !$('[data-panel=versions]').classList.contains('hidden')) renderVersions();
}

// ---------- Puente con Claude Code ----------
function publishState() {
  try {
    caplis.publishState({
      name: state.name, filePath: state.filePath, settings: state.settings, duration: totalDur(), view: inEditor ? 'editor' : 'home', playT, playing,
      version: state.version, previewingVersion, fx: (state.fx || []).length,
      previewSrc: preview.dataset.src || null, previewReady: preview.readyState,
      videoClips: state.video.length, audioClips: state.audioLanes.flat().length, texts: (state.texts || []).length,
      captions: (state.captions && state.captions.items || []).length,
      media: Object.values(state.media).map((m) => ({ path: m.path, name: m.name, kind: m.kind, duration: m.duration })),
    });
  } catch {}
}
function initBridge() {
  caplis.onBridgeLoad(async (d) => {
    if (!d || !d.project) return;
    const same = inEditor && state.filePath && d.filePath && state.filePath.toLowerCase() === d.filePath.toLowerCase();
    // Si estabas en otro proyecto, se guarda antes de cambiar.
    if (inEditor && !same && !previewingVersion && state.video.length + state.audioLanes.flat().length) { clearTimeout(autosaveT); await saveProject(true); }
    exitVersionPreview(true);
    const wasPlaying = playing;
    loadProjectObject(d.project, d.filePath, { keepView: same && d.reload });
    if (d.seek != null) seek(+d.seek);
    showEditor();
    if (d.reload) {
      const who = d.author === 'usuario' ? 'Restaurado' : 'Claude';
      toast(`${who}${d.version ? ' · v' + d.version : ''}: ${d.message || 'proyecto actualizado'}`, { claude: true, ms: 9000, action: { label: 'Ver versiones', fn: () => { openTab('versions'); renderVersions(); } } });
      const b = $('#verBadge'); b.textContent = '●'; b.classList.remove('hidden');
      if (wasPlaying || d.autoplay) setTimeout(play, 400);
    } else {
      toast('Proyecto cargado desde Claude Code: ' + (d.project.name || ''));
      if (d.autoplay) setTimeout(play, 600);
    }
    publishState();
  });
  caplis.onBridgeToast((d) => toast(d.message, { err: d.err, link: d.link }));
  // Control remoto desde Claude Code (sin tocar el ratón del usuario)
  caplis.onBridgeControl((d) => {
    if (d.home) showHome();
    if (d.tab) { const b = $(`.tabs button[data-tab="${d.tab}"]`); if (b) b.click(); }
    if (d.seek != null) seek(+d.seek);
    if (d.zoomFit) zoomFit();
    if (d.select) { const [kind, idx] = String(d.select).split(':'); if (kind === 'video' && state.video[+idx]) select('video', state.video[+idx].id); else if (kind === 'none') select(null); else { const [lane, i] = (idx || '0.0').split('.').map(Number); const c = state.audioLanes[lane] && state.audioLanes[lane][i]; if (c) select('audio', c.id, lane); } }
    if (d.hoverScrub != null && d.hoverScrub < 0) $('#scrub').classList.remove('dragging');
    else if (d.hoverScrub != null) { const pct = clamp(+d.hoverScrub, 0, 1) * 100; $('#scrub').classList.add('dragging'); $('#scrubHover').style.width = pct + '%'; $('#scrubTip').style.left = pct + '%'; $('#scrubTip').textContent = fmtShort(+d.hoverScrub * totalDur()); }
    if (d.hoverScrub === null || d.clearHover) $('#scrub').classList.remove('dragging');
    if (d.play) play();
    if (d.pause) pause();
    publishState();
  });
  publishState();
  setInterval(publishState, 2500);
}

// ---------- Biblioteca de sonidos ----------
let libData = null; const libAudio = new Audio();
let libPlayingPath = null;
function initLibrary() {
  $('#libReload').onclick = () => { libData = null; loadLibrary(); };
  $('#libSearch').addEventListener('input', renderLibrary);
  libAudio.addEventListener('ended', () => { libPlayingPath = null; renderLibrary(); });
}
async function loadLibrary() {
  const box = $('#libGroups'); box.innerHTML = '<p class="muted small">Cargando…</p>';
  try { libData = await caplis.audioLibrary(); renderLibrary(); }
  catch (e) { box.innerHTML = '<p class="muted small">No se pudo leer la biblioteca: ' + esc(e.message) + '</p>'; }
}
function renderLibrary() {
  if (!libData) return;
  const q = ($('#libSearch').value || '').toLowerCase();
  const box = $('#libGroups'); box.innerHTML = '';
  if (!libData.total) { box.innerHTML = '<p class="muted small">No se encontraron audios en «Audio para Videos».</p>'; return; }
  let shown = 0;
  libData.groups.forEach((g, gi) => {
    const items = g.items.filter((it) => !q || it.name.toLowerCase().includes(q));
    if (!items.length) return; shown += items.length;
    const det = document.createElement('details'); det.className = 'lib-group'; if (q || gi === 0) det.open = true;
    det.innerHTML = `<summary>${esc(g.name)}<span class="lg-count">${items.length}</span></summary>`;
    const list = document.createElement('div'); list.className = 'lib-items';
    for (const it of items.slice(0, q ? 200 : 400)) {
      const on = libPlayingPath === it.path;
      const row = document.createElement('div'); row.className = 'lib-item' + (on ? ' playing' : '');
      row.innerHTML = `<button class="li-play" title="${on ? 'Parar' : 'Escuchar'}">${icon(on ? 'pause' : 'play')}</button><span class="li-name" title="${esc(it.name)}">${esc(it.name.replace(/\.[^.]+$/, ''))}</span><button class="li-add" title="Añadir en el cursor">${icon('plus')}</button>`;
      $('.li-play', row).onclick = () => toggleLibPlay(it.path);
      $('.li-add', row).onclick = () => addLibraryAudio(it.path);
      list.append(row);
    }
    det.append(list); box.append(det);
  });
  if (!shown) box.innerHTML = '<p class="muted small">Sin resultados.</p>';
}
async function toggleLibPlay(p) {
  if (libPlayingPath === p) { libAudio.pause(); libPlayingPath = null; renderLibrary(); return; }
  libAudio.src = await caplis.audioUrl(p); libAudio.volume = previewVol; libAudio.play().catch(() => {}); libPlayingPath = p; renderLibrary();
}
async function addLibraryAudio(p) {
  const info = await caplis.importMedia(p); state.media[info.path] = info;
  const start = snapTime(playT); const lane = freeLaneAt(start, info.duration);
  state.audioLanes[lane].push({ id: uid(), mediaId: info.path, in: 0, out: info.duration, start, volume: 1, fadeIn: 0, fadeOut: 0 });
  renderAll(); snapshot(); toast('Sonido añadido en ' + fmtShort(start) + '.');
}

// ---------- Texto en pantalla ----------
// Plantillas, animaciones y fuentes vienen del catálogo (lib/catalog.js): las mismas que usa Claude y la exportación.
let TEMPLATES = {};
let selText = null;
function initTextPanel() {
  TEMPLATES = (CAT && CAT._raw.TEXT_TEMPLATES) || {};
  const box = $('#txTemplates');
  box.innerHTML = Object.entries(TEMPLATES).map(([k, t]) => {
    const st = `color:#${t.color};text-shadow:0 1px 2px #${t.outline},0 0 1px #${t.outline};${t.font ? `font-family:'${t.font}';` : ''}${t.italic ? 'font-style:italic;' : ''}${t.box ? `background:#${t.box};padding:0 4px;` : ''}${t.glow ? `text-shadow:0 0 6px #${t.outline},0 0 12px #${t.outline};` : ''}`;
    const sample = t.text.length > 9 ? t.text.slice(0, 8) + '…' : t.text;
    return `<button data-tpl="${k}" title="${esc(t.name)} · ${esc((CAT.textAnims || {})[t.anim] || '')}"><span class="tp-prev" style="${st}">${esc(sample)}</span>${esc(t.name)}</button>`;
  }).join('');
  $$('#txTemplates button').forEach((b) => b.onclick = () => addText(b.dataset.tpl));
  $('#txAnim').innerHTML = Object.entries((CAT && CAT.textAnims) || { fade: 'Fundido' }).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  $('#txFont').innerHTML = ((CAT && CAT.fonts) || ['Arial']).map((f) => `<option value="${esc(f)}" style="font-family:'${esc(f)}'">${esc(f)}</option>`).join('');
  $('#txDone').onclick = () => { selText = null; $('#textEditor').classList.add('hidden'); renderTextList(); renderTextLayer(); };
  $('#txDelete').onclick = deleteText;
  const upd = () => { const t = currentText(); if (!t) return; captureTextEditor(t); renderTextList(); renderTextLayer(); renderTracks(); };
  ['txText', 'txStart', 'txDur', 'txSize', 'txAnim', 'txColor', 'txOutline', 'txFont', 'txBox', 'txBoxOn', 'txGlow'].forEach((id) => { $('#' + id).addEventListener('input', upd); $('#' + id).addEventListener('change', () => { upd(); snapshot(); }); });
  $('#txAnim').addEventListener('change', () => { const t = currentText(); if (t) { seek(t.start); if (!playing) { play(); setTimeout(() => { if (playing) pause(); }, 1300); } } });
}
function currentText() { return (state.texts || []).find((t) => t.id === selText); }
function addText(tpl = 'simple') {
  state.texts = state.texts || [];
  const p = TEMPLATES[tpl] || TEMPLATES.simple || { text: 'Texto', size: 64, x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'fade', dur: 3 };
  const start = Math.round(playT * 10) / 10;
  const t = { id: uid(), text: p.text, start, end: start + p.dur, x: p.x, y: p.y, size: p.size, color: p.color, outline: p.outline, anim: p.anim, italic: !!p.italic };
  for (const k of ['font', 'box', 'glow']) if (p[k] != null) t[k] = p[k];
  state.texts.push(t); selectText(t.id); renderHeads(); renderTracks(); snapshot();
  setTimeout(() => { $('#txText').focus(); $('#txText').select(); }, 30);
}
function selectText(id) {
  selText = id; const t = currentText(); if (!t) return;
  state.sel = { kind: 'text', id };
  openTab('text');
  $('#textEditor').classList.remove('hidden');
  $('#txText').value = t.text; $('#txStart').value = t.start.toFixed(1); $('#txDur').value = (t.end - t.start).toFixed(1);
  $('#txSize').value = t.size; $('#txAnim').value = t.anim || 'none'; $('#txColor').value = '#' + t.color; $('#txOutline').value = '#' + t.outline;
  $('#txFont').value = t.font || 'Arial';
  $('#txBoxOn').checked = !!(t.box && t.box !== 'none'); if (t.box && t.box !== 'none') $('#txBox').value = '#' + t.box;
  $('#txGlow').checked = !!t.glow;
  renderTextList(); renderTextLayer(); renderTracks();
}
function captureTextEditor(t) {
  t.text = $('#txText').value; const s = Math.max(0, parseFloat($('#txStart').value.replace(',', '.')) || 0); const d = Math.max(0.3, parseFloat($('#txDur').value.replace(',', '.')) || 3);
  t.start = s; t.end = s + d; t.size = +$('#txSize').value; t.anim = $('#txAnim').value;
  t.color = $('#txColor').value.replace('#', ''); t.outline = $('#txOutline').value.replace('#', '');
  t.font = $('#txFont').value === 'Arial' ? undefined : $('#txFont').value;
  t.box = $('#txBoxOn').checked ? $('#txBox').value.replace('#', '') : undefined;
  t.glow = $('#txGlow').checked || undefined;
}
function deleteText() { if (!selText) return; state.texts = (state.texts || []).filter((t) => t.id !== selText); selText = null; if (state.sel && state.sel.kind === 'text') state.sel = null; $('#textEditor').classList.add('hidden'); renderTextList(); renderTextLayer(); renderHeads(); renderTracks(); snapshot(); }
function renderTextList() {
  const box = $('#textList'); if (!box) return; box.innerHTML = '';
  const list = [...(state.texts || [])].sort((a, b) => a.start - b.start);
  list.forEach((t) => {
    const row = document.createElement('div'); row.className = 'text-row' + (t.id === selText ? ' sel' : '');
    row.innerHTML = `<span class="tr-txt">${esc(t.text || '(vacío)')}</span><span class="tr-time">${fmtShort(t.start)}</span>`;
    row.onclick = () => { seek(t.start + 0.05); selectText(t.id); };
    box.append(row);
  });
}
// Vista previa de un texto con su animación (aproxima lo que hace el ASS de la exportación).
function renderTextLayer() {
  const layer = $('#textLayer'); if (!layer) return; layer.innerHTML = '';
  const stageH = $('#stage').clientHeight || 400, H = state.settings.height;
  (state.texts || []).forEach((t) => {
    if (t.hidden || playT < t.start || playT > t.end) return;
    const el = document.createElement('div'); el.className = 'text-item' + (t.id === selText ? ' sel' : '');
    const px = t.size * stageH / H;
    const local = playT - t.start, dur = t.end - t.start, ms = local * 1000;
    let text = t.text;
    el.style.left = (t.x * 100) + '%'; el.style.top = (t.y * 100) + '%';
    el.style.fontSize = px + 'px';
    el.style.fontStyle = t.italic ? 'italic' : 'normal';
    if (t.font) el.style.fontFamily = `'${t.font}', Arial, sans-serif`;
    el.style.color = '#' + t.color;
    const box = t.box && t.box !== 'none';
    if (box) { el.style.background = '#' + t.box; el.style.padding = `${px * 0.12}px ${px * 0.25}px`; el.style.webkitTextStroke = '0'; }
    else el.style.webkitTextStroke = Math.max(1.5, px * 0.05 * 2) + 'px #' + t.outline;
    if (t.glow) el.style.textShadow = `0 0 ${px * 0.12}px #${t.outline}, 0 0 ${px * 0.3}px #${t.outline}, 0 0 ${px * 0.5}px #${t.outline}`;
    let op = 1, sc = 1, dx = 0, dy = 0, blur = 0, ls = 0;
    const fadeIO = (i, o) => Math.min(clamp(ms / i, 0, 1), clamp((dur - local) * 1000 / o, 0, 1));
    switch (t.anim) {
      case 'fade': op = fadeIO(300, 300); break;
      case 'pop': op = fadeIO(150, 150); sc = 0.6 + 0.4 * clamp(ms / 180, 0, 1); break;
      case 'bounce': op = fadeIO(80, 150); sc = ms < 150 ? 0.3 + 0.9 * ms / 150 : ms < 260 ? 1.2 - 0.26 * (ms - 150) / 110 : ms < 340 ? 0.94 + 0.06 * (ms - 260) / 80 : 1; break;
      case 'slide': op = fadeIO(250, 250); dy = (1 - clamp(ms / 350, 0, 1)) * H * 0.04; break;
      case 'drop': op = fadeIO(120, 250); dy = -(1 - clamp(ms / 280, 0, 1)) * H * 0.12; break;
      case 'zoom': op = fadeIO(1, 200); { const k = clamp(ms / 320, 0, 1); sc = 1.9 - 0.9 * (1 - Math.pow(1 - k, 3)); } break;
      case 'blur': op = fadeIO(150, 250); blur = 18 * (1 - clamp(ms / 420, 0, 1)); break;
      case 'flicker': op = ms < 40 ? ms / 40 : ms < 80 ? 1 : ms < 120 ? 0.25 : ms < 160 ? 1 : ms < 320 ? 1 : ms < 360 ? 0.45 : 1; op = Math.min(op, fadeIO(1, 200)); break;
      case 'wide': op = fadeIO(250, 250); ls = (t.size * 0.18) * clamp(local / dur, 0, 1); break;
      case 'typewriter': { const chars = [...String(t.text)]; const step = Math.min(0.07, (dur * 0.6) / Math.max(1, chars.length)); const n = clamp(Math.floor(local / step) + 1, 0, chars.length); text = null; el.innerHTML = esc(chars.slice(0, n).join('')) + `<span style="opacity:0">${esc(chars.slice(n).join(''))}</span>`; break; }
      case 'shake': { const i = Math.floor(local / 0.07); const amp = Math.max(2, t.size * 0.045); dx = Math.round(Math.sin(i * 2.3) * amp); dy = Math.round(Math.cos(i * 1.7) * amp); break; }
    }
    if (text != null) el.textContent = text;
    const k = stageH / H;
    el.style.opacity = op;
    el.style.transform = `translate(-50%,-50%) translate(${dx * k}px, ${dy * k}px) scale(${sc})`;
    if (blur) el.style.filter = `blur(${blur * k}px)`;
    if (ls) el.style.letterSpacing = ls * k + 'px';
    el.onmousedown = (e) => startDragText(e, t, el);
    layer.append(el);
  });
}
function startDragText(e, t, el) {
  e.preventDefault(); e.stopPropagation(); selectText(t.id);
  const tab = $('.tabs button[data-tab=text]'); if (tab && !tab.classList.contains('active')) tab.click();
  const stage = $('#stage').getBoundingClientRect();
  const move = (ev) => { t.x = clamp((ev.clientX - stage.left) / stage.width, 0, 1); t.y = clamp((ev.clientY - stage.top) / stage.height, 0, 1); renderTextLayer(); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); snapshot(); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}

// ---------- Subtítulos ----------
function initSubsPanel() {
  $('#btnTranscribe').onclick = runTranscribe;
  $('#btnTranscript').onclick = runTranscript;
  ['styleSize', 'stylePos', 'styleColor', 'styleOutline', 'styleBox', 'subBurn'].forEach((id) => {
    $('#' + id).addEventListener('input', () => { captureStyle(); setPlayhead(); });
    $('#' + id).addEventListener('change', () => snapshot());
  });
}
function refreshSubSources() {
  const sel = $('#subSource'); if (!sel) return;
  const voices = [];
  state.audioLanes.flat().forEach((c) => { const m = state.media[c.mediaId]; if (m) voices.push({ id: c.mediaId, name: m.name, voice: roleOf(c) === 'voice' }); });
  state.video.forEach((c) => { if (c.audioOverride && state.media[c.audioOverride]) voices.push({ id: c.audioOverride, name: state.media[c.audioOverride].name, voice: true }); const m = state.media[c.mediaId]; if (m && m.hasAudio) voices.push({ id: c.mediaId, name: m.name + ' (vídeo)' }); });
  voices.sort((a, b) => (b.voice ? 1 : 0) - (a.voice ? 1 : 0));
  const seen = new Set(); sel.innerHTML = '';
  for (const v of voices) { if (seen.has(v.id)) continue; seen.add(v.id); const o = document.createElement('option'); o.value = v.id; o.textContent = v.name; sel.append(o); }
  $('#btnTranscribe').disabled = !voices.length; $('#btnTranscript').disabled = !voices.length;
  $('#subNote').textContent = voices.length ? 'La IA trabaja en tu PC; tarda más o menos lo que dura el audio.' : 'Añade una pista con voz para transcribir.';
}
function captureStyle() {
  state.captions = state.captions || { items: [], style: {}, burn: true };
  state.captions.style = {
    size: Math.round((+$('#styleSize').value) * state.settings.height / 1080) || 56,
    outlineW: Math.max(2, Math.round(state.settings.height / 360)),
    pos: $('#stylePos').value, color: $('#styleColor').value.replace('#', ''), outline: $('#styleOutline').value.replace('#', ''), box: $('#styleBox').checked ? 1 : 0,
  };
  state.captions.burn = $('#subBurn').checked;
}
async function runTranscribe() {
  if (!(await caplis.subsAvailable())) { toast('faster-whisper no está instalado. Ejecuta: pip install faster-whisper', { err: true }); return; }
  const m = state.media[$('#subSource').value]; if (!m) return;
  try {
    showJob('Transcribiendo con IA local…', false);
    const res = await caplis.transcribe({ file: m.path, model: $('#subModel').value, lang: $('#subLang').value });
    hideJob();
    state.captions = state.captions || {};
    state.captions.items = res.segments || [];
    captureStyle();
    $('#subStyle').classList.remove('hidden');
    renderSubList(); renderAll(); snapshot();
    toast(state.captions.items.length + ' subtítulos generados.');
  } catch (e) { hideJob(); toast('Error al transcribir: ' + e.message, { err: true }); }
}
async function runTranscript() {
  if (!(await caplis.subsAvailable())) { toast('faster-whisper no está instalado. Ejecuta: pip install faster-whisper', { err: true }); return; }
  let items = state.captions && state.captions.items;
  const m = state.media[$('#subSource').value];
  try {
    if (!items || !items.length) {
      if (!m) return;
      showJob('Transcribiendo a texto…', false);
      items = (await caplis.transcribe({ file: m.path, model: $('#subModel').value, lang: $('#subLang').value })).segments || [];
      hideJob();
    }
    const text = items.map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    try { await navigator.clipboard.writeText(text); } catch {}
    const r = await caplis.saveText(text, (state.name || 'transcripcion').slice(0, 40));
    if (r && r.path) toast('Texto guardado y copiado al portapapeles.', { link: r.path });
    else toast('Texto copiado al portapapeles (' + text.length + ' caracteres).');
  } catch (e) { hideJob(); toast('Error al transcribir: ' + e.message, { err: true }); }
}
function renderSubList() {
  const box = $('#subList'); if (!box) return; const items = (state.captions && state.captions.items) || [];
  box.innerHTML = '';
  items.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'sub-row'; row.dataset.i = i;
    row.innerHTML = `<span class="st" title="Ir aquí">${fmtShort(c.start)}</span><textarea rows="1">${esc(c.text)}</textarea>`;
    $('.st', row).onclick = () => seek(c.start + 0.01);
    const ta = $('textarea', row); ta.oninput = () => { c.text = ta.value; ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; renderCaptionOverlay(); };
    ta.onchange = () => snapshot();
    box.append(row);
  });
  requestAnimationFrame(() => $$('#subList textarea').forEach((ta) => { ta.style.height = ta.scrollHeight + 'px'; }));
  const n = items.length; $('#subCount').textContent = n + ' líneas'; $('#subCount').classList.toggle('hidden', !n);
}
let lastSubIdx = -1;
function highlightCurrentSub() {
  const caps = state.captions && state.captions.items; if (!caps || !caps.length) return;
  const i = caps.findIndex((c) => playT >= c.start && playT <= c.end);
  if (i === lastSubIdx) return;
  $$('#subList .sub-row.now').forEach((r) => r.classList.remove('now'));
  lastSubIdx = i; if (i < 0) return;
  const row = $(`#subList .sub-row[data-i="${i}"]`); if (!row) return;
  row.classList.add('now');
  if (playing && !$('[data-panel=subs]').classList.contains('hidden')) row.scrollIntoView({ block: 'nearest' });
}
function renderCaptionOverlay() {
  const ov = $('#capOverlay'), tx = $('#capText'); if (!ov) return;
  const caps = state.captions && state.captions.items;
  const c = caps && caps.find((x) => playT >= x.start && playT <= x.end);
  const st = (state.captions && state.captions.style) || {};
  if (!c || (state.captions && state.captions.burn === false && false)) { tx.textContent = ''; return; }
  tx.textContent = c.text;
  ov.className = 'cap-overlay pos-' + (st.pos || 'abajo') + (st.box ? ' box' : '');
  const stageH = $('#stage').clientHeight || 400;
  tx.style.fontSize = Math.max(10, (st.size || 56) * stageH / state.settings.height) + 'px';
  tx.style.color = '#' + (st.color || 'ffffff');
  tx.style.webkitTextStroke = Math.max(2, 2 * (st.outlineW || 3) * stageH / state.settings.height) + 'px #' + (st.outline || '000000');
}

// ---------- Efectos (panel) ----------
function renderFxPanel() {
  const box = $('#fxClipBox'); if (!box || !CAT) return;
  const c = state.sel && state.sel.kind === 'video' ? state.video.find((x) => x.id === state.sel.id) : null;
  if (!c) {
    box.innerHTML = `<div class="target">Selecciona un clip de vídeo para darle look, ajustes y movimiento.${state.video.length ? ' <a id="fxPickCur">Usar el clip del cursor</a>' : ''}</div>`;
    const a = $('#fxPickCur'); if (a) a.onclick = () => { const h = clipAt(playT) || (state.video[0] && { c: state.video[0] }); if (h) { select('video', h.c.id); renderFxPanel(); } };
  } else {
    const fx = c.fx || {};
    const m = state.media[c.mediaId] || {};
    const mt = fx.motion && (fx.motion.type || fx.motion) || 'none';
    const amt = (fx.motion && fx.motion.amount) ?? (CAT.motions[mt] && CAT.motions[mt].amount) ?? 0.15;
    box.innerHTML = `
      <div class="target ok">${esc(m.name || 'clip')} · ${fmtShort(clipDur(c))}</div>
      <div class="section-title">Look</div>
      <div class="look-grid">${Object.entries(CAT.looks).map(([k, v]) => `<button data-look="${k}" class="${(fx.look || 'none') === k ? 'on' : ''}"><span class="lk-sw lk-${k}" style="filter:${FX.cssFilter({ look: k }, 80) || 'none'}"></span>${esc(v)}</button>`).join('')}</div>
      <div class="section-title">Ajustes</div>
      ${Object.entries(CAT.adjust).map(([k, d]) => `<div class="row"><span>${esc(d.name)}</span><input type="range" data-adj="${k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${fx[k] ?? d.def}"><span class="val" data-adjv="${k}">${fmtAdj(k, fx[k] ?? d.def)}</span></div>`).join('')}
      <div class="section-title">Movimiento</div>
      <select id="fxMotion" style="width:100%">${Object.entries(CAT.motions).map(([k, v]) => `<option value="${k}" ${k === mt ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
      <div class="row" style="margin-top:6px"><span>Intensidad</span><input type="range" id="fxAmt" min="0.02" max="0.5" step="0.01" value="${amt}"><span class="val" id="fxAmtV">${Math.round(amt * 100)}%</span></div>
      <div class="row"><span>Aparece de negro</span><input type="range" id="fxFin" min="0" max="2" step="0.1" value="${fx.fadeIn || 0}"><span class="val" id="fxFinV">${(fx.fadeIn || 0).toFixed(1)}s</span></div>
      <div class="row"><span>Se funde a negro</span><input type="range" id="fxFout" min="0" max="2" step="0.1" value="${fx.fadeOut || 0}"><span class="val" id="fxFoutV">${(fx.fadeOut || 0).toFixed(1)}s</span></div>
      <div class="row-actions"><button id="fxAll" class="ghost small" title="Copia look y ajustes (sin movimiento) a todos los clips">Aplicar a todos</button><button id="fxReset" class="ghost small">Quitar efectos</button></div>`;
    const commit = () => { renderTracks(); setPlayhead(); snapshot(); };
    const setFx = (patch) => { const n = { ...(c.fx || {}), ...patch }; for (const k of Object.keys(n)) if (n[k] == null || (CAT.adjust[k] && n[k] === CAT.adjust[k].def) || (k === 'look' && n[k] === 'none') || (k === 'motion' && (n[k] === 'none' || n[k].type === 'none'))) delete n[k]; c.fx = Object.keys(n).length ? n : undefined; };
    $$('[data-look]', box).forEach((b) => b.onclick = () => { setFx({ look: b.dataset.look }); commit(); renderFxPanel(); });
    $$('[data-adj]', box).forEach((r) => {
      r.oninput = () => { setFx({ [r.dataset.adj]: +r.value }); $(`[data-adjv="${r.dataset.adj}"]`, box).textContent = fmtAdj(r.dataset.adj, +r.value); setPlayhead(); };
      r.onchange = () => { commit(); };
      r.ondblclick = () => { setFx({ [r.dataset.adj]: null }); commit(); renderFxPanel(); };
    });
    const motion = () => { const t = $('#fxMotion').value; setFx({ motion: t === 'none' ? null : { type: t, amount: +$('#fxAmt').value } }); };
    $('#fxMotion').onchange = () => { const t = $('#fxMotion').value; if (CAT.motions[t] && CAT.motions[t].amount) $('#fxAmt').value = CAT.motions[t].amount; motion(); commit(); renderFxPanel(); seek(videoStart(c.id)); };
    $('#fxAmt').oninput = () => { $('#fxAmtV').textContent = Math.round(+$('#fxAmt').value * 100) + '%'; motion(); setPlayhead(); };
    $('#fxAmt').onchange = commit;
    $('#fxFin').oninput = () => { $('#fxFinV').textContent = (+$('#fxFin').value).toFixed(1) + 's'; setFx({ fadeIn: +$('#fxFin').value || null }); setPlayhead(); };
    $('#fxFout').oninput = () => { $('#fxFoutV').textContent = (+$('#fxFout').value).toFixed(1) + 's'; setFx({ fadeOut: +$('#fxFout').value || null }); setPlayhead(); };
    $('#fxFin').onchange = commit; $('#fxFout').onchange = commit;
    $('#fxAll').onclick = () => { const src = { ...(c.fx || {}) }; delete src.motion; delete src.fadeIn; delete src.fadeOut; state.video.forEach((x) => { if (x === c) return; const n = { ...(x.fx || {}) }; for (const k of ['look', ...Object.keys(CAT.adjust)]) delete n[k]; Object.assign(n, src); x.fx = Object.keys(n).length ? n : undefined; }); commit(); toast('Look y ajustes copiados a todos los clips.'); };
    $('#fxReset').onclick = () => { c.fx = undefined; commit(); renderFxPanel(); };
  }
  // Impactos
  const grid = $('#fxImpacts');
  grid.innerHTML = Object.entries(CAT.impacts).map(([k, v]) => `<button data-imp="${k}" title="${esc(v.name)} · ${v.dur}s"><span class="imp-ic imp-${k === 'viñeta' ? 'vin' : k}"></span>${esc(v.name)}</button>`).join('');
  $$('[data-imp]', grid).forEach((b) => b.onclick = () => {
    const d = CAT.impacts[b.dataset.imp];
    const f = { id: uid(), type: b.dataset.imp, start: Math.round(playT * 100) / 100, dur: d.dur, intensity: d.intensity };
    state.fx.push(f); state.sel = { kind: 'fx', id: f.id }; renderAll(); snapshot(); renderFxPanel();
    const t0 = Math.max(0, f.start - 0.5); seek(t0); if (!playing) { play(); setTimeout(() => { if (playing && playT > f.start + f.dur + 0.4) pause(); }, (f.dur + 1.2) * 1000); }
  });
  const list = $('#fxList'); list.innerHTML = '';
  [...(state.fx || [])].sort((a, b) => a.start - b.start).forEach((f) => {
    const sel = state.sel && state.sel.kind === 'fx' && state.sel.id === f.id;
    const row = document.createElement('div'); row.className = 'fx-row' + (sel ? ' sel' : '');
    row.innerHTML = `<div class="fx-row-h"><span class="tr-txt">${esc(CAT.impacts[f.type] ? CAT.impacts[f.type].name : f.type)}</span><span class="tr-time">${fmt(f.start)}</span><button class="ghost small icon-only fx-del" title="Quitar">${icon('trash')}</button></div>
      ${sel ? `<div class="fx-row-b"><div class="row"><span>Inicio</span><input type="number" step="0.05" min="0" class="fxs" value="${f.start}"><span class="val">s</span></div>
      <div class="row"><span>Duración</span><input type="range" class="fxd" min="0.05" max="3" step="0.05" value="${f.dur}"><span class="val fxdv">${(+f.dur).toFixed(2)}s</span></div>
      <div class="row"><span>Intensidad</span><input type="range" class="fxi" min="0.05" max="1" step="0.05" value="${f.intensity}"><span class="val fxiv">${Math.round(f.intensity * 100)}%</span></div></div>` : ''}`;
    row.onclick = (e) => { if (e.target.closest('input,button')) return; state.sel = { kind: 'fx', id: f.id }; seek(Math.max(0, f.start - 0.3)); renderTracks(); renderFxPanel(); };
    $('.fx-del', row).onclick = () => { state.fx = state.fx.filter((x) => x !== f); renderAll(); snapshot(); renderFxPanel(); };
    if (sel) {
      $('.fxs', row).onchange = (e) => { f.start = Math.max(0, +e.target.value || 0); renderTracks(); snapshot(); renderFxPanel(); };
      $('.fxd', row).oninput = (e) => { f.dur = +e.target.value; $('.fxdv', row).textContent = f.dur.toFixed(2) + 's'; renderTracks(); setPlayhead(); };
      $('.fxi', row).oninput = (e) => { f.intensity = +e.target.value; $('.fxiv', row).textContent = Math.round(f.intensity * 100) + '%'; setPlayhead(); };
      $('.fxd', row).onchange = () => snapshot(); $('.fxi', row).onchange = () => snapshot();
    }
    list.append(row);
  });
}
function fmtAdj(k, v) { if (k === 'hue') return Math.round(v) + '°'; if (k === 'contrast' || k === 'saturation') return Math.round(v * 100) + '%'; return (v > 0 && k !== 'vignette' && k !== 'blur' && k !== 'grain' && k !== 'sharpen' && k !== 'sepia' ? '+' : '') + Math.round(v * 100); }

// ---------- Versiones ----------
function updateVersionChip() {
  const el = $('#tbVersion'); if (!el) return;
  el.textContent = previewingVersion ? `viendo v${previewingVersion}` : (state.version ? 'v' + state.version : '');
  el.classList.toggle('hidden', !(state.version || previewingVersion) || !inEditor);
  el.classList.toggle('old', !!previewingVersion);
}
const ago = (ts) => { const s = (Date.now() - ts) / 1000; if (s < 60) return 'ahora'; if (s < 3600) return `hace ${Math.floor(s / 60)} min`; if (s < 86400) return `hace ${Math.floor(s / 3600)} h`; return new Date(ts).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) + ' ' + new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); };
let currentSnapshot = null; // estado actual guardado mientras se ve una versión antigua
async function renderVersions() {
  const box = $('#verList'); if (!box) return;
  $('#verBadge').classList.add('hidden');
  if (!state.filePath) { box.innerHTML = '<p class="muted small">Guarda el proyecto para empezar su historial.</p>'; return; }
  const list = await caplis.versionsList(state.filePath);
  if (!list.length) { box.innerHTML = '<p class="muted small">Aún no hay versiones. Pulsa «Guardar versión» o pide cambios a Claude desde Viralis.</p>'; return; }
  const cur = state.version || (list[0] && list[0].v);
  box.innerHTML = '';
  for (const v of list) {
    const row = document.createElement('div');
    const isCur = v.v === cur && !previewingVersion, isView = v.v === previewingVersion;
    row.className = 'ver-row' + (isCur ? ' cur' : '') + (isView ? ' view' : '');
    const who = v.author === 'claude' ? '<span class="who claude">Claude</span>' : v.author === 'viralis' ? '<span class="who claude">Viralis</span>' : '<span class="who">Tú</span>';
    row.innerHTML = `<div class="ver-h"><b>v${v.v}</b>${who}<span class="muted small">${ago(v.ts)}</span>${isCur ? '<span class="chip ok">actual</span>' : ''}</div>
      <div class="ver-msg">${esc(v.message || '(sin descripción)')}</div>
      <div class="ver-a">${isCur ? '' : `<button class="ghost small vb-view">${isView ? 'Viendo…' : 'Ver'}</button><button class="ghost small vb-restore">Restaurar</button>`}</div>`;
    const bv = $('.vb-view', row); if (bv) bv.onclick = () => viewVersion(v.v);
    const br = $('.vb-restore', row); if (br) br.onclick = () => restoreVersion(v.v);
    box.append(row);
  }
}
async function viewVersion(v) {
  if (!state.filePath) return;
  if (!previewingVersion) { clearTimeout(autosaveT); await saveProject(true); currentSnapshot = { project: exportProjectState(), filePath: state.filePath }; }
  const p = await caplis.versionsGet(state.filePath, v);
  const fp = state.filePath;
  previewingVersion = v;
  loadProjectObject(p, fp, { keepView: true });
  state.version = currentSnapshot.project.version;
  $('#verPreviewTxt').textContent = `Viendo la versión ${v} (no se guarda nada)`;
  $('#verPreview').classList.remove('hidden'); updateVersionChip(); renderVersions();
}
function exitVersionPreview(silent) {
  if (!previewingVersion) return;
  previewingVersion = null; $('#verPreview').classList.add('hidden');
  if (!silent && currentSnapshot) loadProjectObject(currentSnapshot.project, currentSnapshot.filePath, { keepView: true });
  currentSnapshot = null; updateVersionChip(); renderVersions();
}
async function restoreVersion(v) {
  if (!state.filePath) return;
  const fp = state.filePath;
  if (!previewingVersion) { clearTimeout(autosaveT); await saveProject(true); }
  previewingVersion = null; currentSnapshot = null; $('#verPreview').classList.add('hidden');
  const r = await caplis.versionsRevert(fp, v);
  loadProjectObject(r.project, fp, { keepView: true });
  toast(`Versión ${v} restaurada (ahora es la v${r.entry.v}).`);
  renderVersions();
}
async function saveVersion() {
  if (previewingVersion) { toast('Restaura esta versión o vuelve a la actual antes de guardar.'); return; }
  const msg = await askText('Describe esta versión', 'Ej.: música más baja y look cine');
  if (msg == null) return;
  clearTimeout(autosaveT); const fp = await saveProject(true); if (!fp) return;
  const e = await caplis.versionsCommit(fp, exportProjectState(), msg || 'Versión guardada a mano');
  if (e) { state.version = e.v; await saveProject(true); updateVersionChip(); toast(e.unchanged ? 'Sin cambios desde la última versión.' : `Versión ${e.v} guardada.`); renderVersions(); }
}
// Pequeño diálogo de texto (sin prompt() del navegador).
function askText(title, placeholder) {
  return new Promise((resolve) => {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="modal-card"><h2>${esc(title)}</h2><input type="text" class="ask-in" style="width:100%" placeholder="${esc(placeholder || '')}"><div class="modal-actions"><button class="ghost ask-no">Cancelar</button><button class="primary ask-ok">Guardar</button></div></div>`;
    document.body.append(m);
    const done = (v) => { m.remove(); resolve(v); };
    const inp = $('.ask-in', m); setTimeout(() => inp.focus(), 30);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null); };
    $('.ask-ok', m).onclick = () => done(inp.value.trim()); $('.ask-no', m).onclick = () => done(null);
  });
}

// ---------- Vistas: inicio / editor ----------
let inEditor = false;
function showHome() {
  if (inEditor && autosaveT) { clearTimeout(autosaveT); if (state.video.length + state.audioLanes.flat().length) saveProject(true); }
  if (previewingVersion) exitVersionPreview();
  inEditor = false; pause(); updateVersionChip();
  $('#home').classList.remove('hidden');
  $('#editor').classList.add('hidden'); $('#timelineArea').classList.add('hidden');
  $('#navHome').classList.add('active'); $('#navEditor').classList.add('hidden');
  $('#tbProject').textContent = ''; setSaved('');
  renderProjects();
}
function showEditor() {
  inEditor = true;
  $('#home').classList.add('hidden');
  $('#editor').classList.remove('hidden'); $('#timelineArea').classList.remove('hidden');
  $('#navEditor').classList.remove('hidden'); $('#navHome').classList.remove('active'); $('#navEditor').classList.add('active');
  $('#tbProject').textContent = state.name || '';
  updateVersionChip();
  requestAnimationFrame(() => { renderAll(); });
}
async function renderProjects() {
  const grid = $('#projectsGrid'); const list = await caplis.listProjects();
  $('#projectsEmpty').classList.toggle('hidden', list.length > 0);
  $('#projectsGrid').classList.toggle('hidden', list.length === 0);
  grid.innerHTML = '';
  const neu = document.createElement('div'); neu.className = 'project-card pc-new';
  neu.innerHTML = '<div class="plus">＋</div><div>Nuevo proyecto</div>';
  neu.onclick = openNewDialog; grid.append(neu);
  for (const p of list) {
    const el = document.createElement('div'); el.className = 'project-card';
    const when = new Date(p.modified).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    el.innerHTML = `<div class="pc-thumb" ${p.thumb ? `style="background-image:url('${p.thumb}')"` : ''}>${p.thumb ? '' : '◐'}<span class="pc-dur">${fmtShort(p.duration)}</span></div>
      <div class="pc-body"><div class="pc-name">${esc(p.name)}</div>
      <div class="pc-meta"><span>${when} · ${p.clips} vídeo · ${p.audioClips} audio${p.versions ? ` · <b class="pc-v">v${p.version || p.versions}</b>` : ''}${p.viralis ? ' · <b class="pc-vir">Viralis</b>' : ''}</span><button class="pc-del" title="Eliminar proyecto">Eliminar</button></div></div>`;
    el.onclick = async () => { const r = await caplis.openProjectFile(p.filePath); loadProjectObject(r.project, r.filePath); showEditor(); };
    $('.pc-del', el).onclick = async (e) => { e.stopPropagation(); if (confirm('¿Eliminar «' + p.name + '»? Tus vídeos y audios no se borran, solo el proyecto.')) { await caplis.deleteProject(p.filePath); renderProjects(); } };
    grid.append(el);
  }
}
function openNewDialog() { $('#newName').value = 'Mi vídeo'; $('#newDialog').classList.remove('hidden'); setTimeout(() => $('#newName').select(), 50); }
function createNewProject() {
  const name = $('#newName').value.trim() || 'Mi vídeo';
  const [w, h] = $('#newAspect').value.split('x').map(Number);
  pause();
  Object.assign(state, { name, settings: { width: w, height: h, fps: 30, fit: 'contain' }, media: {}, video: [], audioLanes: [[], []], texts: [], fx: [], captions: null, script: null, sel: null, filePath: null, version: null, viralis: null });
  previewingVersion = null; $('#verPreview').classList.add('hidden'); updateVersionChip(); renderFxPanel();
  $('#newDialog').classList.add('hidden');
  $('#stage').style.aspectRatio = `${w}/${h}`; applyFit();
  history.length = 0; hIdx = -1; playT = 0; selText = null;
  renderSubList(); renderTextList(); $('#subStyle').classList.add('hidden'); $('#textEditor').classList.add('hidden');
  showEditor(); snapshot(true); setSaved('');
}

// ---------- Render global ----------
function renderAll() { renderMedia(); renderHeads(); renderRuler(); renderTracks(); renderInspector(); setPlayhead(); updateEnhanceTarget(); $('#tbProject').textContent = state.name || ''; }

// ---------- Eventos UI ----------
function segPick(sel, hidden) { $$(sel + ' button').forEach((b) => b.onclick = () => { $$(sel + ' button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); $(hidden).value = b.dataset.v; }); }
function wire() {
  $('#btnImport').onclick = async () => importFiles(await caplis.openMedia());
  $('#btnPlay').onclick = togglePlay;
  $('#btnStart').onclick = () => seek(0);
  $('#btnEnd').onclick = () => seek(totalDur());
  $('#btnBack').onclick = () => seek(playT - 5);
  $('#btnFwd').onclick = () => seek(playT + 5);
  $('#btnMute').onclick = () => setPreviewMute(!previewMuted);
  $('#volPreview').oninput = (e) => { previewVol = +e.target.value; if (previewVol > 0 && previewMuted) setPreviewMute(false); setPlayhead(); };
  $('#btnSplit').onclick = splitAtPlayhead;
  $('#btnDelete').onclick = deleteSelected;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#btnAddLane').onclick = () => { state.audioLanes.push([]); renderAll(); snapshot(); };
  $('#btnEnhance').onclick = runEnhance;
  $('#btnTts').onclick = runTts;
  $('#btnSave').onclick = () => saveProject(false);
  $('#verSave').onclick = saveVersion;
  $('#verPreviewExit').onclick = (e) => { e.stopPropagation(); exitVersionPreview(); };
  $('#verPreviewRestore').onclick = (e) => { e.stopPropagation(); restoreVersion(previewingVersion); };
  $('#tbVersion').onclick = () => { if (inEditor) { openTab('versions'); } };
  $('#jobCancel').onclick = () => caplis.cancelJob();
  $('#zoom').oninput = (e) => setZoom(+e.target.value);
  $('#btnZoomIn').onclick = () => setZoom(PPS * 1.5);
  $('#btnZoomOut').onclick = () => setZoom(PPS / 1.5);
  $('#btnZoomFit').onclick = zoomFit;
  $('#snap').onchange = (e) => snap = e.target.checked;

  $('#winMin').onclick = () => caplis.winMinimize();
  $('#winMax').onclick = () => caplis.winMaximize();
  $('#winClose').onclick = async () => { if (inEditor && state.video.length + state.audioLanes.flat().length) await saveProject(true); caplis.winClose(); };
  $('#navHome').onclick = showHome;
  $('#navEditor').onclick = showEditor;

  $('#btnNew').onclick = openNewDialog;
  $('#btnNew2').onclick = openNewDialog;
  $('#newCancel').onclick = () => $('#newDialog').classList.add('hidden');
  $('#newCreate').onclick = createNewProject;
  $('#newName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createNewProject(); });
  segPick('#newAspectPick', '#newAspect');

  $('#btnExport').onclick = openExportDialog;
  $('#expCancel').onclick = () => $('#exportDialog').classList.add('hidden');
  $('#expGo').onclick = doExport;
  segPick('#expQualityPick', '#expQuality');
  $$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.classList.add('hidden'); }));

  $('#btnFull').onclick = () => caplis.winFullscreen(true);
  $('#btnFsExit').onclick = (e) => { e.stopPropagation(); caplis.winFullscreen(false); };
  caplis.onWinState((s) => {
    if (s.fullscreen != null) { document.body.classList.toggle('fullscreen', s.fullscreen); $('#btnFsExit').classList.toggle('hidden', !s.fullscreen); setTimeout(() => { renderRuler(); renderTracks(); setPlayhead(); }, 80); }
  });
  window.addEventListener('resize', () => { if (inEditor) { renderRuler(); setPlayhead(); } });

  $('#btnScript').onclick = () => { if (state.script) { $('#ttsText').value = state.script; $('#ttsCount').textContent = state.script.length; } };

  $$('.tabs button').forEach((b) => b.onclick = () => {
    $$('.tabs button').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    $$('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    $('#btnScript').classList.toggle('hidden', !(b.dataset.tab === 'tts' && state.script));
    if (b.dataset.tab === 'library' && !libData) loadLibrary();
    if (b.dataset.tab === 'subs') refreshSubSources();
    if (b.dataset.tab === 'text') renderTextList();
    if (b.dataset.tab === 'fx') renderFxPanel();
    if (b.dataset.tab === 'versions') renderVersions();
  });

  // Arrastrar archivos desde Windows
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging'); } }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { if (e.target === document.documentElement || ev === 'drop') document.body.classList.remove('dragging'); }));
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return; e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => caplis.pathForFile(f)).filter(Boolean);
    if (!inEditor) { toast('Abre o crea un proyecto para importar archivos.'); return; }
    importFiles(paths);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (document.body.classList.contains('fullscreen')) { caplis.winFullscreen(false); return; } $$('.modal').forEach((m) => m.classList.add('hidden')); return; }
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox';
    if (typing) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return; }
    if (e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject(false).then(async (fp) => { if (!fp) return; const v = await caplis.versionsCommit(fp, exportProjectState(), 'Guardado a mano (Ctrl+S)'); if (v && !v.unchanged) { state.version = v.v; updateVersionChip(); saveProject(true); } });
      return;
    }
    if (!inEditor || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 's') splitAtPlayhead();
    else if (k === 'f') caplis.winFullscreen();
    else if (k === 'm') setPreviewMute(!previewMuted);
    else if (k === 'j') seek(playT - 5);
    else if (k === 'l') seek(playT + 5);
    else if (k === 'z') zoomFit();
    else if (k === '+' || k === '=') setZoom(PPS * 1.5);
    else if (k === '-') setZoom(PPS / 1.5);
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (selText && !$('[data-panel=text]').classList.contains('hidden')) deleteText(); else deleteSelected(); }
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(totalDur());
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(playT - (e.shiftKey ? 1 : 1 / state.settings.fps)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(playT + (e.shiftKey ? 1 : 1 / state.settings.fps)); }
  });
}

// ---------- Arranque ----------
(async function start() {
  try { CAT = await caplis.catalog(); FX.setCatalog(CAT._raw); } catch (e) { console.error('catálogo', e); }
  wire();
  $('#stage').classList.add('paused-hint');
  try { new ResizeObserver(() => fitStage()).observe($('#stageWrap')); } catch {}
  initScrub();
  initTimelineHover();
  initLibrary();
  initSubsPanel();
  initTextPanel();
  initBridge();
  showHome();
  await initEnhancePanel().catch(() => {});
  await initTtsPanel().catch((e) => toast('Narración: ' + e.message, { err: true }));
})();
