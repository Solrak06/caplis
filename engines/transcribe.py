#!/usr/bin/env python
# Transcribe audio/video a subtitulos con faster-whisper (100% local, modelos en cache).
# Uso: python transcribe.py --input <archivo> [--model small|medium|large-v3] [--lang es|en|auto] --output <json>
import argparse, json, sys, os, subprocess, tempfile

def load_audio_16k(path):
    # Decodifica a 16 kHz mono float32 con ffmpeg + soundfile (evita PyAV, que es incompatible).
    import soundfile as sf
    import numpy as np
    ff = os.environ.get('CAPLIS_FFMPEG', 'ffmpeg')
    tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    tmp.close()
    subprocess.run([ff, '-y', '-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp.name], check=True)
    data, sr = sf.read(tmp.name, dtype='float32')
    try: os.unlink(tmp.name)
    except Exception: pass
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data), sr

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--model', default='small')
    ap.add_argument('--lang', default='auto')
    ap.add_argument('--output', required=True)
    ap.add_argument('--maxchars', type=int, default=42)
    a = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print('ERROR: faster-whisper no esta instalado (pip install faster-whisper). ' + str(e), file=sys.stderr)
        sys.exit(2)

    print('Decodificando audio...', file=sys.stderr, flush=True)
    audio, _ = load_audio_16k(a.input)

    print(f'Cargando modelo {a.model}...', file=sys.stderr, flush=True)
    model = WhisperModel(a.model, device='cpu', compute_type='int8')

    lang = None if a.lang == 'auto' else a.lang
    print('Transcribiendo...', file=sys.stderr, flush=True)
    segments, info = model.transcribe(
        audio, language=lang, vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=400),
        word_timestamps=True, beam_size=5,
    )

    total = max(0.1, info.duration)
    out = []
    def flush(words):
        if not words:
            return
        text = ''.join(w.word for w in words).strip()
        if text:
            out.append({'start': round(words[0].start, 3), 'end': round(words[-1].end, 3), 'text': text})

    # Agrupa palabras en lineas de subtitulo de longitud razonable (<= maxchars, corte en pausa o puntuacion)
    buf = []
    for seg in segments:
        words = seg.words or []
        if not words:
            if seg.text.strip():
                out.append({'start': round(seg.start, 3), 'end': round(seg.end, 3), 'text': seg.text.strip()})
            print(f'PROGRESS {min(0.99, seg.end/total):.3f}', file=sys.stderr, flush=True)
            continue
        for w in words:
            buf.append(w)
            cur = ''.join(x.word for x in buf).strip()
            gap = (w.end - buf[-2].end) if len(buf) >= 2 else 0
            if len(cur) >= a.maxchars or w.word.strip().endswith(('.', '?', '!', '…', ':')) or gap > 0.7:
                flush(buf); buf = []
        print(f'PROGRESS {min(0.99, seg.end/total):.3f}', file=sys.stderr, flush=True)
    flush(buf)

    with open(a.output, 'w', encoding='utf-8') as f:
        json.dump({'language': info.language, 'duration': info.duration, 'segments': out}, f, ensure_ascii=False)
    print('PROGRESS 1.000', file=sys.stderr, flush=True)
    print(f'OK {len(out)} lineas, idioma {info.language}', file=sys.stderr, flush=True)

if __name__ == '__main__':
    main()
