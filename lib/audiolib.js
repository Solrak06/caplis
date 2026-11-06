// Biblioteca de audio: explora "Audio para Videos" y otras carpetas para escuchar y añadir pistas.
const fs = require('fs');
const path = require('path');

const os = require('os');
// Carpetas de sonidos: «Audio para Videos» y la biblioteca real-sfx de Viralis (carpetas = tipo de sonido).
// CAPLIS_AUDIO_ROOTS (separadas por ;) añade otras.
const DESK = path.join(os.homedir(), 'OneDrive', 'Desktop');
const DEFAULT_ROOTS = [
  path.join(DESK, 'Audio para Videos'),
  path.join(DESK, 'Viralis', 'audio'),
  ...String(process.env.CAPLIS_AUDIO_ROOTS || '').split(';').filter(Boolean),
];
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
const SKIP = /(\\|\/)(\.venv|site-packages|\.cache|tests?|eval|node_modules|\.git|__pycache__)(\\|\/|$)/i;
const SKIP_NAME = /egg-info/i;

function scanDir(root, maxDepth = 6) {
  const results = [];
  if (!fs.existsSync(root)) return results;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (SKIP.test(full) || SKIP_NAME.test(e.name)) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
        let size = 0; try { size = fs.statSync(full).size; } catch {}
        if (size < 1024) continue; // descarta ficheros de prueba vacíos
        results.push({ path: full, name: e.name, folder: path.basename(dir), size });
      }
    }
  };
  walk(root, 0);
  return results;
}

function library(extraRoots = []) {
  const roots = [...DEFAULT_ROOTS, ...extraRoots];
  const all = [];
  for (const r of roots) all.push(...scanDir(r));
  // Agrupa por carpeta contenedora para una navegación limpia
  const byFolder = {};
  for (const f of all) { (byFolder[f.folder] ||= []).push(f); }
  const groups = Object.entries(byFolder)
    .map(([name, items]) => ({ name, count: items.length, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.count - a.count);
  return { total: all.length, groups, roots: roots.filter(fs.existsSync) };
}

module.exports = { library, scanDir, DEFAULT_ROOTS };
