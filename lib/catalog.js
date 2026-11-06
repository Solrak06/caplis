// Repertorio de Caplis: looks de color, ajustes, movimientos, efectos de impacto, transiciones, efectos de audio y
// plantillas de texto. Lo usan el editor (paneles), la exportación (ffmpeg) y el conector (`catalog`) para que
// Claude Code sepa qué puede usar al montar o retocar un proyecto.

// Looks de color: ajustes base que se suman a los del clip.
const LOOKS = {
  none:      { name: 'Natural', fx: {} },
  cine:      { name: 'Cine', fx: { contrast: 1.12, saturation: 0.9, temp: 0.15, vignette: 0.35 } },
  calido:    { name: 'Cálido', fx: { temp: 0.45, saturation: 1.08, brightness: 0.02 } },
  frio:      { name: 'Frío', fx: { temp: -0.45, saturation: 0.95 } },
  drama:     { name: 'Drama', fx: { contrast: 1.3, saturation: 0.8, brightness: -0.04, vignette: 0.55 } },
  epico:     { name: 'Épico', fx: { contrast: 1.22, saturation: 1.15, temp: 0.2, vignette: 0.4, sharpen: 0.4 } },
  bn:        { name: 'Blanco y negro', fx: { saturation: 0, contrast: 1.15 } },
  noir:      { name: 'Noir', fx: { saturation: 0, contrast: 1.45, brightness: -0.06, vignette: 0.7, grain: 0.35 } },
  vintage:   { name: 'Vintage', fx: { sepia: 0.45, contrast: 0.92, saturation: 0.85, grain: 0.4, vignette: 0.45 } },
  sepia:     { name: 'Sepia', fx: { sepia: 0.9, contrast: 1.05 } },
  vivo:      { name: 'Vivo', fx: { saturation: 1.45, contrast: 1.08 } },
  desvaido:  { name: 'Desvaído', fx: { saturation: 0.6, contrast: 0.85, brightness: 0.05 } },
  terror:    { name: 'Terror', fx: { saturation: 0.35, temp: -0.35, contrast: 1.25, brightness: -0.08, vignette: 0.75, grain: 0.3 } },
  neon:      { name: 'Neón', fx: { saturation: 1.6, contrast: 1.2, hue: 20, temp: -0.2 } },
  sueno:     { name: 'Sueño', fx: { blur: 0.12, brightness: 0.06, saturation: 1.1, temp: 0.2 } },
  vhs:       { name: 'VHS', fx: { saturation: 1.2, contrast: 0.95, grain: 0.6, blur: 0.06, temp: 0.1 } },
};

// Ajustes de un clip (todos opcionales). Rango y valor neutro.
const ADJUST = {
  brightness: { name: 'Brillo', min: -0.5, max: 0.5, def: 0, step: 0.01 },
  contrast:   { name: 'Contraste', min: 0.3, max: 2, def: 1, step: 0.01 },
  saturation: { name: 'Saturación', min: 0, max: 2.5, def: 1, step: 0.01 },
  temp:       { name: 'Temperatura', min: -1, max: 1, def: 0, step: 0.01 },
  hue:        { name: 'Tono', min: -180, max: 180, def: 0, step: 1 },
  sepia:      { name: 'Sepia', min: 0, max: 1, def: 0, step: 0.01 },
  vignette:   { name: 'Viñeta', min: 0, max: 1, def: 0, step: 0.01 },
  blur:       { name: 'Desenfoque', min: 0, max: 1, def: 0, step: 0.01 },
  grain:      { name: 'Grano', min: 0, max: 1, def: 0, step: 0.01 },
  sharpen:    { name: 'Nitidez', min: 0, max: 1, def: 0, step: 0.01 },
};

// Movimiento de cámara dentro del clip (Ken Burns, sacudida…). amount = intensidad (0.02–0.5).
const MOTIONS = {
  none:      { name: 'Sin movimiento' },
  zoomin:    { name: 'Acercar (Ken Burns)', amount: 0.15 },
  zoomout:   { name: 'Alejar', amount: 0.15 },
  panleft:   { name: 'Paneo a la izquierda', amount: 0.12 },
  panright:  { name: 'Paneo a la derecha', amount: 0.12 },
  panup:     { name: 'Paneo arriba', amount: 0.12 },
  pandown:   { name: 'Paneo abajo', amount: 0.12 },
  shake:     { name: 'Cámara en mano', amount: 0.25 },
  pulse:     { name: 'Latido (zoom rítmico)', amount: 0.06 },
  punchin:   { name: 'Golpe de zoom al entrar', amount: 0.2 },
};

