"""Prepare the optional, isolated Dania engine. Does not change DSH or audio settings.

Run with Python 3.12. Stages can be rerun:
  python scripts/dania-setup.py --stage models --proxy http://127.0.0.1:7897
  python scripts/dania-setup.py --stage dependencies --proxy http://127.0.0.1:7897
  python scripts/dania-setup.py --stage resources --proxy http://127.0.0.1:7897
  python scripts/dania-setup.py --stage configure
  python scripts/dania-setup.py --stage check
Source and artifacts are pinned below. No downloaded install script is executed.
"""
from __future__ import annotations
import argparse
import ast
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
INSTALL = PROJECT / "state" / "dania-voice"
ROOT = INSTALL / "gpt-sovits"
PYTHON = INSTALL / "venv" / "Scripts" / "python.exe"
SOURCE_COMMIT = "b4570b876f5c086819ba84e3215472733c6a7b70"
HF_REVISION = "8f8857563c040d542de108a2c18b0425abd6c9c5"
MS_REVISION = "3bfd54139e141702c1b4a4a744188d234df6620d"
NLTK_REVISION = "550b6625bcef1f2abff2ff770a5a0d272c9c6b2a"
NLTK_FILES = [
    ("taggers", "averaged_perceptron_tagger", 2526731, "e1f13cf2532daadfd6f3bc481a49859f0b8ea6432ccdcd83e6a49a5f19008de9"),
    ("taggers", "averaged_perceptron_tagger_eng", 1539115, "6025f530624335c67d6547d44757b357b4e79bae030a0383e9887a92c1718f0b"),
    ("corpora", "cmudict", 896069, "d07cca47fd72ad32ea9d8ad1219f85301eeaf4568f8b6b73747506a71fb5afd6"),
]
HF_FILES = [
    "s1v3.ckpt", "v2Pro/s2Gv2ProPlus.pth",
    "chinese-roberta-wwm-ext-large/pytorch_model.bin",
    "chinese-roberta-wwm-ext-large/config.json", "chinese-roberta-wwm-ext-large/tokenizer.json",
    "chinese-hubert-base/pytorch_model.bin", "chinese-hubert-base/config.json",
    "chinese-hubert-base/preprocessor_config.json", "sv/pretrained_eres2netv2w24s4ep4.ckpt",
]
MS_FILES = [
    ("dania-e15.ckpt", "GPT_SoVITS/dania-e15.ckpt", 155313312, "021de96fd53115fd5acac114d6be2c7cc1201bbf64e62f8985abbc76b35014c6"),
    ("dania_e16_s2192.pth", "GPT_SoVITS/dania_e16_s2192.pth", 172765299, "668b7ff9d01aeaa36acdff65b1126cb65a5f1ebf8f93c08108130b856b1030cd"),
    ("output.wav_0009342720_0009558400.wav", "output/slicer_opt/output.wav_0009342720_0009558400.wav", 431404, "98cde6a626505e531d0297b5e9ad99f0aec274077ef6bc9540c83dad89c945c8"),
]
DEPS = [
    "numpy<2.0", "scipy", "librosa==0.10.2", "transformers==4.51.3", "sentencepiece", "peft<0.18.0",
    "cn2an", "pypinyin", "g2p_en", "modelscope", "chardet", "PyYAML", "psutil", "jieba", "split-lang",
    "fast_langdetect>=0.3.1", "wordsegment", "rotary_embedding_torch", "ToJyutping", "ko_pron", "opencc",
    "fastapi", "uvicorn", "pydantic<=2.10.6", "ctranslate2>=4,<5", "av", "tqdm", "onnxruntime",
    "matplotlib", "ffmpeg-python", "pytorch-lightning>=2.4,<2.7", "torchmetrics<=1.5", "lightning-utilities",
    "x_transformers", "resampy", "python-multipart", "soundfile", "imageio-ffmpeg==0.6.0",
]

def atomic_json(file: Path, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(file)

def run(args, **kwargs):
    subprocess.run([str(part) for part in args], check=True, **kwargs)

def opener(proxy):
    return urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}) if proxy else urllib.request.ProxyHandler())

def hashes(file):
    sha = hashlib.sha256()
    git = hashlib.sha1(f"blob {file.stat().st_size}\0".encode())
    with file.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            sha.update(block); git.update(block)
    return sha.hexdigest(), git.hexdigest()

