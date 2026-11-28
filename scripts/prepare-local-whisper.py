"""Prepare the CPU speech environment and verify each file of a pinned Whisper model."""

import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile
from urllib.request import urlopen
import venv

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    'tiny': (
        'd90ca5fe260221311c53c58e660288d3deb8d356',
        2249,
        '3baa18e2b321a2f489614607852a729fcd516480',
        75538270,
        'dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1',
    ),
    'base': (
        'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',
        2309,
        '867cf1a0fece1394e01d55e287ba2f09a577c046',
        145217532,
        'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9',
    ),
    'small': (
        '536b0662742c02347bc0e980a01041f333bce120',
        2370,
        'e5047537059bd8f182d9ca64c470201585015187',
        483546902,
        '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
    ),
}
REQUIREMENTS = [
    'faster-whisper==1.2.1',
    'av==15.1.0',  # faster-whisper 1.2.1 still calls av.open(metadata_errors=...).
    'starlette==1.10.0',
    'uvicorn==0.54.0',
    'python-multipart==0.0.32',
]


def verified(file, size, digest):
    if not file.is_file() or file.stat().st_size != size:
        return False
    hasher = hashlib.sha256() if len(digest) == 64 else hashlib.sha1(f'blob {size}\0'.encode())
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest() == digest


def prepare_model(name, directory, download):
    revision, cfg_size, cfg_hash, size, digest = MODELS[name]
    files = [
        ('config.json', cfg_size, cfg_hash),
        ('tokenizer.json', 2203239, '7818adb6de9fa3064d3ff81226fdd675be1f6344'),
        ('vocabulary.txt', 459861, 'c9074644d9d1205686f16d411564729461324b75'),
        ('model.bin', size, digest),
    ]
    for filename, length, expected in files:
        target = directory / filename
        if verified(target, length, expected):
            continue
        if not download:
            raise ValueError(f'Missing or invalid model file: {target}')
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            staged = Path(temporary) / filename
            url = f'https://huggingface.co/Systran/faster-whisper-{name}/resolve/{revision}/{filename}'
            with urlopen(url, timeout=90) as source, staged.open('xb') as dest:
                remaining = length
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    dest.write(chunk)
                    remaining -= len(chunk)
                if remaining or source.read(1):
                    raise ValueError(f'Unexpected size for {filename}')
            if not verified(staged, length, expected):
                raise ValueError(f'Unexpected digest for {filename}')
            staged.replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=MODELS, default='small')
    parser.add_argument('--model-directory', type=Path)
    parser.add_argument('--python', type=Path, help='Use an existing speech environment')
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    base = ROOT / 'state/local-whisper'
    directory = (args.model_directory or base / 'models' / args.model).resolve()
    python = (args.python or base / 'venv/Scripts/python.exe').resolve()
    if not args.python and not python.exists() and args.download:
        venv.EnvBuilder(with_pip=True).create(base / 'venv')
    if args.download:
        subprocess.run([str(python), '-m', 'pip', 'install', *REQUIREMENTS], check=True)
    subprocess.run([str(python), '-IB', '-c', 'import faster_whisper, starlette, uvicorn, multipart'], check=True)
    prepare_model(args.model, directory, args.download)
    subprocess.run(
        [str(python), '-IB', str(ROOT / 'scripts/local-whisper.py'), '--model-dir', str(directory), '--check'],
        check=True,
    )
    print(f'Python: {python}\nModel: {directory}')


if __name__ == '__main__':
    main()
