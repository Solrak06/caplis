// Vista previa de los efectos en el editor (CSS + WebAudio), sin renderizar.
// La exportación hace lo mismo con ffmpeg (lib/effects.js); los parámetros vienen de lib/catalog.js.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let RAW = null;
export function setCatalog(raw) { RAW = raw; }

export function effectiveFx(fx) {
  if (!fx || !RAW) return null;
  const base = (RAW.LOOKS[fx.look] || RAW.LOOKS.none).fx;
  const out = { ...base };
  for (const k of Object.keys(RAW.ADJUST)) if (fx[k] != null) {
    if (k === 'contrast' || k === 'saturation') out[k] = (base[k] ?? 1) * fx[k];
    else out[k] = (base[k] ?? 0) + fx[k];
  }
  return out;
}

// Filtro CSS aproximado del look/ajustes de un clip. stageH escala el desenfoque al tamaño del visor.
export function cssFilter(fx, stageH = 500, H = 1920) {
  const e = effectiveFx(fx); if (!e) return '';
  const f = [];
  const b = e.brightness || 0, c = e.contrast ?? 1, s = e.saturation ?? 1;
  if (b) f.push(`brightness(${(1 + b * 1.6).toFixed(3)})`);
  if (c !== 1) f.push(`contrast(${c.toFixed(3)})`);
  if (e.temp > 0) f.push(`sepia(${(e.temp * 0.35).toFixed(3)})`);
  if (e.sepia) f.push(`sepia(${clamp(e.sepia, 0, 1).toFixed(3)})`);
  if (s !== 1) f.push(`saturate(${s.toFixed(3)})`);
  if (e.temp < 0) f.push(`hue-rotate(${(e.temp * -14).toFixed(1)}deg) saturate(${(1 - e.temp * 0.1).toFixed(3)})`);
  if (e.hue) f.push(`hue-rotate(${e.hue}deg)`);
  if (e.blur > 0) f.push(`blur(${(e.blur * 18 * stageH / H).toFixed(2)}px)`);
  return f.join(' ');
}
export function overlayLevels(fx) {
  const e = effectiveFx(fx) || {};
  return { vignette: clamp(e.vignette || 0, 0, 1), grain: clamp(e.grain || 0, 0, 1) };
}

// Movimiento dentro del clip: { scale, ox, oy } (origen de la transformación en 0–1), igual que el zoompan de la exportación.
export function motionTransform(fx, local, dur, fps = 30) {
  const mt = fx && fx.motion; const type = mt && (typeof mt === 'string' ? mt : mt.type);
  if (!type || type === 'none' || !RAW || !RAW.MOTIONS[type]) return null;
  const A = clamp(+((typeof mt === 'object' && mt.amount) ?? RAW.MOTIONS[type].amount ?? 0.15), 0.01, 0.8);
  const p = clamp(local / Math.max(0.01, dur), 0, 1), on = local * fps;
  let z = 1 + A, ox = 0.5, oy = 0.5;
  switch (type) {
    case 'zoomin': z = 1 + A * p; break;
    case 'zoomout': z = 1 + A * (1 - p); break;
    case 'panleft': ox = 1 - p; break;
    case 'panright': ox = p; break;
    case 'panup': oy = 1 - p; break;
    case 'pandown': oy = p; break;
    case 'shake': z = 1.03 + A * 0.08; ox = 0.5 + 0.5 * (0.6 * Math.sin(on * 0.37) + 0.4 * Math.sin(on * 0.91)); oy = 0.5 + 0.5 * (0.6 * Math.cos(on * 0.29) + 0.4 * Math.sin(on * 0.73)); break;
    case 'pulse': z = 1 + A * (0.5 + 0.5 * Math.sin(on * 2 * Math.PI * 1.6 / fps)); break;
    case 'punchin': z = 1 + A * Math.pow(Math.max(0, 1 - on / (0.35 * fps)), 2); break;
  }
  return { scale: z, ox, oy };
}
// Fundido de entrada/salida del clip (a negro): opacidad 0–1.
export function clipFadeOpacity(fx, local, dur) {
  if (!fx) return 1;
  let o = 1;
  if (fx.fadeIn > 0 && local < fx.fadeIn) o = Math.min(o, local / fx.fadeIn);
  if (fx.fadeOut > 0 && dur - local < fx.fadeOut) o = Math.min(o, (dur - local) / fx.fadeOut);
  return clamp(o, 0, 1);
}