def fetch_artifact(item, proxy):
    destination = (ROOT / item["path"]).resolve()
    if not destination.is_relative_to(ROOT.resolve()):
        raise RuntimeError("Artifact destination escapes engine directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    def valid(file):
        if not file.is_file() or file.stat().st_size != item["size"]: return False
        sha, git = hashes(file)
        return sha == item["sha256"] if item.get("sha256") else git == item["gitBlob"]
    if valid(destination):
        print("Verified existing:", item["path"], flush=True)
        return {**item, "actualSha256": hashes(destination)[0]}
    partial = destination.with_suffix(destination.suffix + ".part")
    if destination.is_file() and destination.stat().st_size < item["size"] and not partial.exists():
        # Allows resuming an interrupted upstream automatic resource download.
        destination.replace(partial)
    if partial.exists() and partial.stat().st_size >= item["size"]:
        if valid(partial):
            partial.replace(destination); return {**item, "actualSha256": hashes(destination)[0]}
        partial.unlink()
    for attempt in range(3):
        position = partial.stat().st_size if partial.exists() else 0
        headers = {"User-Agent": "WeChatAgent-Dania-Setup/1"}
        if position: headers["Range"] = f"bytes={position}-"
        try:
            with opener(proxy).open(urllib.request.Request(item["url"], headers=headers), timeout=60) as response:
                if response.status == 206:
                    if not response.headers.get("Content-Range", "").startswith(f"bytes {position}-"):
                        raise RuntimeError("Unexpected download range")
                elif response.status == 200:
                    position = 0
                else: raise RuntimeError(f"Unexpected HTTP status {response.status}")
                last_report = 0
                with partial.open("ab" if position else "wb") as stream:
                    while block := response.read(1024 * 1024):
                        position += len(block)
                        if position > item["size"]: raise RuntimeError("Download exceeds pinned size")
                        stream.write(block)
                        if time.monotonic() - last_report > 10:
                            print(f"Downloading {item['path']}: {position / 1048576:.1f}/{item['size'] / 1048576:.1f} MiB", flush=True)
                            last_report = time.monotonic()
            if not valid(partial): raise RuntimeError("Download integrity check failed")
            partial.replace(destination)
            print("Verified downloaded:", item["path"], flush=True)
            return {**item, "actualSha256": hashes(destination)[0]}
        except (urllib.error.URLError, TimeoutError, OSError) as failure:
            print(f"Download retry {attempt + 1}/3: {item['path']} ({type(failure).__name__})", flush=True)
            if attempt == 2: raise RuntimeError("Download failed: " + item["path"]) from None
            time.sleep(2)

def ensure_source(proxy):
    INSTALL.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(INSTALL).free < 12 * 1024**3:
        raise RuntimeError("At least 12 GiB free space is required before setup")
    if not ROOT.exists():
        command = ["git"] + (["-c", "http.proxy=" + proxy] if proxy else [])
        run(command + ["clone", "--no-checkout", "--filter=blob:none", "https://github.com/RVC-Boss/GPT-SoVITS.git", ROOT])
        run(command + ["-C", ROOT, "checkout", "--detach", SOURCE_COMMIT])
    actual = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    if actual != SOURCE_COMMIT: raise RuntimeError("Engine checkout differs from reviewed source commit")

def models(proxy):
    ensure_source(proxy)
    api = f"https://huggingface.co/api/models/lj1995/GPT-SoVITS/revision/{HF_REVISION}?blobs=true"
    with opener(proxy).open(api, timeout=60) as response: metadata = json.load(response)
    if metadata["sha"] != HF_REVISION: raise RuntimeError("Unexpected model repository revision")
    listing = {entry["rfilename"]: entry for entry in metadata["siblings"]}
    artifacts = []
    for name in HF_FILES:
        info = listing[name]
        artifacts.append({"path": "GPT_SoVITS/pretrained_models/" + name,
            "url": f"https://huggingface.co/lj1995/GPT-SoVITS/resolve/{HF_REVISION}/{name}",
            "size": info["size"], "sha256": info.get("lfs", {}).get("sha256"), "gitBlob": info["blobId"]})
    for name, target, size, sha in MS_FILES:
        artifacts.append({"path": target, "url": f"https://www.modelscope.cn/models/villia/dania/resolve/{MS_REVISION}/{name}", "size": size, "sha256": sha})
    print(f"Pinned model download total: {sum(item['size'] for item in artifacts) / 1024**3:.2f} GiB", flush=True)
    atomic_json(INSTALL / "model-manifest.json", {"sourceCommit": SOURCE_COMMIT, "hfRevision": HF_REVISION, "modelScopeRevision": MS_REVISION, "artifacts": artifacts})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        completed = list(pool.map(lambda entry: fetch_artifact(entry, proxy), artifacts))
    atomic_json(INSTALL / "model-manifest.json", {"sourceCommit": SOURCE_COMMIT, "hfRevision": HF_REVISION, "modelScopeRevision": MS_REVISION, "verified": True, "artifacts": completed})

def dependencies(proxy):
    ensure_source(proxy)
    if not PYTHON.exists():
        if sys.version_info[:2] != (3, 12): raise RuntimeError("Run setup with Python 3.12")
        run([sys.executable, "-m", "venv", INSTALL / "venv"])
    pip = [PYTHON, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir"]
    if proxy: pip += ["--proxy", proxy]
    run(pip + ["--index-url", "https://download.pytorch.org/whl/cu128", "torch==2.8.0", "torchaudio==2.8.0"])
    constraints = INSTALL / "constraints.txt"
    constraints.write_text("torch==2.8.0\ntorchaudio==2.8.0\n", encoding="utf-8")
    run(pip + ["--index-url", "https://pypi.org/simple", "-c", constraints, *DEPS])
    frozen = subprocess.check_output([str(PYTHON), "-m", "pip", "freeze"], text=True)
    (INSTALL / "installed-requirements.txt").write_text(frozen, encoding="utf-8")

def configure():
    if not (ROOT / "api_v2.py").is_file() or not PYTHON.is_file(): raise RuntimeError("Prepare source and venv first")
    config = ROOT / "GPT_SoVITS" / "configs" / "tts_infer.yaml"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text("""custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: true
  t2s_weights_path: GPT_SoVITS/dania-e15.ckpt
  version: v2ProPlus
  vits_weights_path: GPT_SoVITS/dania_e16_s2192.pth
""", encoding="utf-8")
    # Reviewed compatibility shim from the plugin installer: avoid compiling jieba_fast on Python 3.12.
    shim = INSTALL / "venv/Lib/site-packages/jieba_fast"
    shim.mkdir(parents=True, exist_ok=True)
    (shim / "__init__.py").write_text('from jieba import *\nfrom jieba import setLogLevel, lcut, cut, cut_for_search, load_userdict, tokenize\n__version__ = "0.0.0-jieba-shim"\n', encoding="utf-8")
    (shim / "posseg.py").write_text('from jieba import load_userdict\nfrom jieba.posseg import *\nfrom jieba.posseg import POSTokenizer, cut, dt, lcut\n', encoding="utf-8")
    runtime = ROOT / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    ffmpeg = subprocess.check_output([str(PYTHON), "-c", "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())"], text=True).strip()
    shutil.copy2(ffmpeg, runtime / "ffmpeg.exe")
    atomic_json(INSTALL / "config.json", {
        "installDir": str(INSTALL), "root": str(ROOT), "pythonPath": str(PYTHON),
        "baseUrl": "http://127.0.0.1:9880", "autostart": False,
        "refAudio": "output/slicer_opt/output.wav_0009342720_0009558400.wav",
        "promptText": "怎么啊？如果有你在也不放心，那就干脆给我也装个限制器或者炸弹喽。",
        "promptLang": "zh", "textLang": "zh", "speed": 1, "temperature": 0.7,
        "topK": 10, "topP": 0.9, "repetitionPenalty": 1.35,
        "fragmentInterval": 0.4, "textSplitMethod": "cut2", "modelId": "dania-v2ProPlus",
        "gptWeights": "GPT_SoVITS/dania-e15.ckpt", "sovitsWeights": "GPT_SoVITS/dania_e16_s2192.pth",
    })
    print("Isolated engine configuration prepared; DSH settings unchanged.", flush=True)


def resources(proxy):
    g2pw = {"path": "GPT_SoVITS/text/G2PWModel_1.1.zip", "size": 588857174,
        "sha256": "b116f6930a7ee55eef6576a8d8e14bf40c1106583439e8ae924b901512379c64",
        "url": "https://www.modelscope.cn/models/kamiorinn/g2pw/resolve/827f4a519b083e3f37c790c938300241e75692d5/G2PWModel_1.1.zip"}
    fetch_artifact(g2pw, proxy)
    with zipfile.ZipFile(ROOT / g2pw["path"]) as archive:
        if sum(entry.file_size for entry in archive.infolist()) > 1024**3:
            raise RuntimeError("G2PW archive exceeds extraction limit")
        # Upstream imports this config as Python. Accept only literal assignments.
        source = archive.read("G2PWModel_1.1/config.py").decode("utf-8-sig")
        for statement in ast.parse(source).body:
            if not isinstance(statement, ast.Assign) or not all(isinstance(target, ast.Name) for target in statement.targets):
                raise RuntimeError("G2PW config contains executable statements requiring review")
            ast.literal_eval(statement.value)
        destination = (ROOT / "GPT_SoVITS/text/G2PWModel").resolve()
        for entry in archive.infolist():
            if not entry.filename.startswith("G2PWModel_1.1/"): raise RuntimeError("Unexpected G2PW archive layout")
            target = (destination / entry.filename.removeprefix("G2PWModel_1.1/")).resolve()
            if not target.is_relative_to(destination): raise RuntimeError("Unsafe G2PW archive path")
            if entry.is_dir(): target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as input_stream, target.open("wb") as output_stream:
                    shutil.copyfileobj(input_stream, output_stream)
    print("Pinned G2PW resources prepared; config contains only literal assignments.", flush=True)
    # The full FastText model is required by split-lang, even for Chinese input.
    # Official URL and MD5 were checked against fast-langdetect 1.1.0; pin SHA-256 here.
    fetch_artifact({"path": "GPT_SoVITS/pretrained_models/fast_langdetect/lid.176.bin",
        "url": "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.bin",
        "size": 131266198, "sha256": "7e69ec5451bc261cc7844e49e4792a85d7f09c06789ec800fc4a44aec362764e"}, proxy)
    # Prevent g2p_en/nltk from fetching resources into the user's home on first use.
    for subdir, name, size, sha in NLTK_FILES:
        item = {"path": f"runtime/nltk_data/{subdir}/{name}.zip", "size": size, "sha256": sha,
                "url": f"https://raw.githubusercontent.com/nltk/nltk_data/{NLTK_REVISION}/packages/{subdir}/{name}.zip"}
        fetch_artifact(item, proxy)
        destination = (ROOT / "runtime/nltk_data" / subdir).resolve()
        with zipfile.ZipFile(ROOT / item["path"]) as archive:
            if sum(entry.file_size for entry in archive.infolist()) > 50 * 1024**2:
                raise RuntimeError("NLTK archive exceeds extraction limit")
            for entry in archive.infolist():
                target = (destination / entry.filename).resolve()
                if not target.is_relative_to(destination): raise RuntimeError("Unsafe NLTK archive path")
            archive.extractall(destination)
    print("Pinned NLTK resources prepared in the isolated engine.", flush=True)

def check():
    run([PYTHON, "-m", "pip", "check"])
    run([PYTHON, "-c", "import torch,torchaudio;print('torch',torch.__version__,'torchaudio',torchaudio.__version__,'cuda',torch.cuda.is_available());print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"])
    if not (INSTALL / "model-manifest.json").is_file(): raise RuntimeError("Model manifest missing")
    manifest = json.loads((INSTALL / "model-manifest.json").read_text(encoding="utf-8"))
    for item in manifest["artifacts"]:
        file = ROOT / item["path"]
        if not file.is_file() or file.stat().st_size != item["size"]: raise RuntimeError("Model file missing or incomplete: " + item["path"])
        sha, git = hashes(file)
        if (sha != item["sha256"] if item.get("sha256") else git != item["gitBlob"]): raise RuntimeError("Model hash mismatch: " + item["path"])
    print("All pinned model files verified. This does not yet confirm synthesis.", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["models", "dependencies", "resources", "configure", "check"], required=True)
    parser.add_argument("--proxy", default="")
    args = parser.parse_args()
    INSTALL.mkdir(parents=True, exist_ok=True)
    if args.stage == "models": models(args.proxy)
    elif args.stage == "dependencies": dependencies(args.proxy)
    elif args.stage == "resources": resources(args.proxy)
    elif args.stage == "configure": configure()
    else: check()
