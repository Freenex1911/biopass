use crate::config::load_config;
use crate::db;
use crate::helper_io::{configure_helper, read_header, terminate_helper};
use crate::paths::get_faces_dir;
use std::process::Stdio;
use std::time::Duration;
use tauri::{
    ipc::{Channel, Response},
    AppHandle, Emitter,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout, MissedTickBehavior};

struct CaptureRequest {
    path: String,
    reply: oneshot::Sender<Result<String, String>>,
}
struct PreviewSession {
    commands: mpsc::Sender<CaptureRequest>,
    shutdown: oneshot::Sender<()>,
    task: JoinHandle<()>,
}
static SESSION: Mutex<Option<PreviewSession>> = Mutex::const_new(None);

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
pub async fn start_face_preview(
    app: AppHandle,
    camera: Option<String>,
    frames: Channel<Response>,
) -> Result<(), String> {
    let preparation = app.clone();
    let model = tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(preparation.clone())?;
        let conn = db::open(&preparation)?;
        db::resolve_model_path(&conn, &config.methods.face.detection.model_id)?
            .ok_or_else(|| "Detection model not found in registry".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut guard = SESSION.lock().await;
    if let Some(session) = guard.take() {
        finish_session(session).await;
    }
    let mut command = Command::new(helper_path());
    configure_helper(&mut command);
    command
        .arg("preview-session")
        .arg("--model")
        .arg(model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(camera) = camera.filter(|c| !c.is_empty()) {
        command.arg("--camera").arg(camera);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn helper: {e}"))?;
    let stdin = child.stdin.take().ok_or("missing stdin")?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("missing stdout")?);
    let ready = timeout(Duration::from_secs(10), read_header(&mut stdout)).await;
    if !matches!(&ready, Ok(Ok(line)) if line == "READY") {
        terminate_helper(&mut child).await;
        return Err("Camera helper did not initialize in time".into());
    }
    let (commands, requests) = mpsc::channel(4);
    let (shutdown, stop) = oneshot::channel();
    let task = tokio::spawn(preview_worker(
        app, frames, child, stdin, stdout, requests, stop,
    ));
    *guard = Some(PreviewSession {
        commands,
        shutdown,
        task,
    });
    Ok(())
}

async fn preview_worker(
    app: AppHandle,
    frames: Channel<Response>,
    mut child: Child,
    mut stdin: ChildStdin,
    mut stdout: BufReader<ChildStdout>,
    mut requests: mpsc::Receiver<CaptureRequest>,
    mut stop: oneshot::Receiver<()>,
) {
    let mut ticks = interval(Duration::from_millis(33));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let result: Result<(), String> = async {
        loop {
            tokio::select! {
                biased;
                _ = &mut stop => return Ok(()),
                request = requests.recv() => {
                    let Some(request) = request else { return Ok(()); };
                    let capture = exchange_capture(&mut stdin, &mut stdout, &request.path);
                    let response = tokio::select! {
                        biased;
                        _ = &mut stop => return Ok(()),
                        response = timeout(Duration::from_secs(10), capture) => response,
                    };
                    match response {
                        Ok(Ok(header)) => {
                            let result = match header.as_str() {
                                "OK" => Ok(request.path),
                                "NO_FACE" => Err("No face detected. Face the camera and try again.".into()),
                                "NO_LANDMARKS" => Err("Facial landmarks could not be detected. Face the camera clearly and try again.".into()),
                                _ => Err(format!("Capture failed: {header}")),
                            };
                            let _ = request.reply.send(result);
                        }
                        _ => { let _ = request.reply.send(Err("Camera did not respond in time".into())); return Err("Camera did not respond in time".into()); }
                    }
                }
                _ = ticks.tick() => {
                    let frame = tokio::select! {
                        biased;
                        _ = &mut stop => return Ok(()),
                        frame = timeout(Duration::from_secs(5), exchange_frame(&mut stdin, &mut stdout)) => frame,
                    };
                    match frame {
                        Ok(Ok(Some(bytes))) => frames.send(Response::new(bytes)).map_err(|e| e.to_string())?,
                        Ok(Ok(None)) => {},
                        _ => return Err("Camera preview stopped because the camera did not respond. Try starting it again.".into()),
                    }
                }
            }
        }
    }.await;
    terminate_helper(&mut child).await;
    if let Err(error) = result {
        let _ = app.emit("face-preview-error", error);
    }
}
async fn exchange_frame(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
) -> Result<Option<Vec<u8>>, String> {
    stdin
        .write_all(b"FRAME\n")
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    let header = read_header(stdout).await.map_err(|e| e.to_string())?;
    if header.starts_with("ERR") {
        return Ok(None);
    }
    let size = header
        .strip_prefix("OK ")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|size| *size > 0 && *size <= 8 * 1024 * 1024)
        .ok_or("Invalid camera frame length")?;
    let mut frame = vec![0; size];
    stdout
        .read_exact(&mut frame)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some(frame))
}
async fn exchange_capture(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    path: &str,
) -> Result<String, String> {
    if path.contains(['\n', '\r']) {
        return Err("Unsupported newline in photo path".into());
    }
    stdin
        .write_all(format!("CAPTURE_ALIGNED {path}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;
    read_header(stdout).await.map_err(|e| e.to_string())
}
async fn finish_session(session: PreviewSession) {
    let _ = session.shutdown.send(());
    let _ = session.task.await;
}
#[tauri::command]
pub async fn stop_face_preview() -> Result<(), String> {
    if let Some(session) = SESSION.lock().await.take() {
        finish_session(session).await;
    }
    Ok(())
}
pub(crate) fn cleanup_preview() {
    let _ = tauri::async_runtime::block_on(stop_face_preview());
}
#[tauri::command]
pub async fn capture_face_in_session(app: AppHandle) -> Result<String, String> {
    let commands = SESSION
        .lock()
        .await
        .as_ref()
        .ok_or("No active preview session")?
        .commands
        .clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let dir = get_faces_dir(&app)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        Ok::<_, String>(
            dir.join(format!("face_{timestamp}.jpg"))
                .to_string_lossy()
                .to_string(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let (reply, response) = oneshot::channel();
    commands
        .send(CaptureRequest { path, reply })
        .await
        .map_err(|_| "Camera preview has stopped")?;
    response
        .await
        .map_err(|_| "Camera preview has stopped".to_string())?
}
