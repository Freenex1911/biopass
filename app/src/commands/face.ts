import type { Channel } from "@tauri-apps/api/core";
import type { VideoDeviceInfo } from "@/types/config";
import { invokeCommand } from "./core";

function listImages() {
  return invokeCommand<string[]>("list_faces");
}

function saveImage(camera?: string | null) {
  return invokeCommand<string>("capture_face", {
    camera: camera ?? null,
  });
}

function startPreview(
  camera: string | null | undefined,
  frames: Channel<ArrayBuffer>,
) {
  return invokeCommand<void>("start_face_preview", {
    camera: camera ?? null,
    frames,
  });
}

function stopPreview() {
  return invokeCommand<void>("stop_face_preview");
}

function captureInSession() {
  return invokeCommand<string>("capture_face_in_session");
}

function deleteImage(path: string) {
  return invokeCommand<void>("delete_face", { path });
}

function listVideoDevices() {
  return invokeCommand<VideoDeviceInfo[]>("list_video_devices");
}
export const face = {
  listImages,
  saveImage,
  startPreview,
  stopPreview,
  captureInSession,
  deleteImage,
  listVideoDevices,
};
