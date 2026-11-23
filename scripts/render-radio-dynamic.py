"""Private bounded local native batch renderer; never reads user data or uses networking itself."""
import argparse
import hashlib
import json
from pathlib import Path

from radio_voicevox_capi import render_asset_paths, render_voicevox

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--probe", action="store_true", help="verify local renderer; do not emit audio")
parser.add_argument("job", type=Path)
a = parser.parse_args()
directory = a.job.resolve(strict=True).parent
request = json.loads(a.job.read_text(encoding="utf-8"))
config = request["config"]
if not config.get("modelTermsReviewed") or len(config["spokenCredit"]) > 120:
    raise ValueError("Reviewed attribution is required")
dictionary, model = render_asset_paths(Path(config["dictionary"]), Path(config["model"]))
with model.open("rb") as f:
    if hashlib.file_digest(f, "sha256").hexdigest() != config["modelSha256"]:
        raise ValueError("Unexpected model contents")
clips = request.get("clips", [])
if not a.probe and not 1 <= len(clips) <= 24:
    raise ValueError("Invalid batch size")
with render_voicevox(Path(config["core"]), Path(config["onnx"]), dictionary, model, config["style"]) as speak:
    if a.probe:
        # ABI, native runtime, dictionary, reviewed style and model loaded.
        # Actual AAC is a separate release smoke gate.
        raise SystemExit(0)
    for i, clip in enumerate(clips):
        text, quality = clip["text"], clip["quality"]
        if not text.strip() or len(text) > 135 or quality not in ("standard", "enhanced"):
            continue
        try:
            voice = speak(text + "音声合成、" + config["spokenCredit"] + "。", 1.03 if quality == "standard" else 0.97)
        except (ValueError, RuntimeError):
            continue
        (directory / str(i)).with_suffix(".wav").write_bytes(voice)
