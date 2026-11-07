// Comprobación de un proyecto SIN renderizar: legibilidad, zona segura, ritmo, gancho, sonido y estilo.
// Reglas de Viralis (canales/_estetica.md y canales/_caplis.md). Devuelve { ok, errores, avisos, metricas }.
// errores = hay que corregir antes de dar el vídeo por bueno; avisos = revisar.
const path = require('path');
const { describe, normalize } = require('./ops');
const C = require('./catalog');

const CHANNEL_RULES = {
  // Lo que cada canal NO quiere (fichas de canal).
  mrowl: { bannedImpacts: ['glitch', 'rgb', 'flash'], bannedAnims: ['bounce'], bannedTransitions: ['pixelize', 'radial', 'circleopen', 'circleclose', 'squeezeh', 'squeezev'] },
  nefralis: { bannedImpacts: [], bannedAnims: ['bounce', 'typewriter', 'shake'], bannedTransitions: ['pixelize', 'radial', 'circleopen', 'circleclose', 'squeezeh', 'squeezev', 'hlwind', 'hrwind'] },
  solrak: { bannedImpacts: [], bannedAnims: ['typewriter'], bannedTransitions: ['radial', 'squeezeh', 'squeezev'] },
};
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const r2 = (n) => Math.round(n * 100) / 100;

