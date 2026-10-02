"""Offline CPU comparison of cropped/aligned faces. Never modifies BioPass settings."""

import argparse
import hashlib
import itertools
import json
import platform
import subprocess
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from skimage.transform import SimilarityTransform

# ArcFace/EdgeFace 112px reference, in detector order: eyes, nose, mouth.
REFERENCE = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


def biopass_letterbox(image, size=112):
    """Match imageResizePad: half-pixel bilinear resize, round, black padding."""
    height, width = image.shape[:2]
    scale = np.float32(min(size / width, size / height))
    nw, nh = int(np.floor(width * scale + 0.5)), int(np.floor(height * scale + 0.5))
    xx = (np.arange(nw, dtype=np.float32) + 0.5) * np.float32(width / nw) - 0.5
    yy = (np.arange(nh, dtype=np.float32) + 0.5) * np.float32(height / nh) - 0.5
    x0, y0 = np.floor(xx).astype(int), np.floor(yy).astype(int)
    wx, wy = (
        (xx - x0).astype(np.float32)[None, :, None],
        (yy - y0).astype(np.float32)[:, None, None],
    )
    x1, y1 = np.clip(x0 + 1, 0, width - 1), np.clip(y0 + 1, 0, height - 1)
    x0, y0 = np.clip(x0, 0, width - 1), np.clip(y0, 0, height - 1)
    src = image.astype(np.float32)
    resized = (1 - wy) * ((1 - wx) * src[y0[:, None], x0] + wx * src[y0[:, None], x1])
    resized += wy * ((1 - wx) * src[y1[:, None], x0] + wx * src[y1[:, None], x1])
    result = np.zeros((size, size, 3), dtype=np.uint8)
    dx, dy = (size - nw) // 2, (size - nh) // 2
    result[dy : dy + nh, dx : dx + nw] = np.clip(resized + 0.5, 0, 255).astype(np.uint8)
    return result


def alignment_matrix(landmarks):
    points = np.asarray(landmarks, dtype=np.float32)
    if points.shape != (5, 2) or not np.isfinite(points).all():
        raise ValueError("Five finite landmarks required")
    if np.linalg.norm(points[0] - points[1]) < 2:
        raise ValueError("Degenerate landmarks")
    transform = SimilarityTransform()
    if not transform.estimate(points, REFERENCE):
        raise ValueError("Could not estimate face alignment")
    if not np.isfinite(transform.params).all() or transform.scale <= 0:
        raise ValueError("Invalid face transform")
    residual = np.sqrt(np.mean(np.sum((transform(points) - REFERENCE) ** 2, axis=1)))
    if residual > 10:
        raise ValueError("Inconsistent facial landmarks")
    return transform.params[:2].astype(np.float32)


def align_face(image, landmarks):
    return cv2.warpAffine(
        image,
        alignment_matrix(landmarks),
        (112, 112),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )


class Aligner:
    def __init__(self, model):
        self.detector = cv2.FaceDetectorYN.create(
            str(model), "", (320, 320), 0.8, 0.3, 5000
        )

    def prepare(self, image):
        height, width = image.shape[:2]
        scale = min(1.0, 320 / max(height, width))
        view = cv2.resize(image, (round(width * scale), round(height * scale)))
        self.detector.setInputSize((view.shape[1], view.shape[0]))
        _, faces = self.detector.detect(view)
        if faces is None or len(faces) != 1:
            raise ValueError("Expected exactly one detected face")
        row = faces[0].copy()
        row[:14] /= scale
        crop = image[
            max(0, int(row[1])) : min(height, int(row[1] + row[3])),
            max(0, int(row[0])) : min(width, int(row[0] + row[2])),
        ]
        if crop.size == 0:
            raise ValueError("Empty face crop")
        return crop, align_face(image, row[4:14].reshape(5, 2))


def tensor(image):
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32)
    return ((rgb / 255.0 - 0.5) / 0.5).transpose(2, 0, 1)[None].copy()


