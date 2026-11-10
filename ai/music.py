"""Local CPU adapter for official All-In-One and HTDemucs weights.
Model weights are accepted and verified separately by Mirea. Pickle code loading,
Hub downloads, telemetry, and outbound socket connections are prohibited here.
"""
import os, sys, json, socket, types, importlib, importlib.util, contextlib
from pathlib import Path
from dataclasses import asdict
from fractions import Fraction
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
def no_network(*args, **kwargs):
    raise RuntimeError("Inference network access is disabled")
socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
import torch
import numpy as np
from scipy.ndimage import maximum_filter1d
from scipy.signal import find_peaks
from omegaconf import OmegaConf
from neighborhood import qk1, av1, qk2, av2

def package(name, path):
    module = types.ModuleType(name)
    module.__path__ = [str(path)]
    sys.modules[name] = module

def load_architecture():
    # Import only architecture modules; the upstream convenience entrypoint
    # would load download, training, visualization and native CUDA dependencies.
    spec = importlib.util.find_spec("allin1")
    base = Path(spec.origin).parent
    package("allin1", base)
    package("allin1.models", base / "models")
    functional = types.ModuleType("natten.functional")
    functional.natten1dqkrpb, functional.natten1dav = qk1, av1
    functional.natten2dqkrpb, functional.natten2dav = qk2, av2
    package("natten", base)
    sys.modules["natten.functional"] = functional
    from allin1.models.allinone import AllInOne
    return AllInOne

def spectrum(audio):
    # Match training: centered 2048-point Hann STFT, 441-sample hop,
    # normalized triangular filters on an A440 semitone grid, log10(1+x).
    bins = np.arange(1024) * 44100 / 2048
    notes = 440 * 2.0 ** (np.arange(-60, 72) / 12)
    notes = notes[(notes >= 30) & (notes <= 17000)]
    middle = np.searchsorted(bins, notes).clip(1, 1023)
    middle -= notes - bins[middle - 1] < bins[middle] - notes
    centers = np.unique(middle)
    filters = np.zeros((1024, len(centers) - 2), dtype=np.float32)
    for index, (left, peak, right) in enumerate(zip(centers, centers[1:], centers[2:])):
        filters[left:peak, index] = np.arange(peak-left)/(peak-left)
        filters[peak:right, index] = 1 - np.arange(right-peak)/(right-peak)
        filters[:, index] /= filters[:, index].sum()
    if filters.shape[1] != 81:
        raise RuntimeError("Spectrogram profile mismatch")
    array = np.asarray(audio, dtype=np.float32)
    window = np.hanning(2048).astype(np.float32)
    frame_count = int(np.ceil(len(array) / 441))
    result = np.empty((frame_count, 81), dtype=np.float32)
    # Bound FFT scratch memory even for a long track.
    padded = np.pad(array, (1024, 2048))
    for begin in range(0, frame_count, 2000):
        count = min(2000, frame_count-begin)
        frames = np.lib.stride_tricks.sliding_window_view(padded[begin*441:], 2048)[::441][:count]
        amplitudes = np.abs(np.fft.rfft(frames * window, axis=1)[:, :1024])
        result[begin:begin+count] = np.log10(1 + amplitudes @ filters)
    return result

def run(request):
    import random
    random.seed(0); np.random.seed(0); torch.manual_seed(0)
    torch.set_num_threads(max(1, min(64, int(request["threads"]))))
    torch.set_num_interop_threads(1)
    from demucs.htdemucs import HTDemucs
    from demucs.apply import apply_model
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd
    with torch.serialization.safe_globals([HTDemucs, Fraction, np.core.multiarray.scalar, np.dtype, type(np.dtype(np.float64))]):
        checkpoint = torch.load(request["stems"], map_location="cpu", weights_only=True)
    if checkpoint["klass"] is not HTDemucs or checkpoint["state"].get("__quantized"):
        raise RuntimeError("Unsupported source-separation checkpoint")
    separator = HTDemucs(*checkpoint["args"], **checkpoint["kwargs"]).eval()
    separator.load_state_dict(checkpoint["state"])
    audio, rate = sf.read(request["input"], dtype="float32", always_2d=True)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    elif audio.shape[1] > 2:
        audio = audio[:, :2]
    if rate != 44100:
        divisor = gcd(rate, 44100)
        audio = resample_poly(audio, 44100//divisor, rate//divisor, axis=0).astype(np.float32)
    duration = len(audio) / 44100
    mix = torch.from_numpy(audio.T.copy())
    reference = mix.mean(0)
    mean, std = reference.mean(), reference.std().clamp_min(1e-6)
    with torch.inference_mode():
        separated = apply_model(separator, ((mix-mean)/std)[None], device="cpu", shifts=1,
                                split=True, overlap=.25, progress=False, num_workers=0)[0]
        separated = separated * std + mean
    specs = np.stack([spectrum(separated[separator.sources.index(name)].mean(0).numpy())
                      for name in ("bass","drums","other","vocals")])
    del separated, separator, mix, checkpoint, audio
    Architecture = load_architecture()
    totals = None
    files = sorted(Path(request["models"]).glob("harmonix-fold*.pth"))
    if len(files) != 8:
        raise RuntimeError("Music ensemble is incomplete")
    with torch.inference_mode():
        for path in files:
            saved = torch.load(path, map_location="cpu", weights_only=True)
            cfg = OmegaConf.create(saved["config"])
            model = Architecture(cfg).eval()
            model.load_state_dict(saved["state_dict"])
            # Full-song inference preserves structural context. CPU attention
            # uses bounded neighbor tensors; it never constructs an NxN matrix.
            outputs = model(torch.from_numpy(specs)[None])
            values = [outputs.logits_section[0], outputs.logits_function[0], outputs.logits_beat[0]]
            if totals is None:
                totals = [value.clone() for value in values]
            else:
                for total, value in zip(totals, values):
                    total.add_(value)
            del model, outputs, saved
    section = torch.sigmoid(totals[0] / len(files)).numpy()
    function = torch.softmax(totals[1] / len(files), dim=0).numpy()
    beat = torch.sigmoid(totals[2] / len(files)).numpy()
    section[section < maximum_filter1d(section, size=97, mode="constant")] = 0
    maxima = (section == maximum_filter1d(section, size=2401, mode="constant")) & (section > 0)
    boundaries = sorted(set([0, len(section)] + [int(i) for i in np.flatnonzero(maxima) if 300 <= i <= len(section)-300]))
    labels = ["start","end","intro","outro","break","bridge","inst","solo","verse","chorus"]
    segments = []
    for start, end in zip(boundaries, boundaries[1:]):
        if end <= start:
            continue
        confidence = function[:, start:end].mean(1)
        label = labels[int(confidence.argmax())]
        if segments and segments[-1]['label'] == label:
            segments[-1]['end'] = min(duration, end/100)
        else:
            segments.append(dict(start=start/100, end=min(duration,end/100), label=label))
    beats, _ = find_peaks(beat, distance=24, height=.19)
    intervals = np.diff(beats) / 100
    bpm = float(np.median(60/intervals)) if len(intervals) else None
    return {"bpm": bpm, "segments": segments}

if __name__ == "__main__":
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        # Suppress upstream progress output and paths. Only bounded result JSON
        # is returned to the parent; diagnostic codes are created there.
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        code='AI_MEMORY_LIMIT' if isinstance(error,MemoryError) or 'out of memory' in str(error).lower() else 'AI_RUNTIME_UNAVAILABLE' if isinstance(error,ModuleNotFoundError) else 'AI_RUNTIME_FAILED'
        print(code, file=sys.stderr)
        sys.exit(1)
