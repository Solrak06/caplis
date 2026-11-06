// Mejora de voz: dos motores, 100% locales y sin internet.
//  - "local":    cadena ffmpeg (RNNoise si hay modelo + reducción de ruido FFT + expansor + EQ + compresor + de-esser).
//  - "ia-local": DeepFilterNet (engines/deep-filter.exe) + el mismo acabado. Opcional.
// Acabado común: normalización de sonoridad a DOS PASADAS en modo lineal, que no vuelve a subir el ruido
// en las pausas (la normalización dinámica sí lo hacía y anulaba la limpieza).
const fs = require('fs');
const path = require('path');
const { run, runWithProgress, probe, hashName, FFMPEG } = require('./ffmpeg');

const ENGINES_DIR = path.join(__dirname, '..', 'engines');
const RNN_MODEL = 'cb.rnnn';
const DEEPFILTER = path.join(ENGINES_DIR, 'deep-filter.exe');

function available() {
  return {
    local: true,
    rnnoise: fs.existsSync(path.join(ENGINES_DIR, RNN_MODEL)),
    iaLocal: fs.existsSync(DEEPFILTER),
  };
}

// Parámetros por nivel. gate.range es lineal (0.5 = -6 dB, 0.25 = -12 dB, 0.1 = -20 dB).
// air = realce de agudos que compensa lo que la reducción de ruido apaga la voz.
const LEVELS = {
  suave:  { nr: 14, nr2: 0,  gateThr: 0.010, gateRange: 0.40, presence: 2.5, air: 4.5, ratio: 2.0 },
  medio:  { nr: 22, nr2: 8,  gateThr: 0.012, gateRange: 0.20, presence: 3.5, air: 6.5, ratio: 2.5 },
  fuerte: { nr: 32, nr2: 14, gateThr: 0.014, gateRange: 0.10, presence: 4,   air: 8.0, ratio: 3.0 },
};
const PRE_LUFS = -23; // nivel al que se lleva la voz antes de procesar, para que los umbrales sirvan con cualquier grabación

function denoiseChain(level, useRnn) {
  const L = LEVELS[level] || LEVELS.medio;
  const f = [];
  if (useRnn) f.push(`arnndn=m=${RNN_MODEL}:mix=${level === 'suave' ? 0.7 : 1}`);
  f.push(`afftdn=nr=${L.nr}:nf=-40:tn=1`);
  if (L.nr2) f.push(`afftdn=nr=${L.nr2}:nf=-55:tn=1`);
  return f;
}
// Expansor suave: baja el fondo entre frases sin cortar la voz.
function gateChain(level) {
  const L = LEVELS[level] || LEVELS.medio;
  return [`agate=threshold=${L.gateThr}:ratio=3:range=${L.gateRange}:attack=1:release=250:knee=4:detection=peak`];
}
// Tono y dinámica de la voz (sin normalizar).
function voiceChain(level) {
  const L = LEVELS[level] || LEVELS.medio;
  return [
    'highpass=f=80',
    'lowpass=f=15000',
    'equalizer=f=250:t=q:w=1:g=-2',
    `equalizer=f=3200:t=q:w=1.4:g=${L.presence}`,
    `treble=g=${L.air}:f=3500:t=q:w=0.5`,
    `acompressor=threshold=-24dB:ratio=${L.ratio}:attack=10:release=180:makeup=1`,
    'deesser=i=0.2:m=0.5:f=0.5',
  ];
}
// Cadena completa en una pasada (se mantiene para vista previa / pruebas rápidas).
function masterChain(level, { loudness = -16 } = {}) {
  return [...voiceChain(level), `loudnorm=I=${loudness}:TP=-1.5:LRA=11`, 'aresample=48000'];
}

