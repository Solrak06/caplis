// Prueba de la mejora de voz: mide ruido en una pausa y sonoridad para cada nivel.
// Uso: node scripts/test-enhance.mjs <audio> [inicioPausa] [durPausa]
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const enhance = require(path.join(root, 'lib', 'enhance.js'));
const { FFMPEG } = require(path.join(root, 'lib', 'ffmpeg.js'));

const src = process.argv[2];
const gapAt = process.argv[3] || '2.95', gapDur = process.argv[4] || '1.2';
const err = (args) => spawnSync(FFMPEG, ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr;
function measure(f) {
  const n = parseFloat((err(['-ss', gapAt, '-t', gapDur, '-i', f, '-af', 'astats=measure_overall=RMS_level:measure_perchannel=none', '-f', 'null', '-']).match(/RMS level dB:\s*(-?[\d.]+|-inf)/) || [])[1]);
  const i = parseFloat(((err(['-i', f, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']).split('Summary:')[1] || '').match(/I:\s*(-?[\d.]+)/) || [])[1]);
  return { ruido: isFinite(n) ? +n.toFixed(1) : -99, lufs: +i.toFixed(1) };
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'caplis-enh-'));
const rows = [{ nivel: 'original', ...measure(src) }];
for (const level of ['suave', 'medio', 'fuerte']) {
  const t0 = Date.now();
  const r = await enhance.enhance(src, out, { mode: 'local', level, loudness: -16 });
  rows.push({ nivel: level, ...measure(r.path), seg: +((Date.now() - t0) / 1000).toFixed(1), file: r.path });
}
console.log(JSON.stringify(rows, null, 1));
