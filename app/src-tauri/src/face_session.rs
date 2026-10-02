use std::io::{BufReader, Read, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use tauri::{AppHandle, Emitter};

use crate::config::{load_config, BiopassConfig};
use crate::db;
use crate::helper_io::{configure_helper, read_header, DeadlineReader, ManagedChild};
use crate::paths::get_faces_dir;

const PREVIEW_EVENT: &str = "face-preview-frame";
const FRAME_INTERVAL_MS: u64 = 33; // ~30fps ceiling

struct ChildIO {
    stdin: ChildStdin,
    stdout: BufReader<DeadlineReader>,
}

struct PreviewSession {
    child: Arc<Mutex<ManagedChild>>,
    io: Arc<Mutex<ChildIO>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

static SESSION: Mutex<Option<PreviewSession>> = Mutex::new(None);

pub(crate) fn helper_path() -> String {
    if let Ok(path) = std::env::var("BIOPASS_HELPER_PATH") {
        return path;
    }
    if std::path::Path::new("/usr/bin/biopass-helper").exists() {
        "/usr/bin/biopass-helper".into()
    } else if std::path::Path::new("../../auth/build/pam/biopass-helper").exists() {
        "../../auth/build/pam/biopass-helper".into()
    } else {
        "biopass-helper".into()
    }
}

#[tauri::command]
pub async fn start_face_preview(app: AppHandle, camera: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_preview(app, camera))
        .await
        .map_err(|e| e.to_string())?
}

fn start_preview(app: AppHandle, camera: Option<String>) -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if guard
        .as_ref()
        .is_some_and(|session| !session.stop.load(Ordering::Relaxed))
    {
        return Ok(());
    }
    if let Some(session) = guard.take() {
        finish_session(session);
    }

    let config: BiopassConfig = load_config(app.clone())?;
    let conn = db::open(&app)?;
    let model_id = &config.methods.face.detection.model_id;
    let detect_model = db::resolve_model_path(&conn, model_id)?
        .ok_or_else(|| format!("Detection model '{}' not found in registry", model_id))?;

    let mut cmd = Command::new(helper_path());
    configure_helper(&mut cmd);
    cmd.arg("preview-session")
        .arg("--model")
        .arg(&detect_model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cam) = camera.filter(|c| !c.is_empty()) {
        cmd.arg("--camera").arg(cam);
    }

    let mut child = ManagedChild(
        cmd.spawn()
            .map_err(|e| format!("Failed to spawn helper: {e}"))?,
    );
    let stdin = child.0.stdin.take().ok_or("missing stdin")?;
    let stdout = child.0.stdout.take().ok_or("missing stdout")?;
    let mut reader = BufReader::new(DeadlineReader::new(stdout, Duration::from_secs(10)));

    let ready = read_header(&mut reader).map_err(|e| format!("Helper did not respond: {e}"))?;
    if ready != "READY" {
        return Err(format!("Helper failed to initialize: {ready}"));
    }

    let io = Arc::new(Mutex::new(ChildIO {
        stdin,
        stdout: reader,
    }));
    let child = Arc::new(Mutex::new(child));
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let io = Arc::clone(&io);
        let stop = Arc::clone(&stop);
        let app = app.clone();
        let child = Arc::clone(&child);
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let frame_result: Result<Vec<u8>, ()> = {
                    let mut io_guard = match io.lock() {
                        Ok(g) => g,
                        Err(_) => break,
                    };
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let io_ref: &mut ChildIO = &mut *io_guard;
                    let send_err = io_ref.stdin.write_all(b"FRAME\n").is_err()
                        || io_ref.stdin.flush().is_err();
                    if send_err {
                        break;
                    }
                    io_ref
                        .stdout
                        .get_mut()
                        .reset_deadline(Duration::from_secs(5));
                    let header = match read_header(&mut io_ref.stdout) {
                        Ok(header) => header,
                        Err(_) => break,
                    };
                    if let Some(rest) = header.strip_prefix("OK ") {
                        if let Ok(len) = rest.parse::<usize>() {
                            if len == 0 || len > 8 * 1024 * 1024 {
                                break;
                            }
                            let mut buf = vec![0u8; len];
                            if io_ref.stdout.read_exact(&mut buf).is_err() {
                                break;
                            }
                            Ok(buf)
                        } else {
                            Err(())
                        }
                    } else {
                        // ERR or unexpected, skip this frame.
                        Err(())
                    }
                };

                if let Ok(frame) = frame_result {
                    let b64 = general_purpose::STANDARD.encode(&frame);
                    let _ = app.emit(PREVIEW_EVENT, b64);
                }

                thread::sleep(Duration::from_millis(FRAME_INTERVAL_MS));
            }
            let unexpected = !stop.swap(true, Ordering::Relaxed);
            terminate_helper(&child);
            if unexpected {
                let _ = app.emit("face-preview-error", "Camera preview stopped because the camera did not respond. Try starting it again.");
            }
        })
    };

    *guard = Some(PreviewSession {
        child,
        io,
        stop,
        thread: Some(thread),
    });
    Ok(())
}

