// Construye un proyecto Caplis a partir de una receta (JSON), sin abrir la ventana.
// Lo usa el conector (caplis-connect.mjs) para que Claude Code / Viralis monten vídeos y la app los muestre.
const fs = require('fs');
const path = require('path');
const enhance = require('./enhance');
const tts = require('./tts');
const { parseAspect } = require('./aspect');
const { applyOps, normalize } = require('./ops');

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * spec = {
 *   name, aspect, fps, fit: 'contain'|'cover', look,          // look = look de color para todos los clips
 *   clips:  [ "video.mp4" | {file, in, out, speed, volume, muted, enhance, fx, transition, cropX, note} ],
 *   audio:  [ {file, start, in, out, volume, fadeIn, fadeOut, role, ducking, afx, lane, name} ],
 *   sfx:    [ {start, query | file, volume, pick, afx} ],
 *   narration: [ {text, engine, voice, speed, start, volume, enhance} ],
 *   texts:  [ {template, text, start, end | dur, x, y, size, color, outline, anim, font, box, glow} ],
 *   fx:     [ {type, start, dur, intensity} ],                  // efectos de impacto (flash, shake, punch, glitch…)
 *   captions: {items, style, burn}, script, viralis,
 *   enhanceClips: bool
 * }
 */
async function buildProject(spec, genDir, log = () => {}) {
  const [w, h] = parseAspect(spec.aspect);
  let project = normalize({ name: spec.name || 'Proyecto Caplis', settings: { width: w, height: h, fps: spec.fps || 30, fit: spec.fit || 'contain' }, media: {}, video: [], audioLanes: [[], []], texts: [], fx: [] });
  fs.mkdirSync(genDir, { recursive: true });
  const ops = [];

  for (const item of spec.clips || []) {
    const c = typeof item === 'string' ? { file: item } : item;
    const fx = c.fx || (spec.look ? { look: spec.look } : undefined);
    ops.push({ op: 'add_clip', ...c, fx });
  }
  for (const a of spec.audio || []) ops.push({ op: 'add_audio', ...a });
  for (const s of spec.sfx || []) ops.push({ op: 'add_sfx', ...s, start: s.start ?? s.t });
  for (const t of spec.texts || []) ops.push({ op: 'add_text', ...t });
  for (const f of spec.fx || []) ops.push({ op: 'add_fx', ...f });
  if (spec.captions) ops.push({ op: 'set_captions', ...spec.captions });
  log(`Montando ${ops.length} elementos…`);
  ({ project } = await applyOps(project, ops));

  // Mejora de voz de los clips de vídeo (opcional)
  for (const [i, c] of project.video.entries()) {
    const src = (spec.clips || [])[i]; const want = (src && typeof src === 'object' && src.enhance) || spec.enhanceClips;
    const m = project.media[c.mediaId];
    if (want && m.hasAudio && !c.muted) {
      log('Mejorando voz de ' + m.name);
      const res = await enhance.enhance(c.mediaId, path.join(genDir, 'voz mejorada'), { mode: 'auto', level: 'medio' });
      c.audioOverride = res.path; c.enhanced = true;
    }
  }

  // Narraciones automáticas (texto → voz)
  const narr = [];
  for (const n of spec.narration || []) {
    log('Narrando: "' + (n.text || '').slice(0, 40) + '…"');
    let p = await tts.speak({ engine: n.engine || 'windows', voice: n.voice || '', text: n.text, speed: n.speed || 1 }, path.join(genDir, 'narraciones'));
    if (n.enhance !== false) { const r = await enhance.enhance(p, path.join(genDir, 'narraciones'), { mode: 'local', level: 'suave' }); p = r.path; }
    narr.push({ op: 'add_audio', file: p, start: n.start ?? 0, volume: n.volume ?? 1, role: 'voice' });
  }
  if (narr.length) ({ project } = await applyOps(project, narr));

  if (spec.script) project.script = spec.script;
  if (spec.viralis) project.viralis = spec.viralis;
  return project;
}

module.exports = { buildProject, parseAspect, uid };
