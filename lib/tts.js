// Narracion automatica (texto -> voz). Motores, todos gratuitos:
//  - "edge":       voces neuronales de Microsoft via edge-tts (gratis; requiere `pip install edge-tts`).
//  - "windows":    voces instaladas en Windows (gratis, sin internet, calidad basica).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { run, hashName } = require('./ffmpeg');

function hasEdgeTts() {
  try { return spawnSync('edge-tts', ['--version'], { windowsHide: true }).status === 0; } catch { return false; }
}

async function windowsVoices() {
  const ps = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture.Name }';
  const { out } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, lang] = l.split('|');
    return { id: name.trim(), name: name.replace(/^Microsoft /, '').replace(/ Desktop$/, '').trim(), lang: (lang || '').trim() };
  });
}

async function edgeVoices() {
  const { out } = await run('edge-tts', ['--list-voices']);
  // Formato tabla: Name  Gender  ContentCategories  VoicePersonalities
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((c) => /^[a-z]{2}-[A-Z]{2}-/.test(c[0] || ''))
    .map((c) => ({ id: c[0], name: c[0].split('-').slice(2).join('-').replace(/Neural$/, ''), lang: c[0].split('-').slice(0, 2).join('-'), desc: c[1] || '' }));
}

async function listEngines() {
  const engines = [];
  if (hasEdgeTts()) engines.push({ id: 'edge', name: 'Microsoft Neural (gratis)' });
  engines.push({ id: 'windows', name: 'Windows (sin internet)' });
  return engines;
}

async function listVoices(engine) {
  if (engine === 'edge') return edgeVoices();
  return windowsVoices();
}

/** Genera la narracion. Devuelve la ruta del archivo de audio. */
async function speak({ engine, voice, text, speed = 1 }, outDir) {
  if (!text || !text.trim()) throw new Error('Escribe el texto a narrar.');
  fs.mkdirSync(outDir, { recursive: true });
  const id = hashName(text, `${engine}-${voice}-${speed}-${Date.now()}`);
  const slug = text.trim().slice(0, 28).replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'narracion';

  const txt = path.join(outDir, `tts-${id}.txt`);
  fs.writeFileSync(txt, text, 'utf8');
  try {
    if (engine === 'edge') {
      const out = path.join(outDir, `Narracion - ${slug} - ${id}.mp3`);
      const pct = Math.round((speed - 1) * 100);
      await run('edge-tts', ['--voice', voice, `--rate=${pct >= 0 ? '+' : ''}${pct}%`, '--file', txt, '--write-media', out]);
      return out;
    }
    const out = path.join(outDir, `Narracion - ${slug} - ${id}.wav`);
    const rate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 10)));
    const ps = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      voice ? `$s.SelectVoice('${String(voice).replace(/'/g, "''")}')` : '',
      `$s.Rate = ${rate}`,
      `$s.SetOutputToWaveFile('${out.replace(/'/g, "''")}')`,
      `$s.Speak([IO.File]::ReadAllText('${txt.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
      '$s.Dispose()',
    ].filter(Boolean).join('; ');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return out;
  } finally {
    fs.rmSync(txt, { force: true });
  }
}

module.exports = { listEngines, listVoices, speak };