class Recognizer:
    def __init__(self, path):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        start = time.perf_counter()
        self.session = ort.InferenceSession(
            str(path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self.load_ms = (time.perf_counter() - start) * 1000
        inputs = self.session.get_inputs()
        outputs = self.session.get_outputs()
        if (
            len(inputs) != 1
            or len(outputs) != 1
            or inputs[0].shape[1:] != [3, 112, 112]
        ):
            raise ValueError("Expected a single NCHW 112px face recognizer")
        self.name = inputs[0].name

    def embed(self, data):
        embedding = self.session.run(None, {self.name: data})[0].reshape(-1)
        norm = np.linalg.norm(embedding)
        if not np.isfinite(embedding).all() or not np.isfinite(norm) or norm <= 0:
            raise ValueError("Invalid embedding")
        return embedding / norm


def summary(values):
    return (
        {
            "count": len(values),
            "min": float(np.min(values)),
            "median": float(np.median(values)),
            "max": float(np.max(values)),
            "p95": float(np.percentile(values, 95)),
        }
        if values
        else None
    )


def production_crop(path, helper, model):
    with tempfile.TemporaryDirectory(prefix="biopass-eval-") as folder:
        output = Path(folder) / "crop.png"
        subprocess.run(
            [
                str(helper),
                "crop-face",
                "--input",
                str(path),
                "--output",
                str(output),
                "--model",
                str(model),
            ],
            check=True,
            capture_output=True,
            timeout=10,
        )
        crop = cv2.imread(str(output))
        if crop is None:
            raise ValueError("Native helper produced no usable crop")
        return crop


def check_native_parity(image, model_path, probe, expected):
    with tempfile.TemporaryDirectory(prefix="biopass-parity-") as folder:
        path = Path(folder) / "input.png"
        if not cv2.imwrite(str(path), image):
            raise ValueError("Could not write native parity input")
        result = subprocess.run(
            [str(probe), str(model_path), str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        native = np.fromstring(result.stdout, sep="\n")
        if native.shape != expected.shape or not np.isfinite(native).all():
            raise ValueError("Invalid native reference embedding")
        norm = np.linalg.norm(native)
        if not np.isfinite(norm) or norm <= 0:
            raise ValueError("Invalid native reference norm")
        native /= norm
        error = float(np.max(np.abs(native - expected)))
        if error > 1e-4:
            raise ValueError(f"Evaluation differs from native preprocessing: {error}")
        return error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--faces",
        type=Path,
        required=True,
        help="Existing cropped photos of one identity",
    )
    parser.add_argument(
        "--negatives", type=Path, help="Full photos of other people; diagnostic only"
    )
    parser.add_argument(
        "--probes", type=Path, help="New full-frame photos of the enrolled identity"
    )
    parser.add_argument("--landmark-model", type=Path, required=True)
    parser.add_argument(
        "--crop-helper",
        type=Path,
        help="Installed BioPass helper for production YOLO crops",
    )
    parser.add_argument("--crop-model", type=Path, help="Current YOLO detection model")
    parser.add_argument(
        "--native-probe",
        type=Path,
        help="Built recognition_probe for preprocessing parity checks",
    )
    parser.add_argument(
        "--model", action="append", required=True, help="NAME=ONNX_PATH"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=100)
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error("iterations must be positive")
    if bool(args.crop_helper) != bool(args.crop_model):
        parser.error("crop-helper and crop-model must be provided together")
    cv2.setNumThreads(1)
    aligner = Aligner(args.landmark_model)
    prepared, failures, timings = [], [], []
    for group, folder in [
        ("enrolled", args.faces),
        ("probe", args.probes),
        ("negative", args.negatives),
    ]:
        if folder is None:
            continue
        for path in sorted(folder.iterdir()):
            if path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                continue
            image = cv2.imread(str(path))
            if image is None:
                failures.append({"file": path.name, "error": "Unreadable image"})
                continue
            try:
                start = time.perf_counter()
                crop, aligned = aligner.prepare(image)
                timings.append((time.perf_counter() - start) * 1000)
                baseline = image if group == "enrolled" else crop
                if group != "enrolled" and args.crop_helper:
                    baseline = production_crop(path, args.crop_helper, args.crop_model)
            except (ValueError, subprocess.SubprocessError) as error:
                failures.append({"file": path.name, "error": str(error)})
                continue
            # Current BioPass already stores detector crops. Do not re-crop
            # those for the baseline; new negative full frames require a crop.
            prepared.append(
                (
                    group,
                    path.name,
                    tensor(biopass_letterbox(baseline)),
                    tensor(aligned),
                    baseline,
                    aligned,
                )
            )
    if sum(row[0] == "enrolled" for row in prepared) < 2:
        raise ValueError("Need at least two enrolled images with usable landmarks")
    report = {
        "platform": platform.platform(),
        "runtime": ort.__version__,
        "threads": 1,
        "baseline_detector": "BioPass helper" if args.crop_helper else "YuNet",
        "alignment_ms": summary(timings),
        "failures": failures,
        "models": {},
        "limitation": "Single-identity diagnostics; scores are not accuracy or FAR estimates.",
    }
    for entry in args.model:
        name, path = entry.split("=", 1)
        model = Recognizer(path)
        result = {
            "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(),
            "load_ms": model.load_ms,
        }
        for mode, index in [("cropped", 2), ("aligned", 3)]:
            embeddings = [
                (group, filename, model.embed(row[index]))
                for row in prepared
                for group, filename in [row[:2]]
            ]
            parity = (
                [
                    check_native_parity(
                        row[index + 2], path, args.native_probe, embedding
                    )
                    for row, (_, _, embedding) in zip(prepared, embeddings)
                ]
                if args.native_probe
                else []
            )
            same, different, pairs = [], [], []
            for first, second in itertools.combinations(embeddings, 2):
                if first[0] == second[0] == "negative":
                    continue
                score = float(first[2] @ second[2])
                genuine = first[0] != "negative" and second[0] != "negative"
                (same if genuine else different).append(score)
                pairs.append(
                    {
                        "first": first[1],
                        "second": second[1],
                        "same_identity": genuine,
                        "score": score,
                    }
                )
            enrolled = [
                embedding for group, _, embedding in embeddings if group == "enrolled"
            ]
            probe_matches = [
                {
                    "file": filename,
                    "best_score": float(
                        max(embedding @ reference for reference in enrolled)
                    ),
                }
                for group, filename, embedding in embeddings
                if group == "probe"
            ]
            data = prepared[0][index]
            for _ in range(5):
                model.embed(data)
            latency = []
            for _ in range(args.iterations):
                start = time.perf_counter()
                model.embed(data)
                latency.append((time.perf_counter() - start) * 1000)
            result[mode] = {
                "same_identity": summary(same),
                "different_identity": summary(different),
                "inference_ms": summary(latency),
                "pairs": pairs,
                "probe_best_matches": probe_matches,
                "native_parity_max_abs_error": max(parity) if parity else None,
            }
        report["models"][name] = result
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(
        json.dumps(
            {
                "output": str(args.output),
                "usable_images": len(prepared),
                "failures": failures,
            }
        )
    )


if __name__ == "__main__":
    main()
