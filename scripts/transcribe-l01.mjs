import { fileURLToPath } from 'url';
// Transcribe la narracion completa del L01 y mete los subtitulos en el proyecto .caplis.
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const subs = require(path.join(ROOT, 'lib', 'subtitles.js'));

const PROJ = path.join(ROOT, 'proyectos', 'L01 - Cómo creé mi laboratorio de IA.caplis');
const VOICE = path.join(ROOT, 'generado', 'voz mejorada', 'L01-narracion-mi-voz (voz mejorada local-medio).wav');
const log = (m) => process.stderr.write('· ' + m + '\n');

const project = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
log('Transcribiendo narración completa (modelo small)…');
const res = await subs.transcribe(VOICE, { model: 'small', lang: 'es', onProgress: (p) => process.stderr.write(`\r  ${Math.round(p * 100)}%   `) });
process.stderr.write('\n');
log(`${res.segments.length} líneas, idioma ${res.language}`);

const H = (project.settings && project.settings.height) || 1080;
project.captions = {
  items: res.segments,
  style: { size: Math.round(56 * H / 1080), outlineW: Math.max(2, Math.round(H / 360)), pos: 'abajo', color: 'ffffff', outline: '000000', box: 0 },
  burn: true,
};
fs.writeFileSync(PROJ, JSON.stringify(project, null, 2), 'utf8');
// Guarda tambien un .txt con el texto corrido
const txt = res.segments.map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
fs.writeFileSync(path.join(ROOT, 'generado', 'L01 - transcripcion.txt'), txt, 'utf8');
// Guarda SRT por si lo quiere
fs.writeFileSync(path.join(ROOT, 'generado', 'L01 - subtitulos.srt'), subs.toSrt(res.segments), 'utf8');
log('Proyecto actualizado con subtítulos + guardado .txt y .srt en generado/');
console.log(JSON.stringify({ ok: true, lines: res.segments.length, chars: txt.length }));
