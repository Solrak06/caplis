# Conector Caplis ↔ Claude Code / Viralis

Claude **monta y retoca** proyectos de Caplis **sin renderizar**. Caplis (abierto) recarga el proyecto en vivo; tú lo
previsualizas, pides otro cambio, Claude lo aplica… y solo cuando te guste exportas el MP4. Cada cambio queda como una
**versión** del mismo proyecto: en Caplis, pestaña **Versiones**, puedes ver cualquiera y restaurarla.

## Flujo de trabajo (iterar sin render)
1. `build receta.json --load` → crea el proyecto (o lo actualiza si ya existe: misma ruta = mismo proyecto, versión nueva).
2. `get <proyecto>` → ids, tiempos y efectos actuales.
3. `edit <proyecto> ops.json --msg "qué cambia"` → aplica cambios, guarda versión, Caplis recarga al instante.
4. Para comprobar sin render: `frame <proyecto> <t> f.jpg` (1 fotograma, ~4 s) o `sheet <proyecto> hoja.jpg --every 0.5`.
5. `history` / `revert <proyecto> <n>` si hay que volver atrás.
6. Final: `render <proyecto> salida.mp4` (o el botón Exportar de Caplis).

## Comandos — `node caplis-connect.mjs <comando>`
| Comando | Qué hace |
|---|---|
| `status` | ¿Caplis abierto?, motores, estado (proyecto, `playT`, vista…) |
| `catalog` | Repertorio completo: looks, ajustes, movimientos, impactos, transiciones, efectos de audio, plantillas y animaciones de texto, fuentes |
| `build <receta> [--into <proyecto>] [--msg ..] [--load] [--play] [--render out.mp4]` | Monta desde receta. `--into` = reescribe ESE proyecto como versión nueva |
| `get <proyecto> [--full]` | Resumen editable (o JSON completo) + últimas versiones |
| `edit <proyecto> <ops.json \| '[...]' \| -> --msg ".." [--dry] [--no-load] [--seek t] [--author claude]` | Aplica operaciones (abajo) |
| `history <proyecto>` / `revert <proyecto> <n>` | Versiones / restaurar (crea versión nueva) |
| `frame <proyecto> <t> <out.jpg> [--width 540]` | Un fotograma con todos los efectos y textos |
| `sheet <proyecto> <out.jpg> [--every 1] [--cols 6] [--width 240]` | Hoja de contacto con marca de tiempo |
| `render <proyecto> <out.mp4> [--quality alta\|normal\|rapida] [--draft] [--range a-b]` | MP4 (`--draft` = mitad de resolución y rápido) |
| `sfx "<búsqueda>" [--limit 10]` | Busca efectos de sonido (acepta español: golpe, silbido, subida, campana, grave, glitch…) |
| `load <proyecto> [--play] [--seek t] [--version n]` | Abre en la app (con `--version`, vista previa de una versión) |
| `toast "msg"`, `control [--seek t] [--play] [--pause] [--tab ...]`, `say`, `voices`, `enhance` | Varios |

`<proyecto>` = ruta a `.caplis` o su nombre (se busca en `proyectos/`).

## Operaciones de `edit` (JSON: lista de `{ "op": ..., ... }`)
Clips de vídeo: `id` = id del clip **o posición** (0 = primero). Audio, textos y efectos: `id` (lo da `get`).
| op | campos |
|---|---|
| `set_project` | `name, aspect, fit (contain\|cover), fps, script` |
| `add_clip` | `file, index?, in, out, speed, volume, muted, fx, transition, cropX, note` |
| `update_clip` | `id, in, out, speed, volume, muted, cropX, fx (se fusiona; null borra), transition` |
| `remove_clip` / `move_clip` | `id` / `id, index` |
| `split_clip` | `t` (segundo del montaje) `[, id]` |
| `replace_media` | `id, file [, in, out]` — cambia el plano por otro archivo manteniendo su duración |
| `set_transition` | `id, type, dur` (`type` de `catalog.transitions`, «none» = corte) |
| `set_fx` | `id` \| `ids:[..]` \| `all:true`, `fx:{...}` |
| `add_audio` | `file, start, in, out, volume, fadeIn, fadeOut, role (voice\|music\|sfx\|ambience), ducking, afx, lane, name` |
| `add_sfx` | `start, query \| file, volume, pick, afx` — elige de la biblioteca |
| `update_audio` / `remove_audio` | `id, ...campos de add_audio, file?` / `id` |
| `set_role_volume` | `role, volume` o `factor` (p. ej. toda la música ×0.7) |
| `add_text` | `template, text, start, end \| dur, x, y (0–1), size (px a 1080 de alto), color, outline, box, glow, font, anim, italic, bold` |
| `update_text` / `remove_text` | `id, ...` / `id` |
| `add_fx` / `update_fx` / `remove_fx` | `type, start, dur, intensity` (impactos) / `id, ...` / `id` |
| `set_captions` | `items:[{start,end,text}], style, burn` |
| `shift` | `from, by` — mueve audio, textos y efectos posteriores |
| `clear` | `what: texts \| fx \| captions \| audio \| sfx \| clip_fx` |

