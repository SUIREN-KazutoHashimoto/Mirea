# Optional local VOICEVOX radio on Linux x64

The image contains adapter source only, not vendor libraries, dictionary, voice pack, model, user data, secrets or certificates. Dynamic MC is opt-in. An unavailable renderer leaves the server healthy and the dynamic capability off; static FM or music continues. Startup never downloads assets.

The following are pinned candidate artifacts for Bookworm amd64. Verify published provenance and archive digests through the normal operator process before staging; successful Windows use does not verify Linux binaries.

- [VOICEVOX CORE 0.17.1](https://github.com/VOICEVOX/voicevox_core/releases/tag/0.17.1), C API Linux x64 asset voicevox_core-linux-x64-0.17.1.zip, configure libvoicevox_core.so.
- [VOICEVOX ONNX Runtime 1.23.2](https://github.com/VOICEVOX/onnxruntime-builder/releases/tag/voicevox_onnxruntime-1.23.2), Linux x64 CPU asset voicevox_onnxruntime-linux-x64-1.23.2.tgz, configure libvoicevox_onnxruntime.so.1.23.2, not the non-VOICEVOX ORT variant. Check the actual ELF dependencies in the target image.
- Open JTalk UTF-8 dictionary 1.11, the extracted directory from the [official pinned Core guide](https://github.com/VOICEVOX/voicevox_core/blob/0.17.1/docs/guide/user/usage.md).
- [VOICEVOX VVM model/style table](https://github.com/VOICEVOX/voicevox_vvm/blob/main/README.md), Nemo n0.vvm, style 10005. The reviewed existing Windows test copy of that platform-independent artifact had SHA-256 f9793559a0ecad1622c15e68674860d7d00ce2736cf02b3f46b083e989c74ec7. Independently verify and approve provenance; a different digest needs a new review.

Place the exact native assets and operator JSON in a dedicated root-owned directory, not group/other writable, mounted read-only in the container at a fixed absolute path such as /app/radio-voice. Executable mappings for the .so mount must work; do not relax the noexec scratch mount. Do not load from /data, /tmp, media/uploads or mutable user-controlled paths. Maintain the existing UID 1000, Landlock, seccomp, no-new-privileges, read-only root, and capability restrictions. The optional prepared FM pack with fm-pack.json is a separate, immutable read-only operator mount. Configure /usr/bin/python3, the exact absolute paths, model hash, style, reviewed terms, and spoken/visible attribution. Leave existing opt-in MIREA_RADIO_STATIONS, MIREA_RADIO_FM_DIR and MIREA_RADIO_DYNAMIC_CONFIG off until a private smoke test has passed.

Review the current [Nemo terms](https://voicevox.hiroshiba.jp/nemo/term/) at use. Retain visible and spoken VOICEVOX Nemo credit, and do not use rendered audio for training. The Core [MIT notice](https://github.com/VOICEVOX/voicevox_core/blob/0.17.1/LICENSE) does not settle licensing or redistribution for models, runtime, dictionary or generated packs. Those require separate review before bundling.

Release gate: run the normal amd64/glibc image and launcher on a real authorized Linux host or release CI, with approved mounts and synthetic media, not nested virtualization on a Windows development host. Check probe success, real credited AAC, duration/loudness/true peak, two listeners and restart; repeat with missing/tampered/inaccessible artifacts and confirm healthy service, no dynamic capability, no fabricated audio and no external fetch. These cannot be proven by Windows or static packaging tests.

## Exact beta CI check and operator configuration

The normal container CI first confirms healthy operation without assets, then uses
the built candidate image for a mandatory real-voice test. The GitHub-hosted
runner fetches only [reviewed pinned inputs](../../scripts/run-radio-voicevox-container-ci.mjs),
verifies all four SHA-256 digests before staging, checks ELF architecture and
uses only the expected archive entries. A download, identity, synthesis, AAC or
access-control failure stops validation. The container runs without networking,
as UID/GID 1000, via the normal launcher. Python is routed through Mirea's
network-denying inference helper. The verified assets are staged read-only at
`/app/radio-voice` and removed without passing them to Docker's build context or
retaining them in CI workflow artifacts. The eventual published image is still
the original tested image without assets.

For an operator-managed mount (file names may only vary within the supported
CORE aliases), put these into a dedicated read-only directory:

```text
libvoicevox_core.so
libvoicevox_onnxruntime.so.1.23.2
dictionary/         # extracted Open JTalk UTF-8 dictionary files, not the tarball
n0.vvm
runtime.json
```

The documented Nemo example JSON is below. Verify rights and the installed
artifacts before using `modelTermsReviewed: true`. Leave the configuration
unset rather than enabling an unreviewed voice.

```json
{
  "python": "/usr/bin/python3",
  "core": "/app/radio-voice/libvoicevox_core.so",
  "onnx": "/app/radio-voice/libvoicevox_onnxruntime.so.1.23.2",
  "dictionary": "/app/radio-voice/dictionary",
  "model": "/app/radio-voice/n0.vvm",
  "modelSha256": "f9793559a0ecad1622c15e68674860d7d00ce2736cf02b3f46b083e989c74ec7",
  "style": 10005,
  "credit": "VOICEVOX Nemo",
  "spokenCredit": "ボイスボックス・ネモ",
  "modelTermsReviewed": true
}
```

Mount the prepared operator directory at `/app/radio-voice` without write
permission; set `MIREA_RADIO_DYNAMIC_CONFIG=/app/radio-voice/runtime.json`
on the service explicitly. Use a separate read-only pack directory for
`MIREA_RADIO_FM_DIR` and set `MIREA_RADIO_STATIONS=1` only when enabling the
Web radio. The FM pack can contain a locally prepared original jingle, but
vendor input files and rendered sample packs must not be uploaded as image
layers. For background selection, listener traffic does not render audio.

The real container check compares the encoded AAC delivered to two independently
signed-in sessions, authorization rejection, health, fallback and restart.
It is not a claim that a particular operator's Linux deployment or browser
audio device has been tested.
