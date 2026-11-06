// Wrappers de ffmpeg / ffprobe: probe, miniaturas, forma de onda y ejecucion con progreso.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resuelve el binario a ruta absoluta (evita fallos ENOENT con los stubs de WinGet).
function resolveBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  try {
    const r = spawnSync(finder, [exe], { encoding: 'utf8' });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (hit) return real(hit); // sigue el symlink (los stubs de WinGet no son ejecutables por spawn)
  } catch {}
  for (const d of [
    'C:/ffmpeg/bin', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/WinGet/Links'),
    'C:/Program Files/ffmpeg/bin',
  ].filter(Boolean)) { const p = path.join(d, exe); if (fs.existsSync(p)) return p; }
  return name;
}

const FFMPEG = resolveBin('ffmpeg', 'CAPLIS_FFMPEG');
const FFPROBE = resolveBin('ffprobe', 'CAPLIS_FFPROBE');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

function run(bin, args, { cwd, onStderr, onStdout, signal } = {}) {
  if (cwd && !fs.existsSync(cwd)) cwd = undefined; // evita ENOENT por cwd inexistente
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { const s = d.toString(); out += s; onStdout && onStdout(s); });
    p.stderr.on('data', (d) => { const s = d.toString(); err += s; if (err.length > 200000) err = err.slice(-100000); onStderr && onStderr(s); });
    if (signal) signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} salio con codigo ${code}\n${err.split('\n').slice(-12).join('\n')}`));
    });
  });
}

async function probe(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const ext = path.extname(file).toLowerCase();
  const isImage = IMAGE_EXT.has(ext);
  let duration = parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration) || '0') || 0;
  if (isImage) duration = 5;
  let fps = 30;
  if (v && v.avg_frame_rate && v.avg_frame_rate.includes('/')) {
    const [n, d] = v.avg_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  return {
    path: file,
    name: path.basename(file),
    kind: isImage ? 'image' : v ? 'video' : a ? 'audio' : 'unknown',
    duration,
    hasVideo: !!v,
    hasAudio: !!a && !isImage,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps,
  };
}

function hashName(file, extra = '') {
  let st = '';
  try { const s = fs.statSync(file); st = `${s.size}-${s.mtimeMs}`; } catch {}
  return crypto.createHash('sha1').update(file + '|' + st + '|' + extra).digest('hex').slice(0, 16);
}

async function thumbnail(file, t, cacheDir) {
  const out = path.join(cacheDir, `thumb-${hashName(file, String(t))}.jpg`);
  if (fs.existsSync(out)) return out;
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '4', out]);
  return out;
}

// Forma de onda como PNG transparente (se estira en la pista de la linea de tiempo).
async function waveform(file, cacheDir) {
  const out = path.join(cacheDir, `wave-${hashName(file)}.png`);
  if (fs.existsSync(out)) return out;
  await run(FFMPEG, ['-y', '-v', 'error', '-i', file, '-filter_complex',
    'aformat=channel_layouts=mono,compand=gain=4,showwavespic=s=1600x120:colors=#ffffff', '-frames:v', '1', out]);
  return out;
}

// Ejecuta ffmpeg informando del progreso (0..1) usando -progress.
function runWithProgress(args, totalSeconds, onProgress, opts = {}) {
  const full = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args];
  let buf = '';
  return run(FFMPEG, full, {
    ...opts,
    onStdout: (s) => {
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (m && totalSeconds > 0) onProgress && onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds));
      }
    },
  });
}

module.exports = { FFMPEG, FFPROBE, run, probe, thumbnail, waveform, runWithProgress, hashName };
