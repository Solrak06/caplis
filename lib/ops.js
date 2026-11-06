// Operaciones de edición de un proyecto Caplis. Las usa el conector (`edit`) para que Claude Code / Viralis cambien
// el proyecto SIN renderizar: el editor recarga el proyecto en vivo y el usuario lo ve al momento.
//
// Cada operación es un objeto { op: '<nombre>', ...campos }. Los clips de vídeo se pueden referir por id o por
// posición (número, 0 = primero). Ver CONECTOR.md para la lista completa.
const path = require('path');
const fs = require('fs');
const { probe } = require('./ffmpeg');
const { parseAspect } = require('./aspect');
const C = require('./catalog');
const sfxlib = require('./sfx');

const uid = () => Math.random().toString(36).slice(2, 10);
const clipDur = (c) => (c.out - c.in) / (c.speed || 1);

function normalize(p) {
  p.settings = p.settings || { width: 1080, height: 1920, fps: 30 };
  if (!p.settings.fit) p.settings.fit = 'contain';
  p.media = p.media || {};
  p.video = p.video || [];
  p.audioLanes = (p.audioLanes && p.audioLanes.length) ? p.audioLanes : [[], []];
  p.texts = p.texts || [];
  p.fx = p.fx || [];
  for (const c of p.video) if (!c.id) c.id = uid();
  for (const lane of p.audioLanes) for (const c of lane) if (!c.id) c.id = uid();
  for (const t of p.texts) if (!t.id) t.id = uid();
  for (const f of p.fx) if (!f.id) f.id = uid();
  return p;
}

// Posición en el tiempo de cada clip de vídeo (mismo cálculo que el editor y la exportación).
function layout(p) {
  const items = []; let acc = 0;
  p.video.forEach((c, i) => {
    const d = clipDur(c); let td = 0;
    if (i > 0 && c.transition && c.transition.type && c.transition.type !== 'none') { td = Math.min(c.transition.dur || 0.5, d - 0.05, acc - 0.05); if (td <= 0.02) td = 0; }
    const start = acc - td; items.push({ c, i, start, end: start + d }); acc = start + d;
  });
  return { items, end: acc };
}

async function addMedia(p, file, extra = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('No existe el archivo: ' + abs);
  if (!p.media[abs]) { const info = await probe(abs); Object.assign(info, extra); p.media[abs] = info; }
  else Object.assign(p.media[abs], extra);
  return abs;
}

function findClip(p, ref) {
  if (ref == null) throw new Error('Falta el clip (id o posición).');
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) { const c = p.video[+ref]; if (!c) throw new Error('No hay clip de vídeo en la posición ' + ref); return c; }
  if (/^#\d+$/.test(String(ref))) { const c = p.video[+String(ref).slice(1) - 1]; if (!c) throw new Error('No hay clip ' + ref); return c; }
  const c = p.video.find((x) => x.id === ref); if (!c) throw new Error('No hay clip de vídeo con id ' + ref); return c;
}
function findAudio(p, ref) {
  for (let l = 0; l < p.audioLanes.length; l++) { const i = p.audioLanes[l].findIndex((c) => c.id === ref); if (i >= 0) return { c: p.audioLanes[l][i], lane: l, i }; }
  throw new Error('No hay clip de audio con id ' + ref);
}
const findById = (list, ref, what) => { const x = list.find((t) => t.id === ref); if (!x) throw new Error(`No hay ${what} con id ${ref}`); return x; };

function freeLane(p, start, dur) {
  for (let i = 0; i < p.audioLanes.length; i++) if (!p.audioLanes[i].some((c) => start < c.start + (c.out - c.in) && start + dur > c.start)) return i;
  p.audioLanes.push([]); return p.audioLanes.length - 1;
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }
const CLIP_KEYS = ['in', 'out', 'speed', 'volume', 'muted', 'cropX', 'cropY', 'name', 'note'];
const AUDIO_KEYS = ['start', 'in', 'out', 'volume', 'fadeIn', 'fadeOut', 'role', 'ducking', 'muted', 'afx', 'name', 'note'];
const TEXT_KEYS = ['text', 'start', 'end', 'x', 'y', 'size', 'color', 'outline', 'anim', 'font', 'box', 'glow', 'italic', 'bold', 'hidden'];