fn terminate_helper(child: &Arc<Mutex<ManagedChild>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.0.kill();
        let _ = child.0.wait();
    }
}

#[tauri::command]
pub async fn stop_face_preview() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_preview())
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn cleanup_preview() {
    let _ = stop_preview();
}

fn finish_session(mut session: PreviewSession) {
    session.stop.store(true, Ordering::Relaxed);
    // Kill before joining: the worker may hold io waiting for a response.
    terminate_helper(&session.child);
    if let Some(thread) = session.thread.take() {
        let _ = thread.join();
    }
}

fn stop_preview() -> Result<(), String> {
    let mut guard = SESSION.lock().map_err(|e| e.to_string())?;
    if let Some(session) = guard.take() {
        finish_session(session);
    }
    Ok(())
}

#[tauri::command]
pub async fn capture_face_in_session(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || capture_preview(app))
        .await
        .map_err(|e| e.to_string())?
}

fn capture_preview(app: AppHandle) -> Result<String, String> {
    let guard = SESSION.lock().map_err(|e| e.to_string())?;
    let sess = guard.as_ref().ok_or("No active preview session")?;
    let io_handle = Arc::clone(&sess.io);
    let stop = Arc::clone(&sess.stop);
    let child = Arc::clone(&sess.child);
    drop(guard);
    if stop.load(Ordering::Relaxed) {
        return Err("Camera preview has stopped. Start it again.".into());
    }

    let faces_dir = get_faces_dir(&app)?;
    if !faces_dir.exists() {
        std::fs::create_dir_all(&faces_dir)
            .map_err(|e| format!("Failed to create faces directory: {e}"))?;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {e}"))?
        .as_millis();
    let file_path = faces_dir.join(format!("face_{}.jpg", ts));

    let mut io = io_handle.lock().map_err(|e| e.to_string())?;
    let alignment = load_config(app.clone())?.methods.face.recognition.alignment;
    let command = if alignment {
        "CAPTURE_ALIGNED"
    } else {
        "CAPTURE"
    };
    let cmd = format!("{command} {}\n", file_path.display());
    io.stdin
        .write_all(cmd.as_bytes())
        .map_err(|e| format!("write CAPTURE: {e}"))?;
    io.stdin.flush().map_err(|e| format!("flush: {e}"))?;

    io.stdout.get_mut().reset_deadline(Duration::from_secs(10));
    let response = match read_header(&mut io.stdout) {
        Ok(response) => response,
        Err(error) => {
            stop.store(true, Ordering::Relaxed);
            terminate_helper(&child);
            let _ = app.emit(
                "face-preview-error",
                "Camera preview stopped because the camera did not respond. Try starting it again.",
            );
            return Err(format!("read response: {error}"));
        }
    };
    match response.as_str() {
        "OK" => Ok(file_path.to_string_lossy().to_string()),
        "NO_LANDMARKS" => Err(
            "Facial landmarks could not be detected. Face the camera clearly and try again.".into(),
        ),
        "NO_FACE" => {
            Err("No face detected. Please position your face in front of the camera.".into())
        }
        s if s.starts_with("ERR") => Err(s.to_string()),
        other => Err(format!("Unexpected response: {other}")),
    }
}
