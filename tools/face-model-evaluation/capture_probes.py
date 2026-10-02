"""Capture local RGB evaluation frames after the user confirms readiness."""

import argparse
import time
from pathlib import Path

import cv2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="/dev/video0")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--pose", choices=["frontal", "tilt-left", "tilt-right"], required=True
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.output.chmod(0o700)
    camera = cv2.VideoCapture(args.device, cv2.CAP_V4L2)
    try:
        camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        camera.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not camera.isOpened():
            raise RuntimeError("Could not open RGB camera")
        for pose in [args.pose]:
            print(pose, flush=True)
            start = time.monotonic()
            next_capture = start + 2
            number = 0
            while time.monotonic() - start < 10:
                ok, frame = camera.read()
                if not ok:
                    raise RuntimeError("Could not read RGB camera")
                now = time.monotonic()
                if now >= next_capture:
                    path = args.output / f"{pose}-{number}.png"
                    if not cv2.imwrite(str(path), frame):
                        raise RuntimeError("Could not save evaluation frame")
                    path.chmod(0o600)
                    number += 1
                    next_capture = now + 2
        print("Capture finished; camera released", flush=True)
    finally:
        camera.release()


if __name__ == "__main__":
    main()
