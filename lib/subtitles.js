// Subtitulos automaticos: transcribe con faster-whisper (local) y genera SRT/ASS para grabar en el video.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { FFMPEG } = require('./ffmpeg');

const PY = process.env.CAPLIS_PYTHON || resolvePython();
const SCRIPT = path.join(__dirname, '..', 'engines', 'transcribe.py');

function resolvePython() {
  for (const c of ['python', 'py', 'python3']) {
    try { const r = spawnSync(c, ['--version'], { encoding: 'utf8' }); if (r.status === 0 || /Python/.test((r.stdout || '') + (r.stderr || ''))) return c; } catch {}
  }
  return 'python';
}

function available() {
  try {
    const r = spawnSync(PY, ['-c', 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("faster_whisper") else 1)']);
    return r.status === 0;
  } catch { return false; }
}

const TIME = (s) => {
  s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000);
  return { h, m, sec, ms };
};
function srtTime(s) { const t = TIME(s); return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}:${String(t.sec).padStart(2, '0')},${String(t.ms).padStart(3, '0')}`; }
function assTime(s) { const t = TIME(s); return `${t.h}:${String(t.m).padStart(2, '0')}:${String(t.sec).padStart(2, '0')}.${String(Math.round(t.ms / 10)).padStart(2, '0')}`; }

function toSrt(items) {
  return items.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

const POS = { abajo: 2, centro: 5, arriba: 8 };
// Genera un archivo .ass con el estilo pedido (fuente, tamaño, color, borde, posición).
function toAss(items, style = {}, settings = {}) {
  const W = settings.width || 1920, H = settings.height || 1080;
  const s = Object.assign({ font: 'Arial', size: Math.round(H * 0.052), color: 'FFFFFF', outline: '000000', outlineW: Math.max(2, Math.round(H / 360)), bold: 1, pos: 'abajo', margin: Math.round(H * 0.06), box: 0 }, style);
  const primary = `&H00${bgr(s.color)}`;
  const outline = `&H00${bgr(s.outline)}`;
  const borderStyle = s.box ? 3 : 1;
  const back = s.box ? '&H90000000' : '&H00000000';
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Cap,${s.font},${s.size},${primary},${outline},${back},${s.bold ? -1 : 0},${borderStyle},${s.outlineW},0,${POS[s.pos] || 2},80,80,${s.margin}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body = items.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${c.text.replace(/\n/g, '\\N')}`).join('\n');
  return header + body + '\n';
}
// #RRGGBB o RRGGBB -> BBGGRR (orden de color de ASS)
function bgr(hex) { hex = String(hex).replace('#', '').padStart(6, '0'); return hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2); }

