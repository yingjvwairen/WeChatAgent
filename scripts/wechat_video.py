"""Message-bound previews from the selected account's local media cache."""

import base64
import hashlib
import io
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import wave
from pathlib import Path
from xml.etree import ElementTree

MAX_BYTES = 64 * 1024 * 1024
MAX_AUDIO_SECONDS = 300
SEGMENT_SECONDS = 60


class VideoWithoutAudio(RuntimeError):
    def __init__(self):
        super().__init__('VOICE_VIDEO_NO_AUDIO')


def audio_segment(raw, segment=0):
    if type(segment) is not int or not 0 <= segment < 5:
        raise ValueError('VOICE_SEGMENT_INVALID')
    with wave.open(io.BytesIO(raw)) as source:
        if source.getparams()[:3] != (1, 2, 16000) or source.getcomptype() != 'NONE':
            raise ValueError('VOICE_FORMAT_UNSUPPORTED')
        frames = source.getnframes()
        if not 0 < frames <= MAX_AUDIO_SECONDS * 16000:
            raise ValueError('VOICE_VIDEO_AUDIO_LIMIT')
        count = math.ceil(frames / (SEGMENT_SECONDS * 16000))
        if segment >= count:
            raise ValueError('VOICE_SEGMENT_INVALID')
        source.setpos(segment * SEGMENT_SECONDS * 16000)
        pcm = source.readframes(SEGMENT_SECONDS * 16000)
    output = io.BytesIO()
    with wave.open(output, 'wb') as target:
        target.setparams((1, 2, 16000, 0, 'NONE', ''))
        target.writeframes(pcm)
    return (
        output.getvalue(),
        len(pcm) / 32000,
        {'segmentIndex': segment, 'segmentCount': count, 'totalDurationSeconds': frames / 16000},
    )


def frame_count(seconds):
    return min(4, max(1, math.ceil(seconds / 2)))


def video_metadata(text):
    if not isinstance(text, str) or len(text) > 65536 or re.search(r'<!DOCTYPE|<!ENTITY', text, re.I):
        return None
    try:
        root = ElementTree.fromstring(text)
        video = root.find('videomsg')
        if root.tag != 'msg' or video is None:
            return None
        declared = video.get('playlength')
        seconds = float(declared) if declared else None
        hashes = [video.attrib.get(key, '').lower() for key in ('newmd5', 'md5', 'rawmd5')]
        hashes = list(dict.fromkeys(value for value in hashes if re.fullmatch('[0-9a-f]{32}', value)))
        if not hashes or (seconds is not None and not 0 < seconds <= MAX_AUDIO_SECONDS):
            return None
        return {
            'durationSeconds': seconds,
            'hashes': hashes,
            'frames': frame_count(seconds) if seconds is not None else 1,
        }
    except (ValueError, ElementTree.ParseError):
        return None


def linked(path):
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def bound_bytes(account, talker, hashes, kind='video', *, resource_names=()):
    directories = [account / 'msg/attach' / hashlib.md5(talker.encode()).hexdigest()]
    if kind == 'video':
        directories.append(account / 'msg/video')
    elif kind == 'audio':
        directories.extend(account / ('msg/' + name) for name in ('audio', 'voice'))
    names = set(hashes).union(resource_names)
    deadline, seen, best, match = time.monotonic() + 2, 0, len(hashes), None
    suffixes = {
        'video': ('.mp4', '.dat', ''),
        'image': ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.dat'),
        'sticker': ('.gif', '.png', '.webp', '.dat'),
        'audio': ('.wav', '.silk', '.amr', '.dat', ''),
    }[kind]
    limit = MAX_BYTES if kind == 'video' else 8 * 1024 * 1024
    for directory in directories:
        if any(linked(part) for part in (directory, *directory.parents)):
            raise ValueError('VIDEO_LINK_REJECTED')
        for parent, folders, files in os.walk(directory, followlinks=False):
            parent = Path(parent)
            seen += len(folders) + len(files)
            if seen > 5000 or time.monotonic() > deadline:
                raise ValueError('VIDEO_LOOKUP_LIMIT')
            folders[:] = [f for f in folders if len(parent.relative_to(directory).parts) < 3 and not linked(parent / f)]
            for name in files:
                path = parent / name
                if path.suffix.lower() not in suffixes or path.stem.lower().removesuffix('_raw') not in names:
                    continue
                if linked(path) or not path.is_file() or not 0 < path.stat().st_size <= limit:
                    continue
                with path.open('rb') as stream:
                    raw = stream.read(limit + 1)
                if not 0 < len(raw) <= limit or kind == 'video' and raw[4:8] != b'ftyp':
                    continue
                digest = hashlib.md5(raw).hexdigest()
                if digest not in hashes:
                    continue
                priority = hashes.index(digest)
                if priority == best and raw != match:
                    raise ValueError('VIDEO_AMBIGUOUS')
                if priority < best:
                    best, match = priority, raw
        if best == 0:
            break
    if match is None:
        raise ValueError('VIDEO_NOT_DOWNLOADED')
    return match


