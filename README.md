# Caplis

Editor de vídeo propio para Windows (Electron + ffmpeg), pensado para trabajar **junto a Claude Code**: Claude monta y
retoca el proyecto, tú lo ves al instante en la vista previa —sin esperar renders— y solo exportas el MP4 cuando te gusta.
Original: no es CapCut ni usa su código ni sus recursos.

## Abrir
```
npm install
npm start          # o doble clic en Caplis.exe (lanzador nativo: build/launcher.c)
```
Necesita **ffmpeg/ffprobe** en el PATH (o `CAPLIS_FFMPEG` / `CAPLIS_FFPROBE`).

## Iterar con Claude sin renderizar (novedad 0.2)
1. Claude (desde Claude Code o desde **Viralis**) monta el vídeo como proyecto de Caplis.
2. Lo ves en Caplis y pides cambios («la música más baja», «flash en el golpe del segundo 8», «look más frío»…).
3. Claude edita el proyecto con `caplis-connect.mjs edit` → Caplis lo **recarga en vivo** («✦ Claude · v7: …»).
4. Repite hasta que te guste y pulsa **Descargar MP4**.
5. Pestaña **Versiones**: cada cambio (de Claude o tuyo con «Guardar versión» / Ctrl+S) es una versión; puedes **ver**
   cualquiera sin tocar nada y **restaurarla** (se crea una versión nueva: nunca se pierde nada).

Guía del conector para Claude: [CONECTOR.md](CONECTOR.md) (`build`, `get`, `edit`, `history`, `revert`, `frame`,
`sheet`, `render --draft`, `sfx`, `catalog`, `shot`).

## Repertorio de efectos (lo que ves en la previa es lo que sale en el MP4)
- **16 looks de color**: cine, cálido, frío, drama, épico, B/N, noir, vintage, sepia, vivo, desvaído, terror, neón, sueño, VHS…
- **Ajustes por clip**: brillo, contraste, saturación, temperatura, tono, sepia, viñeta, desenfoque, grano, nitidez.
- **Movimiento**: Ken Burns (acercar/alejar), paneos, cámara en mano, latido, golpe de zoom; aparecer/fundir a negro.
- **Impactos en el tiempo** (pista «Efectos»): flash, golpe a negro, sacudida, zoom golpe, glitch, separación RGB, B/N,
  negativo, desenfoque y túnel.
- **44 transiciones** (fundidos, barridos, deslizar, empujes, iris, radial, zoom, pixelar, persianas, viento…), con vista
  previa real entre los dos planos.
- **Efectos de audio por clip**: teléfono, radio, bajo el agua, lejano, eco, sala, catedral, graves, brillo, megáfono,
  robot y panorama (WebAudio en la previa, ffmpeg al exportar).
- **12 plantillas de texto** y **12 animaciones** (pop, rebote, caer, zoom, enfocar, máquina de escribir, parpadeo,
  temblor, expandir…), con fuente, caja de color y brillo neón.

## Qué más hace
- **Montaje**: importar vídeos/audios/imágenes (botón o arrastrar), línea de tiempo multipista (texto, efectos, vídeo y
  audio), reordenar, dividir (S), recortar arrastrando los bordes, velocidad, volumen, fundidos.
- **Tu propio audio**: pistas independientes; música/voz/efectos con volumen, fundidos y efecto; silencia el audio de un clip.
- **Mejorar voz con IA** (panel ✦), todo local: DeepFilterNet (`engines/deep-filter.exe`, opcional) o filtros ffmpeg.
- **Narración automática**: texto → voz (edge-tts o voces de Windows).
- **Música con ducking**: baja ~12 dB automáticamente mientras hay voz (en la previa y en el MP4).
- **Reencuadre 9:16 / 1:1 / 4:5** con «Rellenar» y encuadre por clip.
- **Subtítulos automáticos** con faster-whisper (local), editables y grabados en el vídeo.
- **Biblioteca de sonidos**: «Audio para Videos» y la biblioteca real-sfx de Viralis (o `CAPLIS_AUDIO_ROOTS`).
- **Reproductor**: clic = play/pausa, doble clic = pantalla completa, barra sobre el vídeo. Atajos: Espacio/K, J/L,
  ←/→, S, F, M, Z, +/−, Ctrl+Z/Y, Ctrl+S (guarda y crea versión).
- **Exportar** MP4 (H.264/AAC) 16:9, 9:16, 1:1, 4:5 y 4K.

## Comprobar sin abrir ventana
```
npm run check   # módulos, ffmpeg y exportación + cada look/movimiento/impacto/efecto de audio validado en ffmpeg,
                # operaciones de edición y versiones
```
Para probar la interfaz sin ocupar la pantalla: `CAPLIS_OFFSCREEN=1 npm start` y `node caplis-connect.mjs shot captura.png`.

## Motores opcionales
- **DeepFilterNet** (IA local de audio): descarga `deep-filter-*-x86_64-pc-windows-msvc.exe` de
  https://github.com/Rikorose/DeepFilterNet/releases y guárdalo como `engines\deep-filter.exe`.
- **Modelo RNNoise**: guarda un `.rnnn` como `engines\cb.rnnn` (p. ej. de https://github.com/richardpl/arnndn-models).
- **edge-tts**: `pip install edge-tts`. **Subtítulos**: `pip install faster-whisper`.

## Estructura
- `main.js` / `preload.js` — proceso Electron, IPC y puente con Claude (`bridge/inbox.json` ↔ `bridge/state.json`).
- `renderer/` — interfaz (HTML/CSS/JS sin frameworks); `renderer/fx.js` = vista previa de efectos (CSS/WebAudio).
- `lib/catalog.js` — el repertorio (looks, movimientos, impactos, transiciones, audio, textos).
- `lib/effects.js` — efectos → filtros de ffmpeg. `lib/export.js` — render (MP4, fotograma, hoja de contacto, borrador).
- `lib/ops.js` — operaciones de edición (`edit`). `lib/versions.js` — historial. `lib/sfx.js` — búsqueda de sonidos.
- `lib/project.js` — recetas → proyecto. `lib/ffmpeg.js`, `lib/enhance.js`, `lib/tts.js`, `lib/subtitles.js`.
- `caplis-connect.mjs` — el conector para Claude Code / Viralis.

## Licencia
MIT.
