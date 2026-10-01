use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use futures_util::StreamExt;
use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::config::{load_config, BiopassConfig};
use crate::db::{self, Model};
use crate::paths::get_data_dir;

const VALID_MODEL_TYPES: [&str; 3] = ["detection", "recognition", "anti_spoofing"];
const PROGRESS_EVENT: &str = "model-download-progress";
const PROGRESS_THROTTLE_MS: u128 = 150;
const MAX_NAME_LEN: usize = 200;

#[tauri::command]
pub fn list_models(app: AppHandle, model_type: Option<String>) -> Result<Vec<Model>, String> {
    let conn = db::open(&app)?;
    db::list_models(&conn, model_type.as_deref())
}

#[derive(Serialize)]
pub struct ModelManagement {
    model: Model,
    selected_for: Vec<String>,
    delete_block_reason: Option<String>,
}

fn selected_for(model: &Model, config: &BiopassConfig) -> Vec<String> {
    let face = &config.methods.face;
    let mut roles = Vec::new();
    for (id, label, enabled) in [
        (&face.detection.model_id, "Face detection", face.enable),
        (&face.recognition.model_id, "Face recognition", face.enable),
        (
            &face.anti_spoofing.model.model_id,
            "Photo & screen protection",
            face.enable && face.anti_spoofing.enable,
        ),
    ] {
        if id == &model.id {
            roles.push(format!("{}{}", label, if enabled { "" } else { " (off)" }));
        }
    }
    roles
}

fn delete_block_reason(model: &Model, config: &BiopassConfig) -> Option<String> {
    if model.source == "builtin" {
        Some("Included with BioPass. Bundled models cannot be deleted.".into())
    } else if !selected_for(model, config).is_empty() {
        Some("Selected in sign-in settings. Choose another model and save before deleting, even if the check is off.".into())
    } else {
        None
    }
}

#[tauri::command]
pub fn list_model_management(app: AppHandle) -> Result<Vec<ModelManagement>, String> {
    let conn = db::open(&app)?;
    let config = load_config(app)?;
    Ok(db::list_models(&conn, None)?
        .into_iter()
        .map(|model| ModelManagement {
            selected_for: selected_for(&model, &config),
            delete_block_reason: delete_block_reason(&model, &config),
            model,
        })
        .collect())
}

fn delete_registered_model(
    conn: &Connection,
    model: &Model,
    config: &BiopassConfig,
    dir: &Path,
) -> Result<(), String> {
    if let Some(reason) = delete_block_reason(model, config) {
        return Err(reason);
    }
    let path = PathBuf::from(&model.path);
    if path.starts_with(dir) {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Failed to delete model file: {}", e)),
        }
    }
    db::delete_model(conn, &model.id)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    downloaded: u64,
    total: Option<u64>,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = get_data_dir(app)?.join("models");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create models directory: {}", e))?;
    Ok(dir)
}

fn validate_model_type(model_type: &str) -> Result<(), String> {
    if VALID_MODEL_TYPES.contains(&model_type) {
        Ok(())
    } else {
        Err(format!(
            "Invalid model type '{}'; expected one of {:?}",
            model_type, VALID_MODEL_TYPES
        ))
    }
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }
    if name.len() > MAX_NAME_LEN {
        return Err("Model name is too long".to_string());
    }
    Ok(name)
}

fn slugify(name: &str) -> String {
    let mut slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    }
}

