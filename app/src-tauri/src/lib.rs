pub mod config;
pub mod db;
pub mod face;
pub mod face_session;
pub mod fingerprint;
pub mod fingerprint_ffi;
mod helper_io;
pub mod models;
pub mod paths;
pub mod system;

use config::{load_config, save_appearance, save_config};
use face::{capture_face, delete_face, list_faces};
use face_session::{capture_face_in_session, start_face_preview, stop_face_preview};
use fingerprint::{
    add_fingerprint, delete_fingerprint, enroll_fingerprint, fingerprint_is_available,
    list_enrolled_fingerprints, list_fingerprint_devices, remove_fingerprint,
};
use models::{
    add_model_from_file, add_model_from_url, delete_model, list_model_management, list_models,
    rename_model,
};
use system::{get_current_username, list_video_devices};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            save_appearance,
            get_current_username,
            capture_face,
            start_face_preview,
            stop_face_preview,
            capture_face_in_session,
            list_faces,
            list_video_devices,
            delete_face,
            add_fingerprint,
            delete_fingerprint,
            enroll_fingerprint,
            remove_fingerprint,
            fingerprint_is_available,
            list_enrolled_fingerprints,
            list_fingerprint_devices,
            list_models,
            list_model_management,
            add_model_from_url,
            add_model_from_file,
            delete_model,
            rename_model
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            face_session::cleanup_preview();
        }
    });
}
