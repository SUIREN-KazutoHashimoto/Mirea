"""Thin offline adapter for the Windows and Linux x64 VOICEVOX CORE 0.17.1 C header."""
import ctypes as ct
import json
import os
import platform
import stat
from contextlib import ExitStack, contextmanager

Handle = ct.c_void_p
Output = ct.POINTER(Handle)


class OrtOptions(ct.Structure):
    _fields_ = [("filename", ct.c_char_p)]


class InitOptions(ct.Structure):
    _fields_ = [("acceleration_mode", ct.c_int32), ("cpu_num_threads", ct.c_uint16)]


class ModelOptions(ct.Structure):
    _fields_ = [("on_existing", ct.c_int32)]


class SynthesisOptions(ct.Structure):
    _fields_ = [("enable_interrogative_upspeak", ct.c_bool)]


def select_adapter(os_name, system, machine, pointer_size):
    if machine.lower() in ("amd64", "x86_64") and pointer_size == 8:
        if os_name == "nt" and system.lower() == "windows":
            return "windows-x64"
        if os_name == "posix" and system.lower() == "linux":
            return "linux-x64"
    raise RuntimeError("The C API adapter requires x64 Windows or glibc Linux")


def protected_posix_asset(path, expected=None, *, directory=False):
    # Resolve vendor SONAME aliases, but trust only protected root-owned
    # libraries and their ancestry, not /data, /tmp, or ambient lookup.
    if not path.is_absolute():
        raise ValueError("Expected an absolute VOICEVOX asset path")
    resolved = path.resolve(strict=True)
    info = resolved.stat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if ((expected is not None and resolved.name not in expected) or not expected_type(info.st_mode)
            or info.st_uid != 0 or info.st_mode & 0o022):
        raise ValueError("Untrusted VOICEVOX asset")
    for directory in resolved.parents:
        info = directory.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Untrusted VOICEVOX library directory")
    return resolved


def render_asset_paths(dictionary, model):
    adapter = select_adapter(os.name, platform.system(), platform.machine(), ct.sizeof(Handle))
    if adapter == "linux-x64":
        return protected_posix_asset(dictionary, directory=True), protected_posix_asset(model)
    return dictionary.resolve(strict=True), model.resolve(strict=True)


@contextmanager
def render_voicevox(core, onnx, dictionary, model, style):
    adapter = select_adapter(os.name, platform.system(), platform.machine(), ct.sizeof(Handle))
    if adapter == "linux-x64":
        core = protected_posix_asset(core, {"libvoicevox_core.so", "libvoicevox_core.so.0.17.1"})
        onnx = protected_posix_asset(onnx, {"libvoicevox_onnxruntime.so.1.23.2"})
        lib = ct.CDLL(os.fspath(core), mode=os.RTLD_LOCAL | os.RTLD_NOW)
    else:
        # Windows trusted dependency search; do not load from cwd or PATH.
        lib = ct.CDLL(str(core.resolve(strict=True)), winmode=0x1100)

    def bind(symbol, result, *args):
        fn = getattr(lib, "voicevox_" + symbol)
        fn.restype, fn.argtypes = result, args
        return fn

    def path(value):
        return str(value.resolve(strict=True)).encode("utf-8")

    if bind("get_version", ct.c_char_p)() != b"0.17.1":
        raise RuntimeError("C API 0.17.1 required")
    message = bind("error_result_to_message", ct.c_char_p, ct.c_int32)

    def check(code):
        if code:
            raise RuntimeError(f"VOICEVOX result {code}: {message(code).decode('utf-8')}")

    new_ort = bind("onnxruntime_load_once", ct.c_int32, OrtOptions, Output)
    new_jtalk = bind("open_jtalk_rc_new", ct.c_int32, ct.c_char_p, Output)
    free_jtalk = bind("open_jtalk_rc_delete", None, Handle)
    open_model = bind("voice_model_file_open", ct.c_int32, ct.c_char_p, Output)
    free_model = bind("voice_model_file_delete", None, Handle)
    model_metas = bind("voice_model_file_create_metas_json", Handle, Handle)
    new_synth = bind("synthesizer_new", ct.c_int32, Handle, Handle, InitOptions, Output)
    free_synth = bind("synthesizer_delete", None, Handle)
    load_model = bind("synthesizer_load_voice_model", ct.c_int32, Handle, Handle, ModelOptions)
    default_model = bind("make_default_load_voice_model_options", ModelOptions)
    audio_query = bind("synthesizer_create_audio_query", ct.c_int32, Handle, ct.c_char_p, ct.c_uint32, Output)
    synthesis = bind("synthesizer_synthesis", ct.c_int32, Handle, ct.c_char_p, ct.c_uint32,
                     SynthesisOptions, ct.POINTER(ct.c_size_t), Output)
    free_string = bind("string_free", None, Handle)
    free_bytes = bind("bytes_free", None, Handle)

    with ExitStack() as closer:
        ort, jtalk, vvm, synth = Handle(), Handle(), Handle(), Handle()
        check(new_ort(OrtOptions(path(onnx)), ct.byref(ort)))
        check(new_jtalk(path(dictionary), ct.byref(jtalk)))
        closer.callback(free_jtalk, jtalk)
        check(open_model(path(model), ct.byref(vvm)))
        closer.callback(free_model, vvm)
        meta_ptr = model_metas(vvm)
        if not meta_ptr:
            raise RuntimeError("Cannot read reviewed model metadata")
        try:
            styles = {p["id"] for voice in json.loads(ct.string_at(meta_ptr)) for p in voice["styles"]}
        finally:
            free_string(meta_ptr)
        if style not in styles:
            raise ValueError("Style doesn't belong to the reviewed model")
        check(new_synth(ort, jtalk, InitOptions(1, 2), ct.byref(synth)))
        closer.callback(free_synth, synth)
        check(load_model(synth, vvm, default_model()))

        def speak(text, speed):
            query_json = Handle()
            check(audio_query(synth, text.encode("utf-8"), style, ct.byref(query_json)))
            try:
                query = json.loads(ct.string_at(query_json))
            finally:
                free_string(query_json)
            query.update(speedScale=speed, prePhonemeLength=0.12, postPhonemeLength=0.25)
            wav, length = Handle(), ct.c_size_t()
            check(synthesis(synth, json.dumps(query, ensure_ascii=False).encode("utf-8"), style,
                            SynthesisOptions(True), ct.byref(length), ct.byref(wav)))
            try:
                if not 44 < length.value <= 8 * 1024 * 1024:
                    raise ValueError("Rendered audio outside expected size")
                return ct.string_at(wav, length.value)
            finally:
                free_bytes(wav)

        yield speak