fn unique_model_id(conn: &Connection, base: &str) -> Result<String, String> {
    if db::get_model(conn, base)?.is_none() {
        return Ok(base.to_string());
    }
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if db::get_model(conn, &candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    Err("Failed to allocate a unique model id".to_string())
}

/// ONNX has no fixed magic number, but a serialized ModelProto is a protobuf
/// message whose first field (ir_version, field 1, varint) means real .onnx
/// files begin with byte 0x08. This is a heuristic guard against obviously
/// wrong content (HTML error pages, JSON, etc.), not a full parse.
fn looks_like_onnx(bytes: &[u8]) -> bool {
    matches!(bytes.first(), Some(0x08))
}

fn validate_onnx_file(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        != Some("onnx".to_string())
    {
        return Err("Selected file must have a .onnx extension".to_string());
    }
    let mut file = File::open(path).map_err(|e| format!("Failed to open model file: {}", e))?;
    let mut header = [0u8; 16];
    let n = file
        .read(&mut header)
        .map_err(|e| format!("Failed to read model file: {}", e))?;
    if n == 0 || !looks_like_onnx(&header[..n]) {
        return Err("File does not look like a valid ONNX model".to_string());
    }
    Ok(())
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("Failed to open model file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to hash model file: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("sha256:{}", hex_encode(hasher.finalize())))
}

#[tauri::command]
pub async fn add_model_from_url(
    app: AppHandle,
    name: String,
    model_type: String,
    url: String,
) -> Result<Model, String> {
    validate_model_type(&model_type)?;
    let name = validate_name(&name)?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL must start with http:// or https://".to_string());
    }

    let dir = models_dir(&app)?;
    let id = {
        let conn = db::open(&app)?;
        unique_model_id(&conn, &slugify(&name))?
    };

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to start download: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }
    let total = response.content_length();

    let mut tmp = tempfile::NamedTempFile::new_in(&dir)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let mut header_checked = false;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
        if !header_checked && !chunk.is_empty() {
            header_checked = true;
            if !looks_like_onnx(&chunk) {
                return Err("Downloaded file does not look like a valid ONNX model".to_string());
            }
        }
        tmp.write_all(&chunk)
            .map_err(|e| format!("Failed to write model file: {}", e))?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
            let _ = app.emit(
                PROGRESS_EVENT,
                DownloadProgress {
                    id: id.clone(),
                    downloaded,
                    total,
                },
            );
            last_emit = Instant::now();
        }
    }
    let _ = app.emit(
        PROGRESS_EVENT,
        DownloadProgress {
            id: id.clone(),
            downloaded,
            total,
        },
    );

    if !header_checked {
        return Err("Downloaded file is empty".to_string());
    }
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync model file: {}", e))?;

    let checksum = format!("sha256:{}", hex_encode(hasher.finalize()));
    let final_path = dir.join(format!("{id}.onnx"));
    tmp.persist(&final_path)
        .map_err(|e| format!("Failed to save model file: {}", e))?;

    let conn = db::open(&app)?;
    db::upsert_model(
        &conn,
        &id,
        &name,
        &model_type,
        &final_path.to_string_lossy(),
        None,
        Some(&checksum),
        "user",
    )?;
    db::get_model(&conn, &id)?.ok_or_else(|| "Model vanished after insert".to_string())
}

#[tauri::command]
pub fn add_model_from_file(
    app: AppHandle,
    name: String,
    model_type: String,
    src_path: String,
) -> Result<Model, String> {
    validate_model_type(&model_type)?;
    let name = validate_name(&name)?;

    let src = PathBuf::from(&src_path);
    validate_onnx_file(&src)?;

    let dir = models_dir(&app)?;
    let conn = db::open(&app)?;
    let id = unique_model_id(&conn, &slugify(&name))?;
    let final_path = dir.join(format!("{id}.onnx"));

    let mut tmp = tempfile::NamedTempFile::new_in(&dir)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;
    let mut src_file =
        File::open(&src).map_err(|e| format!("Failed to open source file: {}", e))?;
    std::io::copy(&mut src_file, tmp.as_file_mut())
        .map_err(|e| format!("Failed to copy model file: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync model file: {}", e))?;

    let checksum = sha256_file(tmp.path())?;
    tmp.persist(&final_path)
        .map_err(|e| format!("Failed to save model file: {}", e))?;

    db::upsert_model(
        &conn,
        &id,
        &name,
        &model_type,
        &final_path.to_string_lossy(),
        None,
        Some(&checksum),
        "user",
    )?;
    db::get_model(&conn, &id)?.ok_or_else(|| "Model vanished after insert".to_string())
}

