use std::fs;
use tauri::AppHandle;

use crate::config::{load_config, BiopassConfig};
use crate::db;
use crate::paths::get_faces_dir;

#[tauri::command]
pub async fn capture_face(app: AppHandle, camera: Option<String>) -> Result<String, String> {
    let faces_dir = get_faces_dir(&app)?;
    let app_config: BiopassConfig = load_config(app.clone())?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to get timestamp: {}", e))?
        .as_millis();
    let filename = format!("face_{}.jpg", timestamp);
    let file_path = faces_dir.join(&filename);

    if !faces_dir.exists() {
        fs::create_dir_all(&faces_dir)
            .map_err(|e| format!("Failed to create faces directory: {}", e))?;
    }

    let conn = db::open(&app)?;
    let model_id = &app_config.methods.face.detection.model_id;
    let detect_model = db::resolve_model_path(&conn, model_id)?
        .ok_or_else(|| format!("Detection model '{}' not found in registry", model_id))?;

    let mut cmd_builder = tokio::process::Command::new(crate::face_session::helper_path());
    cmd_builder
        .arg("capture-face")
        .arg("--output")
        .arg(&file_path)
        .arg("--model")
        .arg(&detect_model);

    if let Some(cam) = camera.filter(|s| !s.is_empty()) {
        cmd_builder.arg("--camera").arg(cam);
    }

    cmd_builder.arg("--align-faces");

    let output = crate::helper_io::output(cmd_builder, std::time::Duration::from_secs(15)).await?;

    if output.status.success() {
        Ok(file_path.to_string_lossy().to_string())
    } else if output.status.code() == Some(3) {
        Err("Facial landmarks could not be detected. Face the camera clearly and try again.".into())
    } else if output.status.code() == Some(2) {
        Err("No face detected. Please position your face in front of the camera.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "Capture failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr
        ))
    }
}

#[tauri::command]
pub fn list_faces(app: AppHandle) -> Result<Vec<String>, String> {
    let faces_dir = get_faces_dir(&app)?;

    if !faces_dir.exists() {
        return Ok(vec![]);
    }

    let entries =
        fs::read_dir(&faces_dir).map_err(|e| format!("Failed to read faces directory: {}", e))?;

    let mut files: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map_or(false, |ext| ext == "jpg" || ext == "png")
        })
        .map(|e| e.path().to_string_lossy().to_string())
        .collect();

    files.sort();
    Ok(files)
}

#[tauri::command]
pub fn delete_face(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
}
