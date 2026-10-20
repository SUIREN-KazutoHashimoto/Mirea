# Mirea project workflow

- After implementing a requested Mirea change, deploy it to the WinVAI01 LAN service and verify it there, even when no PR or GitHub Release was requested. This is the owner's standing request (2026-10-20).
- A PR or release still requires the owner's request. When requested, target `develop` and wait for formally successful CI before merging or publishing; build logs alone do not replace CI results.
- Preserve production accounts, media, history, progress, download encryption keys, APK signing identity, AD CS certificates, and the existing LAN-only network boundary. Back up the full data directory and configuration before schema migrations or release switching. Do not bypass TLS verification.
- Keep the web service unprivileged. Privileged maintenance must use the reviewed, narrowly scoped helper. Never include production data or private credentials in source, releases, containers, or CI logs.
- If LAN deployment is blocked by missing authority or an unsafe condition, report it explicitly instead of claiming the change is verified. Do not widen permissions, disable safety checks, or delete user data to force a deployment.
