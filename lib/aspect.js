// Formatos de proyecto: "16:9", "9:16", "1:1", "4:5", "4k", "1920x1080"…
const ASPECTS = {
  '16:9': [1920, 1080], '1080p': [1920, 1080], '4k': [3840, 2160],
  '9:16': [1080, 1920], 'shorts': [1080, 1920], 'tiktok': [1080, 1920], 'vertical': [1080, 1920],
  '1:1': [1080, 1080], 'cuadrado': [1080, 1080], '4:5': [1080, 1350],
};
function parseAspect(a) {
  if (!a) return [1920, 1080];
  if (ASPECTS[String(a).toLowerCase()]) return ASPECTS[String(a).toLowerCase()];
  const m = String(a).match(/(\d+)\s*[x:]\s*(\d+)/);
  if (m) { const w = +m[1], h = +m[2]; return w > 100 ? [w, h] : [1080, Math.round(1080 * h / w)]; }
  return [1920, 1080];
}
module.exports = { ASPECTS, parseAspect };
