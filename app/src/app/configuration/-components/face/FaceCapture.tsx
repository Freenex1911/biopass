import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Camera, Circle, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cmd } from "@/commands";
import { Button } from "@/components/ui/button";

export function FaceCapture({
  camera,
  available,
}: {
  camera: string | null;
  available: boolean;
}) {
  const previewRef = useRef<HTMLImageElement>(null);
  const [capturing, setCapturing] = useState(false);
  const runningCamera = useRef<string | null | undefined>(undefined);
  const [faceImages, setFaceImages] = useState<string[]>([]);

  const loadFaceImages = useCallback(async () => {
    try {
      const images = await cmd.face.listImages();
      setFaceImages(images);
    } catch (err) {
      console.error("Failed to load face images:", err);
    }
  }, []);

  useEffect(() => {
    loadFaceImages();
  }, [loadFaceImages]);

  // Subscribe to native preview frames whenever the session is active.
  useEffect(() => {
    if (!capturing) return;

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    listen<string>("face-preview-frame", (event) => {
      if (previewRef.current) {
        previewRef.current.src = `data:image/jpeg;base64,${event.payload}`;
      }
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [capturing]);

  // Make sure the helper process is torn down on unmount.
  useEffect(() => {
    return () => {
      cmd.face.stopPreview().catch(() => {});
    };
  }, []);

  // Restart session when camera selection changes while preview is running.
  useEffect(() => {
    if (!capturing) return;
    if (available && runningCamera.current === camera) return;
    let alive = true;
    (async () => {
      try {
        await cmd.face.stopPreview();
        if (!available) {
          setCapturing(false);
          return;
        }
        await cmd.face.startPreview(camera);
        runningCamera.current = camera;
      } catch (err) {
        if (alive) {
          toast.error(`Failed to switch camera: ${err}`);
          setCapturing(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [camera, capturing, available]);

  async function startCamera() {
    if (!available) return;
    try {
      await cmd.face.startPreview(camera);
      runningCamera.current = camera;
      setCapturing(true);
    } catch (err) {
      toast.error(`Failed to start camera: ${err}`);
      console.error(err);
    }
  }

  async function stopCamera() {
    try {
      await cmd.face.stopPreview();
    } catch (err) {
      console.error("stopPreview failed:", err);
    }
    setCapturing(false);
    if (previewRef.current) {
      previewRef.current.removeAttribute("src");
    }
  }

  async function capturePhoto() {
    try {
      await cmd.face.captureInSession();
      toast.success("Face image saved!");
      await loadFaceImages();
    } catch (err) {
      toast.error(`${err}`);
    }
  }

  async function deleteFace(path: string) {
    try {
      await cmd.face.deleteImage(path);
      toast.success("Face image deleted");
      await loadFaceImages();
    } catch (err) {
      toast.error(`Failed to delete: ${err}`);
    }
  }

  return (
    <div className="p-4 rounded-lg bg-muted/50 border border-border/50">
      <h4 className="font-medium mb-3 flex items-center gap-2">
        <Camera className="w-4 h-4" />
        Camera preview & saved photos
      </h4>

      <div className="grid gap-4">
        <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
          <img
            ref={previewRef}
            alt="Camera preview"
            className={`w-full h-full object-cover ${capturing ? "" : "hidden"}`}
          />
          {!capturing && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Camera className="w-12 h-12 opacity-50" />
            </div>
          )}
        </div>

        <div className="flex gap-2">
          {!capturing ? (
            <Button
              type="button"
              onClick={startCamera}
              disabled={!available}
              className="flex-1"
            >
              <Camera className="w-4 h-4 mr-2" />
              Start preview
            </Button>
          ) : (
            <>
              <Button type="button" onClick={capturePhoto} className="flex-1">
                <Circle className="w-4 h-4 mr-2" />
                Save face photo
              </Button>
              <Button type="button" variant="outline" onClick={stopCamera}>
                <Square className="w-4 h-4 mr-2" />
                Stop
              </Button>
            </>
          )}
        </div>

        {faceImages.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              Saved Faces ({faceImages.length})
            </p>
            <div className="grid grid-cols-4 gap-2">
              {faceImages.map((path) => (
                <div key={path} className="relative group">
                  <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                    <img
                      src={convertFileSrc(path)}
                      alt="Captured face"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteFace(path)}
                    className="absolute top-1 right-1 p-1 rounded bg-destructive/80 text-destructive-foreground cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