### `fx` de un clip
`{ "look": "cine", "brightness": 0, "contrast": 1, "saturation": 1, "temp": 0, "hue": 0, "sepia": 0, "vignette": 0,
"blur": 0, "grain": 0, "sharpen": 0, "motion": {"type": "zoomin", "amount": 0.15}, "fadeIn": 0, "fadeOut": 0 }`
- **looks**: none, cine, calido, frio, drama, epico, bn, noir, vintage, sepia, vivo, desvaido, terror, neon, sueno, vhs
- **motion**: zoomin, zoomout, panleft, panright, panup, pandown, shake, pulse, punchin
### Impactos (`add_fx`)
flash, negro, shake, punch, glitch, rgb, bn, invert, blur, viñeta
### Transiciones
fade, fadeblack, fadewhite, dissolve, fadegrays, wipe*/slide*/smooth*/cover*/reveal* (left/right/up/down),
circleopen, circleclose, circlecrop, rectcrop, vertopen, horzopen, radial, zoomin, pixelize, hblur, distance,
squeezeh, squeezev, diagtl, diagbr, hlslice, hrslice, hlwind, hrwind (lista exacta: `catalog`)
### Audio (`afx`)
`"telefono"` o `{"preset": "eco", "pan": -0.3}` — telefono, radio, bajo_agua, lejano, eco, sala, catedral, graves, brillo, megafono, robot
### Textos
Plantillas: titulo, lower, impacto, etiqueta, cita, simple, caja, maquina, neon, contador, subtitulo, terror.
Animaciones: fade, pop, bounce, slide, drop, zoom, blur, typewriter, flicker, shake, wide, none.

Ejemplo:
```json
[
  {"op": "set_fx", "all": true, "fx": {"look": "cine"}},
  {"op": "set_fx", "id": 0, "fx": {"motion": {"type": "zoomin", "amount": 0.2}}},
  {"op": "set_transition", "id": 3, "type": "fadewhite", "dur": 0.3},
  {"op": "add_fx", "type": "flash", "start": 8.16},
  {"op": "add_sfx", "query": "boom grave", "start": 8.16, "volume": 0.9},
  {"op": "add_text", "template": "impacto", "text": "VUELVE.", "start": 8.2, "dur": 1.6},
  {"op": "set_role_volume", "role": "music", "factor": 0.7}
]
```

## Receta (`build`)
```json
{
  "name": "Mi vídeo", "aspect": "9:16", "fps": 30, "fit": "cover", "look": "cine",
  "clips": ["C:/a.mp4", {"file": "C:/b.mp4", "in": 1, "out": 4, "fx": {"motion": "zoomin"}, "transition": {"type": "fade", "dur": 0.4}, "muted": true}],
  "audio": [{"file": "C:/musica.wav", "start": 0, "volume": 0.8, "role": "music"}],
  "sfx": [{"start": 2.3, "query": "whoosh", "volume": 0.7}, {"start": 8.16, "file": "C:/boom.wav"}],
  "texts": [{"template": "titulo", "text": "Hola", "start": 0, "dur": 2}],
  "fx": [{"type": "flash", "start": 8.16}],
  "narration": [{"text": "Texto", "start": 0.5}],
  "script": "guion (opcional)", "viralis": {"run": "...", "n": 1}
}
```

## Detalles
- Caplis vigila `bridge/inbox.json`; el conector escribe ahí (`reload` recarga el proyecto abierto conservando el cursor).
- Versiones: `proyectos/.versiones/<nombre>/` (`index.json` + `vNNNN.json`). Antes de cada cambio de Claude, si tú habías
  tocado el proyecto a mano, esos cambios se guardan como versión propia: nunca se pierde nada.
- `CAPLIS_OFFSCREEN=1` abre la ventana fuera de pantalla (pruebas).