function mergeFx(old, fx) {
  if (fx === null) return undefined;
  const out = { ...(old || {}), ...fx };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  if (out.look && !C.LOOKS[out.look]) throw new Error(`Look desconocido «${out.look}». Usa: ${Object.keys(C.LOOKS).join(', ')}`);
  const mt = out.motion && (typeof out.motion === 'string' ? out.motion : out.motion.type);
  if (mt && !C.MOTIONS[mt]) throw new Error(`Movimiento desconocido «${mt}». Usa: ${Object.keys(C.MOTIONS).join(', ')}`);
  return Object.keys(out).length ? out : undefined;
}
function normTransition(tr) {
  if (!tr || tr === 'none' || tr.type === 'none') return null;
  const t = typeof tr === 'string' ? { type: tr } : { ...tr };
  t.type = C.TRANSITION_ALIAS[t.type] || t.type;
  if (!C.TRANSITIONS[t.type]) throw new Error(`Transición desconocida «${t.type}». Usa: ${Object.keys(C.TRANSITIONS).join(', ')}`);
  t.dur = Math.max(0.1, Math.min(3, +t.dur || 0.5));
  return t;
}
function checkAfx(afx) {
  const pr = afx && (typeof afx === 'string' ? afx : afx.preset);
  if (pr && !C.AUDIO_FX[pr]) throw new Error(`Efecto de audio desconocido «${pr}». Usa: ${Object.keys(C.AUDIO_FX).join(', ')}`);
  return afx;
}
function makeText(o) {
  const tpl = C.TEXT_TEMPLATES[o.template] || (o.template ? (() => { throw new Error(`Plantilla de texto desconocida «${o.template}». Usa: ${Object.keys(C.TEXT_TEMPLATES).join(', ')}`); })() : C.TEXT_TEMPLATES.simple);
  const start = +o.start || 0; const dur = o.end != null ? +o.end - start : +(o.dur ?? tpl.dur);
  const t = { id: uid(), text: tpl.text, x: tpl.x, y: tpl.y, size: tpl.size, color: tpl.color, outline: tpl.outline, anim: tpl.anim, italic: !!tpl.italic };
  for (const k of ['font', 'box', 'glow']) if (tpl[k] != null) t[k] = tpl[k];
  Object.assign(t, pick(o, TEXT_KEYS)); t.start = start; t.end = start + Math.max(0.2, dur);
  for (const k of ['color', 'outline', 'box']) if (typeof t[k] === 'string') t[k] = t[k].replace('#', '');
  if (t.anim && !C.TEXT_ANIMS[t.anim]) throw new Error(`Animación de texto desconocida «${t.anim}». Usa: ${Object.keys(C.TEXT_ANIMS).join(', ')}`);
  return t;
}
function makeFx(o) {
  const def = C.IMPACTS[o.type]; if (!def) throw new Error(`Efecto desconocido «${o.type}». Usa: ${Object.keys(C.IMPACTS).join(', ')}`);
  return { id: o.id || uid(), type: o.type, start: Math.max(0, +o.start || 0), dur: +(o.dur ?? def.dur), intensity: +(o.intensity ?? def.intensity) };
}

async function resolveSfx(o) {
  if (o.file) return path.resolve(o.file);
  const q = o.query || o.type || o.sfx; if (!q) throw new Error('add_sfx necesita "file" o "query".');
  const hits = sfxlib.search(q, { limit: 12 });
  if (!hits.length) throw new Error(`No encuentro ningún sonido para «${q}» en la biblioteca.`);
  return hits[Math.min(hits.length - 1, +o.pick || 0)].path;
}