// Efectos de impacto en el tiempo (afectan a toda la imagen en [start, start+dur]).
const IMPACTS = {
  flash:   { name: 'Flash blanco', dur: 0.25, intensity: 0.9 },
  negro:   { name: 'Golpe a negro', dur: 0.3, intensity: 1 },
  shake:   { name: 'Sacudida', dur: 0.5, intensity: 0.6 },
  punch:   { name: 'Zoom golpe', dur: 0.4, intensity: 0.5 },
  glitch:  { name: 'Glitch', dur: 0.35, intensity: 0.7 },
  rgb:     { name: 'Separación RGB', dur: 0.5, intensity: 0.5 },
  bn:      { name: 'Blanco y negro', dur: 1.5, intensity: 1 },
  invert:  { name: 'Negativo', dur: 0.15, intensity: 1 },
  blur:    { name: 'Desenfoque', dur: 0.6, intensity: 0.6 },
  viñeta:  { name: 'Túnel (viñeta fuerte)', dur: 1.2, intensity: 0.8 },
};

// Transiciones de entrada de un clip (nombres de xfade de ffmpeg).
const TRANSITIONS = {
  none: 'Corte', fade: 'Fundido encadenado', fadeblack: 'Fundido a negro', fadewhite: 'Fundido a blanco (flash)',
  dissolve: 'Disolver', fadegrays: 'Fundido en grises', fadefast: 'Fundido rápido', fadeslow: 'Fundido lento',
  wipeleft: 'Barrido ←', wiperight: 'Barrido →', wipeup: 'Barrido ↑', wipedown: 'Barrido ↓',
  slideleft: 'Deslizar ←', slideright: 'Deslizar →', slideup: 'Deslizar ↑', slidedown: 'Deslizar ↓',
  smoothleft: 'Empuje suave ←', smoothright: 'Empuje suave →', smoothup: 'Empuje suave ↑', smoothdown: 'Empuje suave ↓',
  coverleft: 'Cubrir ←', coverright: 'Cubrir →', revealleft: 'Revelar ←', revealright: 'Revelar →',
  circleopen: 'Círculo abre', circleclose: 'Círculo cierra', circlecrop: 'Iris', rectcrop: 'Rectángulo',
  vertopen: 'Puertas verticales', horzopen: 'Puertas horizontales', radial: 'Radial (reloj)',
  zoomin: 'Zoom de entrada', pixelize: 'Pixelar', hblur: 'Desenfoque horizontal', distance: 'Distorsión',
  squeezeh: 'Aplastar horizontal', squeezev: 'Aplastar vertical', diagtl: 'Diagonal ↖', diagbr: 'Diagonal ↘',
  hlslice: 'Persiana ←', hrslice: 'Persiana →', hlwind: 'Viento ←', hrwind: 'Viento →',
};
// Compatibilidad con proyectos antiguos.
const TRANSITION_ALIAS = { crossfade: 'fade' };

// Efectos de audio por clip (ffmpeg en la exportación; WebAudio en la vista previa).
const AUDIO_FX = {
  none:      { name: 'Sin efecto', ff: '' },
  telefono:  { name: 'Teléfono', ff: 'highpass=f=320,lowpass=f=3300,acompressor=threshold=0.1:ratio=4' },
  radio:     { name: 'Radio antigua', ff: 'highpass=f=500,lowpass=f=4200,acompressor=threshold=0.08:ratio=6,volume=1.3' },
  bajo_agua: { name: 'Bajo el agua', ff: 'lowpass=f=420,volume=1.4' },
  lejano:    { name: 'Lejano / otra sala', ff: 'lowpass=f=1600,aecho=0.8:0.6:60:0.3,volume=0.9' },
  eco:       { name: 'Eco', ff: 'aecho=0.8:0.7:220|440:0.35|0.2' },
  sala:      { name: 'Reverb sala', ff: 'aecho=0.8:0.85:35|67|113:0.32|0.24|0.16' },
  catedral:  { name: 'Reverb catedral', ff: 'aecho=0.8:0.9:400|780|1200:0.38|0.28|0.18' },
  graves:    { name: 'Más graves', ff: 'bass=g=8:f=90' },
  brillo:    { name: 'Más brillo', ff: 'treble=g=6:f=5000' },
  megafono:  { name: 'Megáfono', ff: 'highpass=f=700,lowpass=f=3000,acrusher=bits=10:mix=0.4,volume=1.4' },
  robot:     { name: 'Robot', ff: 'aphaser=type=t:speed=2:decay=0.6,acrusher=bits=8:mix=0.3' },
};

