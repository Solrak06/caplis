// Mini vídeo de presentación: la misma frase con 4 niveles de corrección de voz.
// Uso: node scripts/build-demo.mjs [--no-render]
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ff = require(path.join(ROOT, 'lib', 'ffmpeg.js'));
const enhance = require(path.join(ROOT, 'lib', 'enhance.js'));
const subs = require(path.join(ROOT, 'lib', 'subtitles.js'));
const { buildExport } = require(path.join(ROOT, 'lib', 'export.js'));

const OUT = path.join(ROOT, 'generado', 'demo-voz');
fs.mkdirSync(OUT, { recursive: true });
const SRC = 'C:/Users/lanza/OneDrive/Desktop/Solrak/L01-como-cree-ia-lab/L01-narracion-mi-voz.wav';
const SRT = path.join(ROOT, 'generado', 'L01 - subtitulos.srt');
const SPEECH = 12.6;               // segundos de discurso por sección
const log = (m) => process.stderr.write('· ' + m + '\n');
const uid = () => Math.random().toString(36).slice(2, 10);
const run = (args) => { const r = spawnSync(ff.FFMPEG, ['-hide_banner', '-v', 'error', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(r.stderr.slice(-800)); return r; };
const runErr = (args) => spawnSync(ff.FFMPEG, ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr;

// 1) Discurso base: fragmento real + ruido de grabación casera (zumbido 50 Hz + ventilador)
const clean = path.join(OUT, 'discurso-limpio.wav');
const noisy = path.join(OUT, '1 - Original.wav');
log('Preparando el discurso base…');
run(['-y', '-ss', '0', '-t', String(SPEECH), '-i', SRC, '-ac', '2', '-ar', '48000', clean]);
run(['-y', '-i', clean,
  '-f', 'lavfi', '-t', String(SPEECH), '-i', 'anoisesrc=color=pink:amplitude=0.035:sample_rate=48000',
  '-f', 'lavfi', '-t', String(SPEECH), '-i', 'sine=frequency=50:sample_rate=48000',
  '-f', 'lavfi', '-t', String(SPEECH), '-i', 'sine=frequency=150:sample_rate=48000',
  '-filter_complex', '[1]lowpass=f=2500,volume=0.9[n];[2]volume=0.05[h1];[3]volume=0.02[h2];[0][n][h1][h2]amix=inputs=4:normalize=0:duration=first,aformat=channel_layouts=stereo',
  '-ar', '48000', noisy]);

// 2) Tres niveles de corrección
const levels = [['suave', '2 - Correccion baja'], ['medio', '3 - Correccion media'], ['fuerte', '4 - Correccion alta']];
const versions = [{ key: 'original', file: noisy, title: 'Original', sub: 'Sin procesar · grabación con ruido de fondo' }];
for (const [lvl, name] of levels) {
  log('Mejorando voz: ' + lvl + '…');
  const r = await enhance.enhance(noisy, OUT, { mode: 'local', level: lvl, loudness: -16 });
  const dst = path.join(OUT, name + '.wav');
  fs.copyFileSync(r.path, dst); fs.unlinkSync(r.path);
  versions.push({ key: lvl, file: dst, title: { suave: 'Corrección baja', medio: 'Corrección media', fuerte: 'Corrección alta' }[lvl] });
}

// 3) Medidas reales: ruido de fondo en una pausa (2.9–4.2 s) y sonoridad integrada
function measure(file) {
  const e1 = runErr(['-ss', '2.95', '-t', '1.2', '-i', file, '-af', 'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-']);
  const noise = parseFloat((e1.match(/RMS level dB:\s*(-?[\d.]+|-inf)/) || [])[1]);
  const e2 = runErr(['-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
  const lufs = parseFloat(((e2.split('Summary:')[1] || '').match(/I:\s*(-?[\d.]+)/) || [])[1]);
  return { noise: isFinite(noise) ? noise : -99, lufs };
}
for (const v of versions) {
  v.m = measure(v.file);
  log(`${v.title}: ruido ${v.m.noise.toFixed(1)} dB · ${v.m.lufs.toFixed(1)} LUFS`);
}
const orig = versions[0].m.noise;
versions.forEach((v, i) => {
  if (i === 0) v.sub = `Sin procesar · ruido de fondo ${v.m.noise.toFixed(0)} dB`;
  else v.sub = `Ruido ${v.m.noise.toFixed(0)} dB (−${(orig - v.m.noise).toFixed(0)} dB) · volumen ${v.m.lufs.toFixed(0)} LUFS`;
});

// 4) Fondos animados (un clip por sección, colores distintos)
const W = 1920, H = 1080, FPS = 30, TR = 0.8;
const PAL = {
  intro:    ['0x0b0d12', '0x0f3d3a', '0x123a5a', '0x0b0d12'],
  original: ['0x140c10', '0x3a1622', '0x24121c', '0x0e0a0d'],
  suave:    ['0x0b1220', '0x14385a', '0x0f2238', '0x0a0f18'],
  medio:    ['0x0a1712', '0x145a46', '0x0f3328', '0x091310'],
  fuerte:   ['0x110c1e', '0x3a2a70', '0x1c1640', '0x0c0a14'],
  outro:    ['0x0b0d12', '0x0f3d3a', '0x123a5a', '0x0b0d12'],
};
function bg(name, dur) {
  const f = path.join(OUT, `fondo-${name}.mp4`);
  if (fs.existsSync(f)) return f;
  log('Fondo animado: ' + name);
  const c = PAL[name];
  run(['-y', '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:r=${FPS}:d=${dur}:c0=${c[0]}:c1=${c[1]}:c2=${c[2]}:c3=${c[3]}:nb_colors=4:speed=0.012:type=radial:seed=${name.length * 7}`,
    '-vf', 'noise=alls=4:allf=t,vignette=PI/4.5,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', f]);
  return f;
}
const SEC = SPEECH + 2.4; // duración de cada sección
const seq = [['intro', 4.5], ['original', SEC], ['suave', SEC], ['medio', SEC], ['fuerte', SEC], ['outro', 4.5]];
const bgs = seq.map(([n, d]) => ({ name: n, dur: d, file: bg(n, d) }));

// 5) Proyecto Caplis
const media = {};
const addMedia = async (file, extra = {}) => { const info = await ff.probe(file); Object.assign(info, extra); media[info.path] = info; return info.path; };
const video = [];
for (const [i, b] of bgs.entries()) {
  const id = await addMedia(b.file);
  video.push({ id: uid(), mediaId: id, in: 0, out: b.dur, speed: 1, volume: 1, muted: true, transition: i ? { type: i === bgs.length - 1 ? 'fade' : 'crossfade', dur: TR } : null });
}
// Posiciones (mismo cálculo que el editor y la exportación)
const starts = []; let acc = 0;
bgs.forEach((b, i) => { const td = i ? Math.min(TR, b.dur - 0.05, acc - 0.05) : 0; const s = acc - td; starts.push(s); acc = s + b.dur; });
const total = acc;

// Música suave (pad de acordes generado) con ducking
const music = path.join(OUT, 'musica-pad.wav');
if (!fs.existsSync(music)) {
  log('Música de fondo…');
  const chord = (t0, f) => f.map((x) => `0.06*sin(2*PI*${x}*t)`).join('+');
  run(['-y', '-f', 'lavfi', '-i', `aevalsrc='(${chord(0, [110, 130.81, 164.81, 196])})*(0.75+0.25*sin(2*PI*0.08*t))':s=48000:d=${Math.ceil(total) + 1}`,
    '-af', 'lowpass=f=1800,aecho=0.8:0.85:120|240:0.35|0.25,afade=t=in:d=2,volume=1.4', '-ac', '2', music]);
}
const audioLanes = [[], []];
const musicId = await addMedia(music, { isMusic: true });
audioLanes[1].push({ id: uid(), mediaId: musicId, in: 0, out: total, start: 0, volume: 0.45, fadeIn: 1.5, fadeOut: 2.5, role: 'music', ducking: true });

// Voces: cada versión en su sección, 1.2 s después del inicio
const texts = [];
const T = (o) => texts.push({ id: uid(), x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'fade', size: 64, ...o });
T({ text: 'Mejora de voz', start: 0.3, end: 4.2, y: 0.42, size: 130, anim: 'pop' });
T({ text: 'La misma grabación · 4 niveles de corrección', start: 0.8, end: 4.2, y: 0.58, size: 46, color: 'c9d1e0' });
T({ text: 'CAPLIS', start: 0.3, end: total - 0.3, x: 0.08, y: 0.07, size: 30, color: '5ef0c0', anim: 'fade' });
const srt = fs.existsSync(SRT) ? fs.readFileSync(SRT, 'utf8') : '';
const baseCaps = [];
for (const b of srt.replace(/\r/g, '').split(/\n\n+/)) {
  const tl = b.split('\n').find((l) => l.includes('-->')); if (!tl) continue;
  const [a, z] = tl.split('-->').map((s) => { const m = s.trim().match(/(\d+):(\d+):(\d+),(\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; });
  const text = b.split('\n').slice(b.split('\n').indexOf(tl) + 1).join(' ').trim();
  if (a < SPEECH - 0.3) baseCaps.push({ start: a, end: Math.min(z, SPEECH), text });
}
const captions = [];
for (const [i, v] of versions.entries()) {
  const s = starts[i + 1], vStart = s + 1.2;
  const id = await addMedia(v.file, { isVoice: true });
  audioLanes[0].push({ id: uid(), mediaId: id, in: 0, out: SPEECH, start: vStart, volume: 1, fadeIn: 0.05, fadeOut: 0.2, role: 'voice', enhanced: i ? v.key : undefined });
  T({ text: `${i + 1} / 4`, start: s + 0.4, end: s + SEC - 0.4, x: 0.92, y: 0.07, size: 30, color: '8a92a6' });
  T({ text: v.title, start: s + 0.4, end: s + SEC - 0.5, y: 0.15, size: 92, anim: 'pop', color: i === 0 ? 'ff9a9a' : 'ffffff' });
  T({ text: v.sub, start: s + 0.7, end: s + SEC - 0.5, y: 0.255, size: 38, color: 'b9c2d3', anim: 'slide' });
  for (const c of baseCaps) captions.push({ start: +(vStart + c.start).toFixed(3), end: +(vStart + c.end).toFixed(3), text: c.text });
}
const so = starts[starts.length - 1];
T({ text: 'Hecho con Caplis', start: so + 0.5, end: total - 0.2, y: 0.45, size: 110, anim: 'pop' });
T({ text: 'Edición · voz · subtítulos — todo en tu PC', start: so + 0.9, end: total - 0.2, y: 0.58, size: 44, color: 'c9d1e0' });

const project = {
  name: 'Demo - Mejora de voz',
  settings: { width: W, height: H, fps: FPS, fit: 'contain' },
  media, video, audioLanes, texts,
  captions: { items: captions, style: { size: 50, outlineW: 3, pos: 'abajo', color: 'ffffff', outline: '000000', box: 1 }, burn: true },
};
const projFile = path.join(ROOT, 'proyectos', project.name + '.caplis');
fs.writeFileSync(projFile, JSON.stringify(project, null, 2), 'utf8');
log('Proyecto guardado: ' + projFile);

// 6) Render a MP4
let rendered = null;
if (!process.argv.includes('--no-render')) {
  const outMp4 = path.join(OUT, 'Demo - Mejora de voz.mp4');
  const audio = audioLanes.flat();
  const subsAss = subs.writeAssFile(project.captions.items, project.captions.style, project.settings, OUT);
  const textAss = subs.writeTextsAssFile(texts, project.settings, OUT);
  const { args, duration } = buildExport({ ...project, audio }, outMp4, { quality: 'normal', subsAss, textAss });
  log(`Renderizando ${duration.toFixed(1)} s…`);
  await ff.runWithProgress(args, duration, (p) => process.stderr.write(`\r  render ${Math.round(p * 100)}%   `));
  process.stderr.write('\n');
  rendered = outMp4;
}
console.log(JSON.stringify({ ok: true, project: projFile, rendered, duration: +total.toFixed(2), versions: versions.map((v) => ({ title: v.title, noise: +v.m.noise.toFixed(1), lufs: +v.m.lufs.toFixed(1) })) }, null, 2));