def decode(raw, count, *, audio=False, metadata_only=False):
    import av

    options = {'protocol_whitelist': 'pipe', 'enable_drefs': '0', 'use_absolute_path': '0'}
    with av.open(io.BytesIO(raw), format='mov', options=options) as movie:
        seconds = movie.duration / av.time_base if movie.duration else 0
        if not 0 < seconds <= 300 or len(movie.streams.video) != 1:
            raise ValueError('VIDEO_FORMAT_UNSUPPORTED')
        video = movie.streams.video[0]
        if not 0 < video.width <= 3840 or not 0 < video.height <= 3840 or video.width * video.height > 3840 * 2160:
            raise ValueError('VIDEO_DIMENSIONS_UNSUPPORTED')
        if metadata_only:
            return {'durationSeconds': seconds, 'audioPresent': bool(movie.streams.audio)}
        if audio:
            if not movie.streams.audio:
                raise VideoWithoutAudio()
            if len(movie.streams.audio) != 1:
                raise ValueError('VOICE_VIDEO_AUDIO_UNAVAILABLE')
            return decode_audio(movie)
        results = []
        for n in range(count):
            target = seconds * (n + 0.5) / count
            movie.seek(int(target * av.time_base))
            for frame in movie.decode(video):
                if frame.time is None or frame.time < target - 0.2:
                    continue
                image = frame.to_image()
                image.thumbnail((640, 640))
                result = io.BytesIO()
                image.convert('RGB').save(result, format='JPEG', quality=80)
                data = result.getvalue()
                if len(data) > 768 * 1024:
                    raise ValueError('VIDEO_FRAME_LIMIT')
                results.append(
                    {
                        'sourceQuality': 'video-frame',
                        'atMs': round(frame.time * 1000),
                        'mime': 'image/jpeg',
                        'sha256': hashlib.sha256(data).hexdigest(),
                        'b64': base64.b64encode(data).decode(),
                    }
                )
                break
            else:
                raise ValueError('VIDEO_FRAME_UNAVAILABLE')
        return results


def decode_audio(movie):
    import av

    resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
    output = io.BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', ''))

        def write(frame):
            for converted in resampler.resample(frame):
                if wav.tell() + converted.samples > MAX_AUDIO_SECONDS * 16000:
                    raise ValueError('VOICE_VIDEO_AUDIO_LIMIT')
                wav.writeframesraw(bytes(converted.planes[0])[: converted.samples * 2])

        for frame in movie.decode(audio=0):
            write(frame)
        write(None)
        if not wav.tell():
            raise ValueError('VOICE_VIDEO_AUDIO_UNAVAILABLE')
        seconds = wav.tell() / 16000
    return output.getvalue(), seconds


