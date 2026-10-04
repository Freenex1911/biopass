import { Channel, convertFileSrc } from "@tauri-apps/api/core";
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
  const previewUrl = useRef<string | null>(null);
  const previewChannel = useRef<Channel<ArrayBuffer> | null>(null);

  function clearFrame() {
    previewChannel.current = null;
    if (previewRef.current) previewRef.current.removeAttribute("src");
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
  }

  function createFrameChannel() {
    const channel = new Channel<ArrayBuffer>();
    previewChannel.current = channel;
    channel.onmessage = (bytes) => {
      if (previewChannel.current !== channel || !previewRef.current) return;
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      previewRef.current.src = url;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = url;
    };
    return channel;
  }

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

  // Subscribe before starting the helper so an immediate failure is not lost.
  useEffect(() => {
    let unlistenError: UnlistenFn | undefined;
    let cancelled = false;

    listen<string>("face-preview-error", (event) => {
      setCapturing(false);
      clearFrame();
      toast.error(event.payload);
      void cmd.face.stopPreview().catch(() => {});
    }).then((u) => {
      if (cancelled) u();
      else unlistenError = u;
    });

    return () => {
      cancelled = true;
      unlistenError?.();
    };
  }, []);

  // Make sure the helper process is torn down on unmount.
  useEffect(() => {
    return () => {
      clearFrame();
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
        await cmd.face.startPreview(camera, createFrameChannel());
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
      await cmd.face.startPreview(camera, createFrameChannel());
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
    clearFrame();
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
      <div className="grid gap-4">
        {capturing && (
          <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
            <img
              ref={previewRef}
              alt="Camera preview"
              className={`w-full h-full object-cover ${capturing ? "" : "hidden"}`}
            />
          </div>
        )}

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

        <p className="text-xs text-muted-foreground">
          Saved photos and deletions take effect immediately.
        </p>

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
                    aria-label="Delete saved face photo"
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
