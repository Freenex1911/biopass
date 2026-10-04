use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

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
const MAX_MODEL_BYTES: u64 = 512 * 1024 * 1024;
static DOWNLOADS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
struct DownloadRegistration(String);
impl Drop for DownloadRegistration {
    fn drop(&mut self) {
        if let Ok(mut downloads) = DOWNLOADS.lock() {
            downloads.remove(&self.0);
        }
    }
}
#[tauri::command]
pub fn cancel_model_download(request_id: String) -> Result<(), String> {
    if let Some(token) = DOWNLOADS
        .lock()
        .map_err(|e| e.to_string())?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}
async fn validate_import(path: &Path, model_type: &str) -> Result<(), String> {
    let mut command = tokio::process::Command::new(crate::face_session::helper_path());
    command
        .arg("validate-model")
        .arg("--model")
        .arg(path)
        .arg("--type")
        .arg(model_type);
    let output = crate::helper_io::output(command, Duration::from_secs(30)).await?;
    if !output.status.success() {
        return Err(format!(
            "Model is incompatible: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

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

async fn stream_download(
    client: reqwest::Client,
    parsed: reqwest::Url,
    dir: PathBuf,
    max_bytes: u64,
    progress: impl Fn(u64, Option<u64>),
) -> Result<(tempfile::NamedTempFile, String), String> {
    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = response.content_length();
    if total.is_some_and(|size| size > max_bytes) {
        return Err("Model exceeds the download size limit".into());
    }
    let tmp = tempfile::NamedTempFile::new_in(&dir).map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::from_std(tmp.reopen().map_err(|e| e.to_string())?);
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut hasher = Sha256::new();
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download failed: {e}"))?;
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or("Invalid download size")?;
        if downloaded > max_bytes {
            return Err("Model exceeds the download size limit".into());
        }
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        if last_emit.elapsed().as_millis() >= PROGRESS_THROTTLE_MS {
            progress(downloaded, total);
            last_emit = Instant::now();
        }
    }
    if downloaded == 0 {
        return Err("Downloaded file is empty".into());
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    progress(downloaded, total);
    let checksum = format!("sha256:{}", hex_encode(hasher.finalize()));
    Ok((tmp, checksum))
}

#[tauri::command]
pub async fn add_model_from_url(
    app: AppHandle,
    name: String,
    model_type: String,
    url: String,
    request_id: String,
) -> Result<Model, String> {
    validate_model_type(&model_type)?;
    let name = validate_name(&name)?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid download URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("URL must start with http:// or https://".into());
    }
    if request_id.is_empty() || request_id.len() > 100 {
        return Err("Invalid download request".into());
    }
    let token = CancellationToken::new();
    {
        let mut downloads = DOWNLOADS.lock().map_err(|e| e.to_string())?;
        if downloads.contains_key(&request_id) {
            return Err("Download is already running".into());
        }
        downloads.insert(request_id.clone(), token.clone());
    }
    let _registration = DownloadRegistration(request_id.clone());
    let download = async {
        let preparation = app.clone();
        let dir = tauri::async_runtime::spawn_blocking(move || models_dir(&preparation))
            .await
            .map_err(|e| e.to_string())??;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        let (tmp, checksum) =
            stream_download(client, parsed, dir, MAX_MODEL_BYTES, |downloaded, total| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DownloadProgress {
                        id: request_id.clone(),
                        downloaded,
                        total,
                    },
                );
            })
            .await?;
        validate_import(tmp.path(), &model_type).await?;
        Ok::<_, String>((tmp, checksum))
    };
    let (tmp, checksum) = tokio::select! {
        biased;
        _ = token.cancelled() => return Err("Download cancelled".into()),
        result = download => result?,
    };
    // Publication is short and atomic with respect to cancellation: after
    // validation finishes, the import is committed as a single operation.
    tauri::async_runtime::spawn_blocking(move || {
        publish_import(&app, &name, &model_type, tmp, checksum)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn publish_import(
    app: &AppHandle,
    name: &str,
    model_type: &str,
    tmp: tempfile::NamedTempFile,
    checksum: String,
) -> Result<Model, String> {
    let mut conn = db::open(app)?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let id = unique_model_id(&transaction, &slugify(name))?;
    let final_path = tmp
        .path()
        .parent()
        .ok_or("Missing model directory")?
        .join(format!("{id}.onnx"));
    tmp.persist_noclobber(&final_path)
        .map_err(|e| format!("Failed to save model: {e}"))?;
    let registered = (|| {
        db::upsert_model(
            &transaction,
            &id,
            name,
            model_type,
            &final_path.to_string_lossy(),
            None,
            Some(&checksum),
            "user",
        )?;
        let model = db::get_model(&transaction, &id)?.ok_or("Model vanished after insert")?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(model)
    })();
    if registered.is_err() {
        let _ = std::fs::remove_file(final_path);
    }
    registered
}
#[tauri::command]
pub async fn add_model_from_file(
    app: AppHandle,
    name: String,
    model_type: String,
    src_path: String,
) -> Result<Model, String> {
    validate_model_type(&model_type)?;
    let name = validate_name(&name)?;
    let preparation = app.clone();
    let (tmp, checksum) = tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(src_path);
        if !src
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("onnx"))
        {
            return Err("Selected file must have a .onnx extension".into());
        }
        if std::fs::metadata(&src).map_err(|e| e.to_string())?.len() > MAX_MODEL_BYTES {
            return Err("Model exceeds the 512 MiB size limit".into());
        }
        let dir = models_dir(&preparation)?;
        let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        let mut source = File::open(src).map_err(|e| e.to_string())?;
        let copied = std::io::copy(
            &mut std::io::Read::by_ref(&mut source).take(MAX_MODEL_BYTES + 1),
            tmp.as_file_mut(),
        )
        .map_err(|e| e.to_string())?;
        if copied == 0 || copied > MAX_MODEL_BYTES {
            return Err("Model is empty or exceeds the 512 MiB size limit".into());
        }
        tmp.as_file().sync_all().map_err(|e| e.to_string())?;
        let checksum = sha256_file(tmp.path())?;
        Ok::<_, String>((tmp, checksum))
    })
    .await
    .map_err(|e| e.to_string())??;
    validate_import(tmp.path(), &model_type).await?;
    tauri::async_runtime::spawn_blocking(move || {
        publish_import(&app, &name, &model_type, tmp, checksum)
    })
    .await
    .map_err(|e| e.to_string())?
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
    async fn response_server(
        response: &'static [u8],
        stall: bool,
    ) -> (reqwest::Url, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
            if stall {
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        (
            reqwest::Url::parse(&format!("http://{address}/model.onnx")).unwrap(),
            task,
        )
    }
    #[tokio::test]
    async fn rejects_large_downloads_with_and_without_content_length() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n".as_slice(),
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n0123456789abcdef0123456789abcdef"
                .as_slice(),
        ] {
            let (url, server) = response_server(response, false).await;
            let dir = tempfile::tempdir().unwrap();
            assert!(stream_download(
                reqwest::Client::new(),
                url,
                dir.path().into(),
                16,
                |_, _| {}
            )
            .await
            .is_err());
            server.await.unwrap();
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }
    #[tokio::test]
    async fn stalled_and_cancelled_downloads_remove_partial_files() {
        for cancel in [false, true] {
            let (url, server) = response_server(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n08",
                true,
            )
            .await;
            let dir = tempfile::tempdir().unwrap();
            let client = reqwest::Client::builder()
                .read_timeout(Duration::from_millis(50))
                .build()
                .unwrap();
            let download = stream_download(client, url, dir.path().into(), 1024, |_, _| {});
            if cancel {
                tokio::select! { _ = tokio::time::sleep(Duration::from_millis(20)) => {}, result = download => panic!("Unexpected early completion: {result:?}") }
            } else {
                assert!(download.await.is_err());
            }
            server.abort();
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        }
    }
    #[tokio::test]
    async fn downloaded_bytes_and_checksum_are_preserved() {
        let (url, server) = response_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
            false,
        )
        .await;
        let dir = tempfile::tempdir().unwrap();
        let (file, checksum) = stream_download(
            reqwest::Client::new(),
            url,
            dir.path().into(),
            1024,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(file.path()).unwrap(), b"abc");
        assert_eq!(
            checksum,
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        server.await.unwrap();
    }
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
        let config = serde_saphyr::from_str(
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