function lint(project, { canal = null } = {}) {
  const p = normalize(JSON.parse(JSON.stringify(project)));
  const d = describe(p);
  const H = p.settings.height || 1920;
  const errores = [], avisos = [];
  const E = (m) => errores.push(m), A = (m) => avisos.push(m);
  const ch = String(canal || (p.viralis && p.viralis.canal) || '').toLowerCase().replace(/\s+/g, '');
  const rules = CHANNEL_RULES[ch] || null;
  const vertical = H > p.settings.width;

  // ── Planos y ritmo (la contraportada, si existe, no cuenta)
  const isOutro = (v) => /contraportada/i.test(v.file || '') || /contraportada/i.test(v.note || '');
  const shots = d.video.filter((v) => !isOutro(v));
  if (!shots.length) E('No hay planos de vídeo.');
  const lens = shots.map((v) => v.end - v.start);
  const media = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  shots.forEach((v, i) => {
    const len = v.end - v.start;
    if (len > 3.5) E(`Plano ${i} (${v.file}, ${r2(v.start)}–${r2(v.end)} s) dura ${r2(len)} s: > 3,5 s. Divídelo o acórtalo.`);
    else if (len > 2.5) A(`Plano ${i} dura ${r2(len)} s (lo normal es 1–2,2 s).`);
    if (len < 0.25) A(`Plano ${i} dura solo ${r2(len)} s: ¿es intencionado?`);
    const m = p.media[p.video[v.i].mediaId] || {};
    const mt = v.fx && v.fx.motion && (v.fx.motion.type || v.fx.motion);
    if (m.kind === 'image' && (!mt || mt === 'none')) E(`Plano ${i} es una imagen quieta (${v.file}): ponle movimiento (fx.motion).`);
  });
  if (media > 2.4) A(`Duración media de plano ${r2(media)} s (objetivo ≤ 2,2 s).`);
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1].fx && shots[i - 1].fx.motion, b = shots[i].fx && shots[i].fx.motion;
    const ta = a && (a.type || a), tb = b && (b.type || b);
    if (ta && ta === tb && /^pan/.test(ta)) A(`Planos ${i - 1} y ${i} repiten el mismo paneo (${ta}): alterna la dirección.`);
  }

  // ── Gancho (0–2 s)
  const t0Text = d.texts.find((t) => t.start <= 0.1);
  const firstIsImage = shots[0] && (p.media[p.video[shots[0].i].mediaId] || {}).kind === 'image';
  if (!t0Text) (firstIsImage ? E : A)('Gancho: no hay texto de Caplis desde el fotograma 0' + (firstIsImage ? '.' : ' (si el titular ya va grabado en el vídeo, ignóralo).'));
  else {
    if (t0Text.anim === 'typewriter') E('Gancho: el titular del fotograma 0 no puede ser máquina de escribir (se lee entero desde el 0).');
    if (t0Text.size * H / 1080 < 100 * H / 1920) A(`Gancho: titular de ${Math.round(t0Text.size * H / 1080)} px; mejor ≥ 100 px reales.`);
  }
  const first = shots[0];
  const fm = first && first.fx && first.fx.motion && (first.fx.motion.type || first.fx.motion);
  if (first && firstIsImage && (!fm || fm === 'none')) E('Gancho: el primer plano (imagen) no tiene movimiento visible desde el fotograma 0.');
  else if (first && ['zoomin', 'zoomout', 'punchin', 'pulse'].includes(fm)) {
    const amt = (first.fx.motion.amount ?? (C.MOTIONS[fm] || {}).amount ?? 0.15);
    const len = first.end - first.start;
    if (['zoomin', 'zoomout'].includes(fm) && amt * Math.min(1, 2 / len) < 0.1) A(`Gancho: el zoom del primer plano es suave (${Math.round(amt * Math.min(1, 2 / len) * 100)} % en 2 s; objetivo ≥ 10 %).`);
  }
  const hit0 = d.audio.some((a) => a.role !== 'music' && a.start <= 0.3 && !a.muted) || d.fx.some((f) => f.start <= 0.3);
  if (!hit0) A('Gancho: no hay golpe (SFX o impacto) en los primeros 0,3 s.');

  // ── Textos: legibilidad, zona segura, tamaño, fuentes y animaciones
  const fonts = new Set();
  d.texts.forEach((t) => {
    const w = words(t.text), dur = t.end - t.start, need = 0.6 + 0.32 * w;
    const label = `«${String(t.text).slice(0, 30)}» (${r2(t.start)} s)`;
    if (dur + 0.001 < need) E(`Texto ${label} dura ${r2(dur)} s; necesita ≥ ${r2(need)} s para leerse (${w} palabras).`);
    if (w > 8) A(`Texto ${label} tiene ${w} palabras (máximo 8 por pantalla).`);
    if (String(t.text).split('\n').length > 2) A(`Texto ${label} tiene más de 2 líneas.`);
    const px = (t.size || 64) * H / 1080;
    if (px < 56 * H / 1920) E(`Texto ${label} mide ${Math.round(px)} px: mínimo 56 px reales.`);
    if (vertical) {
      const y = (t.y ?? 0.5) * H;
      if (y - px / 2 < 200 || y + px / 2 > 1560) E(`Texto ${label} se sale de la zona segura (y = 200–1560 px): está en ${Math.round(y)} px.`);
    }
    fonts.add(t.font || 'Arial');
    if (t.anim && !C.TEXT_ANIMS[t.anim]) E(`Texto ${label}: animación desconocida «${t.anim}».`);
    if (rules && rules.bannedAnims.includes(t.anim)) E(`Texto ${label}: la animación «${t.anim}» no encaja con el canal ${ch}.`);
  });
  if (fonts.size > 2) E(`Hay ${fonts.size} tipografías (${[...fonts].join(', ')}): máximo 2 por vídeo.`);
  // Textos que se pisan en el tiempo y en la misma zona
  const T = d.texts;
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
    const a = T[i], b = T[j];
    if (a.start < b.end && b.start < a.end && Math.abs((a.y ?? 0.5) - (b.y ?? 0.5)) < 0.06 && Math.abs((a.x ?? 0.5) - (b.x ?? 0.5)) < 0.3) E(`Los textos «${String(a.text).slice(0, 20)}» y «${String(b.text).slice(0, 20)}» se superponen.`);
  }

  // ── Transiciones e impactos
  const trs = d.video.filter((v) => v.transition && v.transition.type);
  const soft = trs.filter((v) => ['fade', 'dissolve'].includes(v.transition.type)).length;
  if (trs.length > Math.max(3, shots.length / 3)) A(`${trs.length} transiciones: el corte en el golpe es la norma; resérvalas para 2–3 momentos.`);
  if (soft > 1) A(`${soft} fundidos encadenados/disolver: prohibido como transición por defecto.`);
  if (rules) trs.forEach((v) => { if (rules.bannedTransitions.includes(v.transition.type)) E(`Transición «${v.transition.type}» (plano ${v.i}) no encaja con el canal ${ch}.`); });
  if (rules) d.fx.forEach((f) => { if (rules.bannedImpacts.includes(f.type)) E(`Impacto «${f.type}» en ${r2(f.start)} s no encaja con el canal ${ch}.`); });
  const fxs = d.fx.slice().sort((a, b) => a.start - b.start);
  for (let i = 2; i < fxs.length; i++) if (fxs[i].start - fxs[i - 2].start < 1) A(`Tres impactos en menos de 1 s (${r2(fxs[i - 2].start)} s): satura.`);
  const total = d.duration || 0;
  if (fxs.length > Math.max(3, total / 2.5)) A(`${fxs.length} impactos en ${r2(total)} s: demasiados (≈ 1 cada 3 s como mucho).`);

  // ── Color: un tratamiento por vídeo
  const looks = new Set(shots.map((v) => (v.fx && v.fx.look) || 'none'));
  if (looks.size > 2) A(`${looks.size} looks distintos (${[...looks].join(', ')}): un tratamiento de color por vídeo.`);

  // ── Sonido
  const isMusic = (a) => a.role === 'music' || (a.role === 'sfx' && /m[uú]sica|music|mezcla/i.test(a.file || ''));
  const music = d.audio.filter((a) => isMusic(a) && !a.muted);
  if (!music.length) E(d.audio.some((a) => isMusic(a)) ? 'La música está silenciada (muted).' : 'No hay música (pista con papel «music»).');
  const covered = []; d.audio.filter((a) => !a.muted).forEach((a) => covered.push([a.start, a.end]));
  d.video.filter((v) => !v.muted).forEach((v) => covered.push([v.start, v.end]));
  covered.sort((a, b) => a[0] - b[0]);
  let cur = 0;
  for (const [a, b] of covered) { if (a - cur > 1.5) E(`Hueco sin audio de ${r2(a - cur)} s (${r2(cur)}–${r2(a)} s).`); cur = Math.max(cur, b); }
  if (total - cur > 1.5) E(`El final (${r2(cur)}–${r2(total)} s) se queda sin audio.`);
  const sfx = d.audio.filter((a) => a.role === 'sfx' && !isMusic(a));
  const cutsWithSfx = shots.filter((v) => sfx.some((s) => Math.abs(s.start - v.start) < 0.08)).length;
  if (shots.length > 6 && cutsWithSfx / shots.length > 0.7) A('Casi todos los cortes llevan efecto de sonido: whoosh solo en las transiciones grandes.');
  d.audio.forEach((a) => { if (a.volume > 1.6) A(`Audio «${a.file}» con volumen ${a.volume}: riesgo de saturar.`); });

  // ── Duración
  if (total > 62) A(`Dura ${r2(total)} s: más de 60 s ya no es un Short.`);
  if (total < 8) A(`Dura solo ${r2(total)} s.`);

  const metricas = { duracion: r2(total), planos: shots.length, plano_medio: r2(media), textos: d.texts.length, impactos: d.fx.length, transiciones: trs.length, sfx: sfx.length, tipografias: [...fonts], looks: [...looks], canal: ch || null };
  return { ok: errores.length === 0, errores, avisos, metricas };
}

module.exports = { lint, CHANNEL_RULES };
