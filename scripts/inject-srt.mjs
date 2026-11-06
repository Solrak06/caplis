import { fileURLToPath } from 'url';
// Inyecta un .srt ya generado como subtitulos del proyecto (sin re-transcribir).
import fs from 'fs';
import path from 'path';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROJ = path.join(ROOT, 'proyectos', 'L01 - Cómo creé mi laboratorio de IA.caplis');
const SRT = path.join(ROOT, 'generado', 'L01 - subtitulos.srt');

function parseSrt(txt) {
  const blocks = txt.replace(/\r/g, '').split(/\n\n+/).filter(Boolean);
  const t = (s) => { const m = s.match(/(\d+):(\d+):(\d+),(\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };
  const items = [];
  for (const b of blocks) {
    const lines = b.split('\n'); const tl = lines.find((l) => l.includes('-->'));
    if (!tl) continue;
    const [a, c] = tl.split('-->').map((x) => x.trim());
    const text = lines.slice(lines.indexOf(tl) + 1).join('\n').trim();
    if (text) items.push({ start: t(a), end: t(c), text });
  }
  return items;
}

const project = JSON.parse(fs.readFileSync(PROJ, 'utf8'));
const items = parseSrt(fs.readFileSync(SRT, 'utf8'));
const H = (project.settings && project.settings.height) || 1080;
project.captions = { items, style: { size: Math.round(56 * H / 1080), outlineW: Math.max(2, Math.round(H / 360)), pos: 'abajo', color: 'ffffff', outline: '000000', box: 0 }, burn: true };
fs.writeFileSync(PROJ, JSON.stringify(project, null, 2), 'utf8');
console.log(JSON.stringify({ ok: true, lines: items.length }));
