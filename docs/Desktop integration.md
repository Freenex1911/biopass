# Desktop integration and WebView policy

BioPass uses the stable identifier `com.ticklab.biopass` as its GTK application
ID (`enableGTKAppId`), with a matching `com.ticklab.biopass.desktop` launcher.
This lets GNOME and Wayland associate windows with the application name and
icon through the desktop environment's normal mechanisms.

The executable remains `biopass`. Packages retain a hidden `biopass.desktop`
compatibility launcher so existing shortcuts still launch the app without
creating a second searchable application. If an old pinned launcher appears
separately from the running window, unpin it and pin the BioPass search result.
No window-manager extension or custom window sizing logic is required.

The production Content Security Policy allows local scripts, Tauri IPC, local
asset images and data/blob images used by the camera preview. It blocks remote
scripts, frames, object embeds and form submission. Inline styles are allowed
because the existing UI components use dynamic style attributes. Tauri adds
its own script nonces and hashes at build time.

Development uses a separate policy allowing Vite's inline React refresh
script and localhost port 1420 HTTP/WebSocket connections. These permissions
are absent from the production policy. Model downloads use the Rust backend,
not the WebView, and do not require remote frontend connections.

ONNX Runtime CPU packages are pinned by version and architecture-specific
SHA-256 checksums. Versioned source directories ensure changing the runtime
also rebuilds its C++ consumers. Stable staged library paths keep Debian/RPM
packaging independent of the runtime's versioned filename. Runtime and native
libraries must be updated together.