// Plantillas de texto en pantalla.
const TEXT_TEMPLATES = {
  titulo:    { name: 'Título grande', text: 'Tu título', size: 110, x: 0.5, y: 0.45, color: 'ffffff', outline: '000000', anim: 'pop', dur: 3 },
  lower:     { name: 'Rótulo inferior', text: 'Nombre Apellido', size: 48, x: 0.27, y: 0.85, color: 'ffffff', outline: '000000', anim: 'slide', dur: 4 },
  impacto:   { name: 'Impacto', text: '¡WOW!', size: 150, x: 0.5, y: 0.5, color: 'ffd84a', outline: '000000', anim: 'bounce', dur: 1.5, font: 'Impact' },
  etiqueta:  { name: 'Etiqueta', text: 'ETIQUETA', size: 34, x: 0.14, y: 0.09, color: '5ef0c0', outline: '000000', anim: 'fade', dur: 4 },
  cita:      { name: 'Cita', text: '“Una frase que se recuerde”', size: 64, x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'fade', italic: true, dur: 4, font: 'Georgia' },
  simple:    { name: 'Texto simple', text: 'Texto', size: 64, x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'fade', dur: 3 },
  caja:      { name: 'Caja (fondo)', text: 'Dato clave', size: 58, x: 0.5, y: 0.72, color: '111111', outline: '000000', box: 'ffd84a', anim: 'pop', dur: 3 },
  maquina:   { name: 'Máquina de escribir', text: 'Escribiendo…', size: 60, x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'typewriter', dur: 4, font: 'Consolas' },
  neon:      { name: 'Neón', text: 'NEÓN', size: 120, x: 0.5, y: 0.45, color: 'ffffff', outline: 'ff2fd0', glow: true, anim: 'flicker', dur: 3 },
  contador:  { name: 'Cifra / contador', text: '1.000.000', size: 140, x: 0.5, y: 0.5, color: 'ffffff', outline: '000000', anim: 'zoom', dur: 2.5, font: 'Impact' },
  subtitulo: { name: 'Subtítulo con caja', text: 'Frase del vídeo', size: 52, x: 0.5, y: 0.82, color: 'ffffff', outline: '000000', box: '000000', anim: 'fade', dur: 3 },
  terror:    { name: 'Terror', text: 'NO MIRES', size: 120, x: 0.5, y: 0.5, color: 'e8e2d0', outline: '3a0000', anim: 'shake', dur: 2, font: 'Georgia' },
};
const TEXT_ANIMS = {
  none: 'Sin animación', fade: 'Fundido', pop: 'Pop', bounce: 'Rebote', slide: 'Subir', drop: 'Caer', zoom: 'Zoom desde grande',
  blur: 'Enfocar', typewriter: 'Máquina de escribir', flicker: 'Parpadeo', shake: 'Temblor', wide: 'Expandir letras',
};
const FONTS = ['Arial', 'Arial Black', 'Impact', 'Segoe UI', 'Segoe UI Black', 'Bahnschrift', 'Georgia', 'Times New Roman', 'Consolas', 'Trebuchet MS', 'Verdana', 'Comic Sans MS'];

function catalog() {
  const map = (o, f = (v) => v.name || v) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
  return {
    looks: map(LOOKS),
    adjust: ADJUST,
    motions: map(MOTIONS, (v) => ({ name: v.name, amount: v.amount })),
    impacts: map(IMPACTS, (v) => ({ name: v.name, dur: v.dur, intensity: v.intensity })),
    transitions: TRANSITIONS,
    audioFx: map(AUDIO_FX),
    textTemplates: map(TEXT_TEMPLATES, (v) => ({ name: v.name, anim: v.anim, size: v.size })),
    textAnims: TEXT_ANIMS,
    fonts: FONTS,
    audioRoles: { voice: 'Voz', music: 'Música (ducking opcional)', sfx: 'Efecto', ambience: 'Ambiente' },
  };
}

// Ajustes efectivos de un clip: look + ajustes propios encima.
function effectiveFx(fx) {
  if (!fx) return null;
  const base = (LOOKS[fx.look] || LOOKS.none).fx;
  const out = { ...base };
  for (const k of Object.keys(ADJUST)) if (fx[k] != null) {
    // Los ajustes del clip se combinan con el look (multiplicativos o aditivos según el parámetro).
    if (['contrast', 'saturation'].includes(k)) out[k] = (base[k] ?? 1) * fx[k];
    else out[k] = (base[k] ?? 0) + fx[k];
  }
  return out;
}

module.exports = { LOOKS, ADJUST, MOTIONS, IMPACTS, TRANSITIONS, TRANSITION_ALIAS, AUDIO_FX, TEXT_TEMPLATES, TEXT_ANIMS, FONTS, catalog, effectiveFx };
