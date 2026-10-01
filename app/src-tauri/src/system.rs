use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;

#[derive(Debug, Serialize, Clone)]
pub struct VideoDeviceInfo {
    pub path: String,
    pub name: String,
    pub display_name: String,
    pub stable_id: String,
}

#[derive(Deserialize)]
struct CaptureCamera {
    id: String,
    model: String,
    video_paths: Vec<String>,
}

#[tauri::command]
pub fn get_current_username() -> Result<String, String> {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .map_err(|_| "Could not determine current username".to_string())
}

#[tauri::command]
pub fn list_video_devices() -> Result<Vec<VideoDeviceInfo>, String> {
    // Enumerate through the same backend as authentication, excluding
    // metadata-only nodes and identifying RGB/IR streams independently.
    let output = Command::new(crate::face_session::helper_path())
        .arg("list-cameras")
        .output()
        .map_err(|e| format!("Could not list capture cameras: {e}"))?;
    if !output.status.success() {
        return Err("Camera discovery failed. Update the app and biopass-helper together.".into());
    }
    let cameras: Vec<CaptureCamera> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid camera discovery response: {e}"))?;
    let mut devices = Vec::new();
    for camera in cameras {
        let stable_id = format!("libcamera:{}", camera.id);
        let path = camera
            .video_paths
            .first()
            .cloned()
            .unwrap_or_else(|| stable_id.clone());
        let node = path.strip_prefix("/dev/").unwrap_or("");
        let name = fs::read_to_string(format!("/sys/class/video4linux/{node}/name"))
            .map(|value| value.trim().to_string())
            .unwrap_or(camera.model);
        let display_name = if node.is_empty() {
            name.clone()
        } else {
            format!("{name} ({path})")
        };
        devices.push(VideoDeviceInfo {
            path,
            name,
            display_name,
            stable_id,
        });
    }
    Ok(devices)
}
