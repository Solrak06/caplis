const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('caplis', {
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  importMedia: (file) => ipcRenderer.invoke('media:import', file),
  pathForFile: (f) => webUtils.getPathForFile(f),
  enhanceAvailable: () => ipcRenderer.invoke('enhance:available'),
  enhance: (opts) => ipcRenderer.invoke('enhance:run', opts),
  ttsEngines: () => ipcRenderer.invoke('tts:engines'),
  ttsVoices: (engine) => ipcRenderer.invoke('tts:voices', engine),
  ttsSpeak: (req) => ipcRenderer.invoke('tts:speak', req),
  exportVideo: (project, quality) => ipcRenderer.invoke('export:run', { project, quality }),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  saveProject: (project, filePath) => ipcRenderer.invoke('project:save', { project, filePath }),
  openProject: () => ipcRenderer.invoke('project:open'),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  fileUrl: (p) => ipcRenderer.invoke('util:fileUrl', p),
  onProgress: (cb) => ipcRenderer.on('job:progress', (_e, d) => cb(d)),
  // Puente Claude Code <-> Caplis
  publishState: (st) => ipcRenderer.invoke('bridge:state', st),
  onBridgeLoad: (cb) => ipcRenderer.on('bridge:load', (_e, d) => cb(d)),
  onBridgeToast: (cb) => ipcRenderer.on('bridge:toast', (_e, d) => cb(d)),
  onBridgeControl: (cb) => ipcRenderer.on('bridge:control', (_e, d) => cb(d)),
  // Ventana
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, d) => cb(d)),
  // Proyectos
  listProjects: () => ipcRenderer.invoke('projects:list'),
  openProjectFile: (p) => ipcRenderer.invoke('projects:open', p),
  saveProjectAs: (project, name, prevPath, rename) => ipcRenderer.invoke('projects:saveAs', { project, name, prevPath, rename }),
  // Repertorio y versiones
  catalog: () => ipcRenderer.invoke('catalog:get'),
  versionsList: (file) => ipcRenderer.invoke('versions:list', file),
  versionsGet: (file, v) => ipcRenderer.invoke('versions:get', file, v),
  versionsCommit: (file, project, message) => ipcRenderer.invoke('versions:commit', { file, project, message }),
  versionsRevert: (file, v) => ipcRenderer.invoke('versions:revert', file, v),
  deleteProject: (p) => ipcRenderer.invoke('projects:delete', p),
  // Subtítulos
  subsAvailable: () => ipcRenderer.invoke('subs:available'),
  transcribe: (opts) => ipcRenderer.invoke('subs:transcribe', opts),
  // Biblioteca de audio
  audioLibrary: () => ipcRenderer.invoke('audiolib:list'),
  audioUrl: (p) => ipcRenderer.invoke('audiolib:url', p),
  saveText: (text, name) => ipcRenderer.invoke('text:save', { text, name }),
});