#[tauri::command]
pub fn delete_model(app: AppHandle, id: String) -> Result<(), String> {
    let conn = db::open(&app)?;
    let model = db::get_model(&conn, &id)?.ok_or_else(|| format!("Model '{}' not found", id))?;

    let config = load_config(app.clone())?;
    delete_registered_model(&conn, &model, &config, &models_dir(&app)?)
}

#[tauri::command]
pub fn rename_model(app: AppHandle, id: String, name: String) -> Result<Model, String> {
    let name = validate_name(&name)?;
    let conn = db::open(&app)?;
    db::update_model_name(&conn, &id, &name)?;
    db::get_model(&conn, &id)?.ok_or_else(|| format!("Model '{}' not found", id))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, tempfile::TempDir, Model, BiopassConfig) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("custom.onnx");
        std::fs::write(&path, b"test model").unwrap();
        db::upsert_model(
            &conn,
            "custom",
            "Custom",
            "anti_spoofing",
            path.to_str().unwrap(),
            None,
            None,
            "user",
        )
        .unwrap();
        let model = db::get_model(&conn, "custom").unwrap().unwrap();
        let config = serde_yaml::from_str(
            r#"
schema_version: 2
appearance: system
strategy: {debug: false, execution_mode: parallel, order: [face], ignore_services: []}
methods:
  face:
    enable: true
    retries: 5
    retry_delay: 200
    camera: null
    detection: {model_id: detector, threshold: 0.5}
    recognition: {model_id: recognizer, threshold: 0.5}
    anti_spoofing:
      enable: false
      model: {model_id: protection, threshold: 0.8}
      ir_camera: null
      ir_warmup_delay_ms: 400
      ir_presence_timeout_ms: 1500
  fingerprint: {enable: false, retries: 1, timeout: 5000}
"#,
        )
        .unwrap();
        (conn, dir, model, config)
    }
    #[test]
    fn delete_imported_model_removes_file_and_registry() {
        let (conn, dir, model, config) = fixture();
        delete_registered_model(&conn, &model, &config, dir.path()).unwrap();
        assert!(!Path::new(&model.path).exists());
        assert!(db::get_model(&conn, &model.id).unwrap().is_none());
    }
    #[test]
    fn disabled_selected_model_is_protected_even_if_file_missing() {
        let (conn, dir, model, mut config) = fixture();
        config.methods.face.anti_spoofing.model.model_id = model.id.clone();
        assert_eq!(
            selected_for(&model, &config),
            vec!["Photo & screen protection (off)"]
        );
        assert!(delete_registered_model(&conn, &model, &config, dir.path()).is_err());
        assert!(Path::new(&model.path).exists());
        std::fs::remove_file(&model.path).unwrap();
        assert!(delete_registered_model(&conn, &model, &config, dir.path()).is_err());
        assert!(db::get_model(&conn, &model.id).unwrap().is_some());
    }
    #[test]
    fn builtin_models_are_protected_and_external_files_are_preserved() {
        let (conn, dir, mut model, config) = fixture();
        model.source = "builtin".into();
        assert!(delete_registered_model(&conn, &model, &config, dir.path()).is_err());
        model.source = "user".into();
        let managed = tempfile::tempdir().unwrap();
        delete_registered_model(&conn, &model, &config, managed.path()).unwrap();
        assert!(Path::new(&model.path).exists());
        assert!(db::get_model(&conn, &model.id).unwrap().is_none());
    }
    #[test]
    fn missing_unselected_model_can_be_removed_from_registry() {
        let (conn, dir, model, config) = fixture();
        std::fs::remove_file(&model.path).unwrap();
        delete_registered_model(&conn, &model, &config, dir.path()).unwrap();
        assert!(db::get_model(&conn, &model.id).unwrap().is_none());
    }
}
