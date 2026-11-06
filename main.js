// Caplis - proceso principal de Electron.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ff = require('./lib/ffmpeg');
const enhance = require('./lib/enhance');
const tts = require('./lib/tts');
const subtitles = require('./lib/subtitles');
const audiolib = require('./lib/audiolib');
const { buildExport } = require('./lib/export');
const versions = require('./lib/versions');
const catalogLib = require('./lib/catalog');

const DATA = () => app.getPath('userData');
const CACHE = () => { const d = path.join(DATA(), 'cache'); fs.mkdirSync(d, { recursive: true }); return d; };
const GENERATED = () => { const d = path.join(app.getPath('videos'), 'Caplis'); fs.mkdirSync(d, { recursive: true }); return d; };

// --- Puente Claude Code <-> Caplis ---
const BRIDGE = path.join(__dirname, 'bridge');
const INBOX = path.join(BRIDGE, 'inbox.json');
const STATE = path.join(BRIDGE, 'state.json');
fs.mkdirSync(BRIDGE, { recursive: true });

let win;
let currentJob = null;
let lastInbox = '';

const PROJECTS = () => { const d = path.join(__dirname, 'proyectos'); fs.mkdirSync(d, { recursive: true }); return d; };

function createWindow() {
  // Modo prueba (CAPLIS_OFFSCREEN=1): ventana fuera de la pantalla y sin robar el foco, para que Claude pruebe sin molestar.
  const off = process.env.CAPLIS_OFFSCREEN === '1';
  win = new BrowserWindow({
    ...(off ? { x: -6000, y: 0, show: false, focusable: true, skipTaskbar: true } : {}),
    width: 1560,
    height: 940,
    minWidth: 1080,
    minHeight: 660,
    backgroundColor: '#0b0d12',
    title: 'Caplis',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.CAPLIS_DEBUG) win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.log('[renderer]', msg, src ? path.basename(src) + ':' + line : ''); });
  if (off) win.once('ready-to-show', () => win.showInactive());
  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('enter-full-screen', () => send('win:state', { fullscreen: true }));
  win.on('leave-full-screen', () => send('win:state', { fullscreen: false }));
}

const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);
const fileUrl = (p) => pathToFileURL(p).href;

