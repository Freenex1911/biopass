# Authentication lifecycle

BioPass keeps the PAM module small. A separate helper owns the camera and inference models for one authentication session. It does not run a persistent camera or model daemon.

## Bounded helper lifetime

The PAM module allows 30 seconds for a helper authentication. A timed-out, cancelled, signalled or unstartable helper never produces a successful authentication result. Timeout ends the helper process group, escalating from SIGTERM to SIGKILL, and reaps the child. Existing PAM stack rules determine password fallback. The helper is also killed by the kernel if its PAM parent exits unexpectedly.

Administrators can adjust the deadline with a module argument, for example:

```
auth sufficient libbiopass_pam.so timeout_ms=45000
```

Accepted values are 100–300000 milliseconds. Configure enough time for all sequential methods and retries. BioPass does not modify PAM service files automatically.

Helper stdout/stderr are disconnected from the caller during PAM authentication. A private nonblocking pipe carries a bounded set of status events; debug logs remain in the user's BioPass log directory. This avoids corrupting callers such as polkit that parse their inherited output as a protocol.

## Optional GNOME hints

Enable **GNOME sign-in hints** in **Sign-in settings → Sign-in behavior & system integration** and save. The setting is `strategy.show_auth_status`; it defaults to false, including for older configuration files.

Hints apply only to the `gdm-password` PAM service, when the caller permits informational messages. When the first available authentication method starts, BioPass sends at most one standard PAM informational message: look at the camera or touch the fingerprint reader. No extra extension, permanent notification service or fake password prompt is used.

These messages improve feedback but do not replace GNOME's password field or add a face-authentication button. GNOME keeps a short informational message pending for at least two seconds from receipt. This overlaps authentication; only any remaining display time can delay completion of an unlock. Successful authentication does not enqueue an additional message.

Keep the existing distinction between first login and unlocking an active session when the login keyring needs the password. BioPass does not change that policy or disable password authentication.

## Session-scoped inference

Detection, recognition and optional AI protection models are reused for an authentication session. The enrolled file list is read once. An enrolled face's embedding is calculated on its first comparison and reused for retries; the live face's embedding is calculated once per attempt. Preparing enrollment lazily avoids loading every photo before a successful first comparison.

No embeddings are persisted by this cache. A new authentication starts from the current saved photos, models and settings. Recognition thresholds and IR verification requirements are unchanged.

## Preview lifecycle

Preview and capture commands run on blocking workers rather than the UI dispatch thread. Helper startup and photo capture responses have a 10-second deadline; a frame response has a 5-second deadline. Protocol headers are limited to 1024 bytes and frames to 8 MiB. The deadline covers the complete response, not just each individual read.

A failed preview releases its helper and reports an error to the UI. A restart discards an ended session. Stopping or exiting the application terminates the helper before waiting for the frame reader, so a stalled read cannot prevent camera cleanup. The kernel also terminates the preview helper if its application parent crashes.

## Regression checks

The fixtures in `tests/config-contract` are read by C++, Rust and frontend tests. They cover legacy camera settings, color-only priority selection, fixed IR selection and the optional GNOME preference. Rust tests also cover bounded protocol reads and child cleanup. C++ tests exercise helper exits, timeout escalation, cancellation, retry cleanup and equivalent direct/cached ONNX comparisons.

Run native checks with `BUILD_TESTS=ON` and `ctest --test-dir auth/build --output-on-failure`. The embedding test needs the actual ONNX model, not a Git LFS pointer. Use `git lfs pull` or configure `BIOPASS_TEST_MODEL_DIR` to a directory containing `edgeface_s_gamma_05.onnx`. Frontend checks use `bun test`; Rust checks use `cargo test --lib` from `app/src-tauri`.
