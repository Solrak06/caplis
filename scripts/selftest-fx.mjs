// Comprobación de lo nuevo (v0.2): efectos → ffmpeg real, operaciones de edición y versiones. Sin ventana.
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FF = process.env.CAPLIS_FFMPEG || 'ffmpeg';

let fail = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : ' FALLA ') + m); if (!c) fail++; };
const fx = require(path.join(root, 'lib', 'effects.js'));
const C = require(path.join(root, 'lib', 'catalog.js'));
const { applyOps, describe } = require(path.join(root, 'lib', 'ops.js'));
const versions = require(path.join(root, 'lib', 'versions.js'));
const { buildExport } = require(path.join(root, 'lib', 'export.js'));

// Cada filtro generado debe ser válido en ffmpeg (fuente sintética, 0,5 s).
const tryVf = (vf, label) => {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=216x384:r=30:d=0.5', '-vf', vf, '-f', 'null', '-'], { encoding: 'utf8' });
  ok(r.status === 0, label); if (r.status !== 0) console.log('        ' + r.stderr.split('\n').slice(-3).join(' '));
};
const ctx = { W: 216, H: 384, fps: 30, dur: 0.5 };
for (const look of Object.keys(C.LOOKS)) if (look !== 'none') tryVf(fx.colorFilters({ look }).join(',') || 'null', `look «${look}» válido en ffmpeg`);
for (const m of Object.keys(C.MOTIONS)) if (m !== 'none') tryVf(fx.motionFilters({ motion: m }, ctx).join(','), `movimiento «${m}» válido en ffmpeg`);
tryVf(fx.impactFilters(Object.keys(C.IMPACTS).map((type, i) => ({ type, start: i * 0.04, dur: 0.1 })), ctx).join(','), 'todos los impactos juntos válidos en ffmpeg');
for (const [k, v] of Object.entries(C.AUDIO_FX)) if (v.ff) {
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', '-af', 'aformat=channel_layouts=stereo,' + fx.audioFxFilters({ preset: k, pan: 0.3 }).join(','), '-f', 'null', '-'], { encoding: 'utf8' });
  ok(r.status === 0, `efecto de audio «${k}» válido en ffmpeg`);
}

// Operaciones de edición + versiones sobre un proyecto temporal (sin archivos de vídeo reales: solo campos).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caplis-test-'));
const file = path.join(dir, 'prueba.caplis');
const base = { name: 'prueba', settings: { width: 1080, height: 1920, fps: 30 }, media: { 'A.mp4': { path: 'A.mp4', kind: 'video', hasAudio: true, duration: 10 } },
  video: [{ id: 'c1', mediaId: 'A.mp4', in: 0, out: 4 }, { id: 'c2', mediaId: 'A.mp4', in: 4, out: 9 }], audioLanes: [[], []] };
fs.writeFileSync(file, JSON.stringify(base));
const { project, applied } = await applyOps(base, [
  { op: 'set_fx', all: true, fx: { look: 'cine' } },
  { op: 'set_transition', id: 1, type: 'fadewhite', dur: 0.4 },
  { op: 'add_fx', type: 'flash', start: 3.8 },
  { op: 'add_text', template: 'impacto', text: 'YA', start: 1, dur: 1 },
  { op: 'split_clip', t: 2 },
]);
ok(applied.length === 5, 'aplica 5 operaciones');
ok(project.video.length === 3 && project.video[0].fx.look === 'cine', 'set_fx + split_clip');
let threw = false; try { await applyOps(base, [{ op: 'set_fx', id: 0, fx: { look: 'inventado' } }]); } catch { threw = true; }
ok(threw, 'rechaza un look desconocido con error claro');
const d = describe(project);
ok(d.texts.length === 1 && d.fx.length === 1 && d.video[2].transition.type === 'fadewhite', 'describe() resume textos, efectos y transiciones');
const e1 = versions.commitPendingFromDisk(file);
const e2 = versions.commit(file, project, { author: 'claude', message: 'prueba' });
const e3 = versions.commit(file, project, { author: 'claude', message: 'sin cambios' });
ok(e1.v === 1 && e2.v === 2 && e3.unchanged, 'versiones: inicial, cambio y «sin cambios»');
const rv = versions.revert(file, 1);
ok(rv.entry.v === 3 && rv.project.video.length === 2, 'restaurar v1 crea la v3 con el contenido de la v1');
const { args } = buildExport({ ...project, audio: [] }, path.join(dir, 'x.mp4'), {});
const fc = args[args.indexOf('-filter_complex') + 1];
ok(fc.includes('xfade=transition=fadewhite') && fc.includes('drawbox') && fc.includes('vignette'), 'la exportación incluye transición, impacto y look');
fs.rmSync(dir, { recursive: true, force: true });

console.log('\n' + (fail ? `FALLOS: ${fail}` : 'TODO OK (efectos, operaciones y versiones)'));
process.exit(fail ? 1 : 0);