ipcMain.handle('dialog:openMedia', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importar medios',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Medios', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('media:import', async (_e, file) => {
  const info = await ff.probe(file);
  info.url = fileUrl(file);
  try {
    if (info.hasVideo) info.thumb = fileUrl(await ff.thumbnail(file, info.kind === 'image' ? 0 : Math.min(1, info.duration / 3), CACHE()));
  } catch {}
  try { if (info.hasAudio) info.wave = fileUrl(await ff.waveform(file, CACHE())); } catch {}
  return info;
});

ipcMain.handle('enhance:available', () => enhance.available());
ipcMain.handle('enhance:run', async (_e, { file, mode, level, loudness }) => {
  const res = await enhance.enhance(file, path.join(GENERATED(), 'voz mejorada'), { mode, level, loudness },
    (p, label) => send('job:progress', { kind: 'enhance', p, label }));
  return res;
});

// Subtítulos automáticos (faster-whisper local)
ipcMain.handle('subs:available', () => subtitles.available());
ipcMain.handle('subs:transcribe', async (_e, { file, model, lang }) => {
  return subtitles.transcribe(file, { model, lang, onProgress: (p) => send('job:progress', { kind: 'subs', p, label: 'Transcribiendo' }) });
});

ipcMain.handle('text:save', async (_e, { text, name }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Guardar transcripción',
    defaultPath: path.join(app.getPath('documents'), (name || 'transcripcion') + '.txt'),
    filters: [{ name: 'Texto', extensions: ['txt'] }, { name: 'Subtítulos SRT', extensions: ['srt'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, text, 'utf8');
  return { path: r.filePath };
});

// Biblioteca de audio (Audio para Videos)
ipcMain.handle('audiolib:list', () => audiolib.library());
ipcMain.handle('audiolib:url', (_e, p) => fileUrl(p));

ipcMain.handle('tts:engines', () => tts.listEngines());
ipcMain.handle('tts:voices', (_e, engine) => tts.listVoices(engine));
ipcMain.handle('tts:speak', (_e, req) => tts.speak(req, path.join(GENERATED(), 'narraciones')));

ipcMain.handle('export:run', async (_e, { project, quality }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Exportar video',
    defaultPath: path.join(app.getPath('videos'), `${project.name || 'Caplis'}.mp4`),
    filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  let subsAss = null, textAss = null;
  if (project.captions && project.captions.burn && (project.captions.items || []).length) {
    subsAss = subtitles.writeAssFile(project.captions.items, project.captions.style, project.settings, CACHE());
  }
  if ((project.texts || []).length) {
    textAss = subtitles.writeTextsAssFile(project.texts, project.settings, CACHE());
  }
  const { args, duration } = buildExport(project, r.filePath, { quality, subsAss, textAss });
  const ctrl = new AbortController();
  currentJob = ctrl;
  try {
    await ff.runWithProgress(args, duration, (p) => send('job:progress', { kind: 'export', p, label: 'Exportando' }), { signal: ctrl.signal });
  } finally { currentJob = null; }
  return { path: r.filePath };
});
ipcMain.handle('job:cancel', () => { if (currentJob) currentJob.abort(); return true; });

ipcMain.handle('project:save', async (_e, { project, filePath }) => {
  let target = filePath;
  if (!target) {
    const r = await dialog.showSaveDialog(win, {
      title: 'Guardar proyecto',
      defaultPath: path.join(app.getPath('documents'), `${project.name || 'Proyecto'}.caplis`),
      filters: [{ name: 'Proyecto Caplis', extensions: ['caplis'] }],
    });
    if (r.canceled) return null;
    target = r.filePath;
  }
  fs.writeFileSync(target, JSON.stringify(project, null, 2), 'utf8');
  return target;
});
ipcMain.handle('project:open', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Abrir proyecto', filters: [{ name: 'Proyecto Caplis', extensions: ['caplis'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  return { filePath: r.filePaths[0], project: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) };
});
ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('util:fileUrl', (_e, p) => fileUrl(p));

// Controles de ventana (barra de titulo propia)
ipcMain.handle('win:minimize', () => win && win.minimize());
ipcMain.handle('win:maximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.handle('win:close', () => win && win.close());
ipcMain.handle('win:fullscreen', (_e, on) => { if (win) win.setFullScreen(on != null ? on : !win.isFullScreen()); return win ? win.isFullScreen() : false; });
ipcMain.handle('win:isMaximized', () => win ? win.isMaximized() : false);

// Proyectos guardados
// Duración real del montaje (las transiciones solapan clips): mismo cálculo que el editor y la exportación.
function foldedDuration(video) {
  let acc = 0;
  (video || []).forEach((c, i) => {
    const d = (c.out - c.in) / (c.speed || 1); let td = 0;
    if (i > 0 && c.transition && c.transition.type && c.transition.type !== 'none') { td = Math.min(c.transition.dur || 0.5, d - 0.05, acc - 0.05); if (td <= 0.02) td = 0; }
    acc = acc - td + d;
  });
  return acc;
}
ipcMain.handle('projects:list', async () => {
  const dir = PROJECTS();
  const list = await Promise.all(fs.readdirSync(dir).filter((f) => f.endsWith('.caplis')).map(async (f) => {
    const full = path.join(dir, f);
    let project = {}; try { project = JSON.parse(fs.readFileSync(full, 'utf8')); } catch {}
    const st = fs.statSync(full);
    // Miniatura: fotograma del primer clip de vídeo (en caché)
    let thumb = null;
    const first = (project.video || [])[0]; const m = first && project.media && project.media[first.mediaId];
    if (m && fs.existsSync(m.path)) {
      try { thumb = fileUrl(await ff.thumbnail(m.path, m.kind === 'image' ? 0 : Math.min((first.in || 0) + 1, Math.max(0, (m.duration || 1) - 0.1)), CACHE())); } catch {}
    }
    let nVersions = 0; try { nVersions = versions.list(full).length; } catch {}
    return { filePath: full, name: project.name || f.replace(/\.caplis$/, ''), modified: st.mtimeMs, versions: nVersions, version: project.version || null, viralis: !!project.viralis, clips: (project.video || []).length, audioClips: (project.audioLanes || []).flat().length, duration: foldedDuration(project.video), thumb };
  }));
  return list.sort((a, b) => b.modified - a.modified);
});
ipcMain.handle('projects:open', (_e, filePath) => ({ filePath, project: JSON.parse(fs.readFileSync(filePath, 'utf8')) }));
ipcMain.handle('projects:saveAs', (_e, { project, name, prevPath, rename }) => {
  const safe = (name || project.name || 'Proyecto').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'Proyecto';
  // Un proyecto abierto desde otra carpeta (p. ej. de Viralis) se sigue guardando en su sitio.
  // Un proyecto abierto se guarda SIEMPRE en su archivo; solo al renombrarlo pasa a <carpeta>/<nombre nuevo>.caplis.
  let full = prevPath && fs.existsSync(path.dirname(prevPath)) ? prevPath : path.join(PROJECTS(), safe + '.caplis');
  if (rename && prevPath) {
    full = path.join(path.dirname(prevPath), safe + '.caplis');
    if (full !== prevPath && fs.existsSync(full)) full = path.join(path.dirname(prevPath), safe + ' (' + Date.now().toString(36) + ').caplis');
  } else if (!prevPath && fs.existsSync(full)) {
    full = path.join(PROJECTS(), safe + ' (' + Date.now().toString(36) + ').caplis'); // nunca pisa otro proyecto
  }
  if (prevPath && prevPath !== full && fs.existsSync(prevPath)) { try { versions.rename(prevPath, full); } catch {} }
  fs.writeFileSync(full, JSON.stringify({ ...project, name: project.name || safe }, null, 2), 'utf8');
  return full;
});
ipcMain.handle('projects:delete', (_e, filePath) => { try { if (path.dirname(filePath) === PROJECTS()) fs.unlinkSync(filePath); return true; } catch { return false; } });

// Repertorio (looks, transiciones, efectos…) y versiones del proyecto
ipcMain.handle('catalog:get', () => ({ ...catalogLib.catalog(), _raw: { LOOKS: catalogLib.LOOKS, ADJUST: catalogLib.ADJUST, MOTIONS: catalogLib.MOTIONS, IMPACTS: catalogLib.IMPACTS, TRANSITIONS: catalogLib.TRANSITIONS, AUDIO_FX: catalogLib.AUDIO_FX, TEXT_TEMPLATES: catalogLib.TEXT_TEMPLATES, TEXT_ANIMS: catalogLib.TEXT_ANIMS, FONTS: catalogLib.FONTS } }));
ipcMain.handle('versions:list', (_e, file) => { try { return file ? versions.list(file) : []; } catch { return []; } });
ipcMain.handle('versions:get', (_e, file, v) => versions.get(file, v));
ipcMain.handle('versions:commit', (_e, { file, project, message, author }) => {
  if (!file) return null;
  const e = versions.commit(file, project, { author: author || 'usuario', message: message || 'Versión guardada a mano' });
  return e;
});
ipcMain.handle('versions:revert', (_e, file, v) => {
  versions.commitPendingFromDisk(file);
  return versions.revert(file, v, { author: 'usuario' });
});

// El renderer informa de su estado actual; lo publicamos para que el conector lo lea.
ipcMain.handle('bridge:state', (_e, st) => {
  try { fs.writeFileSync(STATE, JSON.stringify({ ...st, ts: Date.now(), running: true }, null, 2)); } catch {}
});
ipcMain.handle('bridge:notify', (_e, msg) => { if (win) win.focus(); return true; });

// Procesa una orden dejada por Claude Code en bridge/inbox.json.
function processInbox() {
  let raw;
  try { raw = fs.readFileSync(INBOX, 'utf8'); } catch { return; }
  if (!raw || raw === lastInbox) return;
  lastInbox = raw;
  let cmd;
  try { cmd = JSON.parse(raw); } catch { return; }
  if (!cmd || !cmd.action) return;
  if (cmd.action === 'load') {
    let project = cmd.project;
    try { if (!project && cmd.file) project = JSON.parse(fs.readFileSync(cmd.file, 'utf8')); } catch (e) { return; }
    if (project) send('bridge:load', { project, filePath: cmd.file || null, autoplay: !!cmd.autoplay, seek: cmd.seek, from: 'claude' });
  } else if (cmd.action === 'reload') {
    // Claude cambió un proyecto: la app lo recarga en vivo (conservando cursor y vista si es el que está abierto).
    let project = cmd.project;
    try { if (!project && cmd.file) project = JSON.parse(fs.readFileSync(cmd.file, 'utf8')); } catch (e) { return; }
    if (project) send('bridge:load', { project, filePath: cmd.file || null, reload: true, version: cmd.version, message: cmd.message || '', author: cmd.author || 'claude', seek: cmd.seek, autoplay: !!cmd.autoplay, from: 'claude' });
  } else if (cmd.action === 'control') {
    send('bridge:control', cmd);
  } else if (cmd.action === 'toast') {
    send('bridge:toast', { message: cmd.message || '', err: !!cmd.err, link: cmd.link || null });
  } else if (cmd.action === 'shot') {
    // Captura de la ventana (para que Claude compruebe la interfaz sin tocar la pantalla).
    if (win) win.webContents.capturePage().then((img) => { try { fs.writeFileSync(cmd.file, img.toPNG()); } catch {} }).catch(() => {});
  } else if (cmd.action === 'focus') {
    if (win) { win.show(); win.focus(); }
  }
}
function watchBridge() {
  try { fs.writeFileSync(STATE, JSON.stringify({ running: true, ts: Date.now() }, null, 2)); } catch {}
  try { fs.watch(BRIDGE, { persistent: false }, (_ev, f) => { if (f === 'inbox.json') setTimeout(processInbox, 60); }); } catch {}
  setInterval(processInbox, 1000); // respaldo por si fs.watch no dispara (OneDrive)
  processInbox();
}

app.whenReady().then(() => { createWindow(); watchBridge(); });
app.on('window-all-closed', () => { try { fs.writeFileSync(STATE, JSON.stringify({ running: false, ts: Date.now() })); } catch {}; app.quit(); });
