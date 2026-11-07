#!/usr/bin/env node
// Conector Caplis <-> Claude Code / Viralis.
// Claude monta y RETOCA proyectos sin renderizar; la app (abierta) los recarga en vivo y guarda cada cambio como versión.
//
// Uso:
//   node caplis-connect.mjs status
//   node caplis-connect.mjs catalog                                   # repertorio: looks, movimientos, impactos, transiciones, textos, audio
//   node caplis-connect.mjs build <receta.json> [--into <proyecto>] [--msg "..."] [--load] [--play] [--render salida.mp4]
//   node caplis-connect.mjs get <proyecto> [--full]                   # resumen editable (ids, tiempos, efectos)
//   node caplis-connect.mjs edit <proyecto> <ops.json | '[{...}]'> --msg "qué cambia" [--author claude] [--dry] [--no-load] [--seek t]
//   node caplis-connect.mjs lint <proyecto> [--canal nefralis|solrak|mrowl]   # reglas de Viralis sin renderizar (errores/avisos)
//   node caplis-connect.mjs history <proyecto>                        # versiones
//   node caplis-connect.mjs revert <proyecto> <versión>               # vuelve a una versión (crea otra nueva)
//   node caplis-connect.mjs frame <proyecto> <t> <salida.jpg> [--width 540]
//   node caplis-connect.mjs sheet <proyecto> <salida.jpg> [--every 1] [--cols 6] [--width 240]
//   node caplis-connect.mjs render <proyecto> <salida.mp4> [--quality alta|normal|rapida] [--draft] [--range a-b]
//   node caplis-connect.mjs sfx "<búsqueda>" [--limit 10]             # busca efectos de sonido en la biblioteca
//   node caplis-connect.mjs load <proyecto> [--play] [--seek t] [--version v]
//   node caplis-connect.mjs voices [engine] | say "texto" [--voice X] [--engine windows|edge] [--out archivo]
//   node caplis-connect.mjs enhance <audio> [--mode auto|ia-local|local] [--level medio]
//   node caplis-connect.mjs toast "mensaje" | control [--seek 12.5] [--play] [--pause] [--tab ...] [--select video:0]
// <proyecto> = ruta a un .caplis o su nombre (se busca en proyectos/).
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { buildProject } = require(path.join(ROOT, 'lib', 'project.js'));
const { applyOps, describe } = require(path.join(ROOT, 'lib', 'ops.js'));
const versions = require(path.join(ROOT, 'lib', 'versions.js'));
const catalogLib = require(path.join(ROOT, 'lib', 'catalog.js'));
const sfxlib = require(path.join(ROOT, 'lib', 'sfx.js'));
const enhance = require(path.join(ROOT, 'lib', 'enhance.js'));
const tts = require(path.join(ROOT, 'lib', 'tts.js'));
const { buildExport } = require(path.join(ROOT, 'lib', 'export.js'));
const ff = require(path.join(ROOT, 'lib', 'ffmpeg.js'));

