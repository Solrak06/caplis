// Traduce los efectos del proyecto (looks, ajustes, movimiento, impactos y efectos de audio) a filtros de ffmpeg.
// La vista previa del editor hace lo mismo con CSS/WebAudio: ambos parten de catalog.js.
const { MOTIONS, IMPACTS, AUDIO_FX, effectiveFx } = require('./catalog');

const r = (n) => (Math.round(Number(n) * 10000) / 10000).toString();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Filtros de color/textura de un clip (se aplican tras el encuadre, ya a W×H).
function colorFilters(fx) {
  const e = effectiveFx(fx); if (!e) return [];
  const out = [];
  const b = e.brightness || 0, c = e.contrast ?? 1, s = e.saturation ?? 1;
  if (b || c !== 1 || s !== 1) out.push(`eq=brightness=${r(clamp(b, -1, 1))}:contrast=${r(clamp(c, 0, 3))}:saturation=${r(clamp(s, 0, 3))}`);
  if (e.hue) out.push(`hue=h=${r(e.hue)}`);
  if (e.temp) {
    const t = clamp(e.temp, -1, 1);
    out.push(`colorbalance=rs=${r(0.25 * t)}:rm=${r(0.18 * t)}:gm=${r(0.04 * t)}:bs=${r(-0.25 * t)}:bm=${r(-0.18 * t)}`);
  }
  if (e.sepia) {
    const k = clamp(e.sepia, 0, 1), m = (a, id) => r(id * (1 - k) + a * k);
    out.push(`colorchannelmixer=rr=${m(0.393, 1)}:rg=${m(0.769, 0)}:rb=${m(0.189, 0)}:gr=${m(0.349, 0)}:gg=${m(0.686, 1)}:gb=${m(0.168, 0)}:br=${m(0.272, 0)}:bg=${m(0.534, 0)}:bb=${m(0.131, 1)}`);
  }
  if (e.sharpen > 0) out.push(`unsharp=5:5:${r(clamp(e.sharpen, 0, 1) * 1.6)}`);
  if (e.blur > 0) out.push(`gblur=sigma=${r(clamp(e.blur, 0, 1) * 18)}`);
  if (e.vignette > 0) out.push(`vignette=angle=${r(0.15 + clamp(e.vignette, 0, 1) * 1.05)}`);
  if (e.grain > 0) out.push(`noise=alls=${Math.round(clamp(e.grain, 0, 1) * 38)}:allf=t+u`);
  return out;
}

// Movimiento de cámara dentro del clip con zoompan (on = fotograma del clip; d=1 → un fotograma por fotograma).
function motionFilters(fx, { W, H, fps, dur }) {
  const mt = fx && fx.motion; const type = mt && (typeof mt === 'string' ? mt : mt.type);
  if (!type || type === 'none' || !MOTIONS[type]) return [];
  const A = clamp(+((typeof mt === 'object' && mt.amount) ?? MOTIONS[type].amount ?? 0.15), 0.01, 0.8);
  const N = Math.max(1, Math.round(dur * fps));
  const p = `min(on/${N},1)`;
  const cx = 'iw/2-(iw/zoom/2)', cy = 'ih/2-(ih/zoom/2)';
  let z = `${r(1 + A)}`, x = cx, y = cy, up = true;
  switch (type) {
    case 'zoomin': z = `1+${r(A)}*${p}`; break;
    case 'zoomout': z = `1+${r(A)}*(1-${p})`; break;
    case 'panleft': x = `(iw-iw/zoom)*(1-${p})`; break;
    case 'panright': x = `(iw-iw/zoom)*${p}`; break;
    case 'panup': y = `(ih-ih/zoom)*(1-${p})`; break;
    case 'pandown': y = `(ih-ih/zoom)*${p}`; break;
    case 'shake': z = r(1.03 + A * 0.08); x = `${cx}+(iw-iw/zoom)/2*(0.6*sin(on*0.37)+0.4*sin(on*0.91))`; y = `${cy}+(ih-ih/zoom)/2*(0.6*cos(on*0.29)+0.4*sin(on*0.73))`; up = false; break;
    case 'pulse': z = `1+${r(A)}*(0.5+0.5*sin(on*${r(2 * Math.PI * 1.6 / fps)}))`; break;
    case 'punchin': z = `1+${r(A)}*pow(max(0,1-on/${r(0.35 * fps)}),2)`; break;
  }
  // A doble resolución el zoom lento no «tiembla» (zoompan redondea a píxeles enteros).
  const pre = up ? [`scale=${W * 2}:${H * 2}:flags=bicubic`] : [];
  return [...pre, `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`];
}