// Efectos de impacto activos en t: devuelve { filter, scale, tx, ty, flash, black, vignette, glitch }.
export function impactState(list, t) {
  const st = { filter: [], scale: 1, tx: 0, ty: 0, flash: 0, black: 0, vignette: 0 };
  for (const f of list || []) {
    const def = RAW && RAW.IMPACTS[f.type]; if (!def) continue;
    const a = +f.start || 0, d = Math.max(0.04, +(f.dur ?? def.dur)), b = a + d;
    if (t < a || t > b) continue;
    const I = clamp(+(f.intensity ?? def.intensity), 0, 1), q = (t - a) / d;
    switch (f.type) {
      case 'flash': st.flash = Math.max(st.flash, I * (q < 1 / 3 ? 1 : q < 2 / 3 ? 0.55 : 0.22)); break;
      case 'negro': st.black = Math.max(st.black, I); break;
      case 'bn': st.filter.push(`grayscale(${I})`); break;
      case 'invert': st.filter.push('invert(1)'); break;
      case 'blur': st.filter.push(`blur(${(2 + I * 10).toFixed(1)}px)`); break;
      case 'viñeta': st.vignette = Math.max(st.vignette, 0.5 + I * 0.5); break;
      case 'rgb': case 'glitch': {
        const px = (f.type === 'glitch' ? 6 + I * 26 : 4 + I * 18); // píxeles del vídeo final, como rgbashift
        const j = f.type === 'glitch' ? (Math.sin(t * 97) > 0 ? 1 : -1) : 1;
        st.rgb = Math.max(st.rgb || 0, px) * j;
        if (f.type === 'glitch') { st.tx += Math.sin(t * 131) * I * 1.2; st.filter.push(`contrast(${1 + I * 0.3})`); }
        break;
      }
      case 'punch': st.scale *= 1 + (0.08 + I * 0.3) * Math.pow(1 - q, 2); break;
      case 'shake': {
        st.scale *= 1 + 0.04 + I * 0.06;
        const amp = (0.04 + I * 0.06) / 2 * 100; // % del ancho
        st.tx += clamp(Math.sin(t * 53) * (0.6 + I), -1, 1) * amp; st.ty += clamp(Math.cos(t * 47) * (0.6 + I), -1, 1) * amp;
        break;
      }
    }
  }
  return st;
}

// Transición en curso: estilo del clip entrante (encima) y del saliente (debajo). q = progreso 0–1.
export function transitionStyle(type, q) {
  const inc = { opacity: 1, transform: '', clipPath: '' }, out = { opacity: 1, transform: '', clipPath: '' };
  let overlay = null;
  const pct = (x) => (x * 100).toFixed(1) + '%';
  switch (type) {
    case 'fadeblack': if (q < 0.5) { inc.opacity = 0; out.opacity = 1 - q * 2; } else { out.opacity = 0; inc.opacity = q * 2 - 1; } break;
    case 'fadewhite': inc.opacity = q; overlay = { color: '#fff', opacity: 1 - Math.abs(q - 0.5) * 2 }; break;
    case 'wipeleft': inc.clipPath = `inset(0 0 0 ${pct(1 - q)})`; break;
    case 'wiperight': inc.clipPath = `inset(0 ${pct(1 - q)} 0 0)`; break;
    case 'wipeup': inc.clipPath = `inset(${pct(1 - q)} 0 0 0)`; break;
    case 'wipedown': inc.clipPath = `inset(0 0 ${pct(1 - q)} 0)`; break;
    case 'slideleft': case 'smoothleft': case 'coverleft': inc.transform = `translateX(${pct(1 - q)})`; if (type === 'slideleft') out.transform = `translateX(${pct(-q)})`; break;
    case 'slideright': case 'smoothright': case 'coverright': inc.transform = `translateX(${pct(q - 1)})`; if (type === 'slideright') out.transform = `translateX(${pct(q)})`; break;
    case 'slideup': case 'smoothup': case 'coverup': inc.transform = `translateY(${pct(1 - q)})`; if (type === 'slideup') out.transform = `translateY(${pct(-q)})`; break;
    case 'slidedown': case 'smoothdown': case 'coverdown': inc.transform = `translateY(${pct(q - 1)})`; if (type === 'slidedown') out.transform = `translateY(${pct(q)})`; break;
    case 'revealleft': out.transform = `translateX(${pct(-q)})`; inc.opacity = 1; break;
    case 'revealright': out.transform = `translateX(${pct(q)})`; break;
    case 'circleopen': case 'circlecrop': inc.clipPath = `circle(${pct(q * 0.75)} at 50% 50%)`; break;
    case 'circleclose': out.clipPath = `circle(${pct((1 - q) * 0.75)} at 50% 50%)`; inc.opacity = 1; return { inc: { ...inc, z: 0 }, out: { ...out, z: 2 }, overlay };
    case 'rectcrop': inc.clipPath = `inset(${pct((1 - q) / 2)})`; break;
    case 'vertopen': inc.clipPath = `inset(0 ${pct((1 - q) / 2)})`; break;
    case 'horzopen': inc.clipPath = `inset(${pct((1 - q) / 2)} 0)`; break;
    case 'radial': inc.clipPath = `polygon(50% 50%, 50% 0%, ${q > 0.125 ? '100% 0%,' : ''} ${q > 0.375 ? '100% 100%,' : ''} ${q > 0.625 ? '0% 100%,' : ''} ${q > 0.875 ? '0% 0%,' : ''} ${radialPoint(q)})`; break;
    case 'zoomin': inc.opacity = q; out.transform = `scale(${1 + q * 0.6})`; out.opacity = 1 - q; break;
    case 'squeezeh': out.transform = `scaleX(${1 - q})`; inc.opacity = q; break;
    case 'squeezev': out.transform = `scaleY(${1 - q})`; inc.opacity = q; break;
    case 'diagtl': inc.clipPath = `polygon(0 0, ${pct(q * 2)} 0, 0 ${pct(q * 2)})`; if (q > 0.5) inc.clipPath = `polygon(0 0, 100% 0, 100% ${pct(q * 2 - 1)}, ${pct(q * 2 - 1)} 100%, 0 100%)`; break;
    case 'diagbr': inc.clipPath = `polygon(100% 100%, ${pct(1 - q * 2)} 100%, 100% ${pct(1 - q * 2)})`; if (q > 0.5) inc.clipPath = `polygon(100% 100%, 0 100%, 0 ${pct(2 - q * 2)}, ${pct(2 - q * 2)} 0, 100% 0)`; break;
    case 'pixelize': case 'hblur': case 'distance': inc.opacity = q; inc.filter = `blur(${((1 - Math.abs(q - 0.5) * 2) * 8).toFixed(1)}px)`; break;
    default: inc.opacity = q; // fade, dissolve, fadegrays, fadefast, fadeslow, slices, wind…
  }
  return { inc, out, overlay };
}
function radialPoint(q) {
  const a = q * 2 * Math.PI - Math.PI / 2; const x = 50 + Math.cos(a) * 150, y = 50 + Math.sin(a) * 150;
  return `${clamp(x, -100, 200).toFixed(1)}% ${clamp(y, -100, 200).toFixed(1)}%`;
}

