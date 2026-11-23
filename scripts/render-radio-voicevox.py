"""Optional local operator CLI. No HTTP, model downloads, database or listener inputs."""
import argparse
import hashlib
import json
from contextlib import contextmanager
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--core-dll", type=Path, help="Optional official Windows x64 VOICEVOX CORE 0.17.1 C API DLL")
parser.add_argument("--onnx", type=Path, required=True)
parser.add_argument("--dict", type=Path, required=True)
parser.add_argument("--model", type=Path, required=True)
parser.add_argument("--model-sha256", required=True)
parser.add_argument("--style", type=int, required=True)
parser.add_argument("--credit", required=True, help="Exact attribution required by the specific reviewed model")
parser.add_argument("--spoken-credit", required=True, help="Pronounceable version of that required credit")
parser.add_argument("--model-terms-reviewed", action="store_true",
                    help="Confirm exact model release's terms permit this output and chosen credits")
args = parser.parse_args()
if not args.model_terms_reviewed or not args.credit.strip() or not args.spoken_credit.strip():
    parser.error("Use only an approved model and explicit written and audible credits")
if any(len(text) > 120 or "\n" in text or "\r" in text for text in (args.credit, args.spoken_credit)):
    parser.error("Use a credit of up to 120 characters on one line")
with args.model.open("rb") as model_file:
    sha256 = hashlib.file_digest(model_file, "sha256").hexdigest()
if sha256 != args.model_sha256.lower():
    parser.error("Installed model differs from the reviewed model")

@contextmanager
def render_python():
    from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile

    engine = Synthesizer(Onnxruntime.load_once(filename=str(args.onnx.resolve())), OpenJtalk(str(args.dict.resolve())))
    with VoiceModelFile.open(str(args.model.resolve())) as model:
        styles = {style.id for speaker in model.metas for style in speaker.styles}
        if args.style not in styles:
            parser.error("Style doesn't belong to the reviewed model")
        engine.load_voice_model(model)

    def speak(text, speed):
        query = engine.create_audio_query(text, args.style)
        query.speed_scale = speed
        query.pre_phoneme_length = 0.12
        query.post_phoneme_length = 0.25
        return engine.synthesis(query, args.style)

    yield speak


if args.core_dll:
    from radio_voicevox_capi import render_voicevox

    renderer = render_voicevox(args.core_dll, args.onnx, args.dict, args.model, args.style)
else:
    renderer = render_python()

parts = {
    "standard": ("ラジオをお聴きいただき、ありがとうございます。引き続き、音楽をどうぞ。", 1.04),
    "enhanced": ("ひと息つける、音楽の時間。ここからも、あなたのそばに。次の一曲をどうぞ。", 0.96),
}
result = {}
args.out.mkdir()
with renderer as speak:
    for level, (text, speed) in parts.items():
        audio = speak(text + "音声合成、" + args.spoken_credit + "。", speed)
        (args.out / ("mc-" + level + ".wav")).write_bytes(audio)
        result[level] = hashlib.sha256(audio).hexdigest()
(args.out / "voice-render.json").write_text(json.dumps({
    "version": 1, "credit": args.credit, "modelSha256": sha256, "files": result,
}, ensure_ascii=False), encoding="utf-8")