function fadeFilters(fx, dur) {
  const out = [];
  if (fx && fx.fadeIn > 0) out.push(`fade=t=in:st=0:d=${r(Math.min(fx.fadeIn, dur))}`);
  if (fx && fx.fadeOut > 0) out.push(`fade=t=out:st=${r(Math.max(0, dur - fx.fadeOut))}:d=${r(Math.min(fx.fadeOut, dur))}`);
  return out;
}

function clipVideoFilters(fx, ctx) {
  if (!fx) return [];
  return [...motionFilters(fx, ctx), ...colorFilters(fx), ...fadeFilters(fx, ctx.dur)];
}

// Efectos de impacto (sobre toda la imagen, en tiempo del montaje). Devuelve una lista de filtros encadenables.
function impactFilters(list, { W, H, fps }) {
  const out = []; const motion = [];
  for (const f of (list || [])) {
    const def = IMPACTS[f.type]; if (!def) continue;
    const a = Math.max(0, +f.start || 0), d = Math.max(0.04, +(f.dur ?? def.dur)), b = a + d;
    const I = clamp(+(f.intensity ?? def.intensity), 0, 1);
    const en = (x, y) => `enable='between(t,${r(x)},${r(y)})'`;
    switch (f.type) {
      case 'flash': {
        const s = d / 3;
        [[1, 0], [0.55, 1], [0.22, 2]].forEach(([k, i]) => out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@${r(I * k)}:t=fill:${en(a + s * i, a + s * (i + 1))}`));
        break;
      }
      case 'negro': {
        const s = Math.min(0.06, d / 4);
        out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@${r(I * 0.5)}:t=fill:${en(a, a + s)}`);
        out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@${r(I)}:t=fill:${en(a + s, b - s)}`);
        out.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@${r(I * 0.5)}:t=fill:${en(b - s, b)}`);
        break;
      }
      case 'glitch': {
        const px = Math.round(6 + I * 26);
        out.push(`rgbashift=rh=${px}:bh=${-px}:gv=${Math.round(px / 3)}:${en(a, b)}`);
        out.push(`noise=alls=${Math.round(20 + I * 40)}:allf=t:${en(a, b)}`);
        break;
      }
      case 'rgb': { const px = Math.round(4 + I * 18); out.push(`rgbashift=rh=${px}:bh=${-px}:${en(a, b)}`); break; }
      case 'bn': out.push(`hue=s=${r(1 - I)}:${en(a, b)}`); break;
      case 'invert': out.push(`negate=${en(a, b)}`); break;
      case 'blur': out.push(`gblur=sigma=${r(4 + I * 24)}:${en(a, b)}`); break;
      case 'viñeta': out.push(`vignette=angle=${r(0.6 + I * 0.9)}:${en(a, b)}`); break;
      case 'shake': case 'punch': motion.push({ type: f.type, a, b, d, I }); break;
    }
  }
  if (motion.length) {
    // Un único zoompan para sacudidas y zoom golpe; t = on/fps.
    const t = `(on/${fps})`;
    const zTerms = [], xTerms = [], yTerms = [];
    for (const m of motion) {
      const inW = `between(${t},${r(m.a)},${r(m.b)})`;
      if (m.type === 'punch') zTerms.push(`${inW}*${r(0.08 + m.I * 0.3)}*pow(1-(${t}-${r(m.a)})/${r(m.d)},2)`);
      else {
        zTerms.push(`${inW}*${r(0.04 + m.I * 0.06)}`);
        xTerms.push(`${inW}*sin(${t}*53)*${r(0.6 + m.I)}`);
        yTerms.push(`${inW}*cos(${t}*47)*${r(0.6 + m.I)}`);
      }
    }
    const z = `1+${zTerms.join('+') || '0'}`;
    const sx = xTerms.length ? `+(iw-iw/zoom)/2*min(1,max(-1,${xTerms.join('+')}))` : '';
    const sy = yTerms.length ? `+(ih-ih/zoom)/2*min(1,max(-1,${yTerms.join('+')}))` : '';
    out.push(`zoompan=z='${z}':x='iw/2-(iw/zoom/2)${sx}':y='ih/2-(ih/zoom/2)${sy}':d=1:s=${W}x${H}:fps=${fps}`);
  }
  return out;
}

// Cadena de efectos de audio de un clip.
function audioFxFilters(afx) {
  if (!afx) return [];
  const out = [];
  const preset = typeof afx === 'string' ? afx : afx.preset;
  if (preset && AUDIO_FX[preset] && AUDIO_FX[preset].ff) out.push(AUDIO_FX[preset].ff);
  const pan = typeof afx === 'object' ? +afx.pan || 0 : 0;
  if (pan) out.push(`stereotools=balance_out=${r(clamp(pan, -1, 1))}`);
  return out;
}

module.exports = { colorFilters, motionFilters, clipVideoFilters, impactFilters, audioFxFilters };
