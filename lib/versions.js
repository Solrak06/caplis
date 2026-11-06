// Historial de versiones de un proyecto Caplis.
// Cada proyecto <nombre>.caplis tiene su carpeta proyectos/.versiones/<nombre>/ con v0001.json, v0002.json… e index.json.
// Claude (desde Viralis o Claude Code) y el usuario crean versiones; restaurar una versión crea otra nueva igual a
// aquella, así nunca se pierde nada.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VERSIONS = 200;

function dirFor(projectFile) {
  const base = path.basename(projectFile).replace(/\.caplis$/i, '');
  return path.join(path.dirname(projectFile), '.versiones', base);
}
const pad = (n) => String(n).padStart(4, '0');
// Lo que define el vídeo (sin miniaturas, URLs ni marcas de versión) para comparar versiones.
function canonical(project) {
  const p = JSON.parse(JSON.stringify(project || {}));
  delete p._thumb; delete p.version; delete p.versionInfo;
  for (const m of Object.values(p.media || {})) { delete m.url; delete m.thumb; delete m.wave; }
  return JSON.stringify(p);
}
const hash = (project) => crypto.createHash('sha1').update(canonical(project)).digest('hex').slice(0, 12);

function readIndex(projectFile) {
  try { return JSON.parse(fs.readFileSync(path.join(dirFor(projectFile), 'index.json'), 'utf8')); } catch { return { versions: [] }; }
}
function writeIndex(projectFile, idx) {
  const d = dirFor(projectFile); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');
}

function list(projectFile) {
  return readIndex(projectFile).versions.slice().reverse();
}

function get(projectFile, v) {
  const f = path.join(dirFor(projectFile), `v${pad(v)}.json`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * Guarda una versión nueva si el proyecto cambió respecto a la última.
 * author: 'claude' | 'usuario' | 'viralis'; message: qué cambió.
 * Devuelve la entrada de la versión (o la última si no había cambios).
 */
function commit(projectFile, project, { author = 'usuario', message = '', force = false, source = null } = {}) {
  const idx = readIndex(projectFile);
  const h = hash(project);
  const last = idx.versions[idx.versions.length - 1];
  if (last && last.hash === h && !force) return { ...last, unchanged: true };
  const v = (last ? last.v : 0) + 1;
  const d = dirFor(projectFile); fs.mkdirSync(d, { recursive: true });
  const clean = JSON.parse(JSON.stringify(project)); delete clean._thumb;
  clean.version = v;
  fs.writeFileSync(path.join(d, `v${pad(v)}.json`), JSON.stringify(clean), 'utf8');
  const entry = {
    v, ts: Date.now(), author, message: String(message || '').slice(0, 400), hash: h, source,
    stats: { clips: (project.video || []).length, audio: (project.audioLanes || []).flat().length, texts: (project.texts || []).length, fx: (project.fx || []).length },
  };
  idx.versions.push(entry);
  // Poda: conserva las primeras 5 y las últimas MAX_VERSIONS.
  if (idx.versions.length > MAX_VERSIONS + 5) {
    const drop = idx.versions.splice(5, idx.versions.length - MAX_VERSIONS - 5);
    for (const e of drop) { try { fs.unlinkSync(path.join(d, `v${pad(e.v)}.json`)); } catch {} }
  }
  writeIndex(projectFile, idx);
  return entry;
}

// Restaurar = nueva versión con el contenido de la versión v.
function revert(projectFile, v, { author = 'usuario' } = {}) {
  const old = get(projectFile, v);
  const entry = commit(projectFile, old, { author, message: `Restaurada la versión ${v}`, force: true, source: { revertOf: v } });
  const project = { ...old, version: entry.v };
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2), 'utf8');
  return { entry, project };
}

function latest(projectFile) {
  const idx = readIndex(projectFile); return idx.versions[idx.versions.length - 1] || null;
}

// Si el archivo del proyecto tiene cambios que no están en ninguna versión (ediciones a mano), los guarda primero.
function commitPendingFromDisk(projectFile, author = 'usuario') {
  if (!fs.existsSync(projectFile)) return null;
  let p; try { p = JSON.parse(fs.readFileSync(projectFile, 'utf8')); } catch { return null; }
  const last = latest(projectFile);
  if (last && last.hash === hash(p)) return null;
  return commit(projectFile, p, { author, message: last ? 'Cambios hechos a mano en Caplis' : 'Versión inicial' });
}

// Renombrar el proyecto mueve también su historial.
function rename(oldFile, newFile) {
  const a = dirFor(oldFile), b = dirFor(newFile);
  if (fs.existsSync(a) && !fs.existsSync(b)) { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); }
}

module.exports = { list, get, commit, revert, latest, commitPendingFromDisk, rename, hash, dirFor };