// ---------- Audio (WebAudio) ----------
let actx = null;
const ctx = () => (actx ||= new AudioContext());
function impulse(seconds, decay) {
  const c = ctx(), len = Math.floor(c.sampleRate * seconds), buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return buf;
}
function chainFor(preset) {
  const c = ctx(); const nodes = [];
  const bq = (type, f, q = 0.7, g = 0) => { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = g; nodes.push(n); return n; };
  const gain = (v) => { const n = c.createGain(); n.gain.value = v; nodes.push(n); return n; };
  let wet = null;
  switch (preset) {
    case 'telefono': bq('highpass', 320); bq('lowpass', 3300); break;
    case 'radio': bq('highpass', 500); bq('lowpass', 4200); bq('peaking', 1800, 1, 5); gain(1.2); break;
    case 'bajo_agua': bq('lowpass', 420); gain(1.4); break;
    case 'lejano': bq('lowpass', 1600); wet = { secs: 0.6, decay: 3, mix: 0.25 }; break;
    case 'eco': wet = { delay: 0.22, feedback: 0.35, mix: 0.4 }; break;
    case 'sala': wet = { secs: 0.9, decay: 3, mix: 0.3 }; break;
    case 'catedral': wet = { secs: 3.2, decay: 2, mix: 0.45 }; break;
    case 'graves': bq('lowshelf', 90, 0.7, 8); break;
    case 'brillo': bq('highshelf', 5000, 0.7, 6); break;
    case 'megafono': bq('highpass', 700); bq('lowpass', 3000); bq('peaking', 1500, 2, 8); gain(1.3); break;
    case 'robot': bq('peaking', 1000, 6, 10); bq('highpass', 200); break;
  }
  return { nodes, wet };
}
// Conecta un <audio> a su cadena de efectos (una sola vez por elemento; se rehace si cambia el efecto).
export function routeAudio(el, afx) {
  const preset = afx && (typeof afx === 'string' ? afx : afx.preset) || 'none';
  const pan = afx && typeof afx === 'object' ? +afx.pan || 0 : 0;
  const key = preset + '|' + pan;
  if (preset === 'none' && !pan && !el._src) return; // sin efectos: el elemento suena tal cual
  if (el._afxKey === key) return;
  const c = ctx(); if (c.state === 'suspended') c.resume().catch(() => {});
  if (!el._src) el._src = c.createMediaElementSource(el);
  try { el._src.disconnect(); } catch {}
  for (const n of el._nodes || []) try { n.disconnect(); } catch {}
  const { nodes, wet } = chainFor(preset);
  const all = [...nodes];
  let head = el._src;
  for (const n of nodes) { head.connect(n); head = n; }
  if (pan) { const p = c.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); head.connect(p); head = p; all.push(p); }
  head.connect(c.destination);
  if (wet) {
    const g = c.createGain(); g.gain.value = wet.mix; all.push(g);
    if (wet.delay) {
      const d = c.createDelay(2); d.delayTime.value = wet.delay; const fb = c.createGain(); fb.gain.value = wet.feedback;
      head.connect(d); d.connect(fb); fb.connect(d); d.connect(g); all.push(d, fb);
    } else { const cv = c.createConvolver(); cv.buffer = impulse(wet.secs, wet.decay); head.connect(cv); cv.connect(g); all.push(cv); }
    g.connect(c.destination);
  }
  el._nodes = all; el._afxKey = key;
}
