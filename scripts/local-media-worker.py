"""Bounded offline audio/video decoding. Never plays or sends."""
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

MAX_BYTES = 64 * 1024 * 1024
MAX_SECONDS = 300
MAX_PCM = MAX_SECONDS * 24000 * 2


def ordinary(file):
    file = Path(file)
    if not file.is_absolute() or str(file).startswith(('\\\\', '//')):
        raise ValueError('MEDIA_PATH_INVALID')
    for item in (file, *file.parents):
        if item.is_symlink() or getattr(item, 'is_junction', lambda: False)():
            raise ValueError('MEDIA_LINK_REJECTED')
    return file.resolve()


def finite_duration(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= MAX_SECONDS:
        raise ValueError('MEDIA_DURATION_UNSUPPORTED')
    return float(value)


def sampled_times(duration, maximum=4):
    duration = finite_duration(duration)
    if type(maximum) is not int or not 1 <= maximum <= 4:
        raise ValueError('MEDIA_FRAME_LIMIT')
    count = min(maximum, max(1, math.ceil(duration / 2)))
    return [round(duration * (index + .5) / count, 3) for index in range(count)]


class LimitedBytes(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_PCM:
            raise ValueError('MEDIA_AUDIO_LIMIT')
        return super().write(data)


def decode_silk(data, output):
    if not data.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
        raise ValueError('MEDIA_AUDIO_FORMAT_UNSUPPORTED')
    import pysilk
    pcm = LimitedBytes()
    pysilk.decode(io.BytesIO(data), pcm, 24000)
    if not pcm.tell() or pcm.tell() % 2:
        raise ValueError('MEDIA_AUDIO_DECODE_FAILED')
    finite_duration(pcm.tell() / 48000)
    with wave.open(str(output), 'wb') as wav:
        wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000);wav.writeframes(pcm.getvalue())


def process(request):
    if not isinstance(request, dict) or request.get('version') != 1 or request.get('kind') not in ('audio', 'video'):
        raise ValueError('MEDIA_REQUEST_INVALID')
    source = ordinary(request.get('path', ''))
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError('MEDIA_SOURCE_LIMIT')
    with source.open('rb') as stream:data=stream.read(MAX_BYTES+1)
    if not 0<len(data)<=MAX_BYTES:
        raise ValueError('MEDIA_SOURCE_LIMIT')
    sha = hashlib.sha256(data).hexdigest()
    if request.get('sha256') != sha:
        raise ValueError('MEDIA_SOURCE_CHANGED')
    ffmpeg = ordinary(request.get('ffmpeg', ''))
    if not ffmpeg.is_file():
        raise ValueError('MEDIA_FFMPEG_UNAVAILABLE')
    with tempfile.TemporaryDirectory(prefix='wechat-media-') as temporary:
        # Decode the already-hashed bytes, never reopen an external path after validation.
        source = Path(temporary) / 'source.bin'
        source.write_bytes(data)
        wav = Path(temporary) / 'audio.wav'
        if request['kind'] == 'audio' and data.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
            decode_silk(data, wav)
            with wave.open(str(wav)) as stream:
                duration = finite_duration(stream.getnframes() / stream.getframerate())
            result = {'version': 1, 'kind': 'audio', 'sourceSha256': sha, 'durationMs': round(duration * 1000), 'frames': [], 'audioPresent': True}
        else:
            if request['kind'] == 'video' and (len(data) < 12 or data[4:8] != b'ftyp'):
                raise ValueError('MEDIA_VIDEO_FORMAT_UNSUPPORTED')
            if request['kind'] == 'audio' and not (data[:4] == b'RIFF' and data[8:12] == b'WAVE' or data.startswith(b'#!AMR')):
                raise ValueError('MEDIA_AUDIO_FORMAT_UNSUPPORTED')
            input_format = 'mov' if request['kind'] == 'video' else 'wav' if data[:4] == b'RIFF' else 'amr'
            input_options = {'protocol_whitelist': 'file,pipe'}
            if request['kind'] == 'video':
                # Keep external MP4 track/file references disabled explicitly.
                input_options.update(enable_drefs='0', use_absolute_path='0')
            import av
            with av.open(str(source), mode='r', format=input_format, options=input_options) as container:
                duration = finite_duration(container.duration / av.time_base if container.duration else 0)
                videos, audios = list(container.streams.video), list(container.streams.audio)
                if request['kind'] == 'video' and (len(videos) != 1 or videos[0].width * videos[0].height > 3840 * 2160):
                    raise ValueError('MEDIA_VIDEO_STREAM_UNSUPPORTED')
                if len(audios) > 1:
                    raise ValueError('MEDIA_AUDIO_STREAM_AMBIGUOUS')
            result = {'version': 1, 'kind': request['kind'], 'sourceSha256': sha, 'durationMs': round(duration * 1000), 'audioPresent': bool(audios), 'frames': []}
            common = [str(ffmpeg), '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-f', input_format]
            if request['kind'] == 'video':common += ['-enable_drefs', '0', '-use_absolute_path', '0']
            common += ['-i', str(source)]
            if request['kind'] == 'video':
                for at in sampled_times(duration, request.get('maxFrames', 4)):
                    frame = subprocess.run(common + ['-ss', str(at), '-frames:v', '1', '-vf', r'scale=min(640\,iw):-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], capture_output=True, timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    if frame.returncode or not frame.stdout.startswith(b'\xff\xd8') or len(frame.stdout) > 768 * 1024:
                        raise ValueError('MEDIA_VIDEO_FRAME_FAILED')
                    result['frames'].append({'atMs': round(at * 1000), 'mime': 'image/jpeg', 'b64': base64.b64encode(frame.stdout).decode(), 'sha256': hashlib.sha256(frame.stdout).hexdigest()})
            if audios:
                audio = subprocess.run(common + ['-map', '0:a:0', '-vn', '-t', str(MAX_SECONDS), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', str(wav)], capture_output=True, timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                if audio.returncode or not wav.is_file() or wav.stat().st_size > MAX_PCM:
                    raise ValueError('MEDIA_AUDIO_DECODE_FAILED')
        result['transcript'] = {'status': 'no_audio', 'text': '', 'segments': [], 'automated': True}
        if result['audioPresent']:
            if wav.stat().st_size > MAX_PCM + 4096:
                raise ValueError('MEDIA_AUDIO_LIMIT')
            result['decodedWav'] = base64.b64encode(wav.read_bytes()).decode('ascii')
        result['semanticAnalysis'] = 'not_performed'
        return result


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError('MEDIA_REQUEST_LIMIT')
        result = process(json.loads(raw))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('MEDIA_') else 'MEDIA_PROCESS_FAILED'
        print(json.dumps({'error': code}), file=sys.stderr)
        sys.exit(1)
