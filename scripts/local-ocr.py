"""Read-only local RapidOCR CPU diagnostic. No downloads, UI actions or uploads.

Install the pinned packages into state/ocr/venv separately. Models and the
interpreter remain local runtime data; they are not bundled with source.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "state" / "ocr" / "venv"
MAX_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 12 * 1024 * 1024
MODEL_HASHES = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    "PP-OCRv6_rec_medium.onnx": "eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b",
}


def fail(code: str):
    raise RuntimeError(code)


def deny_network(event, args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.bind"}:
        fail("VISUAL_NETWORK_FORBIDDEN")


def check_runtime():
    if Path(sys.prefix).resolve() != RUNTIME.resolve():
        fail("VISUAL_ISOLATED_RUNTIME_REQUIRED")
    for name, expected in [("rapidocr", "3.10.0"), ("onnxruntime", "1.31.0")]:
        if importlib.metadata.version(name) != expected:
            fail("VISUAL_RUNTIME_VERSION_MISMATCH")


def checked_model(path: Path) -> str:
    if not path.is_file() or path.stat().st_size > 160 * 1024 * 1024:
        fail("VISUAL_MODEL_MISSING")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != MODEL_HASHES.get(path.name):
        fail("VISUAL_MODEL_HASH_MISMATCH")
    return str(path)


def load_image(file: str):
    from PIL import Image
    import numpy as np

    path = Path(file)
    if not path.is_absolute() or str(path).startswith(('\\\\', '//')) or not path.is_file():
        fail("VISUAL_ABSOLUTE_PATH_REQUIRED")
    with path.open("rb") as handle:
        payload = handle.read(MAX_BYTES + 1)
    if len(payload) < 24 or len(payload) > MAX_BYTES:
        fail("VISUAL_IMAGE_SIZE_INVALID")
    if not (payload.startswith(b"\x89PNG\r\n\x1a\n") or payload.startswith(b"\xff\xd8\xff")):
        fail("VISUAL_IMAGE_FORMAT_INVALID")
    with Image.open(io.BytesIO(payload)) as image:
        if image.format not in {"PNG", "JPEG"}:
            fail("VISUAL_IMAGE_FORMAT_INVALID")
        width, height = image.size
        if min(width, height) < 1 or max(width, height) > 4096 or width * height > MAX_PIXELS:
            fail("VISUAL_IMAGE_DIMENSIONS_INVALID")
        # Ignore EXIF orientation so returned coordinates refer to source pixels.
        pixels = np.array(image.convert("RGB"))[:, :, ::-1].copy()
    return pixels, hashlib.sha256(payload).hexdigest()


def create_engine(size: str):
    import rapidocr
    import onnxruntime

    onnxruntime.disable_telemetry_events()
    bundled = Path(rapidocr.__file__).resolve().parent / "models"
    recognizer = bundled / "PP-OCRv6_rec_small.onnx" if size == "small" else ROOT / "state" / "ocr" / "models" / "PP-OCRv6_rec_medium.onnx"
    engine = rapidocr.RapidOCR(params={
        "Global.log_level": "critical", "Global.model_root_dir": str(bundled),
        "Global.return_word_box": True, "Global.return_single_char_box": True,
        "Det.model_path": checked_model(bundled / "PP-OCRv6_det_small.onnx"),
        "Cls.model_path": checked_model(bundled / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
        "Rec.model_path": checked_model(recognizer),
        "Rec.model_type": rapidocr.ModelType.SMALL if size == "small" else rapidocr.ModelType.MEDIUM,
        "EngineConfig.onnxruntime.use_cuda": False,
        "EngineConfig.onnxruntime.use_dml": False,
        "EngineConfig.onnxruntime.use_cann": False,
        "EngineConfig.onnxruntime.use_coreml": False,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
    })
    # This pinned RapidOCR version loads ONNX sessions lazily. Explicitly load
    # all three before reporting worker readiness, so prewarm truly happens
    # before a caller acquires WeChat focus. No image is read during warmup.
    engine._load_det_model()
    engine._load_cls_model()
    engine._load_rec_model()
    return engine


def checked_region(value, width, height):
    if value is None:
        return None
    if (not isinstance(value, dict) or set(value) != {'left', 'top', 'right', 'bottom'}
            or any(type(value[key]) is not int for key in value)
            or not 0 <= value['left'] < value['right'] <= width
            or not 0 <= value['top'] < value['bottom'] <= height):
        fail('VISUAL_REGION_INVALID')
    return dict(value)


def preprocess_pixels(pixels, operation):
    if operation is None:
        return pixels
    if operation != 'gray-gamma-1.6':
        fail('VISUAL_PREPROCESS_INVALID')
    import numpy as np
    # Fixed pixel transform only: no identity text, adaptive thresholds,
    # resampling, character repair or changes to the OCR confidence scores.
    gray = np.round(pixels[:, :, 0] * .114 + pixels[:, :, 1] * .587 + pixels[:, :, 2] * .299).astype(np.uint8)
    table = np.round((np.arange(256) / 255.) ** 1.6 * 255).astype(np.uint8)
    return np.repeat(table[gray][:, :, None], 3, axis=2)


def recognize(pixels, digest: str, size: str, region=None, engine=None, preprocess=None):
    started = time.monotonic()
    source_height, source_width = pixels.shape[:2]
    pixels = preprocess_pixels(pixels, preprocess)
    region = checked_region(region, source_width, source_height)
    left, top = (region['left'], region['top']) if region else (0, 0)
    if region:
        pixels = pixels[top:region['bottom'], left:region['right']].copy()
    height, width = pixels.shape[:2]
    engine = engine if engine is not None else create_engine(size)
    result = engine(pixels)
    words = []
    if result.txts is not None:
        for line, entries in enumerate(result.word_results):
            if line >= 512:
                fail("VISUAL_OCR_RESULT_TOO_LARGE")
            for text, score, points in entries:
                if not isinstance(text, str) or not text or len(text) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in text):
                    fail("VISUAL_OCR_INVALID")
                points = [[float(p[0]), float(p[1])] for p in points]
                if not points or any(not math.isfinite(v) for p in points for v in p):
                    fail("VISUAL_OCR_BOUNDS_INVALID")
                # Character boxes are estimates. Clamp only subpixel rounding
                # at the source edge; never invent text or fill missing glyphs.
                x, y = min(p[0] for p in points), min(p[1] for p in points)
                right, bottom = max(p[0] for p in points), max(p[1] for p in points)
                if x < -1 or y < -1 or right > width + 1 or bottom > height + 1:
                    fail("VISUAL_OCR_BOUNDS_INVALID")
                x, y, right, bottom = max(0, x), max(0, y), min(width, right), min(height, bottom)
                if right <= x or bottom <= y or not math.isfinite(float(score)) or not 0 <= float(score) <= 1:
                    fail("VISUAL_OCR_BOUNDS_INVALID")
                words.append({"text": text, "line": line, "x": x + left, "y": y + top, "width": right - x, "height": bottom - y, "confidence": float(score)})
    if len(words) > 4096 or sum(len(w["text"]) for w in words) > 32768:
        fail("VISUAL_OCR_RESULT_TOO_LARGE")
    return {"ok": True, "mode": "ocr", "engine": "rapidocr", "model": "PP-OCRv6-" + size,
            "imageSha256": digest, "width": source_width, "height": source_height, "language": "zh-Hans-CN", "textAngle": 0,
            **({"region": region} if region else {}),
            **({"preprocess": preprocess} if preprocess is not None else {}),
            "words": words, "elapsedMs": round((time.monotonic() - started) * 1000),
            "readOnly": True, "inputSent": False, "networkDisabled": True, "provider": "CPUExecutionProvider"}


def serve(size):
    """Private stdin protocol. No listener, network endpoint or dynamic models."""
    started = time.monotonic()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        engine = create_engine(size)
    print(json.dumps({'version': 1, 'ready': True, 'model': size, 'runtime': 'rapidocr-3.10.0/onnxruntime-1.31.0',
        'modelsVerified': 'pinned-sha256-v1', 'networkDisabled': True, 'startupMs': round((time.monotonic() - started) * 1000)}), flush=True)
    for _ in range(10000):
        raw = sys.stdin.buffer.readline(8193)
        if not raw:
            return
        identifier = None
        try:
            if len(raw) > 8192 or not raw.endswith(b'\n'):
                fail('VISUAL_WORKER_PROTOCOL_INVALID')
            request = json.loads(raw)
            if (not isinstance(request, dict) or set(request) - {'version', 'id', 'image', 'imageSha256', 'region', 'preprocess'}
                    or type(request.get('version')) is not int or request['version'] != 1
                    or not isinstance(request.get('id'), str) or not re.fullmatch('[a-f0-9]{32}', request['id'])
                    or not isinstance(request.get('image'), str) or not 1 <= len(request['image']) <= 4096
                    or any(ord(c) < 32 for c in request['image'])
                    or 'region' in request and request['region'] is None
                    or 'preprocess' in request and request['preprocess'] != 'gray-gamma-1.6'
                    or not isinstance(request.get('imageSha256'), str) or not re.fullmatch('[a-f0-9]{64}', request['imageSha256'])):
                fail('VISUAL_WORKER_PROTOCOL_INVALID')
            identifier = request['id']
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                pixels, digest = load_image(request['image'])
                if digest != request['imageSha256']:
                    fail('VISUAL_IMAGE_CHANGED')
                result = recognize(pixels, digest, size, request.get('region'), engine=engine, preprocess=request.get('preprocess'))
            reply = {'version': 1, 'id': identifier, 'ok': True, 'result': result}
        except Exception as error:
            code = str(error)
            if not re.fullmatch(r'VISUAL_[A-Z0-9_]{1,64}', code):
                code = 'VISUAL_LOCAL_OCR_FAILED'
            reply = {'version': 1, 'id': identifier, 'ok': False, 'error': code}
        print(json.dumps(reply, ensure_ascii=True, separators=(',', ':')), flush=True)
        if identifier is None:
            return


def fixture(size: str):
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np

    image = Image.new("RGB", (1200, 800), "white")
    font = ImageFont.truetype(str(Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / "msyh.ttc"), 30)
    draw = ImageDraw.Draw(image)
    for text, point in [("搜索", (80, 40)), ("文件传输助手", (430, 40)), ("发送", (1080, 740))]:
        draw.text(point, text, font=font, fill="black")
    array = np.array(image)[:, :, ::-1].copy()
    result = recognize(array, hashlib.sha256(array.tobytes()).hexdigest(), size)
    found = "".join(word["text"] for word in result["words"])
    checks = {"matchedTitle": "文件传输助手" in found, "matchedSearch": "搜索" in found, "matchedSend": "发送" in found}
    if not all(checks.values()):
        fail("VISUAL_FIXTURE_OCR_FAILED")
    return {"ok": True, "fixtureTest": True, **checks, "uiAccessed": False, "inputSent": False, "networkDisabled": True}


def main():
    parser = argparse.ArgumentParser(description="Local offline OCR diagnostic")
    parser.add_argument("--image")
    parser.add_argument("--model", choices=["small", "medium"], default="small")
    parser.add_argument("--include-text", action="store_true")
    parser.add_argument("--region", help="Exact source-pixel rectangle JSON; original image identity and coordinates are retained")
    parser.add_argument("--preprocess", help="Optional fixed gray-gamma-1.6 transform; original image identity and coordinates are retained")
    parser.add_argument("--fixture-test", action="store_true")
    parser.add_argument("--worker", action="store_true")
    args = parser.parse_args()
    if args.preprocess is not None:
        if args.preprocess != 'gray-gamma-1.6':
            fail('VISUAL_PREPROCESS_INVALID')
        if not args.image or args.fixture_test:
            fail('VISUAL_ARGUMENTS_INVALID')
    region = None
    if args.region is not None:
        if not args.image or args.fixture_test or len(args.region) > 256:
            fail('VISUAL_ARGUMENTS_INVALID')
        try:
            region = json.loads(args.region)
        except ValueError:
            fail('VISUAL_REGION_INVALID')
        if region is None:
            fail('VISUAL_REGION_INVALID')
    check_runtime()
    sys.addaudithook(deny_network)
    if args.worker:
        if args.image or args.fixture_test or args.include_text or args.region is not None or args.preprocess is not None:
            fail('VISUAL_ARGUMENTS_INVALID')
        serve(args.model)
        return
    # Libraries may log model paths. They must not contaminate the JSON channel.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        if args.fixture_test:
            if args.image or args.include_text:
                fail("VISUAL_ARGUMENTS_INVALID")
            result = fixture(args.model)
        elif args.image:
            pixels, digest = load_image(args.image)
            result = recognize(pixels, digest, args.model, region, preprocess=args.preprocess)
            if not args.include_text:
                result["wordCount"] = len(result.pop("words"))
        else:
            result = {"ok": True, "engine": "rapidocr", "version": "3.10.0", "onnxruntime": "1.31.0", "readOnly": True, "inputSent": False, "networkDisabled": True}
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r"VISUAL_[A-Z0-9_]{1,64}", code):
            code = "VISUAL_LOCAL_OCR_FAILED"
        print(json.dumps({"ok": False, "error": code, "readOnly": True, "inputSent": False}))
        sys.exit(1)