// Títulos/texto en pantalla: cada elemento con su posición, tamaño, color, fuente, caja y animación.
function toAssTexts(items, settings = {}) {
  const W = settings.width || 1920, H = settings.height || 1080;
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Txt,Arial,${Math.round(H * 0.06)},&H00FFFFFF,&H00000000,&H00000000,-1,1,3,0,5,40,40,40
Style: Box,Arial,${Math.round(H * 0.06)},&H00FFFFFF,&H00000000,&H00000000,-1,3,3,0,5,40,40,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  const esc = (s) => String(s ?? '').replace(/\n/g, '\\N').replace(/[{}]/g, '');
  (items || []).forEach((t) => {
    if (t.hidden) return;
    const size = Math.round((t.size || 72) * H / 1080);
    const x = Math.round((t.x != null ? t.x : 0.5) * W);
    const y = Math.round((t.y != null ? t.y : 0.5) * H);
    const dur = Math.max(0.1, (t.end ?? t.start + 3) - t.start);
    const ms = Math.round(dur * 1000);
    const font = t.font ? `\\fn${t.font}` : '';
    const col = `\\c&H${bgr(t.color || 'FFFFFF')}&`;
    const box = t.box && t.box !== 'none';
    const out = `\\3c&H${bgr(box ? t.box : (t.outline || '000000'))}&`;
    const bord = box ? `\\bord${Math.max(6, Math.round(size * 0.22))}` : `\\bord${Math.max(2, Math.round(size * 0.05))}`;
    const bold = t.bold === false || t.italic ? '\\b0' : '\\b1';
    const ital = t.italic ? '\\i1' : '';
    const style = box ? 'Box' : 'Txt';
    let anim = '', place = `\\pos(${x},${y})`;
    switch (t.anim) {
      case 'fade': anim = '\\fad(300,300)'; break;
      case 'pop': anim = '\\fad(150,150)\\fscx60\\fscy60\\t(0,180,\\fscx100\\fscy100)'; break;
      case 'bounce': anim = '\\fad(80,150)\\fscx30\\fscy30\\t(0,150,\\fscx120\\fscy120)\\t(150,260,\\fscx94\\fscy94)\\t(260,340,\\fscx100\\fscy100)'; break;
      case 'slide': anim = '\\fad(250,250)'; place = `\\move(${x},${y + Math.round(H * 0.04)},${x},${y},0,350)`; break;
      case 'drop': anim = '\\fad(120,250)'; place = `\\move(${x},${y - Math.round(H * 0.12)},${x},${y},0,280)`; break;
      case 'zoom': anim = '\\fad(0,200)\\fscx190\\fscy190\\t(0,320,0.6,\\fscx100\\fscy100)'; break;
      case 'blur': anim = '\\fad(150,250)\\blur18\\t(0,420,\\blur0)'; break;
      case 'flicker': anim = '\\fad(0,200)\\alpha&HFF&\\t(0,40,\\alpha&H00&)\\t(80,120,\\alpha&HC0&)\\t(160,200,\\alpha&H00&)\\t(320,360,\\alpha&H90&)\\t(380,420,\\alpha&H00&)'; break;
      case 'wide': anim = `\\fad(250,250)\\fsp0\\t(0,${ms},\\fsp${Math.round(size * 0.18)})`; break;
      default: break;
    }
    const ov = (extra = '', pl = place) => `{\\an5${pl}\\fs${size}${font}${col}${out}${bord}${bold}${ital}${extra}}`;
    const text = esc(t.text);
    const line = (layer, a, b, tags, txt) => lines.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${tags}${txt}`);
    if (t.glow) line(0, t.start, t.end, ov(`\\blur${Math.round(size * 0.18)}\\bord${Math.round(size * 0.12)}${anim}`), text);
    if (t.anim === 'typewriter') {
      // Cada letra aparece una tras otra; el resto ocupa su sitio invisible para que el texto no se mueva.
      const chars = [...String(t.text ?? '')];
      const step = Math.min(0.07, (dur * 0.6) / Math.max(1, chars.length));
      for (let i = 1; i <= chars.length; i++) {
        const a = t.start + (i - 1) * step, b = i === chars.length ? t.end : t.start + i * step;
        line(1, a, b, ov(), esc(chars.slice(0, i).join('')) + `{\\alpha&HFF&}` + esc(chars.slice(i).join('')));
      }
    } else if (t.anim === 'shake') {
      const step = 0.07, n = Math.min(160, Math.ceil(dur / step)), amp = Math.max(2, Math.round(size * 0.045));
      for (let i = 0; i < n; i++) {
        const a = t.start + i * step, b = Math.min(t.end, a + step);
        const dx = Math.round(Math.sin(i * 2.3) * amp), dy = Math.round(Math.cos(i * 1.7) * amp);
        line(1, a, b, ov('', `\\pos(${x + dx},${y + dy})`), text);
      }
    } else {
      line(1, t.start, t.end, ov(anim), text);
    }
  });
  return header + lines.join('\n') + '\n';
}
function writeTextsAssFile(items, settings, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'texts-' + Date.now() + '.ass');
  fs.writeFileSync(f, toAssTexts(items, settings), 'utf8');
  return f;
}

/** Transcribe un archivo. Devuelve { language, duration, segments:[{start,end,text}] }. */
function transcribe(file, { model = 'small', lang = 'auto', onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error('faster-whisper no está instalado. Ejecuta: pip install faster-whisper'));
    const out = path.join(require('os').tmpdir(), 'caplis-sub-' + Date.now() + '.json');
    const p = spawn(PY, ['-I', SCRIPT, '--input', file, '--model', model, '--lang', lang, '--output', out], { windowsHide: true, env: { ...process.env, CAPLIS_FFMPEG: FFMPEG } });
    let err = '';
    p.stderr.on('data', (d) => {
      const s = d.toString(); err += s;
      for (const line of s.split(/\r?\n/)) { const m = line.match(/^PROGRESS ([\d.]+)/); if (m) onProgress(parseFloat(m[1])); }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('Transcripción falló: ' + err.split('\n').filter(Boolean).slice(-3).join(' ')));
      try { const j = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); resolve(j); }
      catch (e) { reject(e); }
    });
  });
}

function writeAssFile(items, style, settings, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'subs-' + Date.now() + '.ass');
  fs.writeFileSync(f, toAss(items, style, settings), 'utf8');
  return f;
}

module.exports = { transcribe, available, toSrt, toAss, writeAssFile, srtTime, toAssTexts, writeTextsAssFile };
