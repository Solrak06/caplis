// Comprobacion sin ventana: carga los modulos, verifica ffmpeg/motores y arma un comando de exportacion de prueba.
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : ' FALLA ') + m); if (!c) fail++; };

// 1) ffmpeg presente
const f = spawnSync(process.env.CAPLIS_FFMPEG || 'ffmpeg', ['-version'], { encoding: 'utf8' });
ok(f.status === 0, 'ffmpeg disponible');
const fp = spawnSync(process.env.CAPLIS_FFPROBE || 'ffprobe', ['-version'], { encoding: 'utf8' });
ok(fp.status === 0, 'ffprobe disponible');

// 2) modulos cargan
const enhance = require(path.join(root, 'lib', 'enhance.js'));
const tts = require(path.join(root, 'lib', 'tts.js'));
const { buildExport, atempoChain } = require(path.join(root, 'lib', 'export.js'));
const subsMod = require(path.join(root, 'lib', 'subtitles.js'));
ok(typeof enhance.enhance === 'function', 'lib/enhance.js carga');
ok(typeof tts.speak === 'function', 'lib/tts.js carga');
ok(typeof buildExport === 'function', 'lib/export.js carga');

// 3) motores de mejora
const av = enhance.available();
console.log('        motores mejora:', JSON.stringify(av));
ok(av.local === true, 'motor local de mejora disponible');

// 4) TTS: motores y voces
const engines = await tts.listEngines();
console.log('        motores TTS:', engines.map((e) => e.id).join(', '));
ok(engines.length >= 1, 'al menos un motor de narracion');
try { const v = await tts.listVoices('windows'); console.log('        voces Windows:', v.length); ok(v.length >= 1, 'voces de Windows disponibles'); } catch (e) { ok(false, 'voces Windows: ' + e.message); }

// 5) atempo para velocidades extremas
ok(atempoChain(4).length === 2 && atempoChain(0.25).length === 2, 'cadena atempo para 4x y 0.25x');

// 6) construir comando de exportacion con un proyecto ficticio
const project = {
  name: 'test', settings: { width: 1920, height: 1080, fps: 30 },
  media: {
    'A.mp4': { path: 'A.mp4', kind: 'video', hasAudio: true, duration: 10 },
    'B.mp4': { path: 'B.mp4', kind: 'video', hasAudio: true, duration: 8 },
    'voz.wav': { path: 'voz.wav', kind: 'audio', hasAudio: true, duration: 6 },
    'img.png': { path: 'img.png', kind: 'image', hasAudio: false, duration: 5 },
  },
  video: [
    { id: '1', mediaId: 'A.mp4', in: 0, out: 5, speed: 1, volume: 1, muted: false },
    { id: '2', mediaId: 'img.png', in: 0, out: 3, speed: 1, volume: 1, muted: true },
    { id: '3', mediaId: 'B.mp4', in: 1, out: 7, speed: 2, volume: 1, muted: false },
  ],
  audio: [
    { id: 'a1', mediaId: 'voz.wav', in: 0, out: 6, start: 1, volume: 1, fadeIn: 0.5, fadeOut: 0.5 },
  ],
};
const { args, duration } = buildExport(project, 'out.mp4', { quality: 'normal' });
ok(args.includes('-filter_complex'), 'exportacion genera filter_complex');
ok(Math.abs(duration - (5 + 3 + 3)) < 0.01, 'duracion total correcta (' + duration.toFixed(2) + 's)');
const fc = args[args.indexOf('-filter_complex') + 1];
ok((fc.match(/concat=n=2:v=1/g) || []).length === 2, 'une 3 clips de video (plegado por pares)');
ok(fc.includes('[v2]') && fc.includes('[vc]'), 'genera las 3 pistas de video y la salida');
ok(fc.includes('amix=inputs=2'), 'mezcla audio del video + pista de voz');
ok(fc.includes('atempo'), 'aplica atempo al clip a 2x');

// 6b) transicion crossfade entre clips
const projT = JSON.parse(JSON.stringify(project));
projT.video[2].transition = { type: 'crossfade', dur: 0.5 };
const rt = buildExport(projT, 'out.mp4', {});
ok(rt.args[rt.args.indexOf('-filter_complex') + 1].includes('xfade'), 'transicion xfade entre clips');
ok(Math.abs(rt.duration - (5 + 3 + 3 - 0.5)) < 0.01, 'duracion con transicion resta el solape');

// 6c) ducking: musica que baja con la voz
const projD = JSON.parse(JSON.stringify(project));
projD.media['musica.mp3'] = { path: 'musica.mp3', kind: 'audio', hasAudio: true, duration: 20 };
projD.audio = [
  { id: 'v', mediaId: 'voz.wav', in: 0, out: 6, start: 1, volume: 1, role: 'voice' },
  { id: 'mu', mediaId: 'musica.mp3', in: 0, out: 11, start: 0, volume: 0.5, role: 'music', ducking: true },
];
const fd = buildExport(projD, 'out.mp4', {}).args;
const fcd = fd[fd.indexOf('-filter_complex') + 1];
ok(fcd.includes('sidechaincompress'), 'ducking con sidechaincompress');
ok(fcd.includes('[mmix][vsc]'), 'la voz controla la musica');

// 6d) reencuadre: rellenar recortando
const projC = JSON.parse(JSON.stringify(project));
projC.settings = { width: 1080, height: 1920, fps: 30, fit: 'cover' };
projC.video[0].cropX = 0.3;
const fcc = buildExport(projC, 'out.mp4', {}).args.find((a) => a.includes('crop='));
ok(!!fcc && fcc.includes('force_original_aspect_ratio=increase') && fcc.includes('*0.3'), 'reencuadre 9:16 recorta con el centro elegido');

// 6e) textos: plantilla con animacion "subir"
const assT = subsMod.toAssTexts([{ text: 'Hola', start: 0, end: 2, x: 0.5, y: 0.8, size: 48, anim: 'slide', italic: true }], { width: 1920, height: 1080 });
ok(assT.includes('\\move(') && assT.includes('\\i1'), 'texto con animacion subir y cursiva');

// 7) validacion de filtro con ffmpeg (lavfi null, sin archivos reales)
const probe = spawnSync(process.env.CAPLIS_FFMPEG || 'ffmpeg', ['-hide_banner', '-f', 'lavfi', '-i', 'anullsrc', '-af', enhance.masterChain('medio').join(','), '-t', '0.1', '-f', 'null', '-'], { encoding: 'utf8' });
ok(probe.status === 0, 'cadena de masterizado valida en ffmpeg');
if (probe.status !== 0) console.log(probe.stderr.split('\n').slice(-5).join('\n'));

console.log('\n' + (fail ? `FALLOS: ${fail}` : 'TODO OK'));
process.exit(fail ? 1 : 0);