const BRIDGE = path.join(ROOT, 'bridge');
const INBOX = path.join(BRIDGE, 'inbox.json');
const STATE = path.join(BRIDGE, 'state.json');
const PROJECTS = path.join(ROOT, 'proyectos');
const GEN = () => { const d = path.join(ROOT, 'generado'); fs.mkdirSync(d, { recursive: true }); return d; };
fs.mkdirSync(BRIDGE, { recursive: true });

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] != null && !String(args[i + 1]).startsWith('--') ? args[i + 1] : true) : d; };
const has = (n) => args.includes('--' + n);
const log = (m) => process.stderr.write('· ' + m + '\n');
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); }
function pushInbox(obj) {
  // Escritura atómica: la app nunca lee un JSON a medias.
  const tmp = INBOX + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ...obj, ts: Date.now() }, null, 2)); fs.renameSync(tmp, INBOX);
}
function appRunning() { try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); return s.running && Date.now() - s.ts < 8000; } catch { return false; } }
const safeName = (s) => String(s || 'Proyecto').replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, ' ').trim() || 'Proyecto';
function resolveProject(p) {
  if (!p) throw new Error('Falta el proyecto (.caplis o nombre).');
  const cands = [p, path.join(PROJECTS, p), path.join(PROJECTS, p + '.caplis'), path.join(PROJECTS, safeName(p) + '.caplis')];
  for (const c of cands) if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
  throw new Error('No encuentro el proyecto: ' + p);
}
function writeProject(file, project) {
  const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8'); fs.renameSync(tmp, file);
}
function parseOps(arg) {
  if (!arg) throw new Error('Faltan las operaciones (archivo .json o JSON en línea).');
  if (arg === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  const s = String(arg).trim();
  if (s.startsWith('[') || s.startsWith('{')) return JSON.parse(s);
  return readJson(path.resolve(s));
}
// Guarda una versión y avisa a la app para que la recargue en vivo.
function commitAndNotify(file, project, { author, message, load = true, seek = null }) {
  versions.commitPendingFromDisk(file);
  const entry = versions.commit(file, project, { author, message });
  project.version = entry.v;
  writeProject(file, project);
  if (load) pushInbox({ action: 'reload', file, project, version: entry.v, message, author, seek });
  return entry;
}

async function renderProject(project, outPath, opts = {}) {
  const audio = []; (project.audioLanes || []).forEach((lane) => lane.forEach((c) => audio.push(c)));
  const flat = { ...project, audio };
  let subsAss = null, textAss = null;
  const subs = require(path.join(ROOT, 'lib', 'subtitles.js'));
  if (project.captions && project.captions.burn && (project.captions.items || []).length) subsAss = subs.writeAssFile(project.captions.items, project.captions.style, project.settings, GEN());
  if ((project.texts || []).length) textAss = subs.writeTextsAssFile(project.texts, project.settings, GEN());
  const { args: a, duration } = buildExport(flat, outPath, { ...opts, subsAss, textAss });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  log((opts.videoOnly ? 'Generando ' : 'Renderizando ') + path.basename(outPath) + ` (${duration.toFixed(1)}s)…`);
  await ff.runWithProgress(a, duration, (p) => process.stderr.write(`\r  ${Math.round(p * 100)}%   `), {});
  process.stderr.write('\n');
  for (const f of [subsAss, textAss]) if (f) try { fs.unlinkSync(f); } catch {}
  return { output: outPath, durationSec: duration };
}

try {
  if (cmd === 'status') {
    let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
    out({ appRunning: appRunning(), state: st, enhanceEngines: enhance.available(), ttsEngines: await tts.listEngines() });

  } else if (cmd === 'catalog') {
    out(catalogLib.catalog());

  } else if (cmd === 'sfx') {
    out({ query: args[1], results: sfxlib.search(args[1] || '', { limit: +(flag('limit', 10)) }) });

  } else if (cmd === 'build') {
    const recipePath = args[1];
    if (!recipePath) throw new Error('Falta la receta JSON.');
    const spec = readJson(recipePath);
    const project = await buildProject(spec, GEN(), log);
    const projFile = flag('into') && flag('into') !== true ? path.resolve(flag('into')) : path.join(PROJECTS, safeName(spec.name) + '.caplis');
    fs.mkdirSync(path.dirname(projFile), { recursive: true });
    const existed = fs.existsSync(projFile);
    const message = flag('msg') || (existed ? 'Proyecto vuelto a montar desde una receta' : 'Proyecto creado desde una receta');
    const load = has('load') || has('play');
    const entry = commitAndNotify(projFile, project, { author: flag('author', 'claude'), message, load: false });
    if (load) pushInbox({ action: 'reload', file: projFile, project, version: entry.v, message, author: flag('author', 'claude'), autoplay: has('play') });
    log((existed ? 'Proyecto actualizado: ' : 'Proyecto creado: ') + projFile + ` (v${entry.v})`);
    let rendered = null;
    if (flag('render')) {
      const outPath = typeof flag('render') === 'string' ? path.resolve(flag('render')) : path.join(GEN(), safeName(spec.name) + '.mp4');
      rendered = await renderProject(project, outPath, { quality: flag('quality', 'normal') });
    }
    out({ ok: true, project: projFile, version: entry.v, updated: existed, durationSec: describe(project).duration, rendered, loadedIntoApp: load, appRunning: appRunning() });

  } else if (cmd === 'get') {
    const file = resolveProject(args[1]);
    const p = readJson(file);
    out({ ok: true, project: file, ...(has('full') ? { data: p } : describe(p)), versions: versions.list(file).slice(0, 5).map(({ v, ts, author, message }) => ({ v, when: new Date(ts).toISOString(), author, message })) });

  } else if (cmd === 'edit') {
    const file = resolveProject(args[1]);
    const ops = parseOps(args[2]);
    const before = readJson(file);
    const { project, applied } = await applyOps(before, ops);
    if (has('dry')) { out({ ok: true, dry: true, applied, preview: describe(project) }); }
    else {
      const message = flag('msg') && flag('msg') !== true ? flag('msg') : applied.join('; ').slice(0, 300);
      const entry = commitAndNotify(file, project, { author: flag('author', 'claude'), message, load: !has('no-load'), seek: flag('seek') != null ? +flag('seek') : null });
      out({ ok: true, project: file, version: entry.v, unchanged: !!entry.unchanged, applied, appRunning: appRunning() });
    }

  } else if (cmd === 'lint') {
    const file = resolveProject(args[1]);
    const { lint } = require(path.join(ROOT, 'lib', 'lint.js'));
    const r = lint(readJson(file), { canal: flag('canal') && flag('canal') !== true ? flag('canal') : null });
    out({ project: file, ...r });
    if (!r.ok) process.exitCode = 2;

  } else if (cmd === 'history') {
    const file = resolveProject(args[1]);
    out({ ok: true, project: file, versions: versions.list(file).map(({ v, ts, author, message, stats, source }) => ({ v, when: new Date(ts).toISOString(), author, message, stats, source })) });

  } else if (cmd === 'revert') {
    const file = resolveProject(args[1]);
    const v = parseInt(String(args[2] || '').replace(/^v/i, ''), 10);
    if (!v) throw new Error('Indica la versión: revert <proyecto> <n>');
    versions.commitPendingFromDisk(file);
    const { entry, project } = versions.revert(file, v, { author: flag('author', 'claude') });
    pushInbox({ action: 'reload', file, project, version: entry.v, message: entry.message, author: entry.author });
    out({ ok: true, project: file, restored: v, version: entry.v });

  } else if (cmd === 'frame') {
    const file = resolveProject(args[1]);
    const t = +args[2]; const outPath = path.resolve(args[3] || path.join(GEN(), 'frame.jpg'));
    const r = await renderProject(readJson(file), outPath, { videoOnly: true, frameAt: t, frameWidth: +(flag('width', 540)) });
    out({ ok: true, ...r, t });

  } else if (cmd === 'sheet') {
    const file = resolveProject(args[1]);
    const outPath = path.resolve(args[2] || path.join(GEN(), 'hoja.jpg'));
    const r = await renderProject(readJson(file), outPath, { videoOnly: true, sheet: { every: +(flag('every', 1)), cols: +(flag('cols', 6)), width: +(flag('width', 240)) } });
    out({ ok: true, ...r });

  } else if (cmd === 'load') {
    const file = resolveProject(args[1]);
    let project = readJson(file);
    if (flag('version')) project = { ...versions.get(file, +flag('version')), _previewOf: +flag('version') };
    pushInbox({ action: 'load', file, project, autoplay: has('play'), seek: flag('seek') != null ? +flag('seek') : null });
    out({ ok: true, loaded: file, appRunning: appRunning() });

  } else if (cmd === 'render') {
    const file = resolveProject(args[1]);
    const outPath = path.resolve(args[2] || path.join(GEN(), 'render.mp4'));
    const range = flag('range') ? String(flag('range')).split('-').map(Number) : null;
    const r = await renderProject(readJson(file), outPath, { quality: has('draft') ? 'rapida' : flag('quality', 'normal'), scale: has('draft') ? 0.5 : 1, range });
    out({ ok: true, ...r });

  } else if (cmd === 'voices') {
    const engine = args[1] || (await tts.listEngines())[0]?.id;
    out({ engine, voices: await tts.listVoices(engine) });

  } else if (cmd === 'say') {
    const text = args[1];
    const p = await tts.speak({ engine: flag('engine', 'windows'), voice: flag('voice', ''), text, speed: +(flag('speed', '1')) }, GEN());
    let finalPath = p;
    if (flag('out')) { finalPath = path.resolve(flag('out')); fs.copyFileSync(p, finalPath); }
    out({ ok: true, file: finalPath });

  } else if (cmd === 'enhance') {
    const res = await enhance.enhance(path.resolve(args[1]), GEN(), { mode: flag('mode', 'auto'), level: flag('level', 'medio') }, (p, l) => log(`${l} ${Math.round(p * 100)}%`));
    out({ ok: true, ...res });

  } else if (cmd === 'control') {
    const o = { action: 'control' };
    if (flag('seek') !== null) o.seek = +flag('seek');
    if (has('play')) o.play = true;
    if (has('pause')) o.pause = true;
    if (flag('tab')) o.tab = flag('tab');
    if (flag('select')) o.select = flag('select');
    if (has('zoom-fit')) o.zoomFit = true;
    if (has('home')) o.home = true;
    if (flag('hover-scrub') !== null) o.hoverScrub = +flag('hover-scrub');
    pushInbox(o);
    out({ ok: true, sent: o, appRunning: appRunning() });

  } else if (cmd === 'shot') {
    const outPath = path.resolve(args[1] || path.join(GEN(), 'caplis.png'));
    try { fs.unlinkSync(outPath); } catch {}
    pushInbox({ action: 'shot', file: outPath });
    const t0 = Date.now(); while (!fs.existsSync(outPath) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 200));
    out({ ok: fs.existsSync(outPath), file: outPath, appRunning: appRunning() });

  } else if (cmd === 'toast') {
    pushInbox({ action: 'toast', message: args[1] || '', link: flag('link') || null });
    out({ ok: true, sent: appRunning() });

  } else {
    process.stderr.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  out({ ok: false, error: e.message });
  process.exit(1);
}
