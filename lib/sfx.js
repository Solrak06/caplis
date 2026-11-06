// Búsqueda de efectos de sonido en la biblioteca local (Audio para Videos y carpetas extra), para que Claude pueda
// pedir «un whoosh en 2,3 s» sin conocer la ruta exacta. Índice en caché (generado/sfx-index.json).
const fs = require('fs');
const path = require('path');
const audiolib = require('./audiolib');

const INDEX = path.join(__dirname, '..', 'generado', 'sfx-index.json');
const MAX_AGE = 1000 * 60 * 60 * 24; // 1 día

// Sinónimos español → términos de los nombres de archivo (casi todos en inglés).
const SYN = {
  golpe: ['hit', 'impact', 'punch', 'thud', 'slam'], impacto: ['impact', 'hit', 'boom'], explosion: ['explosion', 'boom', 'blast'],
  silbido: ['whoosh', 'swish', 'swoosh'], barrido: ['whoosh', 'swoosh', 'sweep'], transicion: ['whoosh', 'transition', 'swoosh', 'riser'],
  subida: ['riser', 'rise', 'build'], tension: ['riser', 'drone', 'tension'], campana: ['bell', 'chime', 'ding'], clic: ['click', 'tick', 'ui'],
  pop: ['pop', 'bubble'], grave: ['sub', 'boom', 'bass', '808', 'low'], cristal: ['glass', 'shatter'], puerta: ['door'], pasos: ['footstep', 'steps'],
  latido: ['heartbeat', 'heart'], viento: ['wind'], lluvia: ['rain'], trueno: ['thunder'], fallo: ['glitch', 'error'], glitch: ['glitch', 'digital'],
  brillo: ['shimmer', 'sparkle', 'magic'], magia: ['magic', 'shimmer', 'sparkle'], risa: ['laugh'], aplauso: ['applause', 'clap'], reloj: ['clock', 'tick'],
  ambiente: ['ambience', 'ambient', 'room', 'atmosphere'], terror: ['horror', 'creepy', 'scary', 'drone'], reverso: ['reverse'],
};
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function loadIndex(force = false) {
  try {
    const st = fs.statSync(INDEX);
    if (!force && Date.now() - st.mtimeMs < MAX_AGE) return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {}
  const roots = [...audiolib.DEFAULT_ROOTS];
  const items = [];
  for (const r of roots) for (const f of audiolib.scanDir(r, 8)) items.push({ path: f.path, name: f.name, folder: f.folder, size: f.size, key: norm(path.relative(r, f.path)) });
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  try { fs.writeFileSync(INDEX, JSON.stringify(items), 'utf8'); } catch {}
  return items;
}

function search(query, { limit = 10, kind = null } = {}) {
  const items = loadIndex();
  const words = norm(query).split(/[^a-z0-9]+/).filter(Boolean);
  const terms = new Set(words);
  for (const w of words) for (const s of (SYN[w] || [])) terms.add(s);
  const scored = [];
  for (const it of items) {
    if (kind && !it.key.includes(norm(kind))) continue;
    let score = 0;
    for (const t of terms) {
      if (!t) continue;
      const n = norm(it.name);
      if (n.includes(t)) score += words.includes(t) ? 3 : 2;
      else if (it.key.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ ...it, score: score - Math.min(1, it.size / 4e6) * 0.3 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ key, ...x }) => x);
}

module.exports = { search, loadIndex };