async function extractWav(input, out, { mono = false } = {}) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', input, '-vn', '-ac', mono ? '1' : '2', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
  return out;
}
// Mide la sonoridad (pasada de análisis de loudnorm).
async function loudnessOf(file, target = -16) {
  const { err } = await run(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-']);
  const j = err.slice(err.lastIndexOf('{'), err.lastIndexOf('}') + 1);
  try { return JSON.parse(j); } catch { return null; }
}

/**
 * Mejora el audio de `input` (audio o vídeo). Devuelve { path, mode, level } del WAV resultante.
 * opts: { mode: 'auto'|'local'|'ia-local', level: 'suave'|'medio'|'fuerte', loudness }
 */
async function enhance(input, outDir, opts = {}, onProgress = () => {}) {
  const av = available();
  let mode = opts.mode || 'auto';
  if (mode === 'auto') mode = av.iaLocal ? 'ia-local' : 'local';
  if (mode === 'ia-local' && !av.iaLocal) throw new Error('DeepFilterNet no esta instalado (falta engines/deep-filter.exe).');
  if (mode !== 'local' && mode !== 'ia-local') throw new Error('Motor de mejora desconocido: ' + mode);
  const level = LEVELS[opts.level] ? opts.level : 'medio';
  const target = opts.loudness || -16;
  fs.mkdirSync(outDir, { recursive: true });
  const id = hashName(input, `${mode}-${level}-${target}-v2`);
  const tmp = path.join(outDir, `tmp-${id}`);
  fs.mkdirSync(tmp, { recursive: true });
  const base = path.parse(input).name;
  const out = path.join(outDir, `${base} (voz mejorada ${mode}-${level}).wav`);
  const info = await probe(input);
  if (!info.hasAudio) throw new Error('Este archivo no tiene audio.');
  const dur = info.duration || 1;

  try {
    onProgress(0.02, 'Extrayendo audio');
    let source = path.join(tmp, 'src.wav');
    await extractWav(input, source, { mono: mode === 'ia-local' });

    // Pre-nivelado: lleva la voz a -23 LUFS para que la puerta y la reducción actúen igual en cualquier grabación.
    onProgress(0.08, 'Analizando la grabación');
    const m0 = await loudnessOf(source, PRE_LUFS);
    const inI = m0 && isFinite(+m0.input_i) ? +m0.input_i : PRE_LUFS;
    const preGain = Math.max(-20, Math.min(30, PRE_LUFS - inI));

    let chain;
    if (mode === 'local') {
      chain = [`volume=${preGain.toFixed(2)}dB`, ...denoiseChain(level, av.rnnoise), ...gateChain(level), ...voiceChain(level)];
    } else {
      onProgress(0.12, 'IA local (DeepFilterNet) quitando ruido');
      const dfOut = path.join(tmp, 'df');
      fs.mkdirSync(dfOut, { recursive: true });
      const atten = level === 'suave' ? ['--atten-lim', '12'] : level === 'medio' ? ['--atten-lim', '30'] : [];
      await run(DEEPFILTER, [...atten, '-o', dfOut, source], { cwd: ENGINES_DIR });
      const produced = fs.readdirSync(dfOut).find((f) => f.toLowerCase().endsWith('.wav'));
      if (!produced) throw new Error('DeepFilterNet no genero salida.');
      source = path.join(dfOut, produced);
      chain = [`volume=${preGain.toFixed(2)}dB`, ...gateChain('suave'), ...voiceChain(level)];
    }

    onProgress(0.15, 'Limpiando la voz');
    const processed = path.join(tmp, 'proc.wav');
    await runWithProgress(['-y', '-v', 'error', '-i', source, '-af', chain.join(','), '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', processed],
      dur, (p) => onProgress(0.15 + p * 0.55, 'Limpiando la voz'), { cwd: ENGINES_DIR });

    // Normalización final en dos pasadas (modo lineal: sube/baja todo por igual, sin levantar el ruido).
    onProgress(0.72, 'Ajustando volumen');
    // Ganancia exacta medida + limitador de picos. (loudnorm en "linear" vuelve en silencio al modo dinámico
    // cuando los picos no caben, y ese modo hace una rampa que se come el arranque de la primera palabra.)
    const m = await loudnessOf(processed, target);
    const gain = m && isFinite(+m.input_i) ? Math.max(-30, Math.min(30, target - +m.input_i)) : 0;
    await runWithProgress(['-y', '-v', 'error', '-i', processed, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.84:attack=2:release=60:level=false,aresample=48000`, '-ac', '2', '-c:a', 'pcm_s16le', out],
      dur, (p) => onProgress(0.75 + p * 0.24, 'Ajustando volumen'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  onProgress(1, 'Listo');
  return { path: out, mode, level };
}

module.exports = { enhance, available, masterChain, denoiseChain, gateChain, voiceChain, loudnessOf, LEVELS };
