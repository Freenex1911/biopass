use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use tauri::AppHandle;

use crate::paths::{get_config_dir, get_config_path};

/// Bumped whenever the on-disk config.yaml shape changes in a way that isn't
/// forward/backward compatible. Mirrors CURRENT_SCHEMA_VERSION in
/// auth/core/auth_config.h - keep both in sync.
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct BiopassConfig {
    pub schema_version: u32,
    pub strategy: StrategyConfig,
    pub methods: MethodsConfig,
    pub appearance: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct StrategyConfig {
    pub debug: bool,
    pub execution_mode: String,
    pub order: Vec<String>,
    pub ignore_services: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MethodsConfig {
    pub face: FaceMethodConfig,
    pub fingerprint: FingerprintMethodConfig,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct FaceMethodConfig {
    pub enable: bool,
    pub retries: u32,
    pub retry_delay: u32,
    pub camera: Option<String>,
    #[serde(default)]
    pub camera_selection: CameraSelectionConfig,
    pub detection: DetectionConfig,
    pub recognition: RecognitionConfig,
    pub anti_spoofing: AntiSpoofingConfig,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CameraSelectionMode {
    Legacy,
    Priority,
    Fixed,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CameraPairConfig {
    pub id: String,
    pub name: String,
    pub camera: String,
    pub ir_camera: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct CameraSelectionConfig {
    pub mode: CameraSelectionMode,
    pub pairs: Vec<CameraPairConfig>,
    pub fixed_pair: Option<String>,
}

impl Default for CameraSelectionConfig {
    fn default() -> Self {
        Self {
            mode: CameraSelectionMode::Legacy,
            pairs: Vec::new(),
            fixed_pair: None,
        }
    }
}

fn validate_camera_selection(selection: &CameraSelectionConfig) -> Result<(), String> {
    if selection.mode == CameraSelectionMode::Legacy {
        return Ok(());
    }
    if selection.pairs.is_empty() {
        return Err("Add at least one camera setup".into());
    }
    let mut ids = std::collections::HashSet::new();
    for pair in &selection.pairs {
        if pair.id.is_empty() || !ids.insert(&pair.id) {
            return Err("Camera pair IDs must be unique and nonempty".into());
        }
        if pair.name.trim().is_empty() || pair.camera.is_empty() {
            return Err("Each camera setup needs a name and color camera".into());
        }
        if pair.camera == pair.ir_camera {
            return Err("Use different color and IR streams".into());
        }
    }
    if selection.mode == CameraSelectionMode::Fixed
        && !selection
            .pairs
            .iter()
            .any(|pair| Some(&pair.id) == selection.fixed_pair.as_ref())
    {
        return Err("Select the camera to use".into());
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DetectionConfig {
    pub model_id: String,
    pub threshold: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct RecognitionConfig {
    pub model_id: String,
    pub threshold: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AntiSpoofingModelConfig {
    pub model_id: String,
    pub threshold: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AntiSpoofingConfig {
    pub enable: bool,
    pub model: AntiSpoofingModelConfig,
    pub ir_camera: Option<String>,
    pub ir_warmup_delay_ms: i32,
    pub ir_presence_timeout_ms: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct FingerprintMethodConfig {
    pub enable: bool,
    pub retries: u32,
    pub timeout: u32,
}

// Mirrors the defaults in auth/core/auth_config.h's AntiSpoofingConfig.
const DEFAULT_IR_WARMUP_DELAY_MS: i32 = 300;
const DEFAULT_IR_PRESENCE_TIMEOUT_MS: i32 = 1500;

fn default_ignored_services() -> Vec<String> {
    vec!["polkit-1".to_string(), "pkexec".to_string()]
}

fn get_default_config() -> BiopassConfig {
    BiopassConfig {
        schema_version: CURRENT_SCHEMA_VERSION,
        strategy: StrategyConfig {
            debug: false,
            execution_mode: "parallel".to_string(),
            order: vec!["face".to_string(), "fingerprint".to_string()],
            ignore_services: default_ignored_services(),
        },
        methods: MethodsConfig {
            face: FaceMethodConfig {
                enable: true,
                retries: 5,
                retry_delay: 200,
                camera: None,
                camera_selection: CameraSelectionConfig::default(),
                detection: DetectionConfig {
                    model_id: "yolov8n-face".to_string(),
                    threshold: 0.5,
                },
                recognition: RecognitionConfig {
                    model_id: "edgeface-s-gamma-05".to_string(),
                    threshold: 0.5,
                },
                anti_spoofing: AntiSpoofingConfig {
                    enable: true,
                    model: AntiSpoofingModelConfig {
                        model_id: "mobilenetv3-antispoof".to_string(),
                        threshold: 0.8,
                    },
                    ir_camera: None,
                    ir_warmup_delay_ms: DEFAULT_IR_WARMUP_DELAY_MS,
                    ir_presence_timeout_ms: DEFAULT_IR_PRESENCE_TIMEOUT_MS,
                },
            },
            fingerprint: FingerprintMethodConfig {
                enable: false,
                retries: 1,
                timeout: 5000,
            },
        },
        appearance: "system".to_string(),
    }
}

/// Parses config.yaml content, falling back to defaults on a parse error or a
/// schema_version that doesn't match CURRENT_SCHEMA_VERSION -- mirrors the
/// defaults+warn fallback in auth/core/auth_config.cc's readConfig().
fn parse_config(content: &str) -> BiopassConfig {
    match serde_yaml::from_str::<BiopassConfig>(content) {
        Ok(config) if config.schema_version == CURRENT_SCHEMA_VERSION => config,
        Ok(config) => {
            eprintln!(
                "Warning: config.yaml schema_version {} does not match expected {}; using defaults",
                config.schema_version, CURRENT_SCHEMA_VERSION
            );
            get_default_config()
        }
        Err(e) => {
            eprintln!(
                "Warning: failed to parse config.yaml ({}); using defaults",
                e
            );
            get_default_config()
        }
    }
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<BiopassConfig, String> {
    let config_path = get_config_path(&app)?;

    if !config_path.exists() {
        return Ok(get_default_config());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;

    Ok(parse_config(&content))
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: BiopassConfig) -> Result<(), String> {
    validate_camera_selection(&config.methods.face.camera_selection)?;
    let config_dir = get_config_dir(&app)?;
    let config_path = get_config_path(&app)?;

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }

    let yaml_content =
        serde_yaml::to_string(&config).map_err(|e| format!("Failed to serialize config: {}", e))?;

    // Write to a temp file in the same directory (so the rename below is an
    // atomic same-filesystem operation) then persist over the real path, so a
    // crash mid-write can never leave config.yaml truncated/corrupt.
    let mut tmp_file = tempfile::NamedTempFile::new_in(&config_dir)
        .map_err(|e| format!("Failed to create temporary config file: {}", e))?;
    tmp_file
        .write_all(yaml_content.as_bytes())
        .map_err(|e| format!("Failed to write temporary config file: {}", e))?;
    tmp_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary config file: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp_file
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to set config file permissions: {}", e))?;
    }

    tmp_file
        .persist(&config_path)
        .map_err(|e| format!("Failed to save config file: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_only_setups_are_valid_but_color_stream_is_required() {
        let mut selection = CameraSelectionConfig {
            mode: CameraSelectionMode::Fixed,
            fixed_pair: Some("camera".into()),
            pairs: vec![CameraPairConfig {
                id: "camera".into(),
                name: "Camera".into(),
                camera: "libcamera:rgb".into(),
                ir_camera: String::new(),
            }],
        };
        assert!(validate_camera_selection(&selection).is_ok());
        selection.pairs[0].camera.clear();
        assert!(validate_camera_selection(&selection).is_err());
    }

    #[test]
    fn existing_configs_preserve_individual_camera_settings() {
        let mut config = get_default_config();
        config.methods.face.camera = Some("/dev/video0".into());
        config.methods.face.anti_spoofing.ir_camera = Some("/dev/video2".into());
        let mut value = serde_json::to_value(&config).unwrap();
        value["methods"]["face"]
            .as_object_mut()
            .unwrap()
            .remove("camera_selection");
        let loaded = parse_config(&serde_yaml::to_string(&value).unwrap());
        assert_eq!(loaded, config);
    }

    #[test]
    fn pair_configuration_round_trips_without_losing_disconnected_entries() {
        let mut config = get_default_config();
        config.methods.face.camera_selection = CameraSelectionConfig {
            mode: CameraSelectionMode::Priority,
            fixed_pair: None,
            pairs: vec![CameraPairConfig {
                id: "dock".into(),
                name: "Dock".into(),
                camera: "libcamera:rgb".into(),
                ir_camera: "libcamera:ir".into(),
            }],
        };
        assert_eq!(
            parse_config(&serde_yaml::to_string(&config).unwrap()),
            config
        );
    }

    #[test]
    fn fixed_mode_requires_an_explicit_pair() {
        let selection = CameraSelectionConfig {
            mode: CameraSelectionMode::Fixed,
            fixed_pair: Some("missing".into()),
            pairs: vec![CameraPairConfig {
                id: "dock".into(),
                name: "Dock".into(),
                camera: "libcamera:rgb".into(),
                ir_camera: "libcamera:ir".into(),
            }],
        };
        assert!(validate_camera_selection(&selection).is_err());
        assert!(validate_camera_selection(&CameraSelectionConfig {
            fixed_pair: Some("dock".into()),
            ..selection
        })
        .is_ok());
    }
}