def decode_isolated(raw, count, *, audio=False, kind='video'):
    mode = ('audio' if audio else 'frames') if kind == 'video' else 'forward-audio' if kind == 'audio' else kind
    result = subprocess.run(
        [sys.executable, '-I', '-B', __file__, mode, str(count)],
        input=raw,
        capture_output=True,
        timeout=3 if mode == 'duration' else 10,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    if mode == 'audio' and result.returncode == 3:
        raise VideoWithoutAudio()
    if result.returncode or len(result.stdout) > (MAX_AUDIO_SECONDS * 32000 + 4096 if audio else 5 * 1024 * 1024):
        raise ValueError('VIDEO_DECODE_UNAVAILABLE')
    if audio:
        with wave.open(io.BytesIO(result.stdout)) as wav:
            return result.stdout, wav.getnframes() / 16000
    return json.loads(result.stdout)


class VideoPreviews:
    def __init__(self, reader):
        self.reader = reader
        self.lock = threading.Lock()
        self.cache_key = self.frames = None
        self.audio_key = self.audio = None

    def read(self, record, *, audio=False, metadata_only=False):
        from reader_message_binding import MessageBinding

        reader, talker = self.reader, record['talker']

        def active():
            if not reader.sticker_account_active() or not reader.image_talker_allowed(talker):
                raise PermissionError('VIDEO_ACCESS_REVOKED')

        binding = MessageBinding(
            reader, record, error_code='FORWARD_MESSAGE_CHANGED' if 'forwardPart' in record else 'VIDEO_MESSAGE_CHANGED'
        )
        source = binding.row['fullText']
        part = record.get('forwardPart')
        original = None
        if part:
            from wechat_forwarded import parse_forwarded_record

            parts = []
            if (
                not source
                or hashlib.sha256(source.encode()).hexdigest() != record['parentSha256']
                or not parse_forwarded_record(source, media=parts)
                or part not in parts
            ):
                raise ValueError('FORWARD_MESSAGE_CHANGED')
            kind = part['kind']
            meta = {'hashes': part['hashes'], 'frames': 1}
            from wechat_reference_media import forwarded_original_row

            original = forwarded_original_row(reader, talker, part)
        else:
            kind = 'video'
            meta = video_metadata(source)
        if not meta or not part and meta != record['video']:
            raise ValueError('VIDEO_MESSAGE_CHANGED')
        if not self.lock.acquire(timeout=0 if metadata_only else 5):
            raise ValueError('VIDEO_PROCESS_BUSY')
        try:
            active()

            def resource_hints():
                names = reader.resource_names(record)
                if original:
                    names = names.union(reader.resource_names(original))
                return names

            if part and kind in ('image', 'sticker'):
                from wechat_nested_media import resolve_nested_bytes

                raw = resolve_nested_bytes(
                    reader.account,
                    talker,
                    meta['hashes'],
                    reader.own_wxid,
                    resource_names=resource_hints(),
                    thumbnails=part.get('thumbnailHashes', ()),
                )
            else:
                raw = bound_bytes(reader.account, talker, meta['hashes'], kind, resource_names=resource_hints())
            count = record.get('frameCount', meta['frames'])
            key = (str(reader.account), talker, record['serverId'], hashlib.sha256(raw).digest(), kind, count)
            if metadata_only:
                result = decode_isolated(raw, 1, kind='duration')
            elif audio:
                if key != self.audio_key:
                    self.audio = decode_isolated(raw, count, audio=True, kind=kind)
                    self.audio_key = key
                result = self.audio
            else:
                if key != self.cache_key:
                    self.frames = decode_isolated(raw, count, kind=kind)
                    self.cache_key = key
                result = dict(self.frames[record['frame']])
                if part:
                    result['forwardItem'] = part['index'] + 1
                    if 'thumbnailHashes' in part and hashlib.md5(raw).hexdigest() in part['thumbnailHashes']:
                        result['sourceQuality'] = 'thumbnail'
            active()
            binding.verify()
            if original is not None and forwarded_original_row(reader, talker, part) != original:
                raise ValueError('FORWARD_REFERENCE_CHANGED')
            return result
        finally:
            self.lock.release()


if __name__ == '__main__':
    mode, count = sys.argv[1], int(sys.argv[2])
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if (
        mode not in ('frames', 'duration', 'audio', 'forward-audio', 'image', 'sticker')
        or not 1 <= count <= 4
        or not 0 < len(raw) <= MAX_BYTES
    ):
        sys.exit(1)
    if mode in ('image', 'sticker'):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from wechat_image_normalize import normalize_image, decode_image_source

        sys.stdout.buffer.write(
            json.dumps(
                [
                    normalize_image(
                        decode_image_source(raw), animated=True, max_side=2048, max_source_bytes=32 * 1024 * 1024
                    )
                ]
            ).encode()
        )
    elif mode == 'forward-audio':
        if raw.startswith((b'#!SILK_V3', b'\x02#!SILK_V3')):
            import runpy

            decoded = runpy.run_path(str(Path(__file__).with_name('decode-wechat-voice.py')))['decode'](raw)
            sys.stdout.buffer.write(base64.b64decode(decoded['b64'], validate=True))
        else:
            import av

            format = (
                'wav'
                if raw.startswith(b'RIFF') and raw[8:12] == b'WAVE'
                else 'amr'
                if raw.startswith(b'#!AMR')
                else None
            )
            if not format:
                sys.exit(1)
            with av.open(io.BytesIO(raw), format=format, options={'protocol_whitelist': 'pipe'}) as sound:
                sys.stdout.buffer.write(decode_audio(sound)[0])
    else:
        try:
            decoded = decode(raw, count, audio=mode == 'audio', metadata_only=mode == 'duration')
        except VideoWithoutAudio:
            sys.exit(3)
        sys.stdout.buffer.write(decoded[0] if mode == 'audio' else json.dumps(decoded).encode())