const OPS = {
  async set_project(p, o) {
    if (o.name) p.name = o.name;
    if (o.aspect) { const [w, h] = parseAspect(o.aspect); p.settings.width = w; p.settings.height = h; }
    if (o.fit) p.settings.fit = o.fit;
    if (o.fps) p.settings.fps = +o.fps;
    if (o.script != null) p.script = o.script;
    return 'proyecto actualizado';
  },
  async add_clip(p, o) {
    const id = await addMedia(p, o.file); const m = p.media[id];
    const c = { id: uid(), mediaId: id, in: 0, out: m.duration, speed: 1, volume: 1, muted: false, ...pick(o, CLIP_KEYS) };
    if (o.fx) c.fx = mergeFx(null, o.fx);
    if (o.transition) c.transition = normTransition(o.transition);
    const at = o.index != null ? Math.max(0, Math.min(p.video.length, +o.index)) : p.video.length;
    p.video.splice(at, 0, c); return `clip ${c.id} añadido en la posición ${at}`;
  },
  async update_clip(p, o) {
    const c = findClip(p, o.id ?? o.clip);
    Object.assign(c, pick(o, CLIP_KEYS));
    if (o.fx !== undefined) { const f = mergeFx(c.fx, o.fx); if (f) c.fx = f; else delete c.fx; }
    if (o.transition !== undefined) c.transition = normTransition(o.transition);
    if (c.out <= c.in) throw new Error('El clip quedaría vacío (out <= in).');
    return `clip ${c.id} actualizado`;
  },
  async remove_clip(p, o) { const c = findClip(p, o.id ?? o.clip); p.video = p.video.filter((x) => x !== c); return `clip ${c.id} eliminado`; },
  async move_clip(p, o) {
    const c = findClip(p, o.id ?? o.clip); const i = p.video.indexOf(c); p.video.splice(i, 1);
    const to = Math.max(0, Math.min(p.video.length, +o.index)); p.video.splice(to, 0, c); return `clip ${c.id} movido a ${to}`;
  },
  async split_clip(p, o) {
    const t = +o.t; const L = layout(p);
    const it = o.id != null || o.clip != null ? L.items.find((x) => x.c === findClip(p, o.id ?? o.clip)) : L.items.filter((x) => t >= x.start && t < x.end).pop();
    if (!it || t <= it.start + 0.05 || t >= it.end - 0.05) throw new Error('El instante no cae dentro de un clip.');
    const local = it.c.in + (t - it.start) * (it.c.speed || 1);
    const nc = { ...JSON.parse(JSON.stringify(it.c)), id: uid(), in: local, transition: null };
    it.c.out = local; p.video.splice(p.video.indexOf(it.c) + 1, 0, nc);
    return `clip ${it.c.id} dividido en ${t}s → nuevo ${nc.id}`;
  },
  async replace_media(p, o) {
    const c = findClip(p, o.id ?? o.clip); const id = await addMedia(p, o.file); const m = p.media[id];
    const len = c.out - c.in; c.mediaId = id; c.in = o.in ?? 0; c.out = o.out ?? Math.min(m.kind === 'image' ? c.in + len : m.duration, c.in + len);
    delete c.audioOverride; return `clip ${c.id} ahora usa ${path.basename(id)}`;
  },
  async set_transition(p, o) { const c = findClip(p, o.id ?? o.clip); c.transition = normTransition(o.type ? { type: o.type, dur: o.dur } : o.transition); return `transición de ${c.id}: ${c.transition ? c.transition.type : 'corte'}`; },
  async set_fx(p, o) {
    const targets = o.all ? p.video : (o.ids || o.clips || [o.id ?? o.clip]).map((r) => findClip(p, r));
    for (const c of targets) { const f = mergeFx(c.fx, o.fx); if (f) c.fx = f; else delete c.fx; }
    return `efectos aplicados a ${targets.length} clip(s)`;
  },
  async add_audio(p, o) {
    const id = await addMedia(p, o.file, o.role === 'voice' ? { isVoice: true } : o.role === 'music' ? { isMusic: true } : {}); const m = p.media[id];
    const c = { id: uid(), mediaId: id, in: 0, out: m.duration, start: 0, volume: 1, fadeIn: 0, fadeOut: 0, ...pick(o, AUDIO_KEYS) };
    checkAfx(c.afx); if (c.role === 'music' && c.ducking == null) c.ducking = false;
    const lane = o.lane != null ? +o.lane : freeLane(p, c.start, c.out - c.in);
    while (p.audioLanes.length <= lane) p.audioLanes.push([]);
    p.audioLanes[lane].push(c); return `audio ${c.id} añadido en la pista ${lane + 1} a ${c.start}s`;
  },
  async add_sfx(p, o) {
    const file = await resolveSfx(o);
    return OPS.add_audio(p, { file, start: +(o.start ?? o.t ?? 0), volume: o.volume ?? 0.8, role: 'sfx', fadeIn: o.fadeIn, fadeOut: o.fadeOut, afx: o.afx, in: o.in, out: o.out, name: o.name || o.query, lane: o.lane });
  },
  async update_audio(p, o) {
    const { c, lane } = findAudio(p, o.id ?? o.audio); Object.assign(c, pick(o, AUDIO_KEYS)); checkAfx(c.afx);
    if (o.lane != null && +o.lane !== lane) { p.audioLanes[lane] = p.audioLanes[lane].filter((x) => x !== c); while (p.audioLanes.length <= +o.lane) p.audioLanes.push([]); p.audioLanes[+o.lane].push(c); }
    if (o.file) { const id = await addMedia(p, o.file); c.mediaId = id; if (o.out == null) c.out = p.media[id].duration; }
    return `audio ${c.id} actualizado`;
  },
  async remove_audio(p, o) { const { c, lane } = findAudio(p, o.id ?? o.audio); p.audioLanes[lane] = p.audioLanes[lane].filter((x) => x !== c); return `audio ${c.id} eliminado`; },
  async set_role_volume(p, o) {
    let n = 0; for (const c of p.audioLanes.flat()) { const role = c.role || (p.media[c.mediaId] && p.media[c.mediaId].isVoice ? 'voice' : 'sfx'); if (role === o.role) { c.volume = o.factor != null ? (c.volume ?? 1) * +o.factor : +o.volume; n++; } }
    return `volumen de ${n} clip(s) «${o.role}» cambiado`;
  },
  async add_text(p, o) { const t = makeText(o); p.texts.push(t); return `texto ${t.id} añadido (${t.start}–${t.end}s)`; },
  async update_text(p, o) {
    const t = findById(p.texts, o.id, 'texto'); const dur = t.end - t.start;
    Object.assign(t, pick(o, TEXT_KEYS)); if (o.start != null && o.end == null) t.end = t.start + (o.dur ?? dur); else if (o.dur != null) t.end = t.start + +o.dur;
    for (const k of ['color', 'outline', 'box']) if (typeof t[k] === 'string') t[k] = t[k].replace('#', '');
    return `texto ${t.id} actualizado`;
  },
  async remove_text(p, o) { const t = findById(p.texts, o.id, 'texto'); p.texts = p.texts.filter((x) => x !== t); return `texto ${t.id} eliminado`; },
  async add_fx(p, o) { const f = makeFx(o); p.fx.push(f); return `efecto ${f.type} (${f.id}) en ${f.start}s`; },
  async update_fx(p, o) { const f = findById(p.fx, o.id, 'efecto'); Object.assign(f, pick(o, ['type', 'start', 'dur', 'intensity'])); makeFx(f); return `efecto ${f.id} actualizado`; },
  async remove_fx(p, o) { const f = findById(p.fx, o.id, 'efecto'); p.fx = p.fx.filter((x) => x !== f); return `efecto ${f.id} eliminado`; },
  async set_captions(p, o) { p.captions = { items: o.items || (p.captions && p.captions.items) || [], style: { ...((p.captions && p.captions.style) || {}), ...(o.style || {}) }, burn: o.burn !== false }; return `${p.captions.items.length} subtítulos`; },
  async clear(p, o) {
    const w = o.what;
    if (w === 'texts') p.texts = []; else if (w === 'fx') p.fx = []; else if (w === 'captions') p.captions = null;
    else if (w === 'audio') p.audioLanes = [[], []];
    else if (w === 'sfx') p.audioLanes = p.audioLanes.map((l) => l.filter((c) => (c.role || 'sfx') !== 'sfx' || (p.media[c.mediaId] || {}).isVoice));
    else if (w === 'clip_fx') p.video.forEach((c) => delete c.fx);
    else throw new Error('clear: what = texts | fx | captions | audio | sfx | clip_fx');
    return `borrado: ${w}`;
  },
  async shift(p, o) {
    // Desplaza audio, textos y efectos que empiezan en o después de `from` (no mueve los clips de vídeo).
    const from = +o.from || 0, by = +o.by || 0; let n = 0;
    for (const c of p.audioLanes.flat()) if (c.start >= from) { c.start = Math.max(0, c.start + by); n++; }
    for (const t of p.texts) if (t.start >= from) { t.start = Math.max(0, t.start + by); t.end += by; n++; }
    for (const f of p.fx) if (f.start >= from) { f.start = Math.max(0, f.start + by); n++; }
    return `${n} elementos desplazados ${by}s`;
  },
};

