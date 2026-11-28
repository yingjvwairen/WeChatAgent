"""Prepare the optional Dania GPT-SoVITS installation for the local speech service."""

import argparse
import ast
import concurrent.futures
from contextlib import closing
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

PLAN = json.loads(Path(__file__).with_name('dania-models.json').read_text(encoding='utf-8'))

# PyYAML belongs to the isolated inference environment.
UPDATE_ENGINE_VERSION = """
import sys
from pathlib import Path
import yaml

config = Path(sys.argv[1])
data = yaml.safe_load(config.read_text(encoding="utf-8-sig"))
if data["custom"].get("version") != "v2ProPlus":
    data["custom"]["version"] = "v2ProPlus"
    temporary = config.with_suffix(".tmp")
    temporary.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    temporary.replace(config)
"""


def run(args):
    subprocess.run([str(part) for part in args], check=True)


def valid_file(file, item):
    if not file.is_file() or file.stat().st_size != item['size']:
        return False
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256']


class Installation:
    def __init__(self, directory, proxy=''):
        self.directory = directory.resolve()
        self.engine = self.directory / 'gpt-sovits'
        self.python = self.directory / 'venv/Scripts/python.exe'
        self.profiles = self.directory / 'dania.profiles.json'
        self.proxy = proxy
        handler = (
            urllib.request.ProxyHandler({'http': proxy, 'https': proxy}) if proxy else urllib.request.ProxyHandler()
        )
        self.http = urllib.request.build_opener(handler)

    def fetch_artifact(self, item):
        destination = (self.engine / item['path']).resolve()
        if not destination.is_relative_to(self.engine.resolve()):
            raise RuntimeError('Artifact destination escapes engine directory')
        destination.parent.mkdir(parents=True, exist_ok=True)
        if valid_file(destination, item):
            return destination
        partial = destination.with_suffix(destination.suffix + '.part')
        if partial.exists() and partial.stat().st_size >= item['size']:
            if valid_file(partial, item):
                partial.replace(destination)
                return destination
            partial.unlink()
        for attempt in range(3):
            position = partial.stat().st_size if partial.exists() else 0
            headers = {'User-Agent': 'WeChatAgent-Dania-Setup/1'}
            if position:
                headers['Range'] = f'bytes={position}-'
            try:
                with self.http.open(urllib.request.Request(item['url'], headers=headers), timeout=60) as response:
                    if response.status == 206:
                        if not response.headers.get('Content-Range', '').startswith(f'bytes {position}-'):
                            raise RuntimeError('Unexpected download range')
                    elif response.status == 200:
                        position = 0
                    else:
                        raise RuntimeError(f'Unexpected HTTP status {response.status}')
                    last_report = 0
                    with partial.open('ab' if position else 'wb') as stream:
                        while block := response.read(1024 * 1024):
                            position += len(block)
                            if position > item['size']:
                                raise RuntimeError('Download exceeds pinned size')
                            stream.write(block)
                            if time.monotonic() - last_report > 10:
                                print(
                                    f'Downloading {item["path"]}: {position / 1048576:.1f}/{item["size"] / 1048576:.1f} MiB',
                                    flush=True,
                                )
                                last_report = time.monotonic()
                if position < item['size']:
                    raise OSError('Incomplete download')
                if not valid_file(partial, item):
                    partial.unlink(missing_ok=True)
                    raise OSError('Download integrity check failed')
                partial.replace(destination)
                print('Verified downloaded:', item['path'], flush=True)
                return destination
            except (urllib.error.URLError, TimeoutError, OSError) as failure:
                print(f'Download retry {attempt + 1}/3: {item["path"]} ({type(failure).__name__})', flush=True)
                if attempt == 2:
                    raise RuntimeError('Download failed: ' + item['path']) from None
                time.sleep(2)

    def ensure_source(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        if not self.engine.exists():
            command = ['git'] + (['-c', 'http.proxy=' + self.proxy] if self.proxy else [])
            with tempfile.TemporaryDirectory(prefix='engine-', dir=self.directory) as temporary:
                checkout = Path(temporary) / 'source'
                run(
                    command
                    + [
                        'clone',
                        '--no-checkout',
                        '--filter=blob:none',
                        'https://github.com/RVC-Boss/GPT-SoVITS.git',
                        checkout,
                    ]
                )
                run(command + ['-C', checkout, 'checkout', '--detach', PLAN['engineRevision']])
                checkout.rename(self.engine)
        actual = subprocess.check_output(['git', '-C', str(self.engine), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != PLAN['engineRevision']:
            raise RuntimeError('Engine checkout differs from reviewed source commit')

    def models(self):
        self.ensure_source()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            list(workers.map(self.fetch_artifact, PLAN['models']))

    def dependencies(self):
        self.ensure_source()
        if not self.python.exists():
            if sys.version_info[:2] != (3, 12):
                raise RuntimeError('Run setup with Python 3.12')
            run([sys.executable, '-m', 'venv', self.directory / 'venv'])
        pip = [self.python, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-cache-dir']
        if self.proxy:
            pip += ['--proxy', self.proxy]
        run(pip + ['--index-url', 'https://download.pytorch.org/whl/cu128', 'torch==2.8.0', 'torchaudio==2.8.0'])
        constraints = self.directory / 'constraints.txt'
        constraints.write_text('torch==2.8.0\ntorchaudio==2.8.0\n', encoding='utf-8')
        run(pip + ['--index-url', 'https://pypi.org/simple', '-c', constraints, *PLAN['requirements']])
        frozen = subprocess.check_output([str(self.python), '-m', 'pip', 'freeze'], text=True)
        (self.directory / 'installed-requirements.txt').write_text(frozen, encoding='utf-8')

    def configure(self):
        if not (self.engine / 'api_v2.py').is_file() or not self.python.is_file():
            raise RuntimeError('Prepare source and venv first')
        config = self.engine / 'GPT_SoVITS' / 'configs' / 'tts_infer.yaml'
        config.parent.mkdir(parents=True, exist_ok=True)
        # Preserve all other version presets in the upstream YAML. The managed
        # service copies the custom section before setting per-voice weights.
        run([self.python, '-I', '-c', UPDATE_ENGINE_VERSION, config])
        # Reviewed compatibility shim from the plugin installer: avoid compiling jieba_fast on Python 3.12.
        shim = self.directory / 'venv/Lib/site-packages/jieba_fast'
        shim.mkdir(parents=True, exist_ok=True)
        (shim / '__init__.py').write_text(
            'from jieba import *\nfrom jieba import setLogLevel, lcut, cut, cut_for_search, load_userdict, tokenize\n__version__ = "0.0.0-jieba-shim"\n',
            encoding='utf-8',
        )
        (shim / 'posseg.py').write_text(
            'from jieba import load_userdict\nfrom jieba.posseg import *\nfrom jieba.posseg import POSTokenizer, cut, dt, lcut\n',
            encoding='utf-8',
        )
        runtime = self.engine / 'runtime'
        runtime.mkdir(parents=True, exist_ok=True)
        ffmpeg = subprocess.check_output(
            [str(self.python), '-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], text=True
        ).strip()
        shutil.copy2(ffmpeg, runtime / 'ffmpeg.exe')
        self.save_profile()

    def save_profile(self):
        # A rerun must preserve an operator's edited voice settings.
        if self.profiles.exists():
            if 'dania' not in json.loads(self.profiles.read_text(encoding='utf-8-sig')):
                raise ValueError('The existing profile file does not contain the prepared voice: ' + str(self.profiles))
        else:
            temporary = self.profiles.with_suffix('.tmp')
            temporary.write_text(
                json.dumps({'dania': PLAN['profile']}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
            )
            temporary.replace(self.profiles)

    def resources(self):
        self.ensure_source()
        for item in PLAN['resources']:
            file = self.fetch_artifact(item)
            if 'extract' not in item:
                continue
            destination = (self.engine / item['extract']).resolve()
            if not destination.is_relative_to(self.engine):
                raise ValueError('Invalid resource extraction directory')
            prefix = item.get('prefix', '')
            with zipfile.ZipFile(file) as archive:
                if sum(entry.file_size for entry in archive.infolist()) > item['limit']:
                    raise ValueError('Resource archive exceeds extraction limit')
                if prefix:
                    # GPT-SoVITS imports this upstream config as a Python module.
                    for statement in ast.parse(archive.read(prefix + 'config.py')).body:
                        if not isinstance(statement, ast.Assign) or not all(
                            isinstance(t, ast.Name) for t in statement.targets
                        ):
                            raise ValueError('Unexpected G2PW configuration statement')
                        ast.literal_eval(statement.value)
                for entry in archive.infolist():
                    target = (destination / entry.filename.removeprefix(prefix)).resolve()
                    if not entry.filename.startswith(prefix) or not target.is_relative_to(destination):
                        raise ValueError('Invalid resource archive path')
                    if not entry.is_dir():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with archive.open(entry) as source, target.open('wb') as out:
                            shutil.copyfileobj(source, out)

    def check(self):
        run([self.python, '-m', 'pip', 'check'])
        run(
            [
                self.python,
                '-c',
                "import torch,torchaudio;print('torch',torch.__version__,'torchaudio',torchaudio.__version__,'cuda',torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')",
            ]
        )
        for item in (*PLAN['models'], *PLAN['resources']):
            if not valid_file(self.engine / item['path'], item):
                raise RuntimeError('Missing or changed model resource: ' + item['path'])
        profiles = json.loads(self.profiles.read_text(encoding='utf-8-sig'))
        for field in ('gptWeights', 'sovitsWeights', 'refAudio'):
            path = (self.engine / profiles['dania'][field]).resolve(strict=True)
            if not path.is_relative_to(self.engine) or not path.is_file():
                raise RuntimeError('Invalid prepared profile path: ' + field)
        print('Verified model weights and named voice profile.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    stages = ('dependencies', 'models', 'resources', 'configure', 'check')
    parser.add_argument('--stage', choices=('all', *stages), default='all')
    parser.add_argument(
        '--directory', type=Path, default=Path(__file__).resolve().parents[1] / 'state/local-gpt-sovits'
    )
    parser.add_argument('--proxy', default='')
    args = parser.parse_args()
    installation = Installation(args.directory, args.proxy)
    installation.directory.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(installation.directory / 'prepare.sqlite', timeout=0)) as lock:
        lock.execute('BEGIN IMMEDIATE')
        for stage in stages if args.stage == 'all' else (args.stage,):
            print('Preparing', stage, flush=True)
            getattr(installation, stage)()
    print('Python:', installation.python)
    print('Model directory:', installation.engine)
    print('Named profiles:', installation.profiles)


if __name__ == '__main__':
    main()
