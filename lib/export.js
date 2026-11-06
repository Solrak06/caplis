// Construye el comando ffmpeg que renderiza el proyecto a MP4.
// Pista principal de video = clips seguidos (magnetica). Pistas de audio = clips libres con posicion.

const r = (n) => Number(n).toFixed(4).replace(/\.?0+$/, '') || '0';
const fxlib = require('./effects');
const { TRANSITION_ALIAS } = require('./catalog');

function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push(2); s /= 2; }
  while (s < 0.5) { parts.push(0.5); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) parts.push(s);
  return parts.map((p) => `atempo=${r(p)}`);
}

function clipDuration(c) {
  return (c.out - c.in) / (c.speed || 1);
}

function projectDuration(project) {
  return project.video.reduce((t, c) => t + clipDuration(c), 0);
}

const PRESETS = {
  alta: { crf: 18, preset: 'slow', abr: '256k' },
  normal: { crf: 21, preset: 'medium', abr: '192k' },
  rapida: { crf: 24, preset: 'veryfast', abr: '160k' },
};

function buildExport(project, outPath, opts = {}) {
  const quality = opts.quality || 'normal';
  const { width: W, height: H, fps } = project.settings;
  const Q = PRESETS[quality] || PRESETS.normal;
  if (!project.video.length) throw new Error('Añade al menos un clip a la pista de video.');
  const inputs = [];
  const filters = [];
  // seek: [inicio, duración] -> busca en la entrada (no decodifica el archivo desde el principio para cada clip).
  const addInput = (media, seek) => {
    if (media.kind === 'image') inputs.push('-loop', '1', '-framerate', String(fps), '-t', '3600', '-i', media.path);
    else if (seek) inputs.push('-ss', r(seek[0]), '-t', r(seek[1] + 0.5), '-i', media.path);
    else inputs.push('-i', media.path);
    return inputs.filter((x) => x === '-i').length - 1;
  };

  const durs = [];
  project.video.forEach((c, i) => {
    const m = project.media[c.mediaId];
    if (!m) throw new Error(`Falta el archivo del clip ${i + 1}.`);
    const speed = c.speed || 1;
    const seekable = m.kind !== 'image';
    const seek = seekable ? [c.in, c.out - c.in] : null;
    const k = addInput(m, seek);
    const tIn = seekable ? 0 : c.in, tOut = seekable ? c.out - c.in : c.out;
    // Encuadre: "contain" = se ve entero con barras; "cover" = rellena recortando (reencuadre), centrado en cropX/cropY.
    const fitF = (project.settings.fit === 'cover')
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-${W})*${r(c.cropX ?? 0.5)}:(ih-${H})*${r(c.cropY ?? 0.5)}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const dur = clipDuration(c);
    const extra = fxlib.clipVideoFilters(c.fx, { W, H, fps, dur });
    filters.push(`[${k}:v]trim=start=${r(tIn)}:end=${r(tOut)},setpts=(PTS-STARTPTS)/${r(speed)},fps=${fps},` +
      `${fitF},setsar=1,${extra.length ? extra.join(',') + ',' : ''}settb=AVTB,format=yuv420p[v${i}]`);
    durs.push(dur);
    let aSrc = null;
    if (!c.muted) {
      if (c.audioOverride) aSrc = addInput({ kind: 'audio', path: c.audioOverride }, seek);
      else if (m.hasAudio) aSrc = k;
    }
    if (opts.videoOnly) { /* sin audio */ } else if (aSrc !== null) {
      filters.push(`[${aSrc}:a]atrim=start=${r(tIn)}:end=${r(tOut)},asetpts=PTS-STARTPTS,` +
        [...atempoChain(speed), `volume=${r(c.volume ?? 1)}`].join(',') +
        `,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=duration=${r(dur)}[a${i}]`);
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${r(dur)}[a${i}]`);
    }
  });

  // Pliega los clips: xfade/acrossfade cuando hay transicion, concat cuando no.
  const n = project.video.length;
  let foldDur = durs[0] || 0;
  if (n === 1) {
    filters.push('[v0]null[vc0]'); if (!opts.videoOnly) filters.push('[a0]anull[ac]');
  } else {
    let curV = 'v0', curA = 'a0', curDur = durs[0];
    for (let i = 1; i < n; i++) {
      const tr = project.video[i].transition;
      const type = tr && tr.type && tr.type !== 'none' ? (TRANSITION_ALIAS[tr.type] || tr.type) : null;
      const td = type ? Math.min(tr.dur || 0.5, durs[i] - 0.05, curDur - 0.05) : 0;
      const nv = `vx${i}`, na = `ax${i}`;
      if (type && td > 0.02) {
        filters.push(`[${curV}][v${i}]xfade=transition=${type}:duration=${r(td)}:offset=${r(curDur - td)}[${nv}]`);
        if (!opts.videoOnly) filters.push(`[${curA}][a${i}]acrossfade=d=${r(td)}[${na}]`);
        curDur = curDur + durs[i] - td;
      } else {
        filters.push(`[${curV}][v${i}]concat=n=2:v=1:a=0[${nv}]`);
        if (!opts.videoOnly) filters.push(`[${curA}][a${i}]concat=n=2:v=0:a=1[${na}]`);
        curDur = curDur + durs[i];
      }
      curV = nv; curA = na;
    }
    filters.push(`[${curV}]null[vc0]`); if (!opts.videoOnly) filters.push(`[${curA}]anull[ac]`);
    foldDur = curDur;
  }
  // Graba titulos/texto y subtitulos en el video (cada uno es un .ass)
  const assEsc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const impacts = fxlib.impactFilters(project.fx, { W, H, fps });
  if (impacts.length) filters.push(`[vc0]${impacts.join(',')},settb=AVTB,setpts=N/(${fps}*TB)[vc0f]`);
  const base = impacts.length ? 'vc0f' : 'vc0';
  const layers = [opts.textAss, opts.subsAss].filter(Boolean);
  if (layers.length) {
    let cur = base;
    layers.forEach((ass, idx) => {
      const out = idx === layers.length - 1 ? 'vc' : `vcl${idx}`;
      filters.push(`[${cur}]ass='${assEsc(ass)}'[${out}]`);
      cur = out;
    });
  } else {
    filters.push(`[${base}]null[vc]`);
  }
  const duration = foldDur;
  if (opts.videoOnly) return finishVideoOnly(filters, inputs, duration, outPath, opts, { W, H, fps, Q });

  // Pistas de audio: cada clip con su rol. Voz = "voice"; Musica = "music" (con ducking opcional); resto = efectos.
  const voicePads = [], duckPads = [], otherPads = [];
  project.audio.forEach((c, j) => {
    const m = project.media[c.mediaId];
    if (!m || c.muted) return;
    const k = addInput(m);
    const dur = c.out - c.in;
    const chain = [`atrim=start=${r(c.in)}:end=${r(c.out)}`, 'asetpts=PTS-STARTPTS', `volume=${r(c.volume ?? 1)}`];
    if (c.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${r(Math.min(c.fadeIn, dur))}`);
    if (c.fadeOut > 0) chain.push(`afade=t=out:st=${r(Math.max(0, dur - c.fadeOut))}:d=${r(Math.min(c.fadeOut, dur))}`);
    chain.push('aformat=sample_rates=48000:channel_layouts=stereo');
    chain.push(...fxlib.audioFxFilters(c.afx));
    const ms = Math.max(0, Math.round(c.start * 1000));
    if (ms > 0) chain.push(`adelay=${ms}:all=1`);
    filters.push(`[${k}:a]${chain.join(',')}[b${j}]`);
    const role = c.role || (m.isVoice ? 'voice' : 'sfx');
    if (role === 'voice') voicePads.push(`[b${j}]`);
    else if (role === 'music' && c.ducking) duckPads.push(`[b${j}]`);
    else otherPads.push(`[b${j}]`);
  });
  const mixOf = (pads, out) => {
    if (pads.length === 1) filters.push(`${pads[0]}anull[${out}]`);
    else filters.push(`${pads.join('')}amix=inputs=${pads.length}:normalize=0:duration=longest:dropout_transition=0[${out}]`);
  };
  const finalPads = ['[ac]', ...otherPads];
  if (duckPads.length && voicePads.length) {
    // Ducking: la musica se comprime con la voz como señal de control (baja ~12 dB cuando hablas).
    mixOf(voicePads, 'vmix');
    filters.push('[vmix]asplit=2[vmain][vsc0]');
    filters.push('[vsc0]apad[vsc]');
    mixOf(duckPads, 'mmix');
    filters.push('[mmix][vsc]sidechaincompress=threshold=0.012:ratio=14:attack=25:release=450:makeup=1:knee=4[mduck]');
    finalPads.push('[vmain]', '[mduck]');
  } else {
    finalPads.push(...voicePads, ...duckPads);
  }
  if (finalPads.length > 1) {
    filters.push(`${finalPads.join('')}amix=inputs=${finalPads.length}:normalize=0:duration=first:dropout_transition=0,alimiter=limit=0.97:level=false[aout]`);
  } else {
    filters.push('[ac]alimiter=limit=0.97:level=false[aout]');
  }

  // La duracion la marca la pista de video (con los solapes de las transiciones).
  let vOut = 'vc';
  if (opts.scale && opts.scale !== 1) { filters.push(`[vc]scale=${even(W * opts.scale)}:${even(H * opts.scale)}[vcs]`); vOut = 'vcs'; }
  const range = opts.range ? ['-ss', r(opts.range[0]), '-t', r(Math.max(0.1, Math.min(duration, opts.range[1]) - opts.range[0]))] : ['-t', r(duration)];
  const args = [
    '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${vOut}]`, '-map', '[aout]',
    '-c:v', 'libx264', '-preset', Q.preset, '-crf', String(Q.crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', Q.abr, '-ar', '48000',
    ...range,
    '-movflags', '+faststart',
    outPath,
  ];
  return { args, duration: opts.range ? Math.min(duration, opts.range[1]) - opts.range[0] : duration };
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Solo imagen: un fotograma (frameAt), una hoja de contacto (sheet) o un vídeo mudo.
function finishVideoOnly(filters, inputs, duration, outPath, opts, { W, H, fps, Q }) {
  let tail = [];
  if (opts.sheet) {
    const every = Math.max(0.1, opts.sheet.every || 1), cols = Math.max(1, opts.sheet.cols || 6);
    const n = Math.max(1, Math.ceil(duration / every)), rows = Math.ceil(n / cols);
    const tw = even(opts.sheet.width || 240);
    filters.push(`[vc]fps=1/${r(every)},scale=${tw}:-2,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='%{pts\\:hms}':x=6:y=6:fontsize=${Math.round(tw / 11)}:fontcolor=white:box=1:boxcolor=black@0.6,tile=${cols}x${rows}:padding=4:color=0x111111[vs]`);
    tail = ['-map', '[vs]', '-frames:v', '1', '-q:v', '3'];
  } else if (opts.frameAt != null) {
    const w = opts.frameWidth ? `,scale=${even(opts.frameWidth)}:-2` : '';
    filters.push(`[vc]trim=start=${r(Math.max(0, Math.min(opts.frameAt, duration - 1 / fps)))},setpts=PTS-STARTPTS${w}[vs]`);
    tail = ['-map', '[vs]', '-frames:v', '1', '-q:v', '2'];
  } else {
    tail = ['-map', '[vc]', '-c:v', 'libx264', '-preset', Q.preset, '-crf', String(Q.crf), '-pix_fmt', 'yuv420p', '-an', '-t', r(duration)];
  }
  return { args: ['-y', ...inputs, '-filter_complex', filters.join(';'), ...tail, outPath], duration };
}

module.exports = { buildExport, projectDuration, clipDuration, atempoChain };