async function applyOps(project, ops) {
  const p = normalize(JSON.parse(JSON.stringify(project)));
  const applied = [];
  if (!Array.isArray(ops)) ops = ops && ops.ops ? ops.ops : [ops];
  for (const [i, o] of ops.entries()) {
    const fn = OPS[o && o.op];
    if (!fn) throw new Error(`Operación ${i + 1}: «${o && o.op}» no existe. Disponibles: ${Object.keys(OPS).join(', ')}`);
    try { applied.push(await fn(p, o)); }
    catch (e) { throw new Error(`Operación ${i + 1} (${o.op}): ${e.message}`); }
  }
  return { project: p, applied };
}

// Resumen compacto del proyecto (lo que Claude necesita para editar: ids, tiempos y efectos).
function describe(project) {
  const p = normalize(JSON.parse(JSON.stringify(project)));
  const L = layout(p);
  const name = (id) => (p.media[id] ? p.media[id].name : path.basename(String(id)));
  const round = (n) => Math.round(n * 100) / 100;
  return {
    name: p.name, version: p.version || null, settings: p.settings, duration: round(Math.max(L.end, ...p.audioLanes.flat().map((c) => c.start + (c.out - c.in)), 0)),
    video: L.items.map(({ c, i, start, end }) => ({ i, id: c.id, file: name(c.mediaId), start: round(start), end: round(end), in: round(c.in), out: round(c.out), speed: c.speed || 1, muted: !!c.muted, volume: c.volume ?? 1, transition: c.transition || null, fx: c.fx || null, note: c.note })),
    audio: p.audioLanes.flatMap((lane, l) => lane.map((c) => ({ id: c.id, lane: l, file: name(c.mediaId), path: c.mediaId, role: c.role || (p.media[c.mediaId] && p.media[c.mediaId].isVoice ? 'voice' : 'sfx'), start: round(c.start), end: round(c.start + c.out - c.in), in: round(c.in), out: round(c.out), volume: c.volume ?? 1, fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0, ducking: !!c.ducking, afx: c.afx || null, muted: !!c.muted, name: c.name }))).sort((a, b) => a.start - b.start),
    texts: p.texts.map((t) => ({ ...t })).sort((a, b) => a.start - b.start),
    fx: p.fx.slice().sort((a, b) => a.start - b.start),
    captions: p.captions ? { lines: (p.captions.items || []).length, burn: p.captions.burn !== false, style: p.captions.style } : null,
    script: p.script ? String(p.script).slice(0, 300) : null,
    viralis: p.viralis || null,
  };
}

module.exports = { applyOps, describe, normalize, layout, OPS, addMedia };
