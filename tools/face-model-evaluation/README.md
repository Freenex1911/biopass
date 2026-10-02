# Local face-model evaluation

This is an offline evaluation of landmark alignment and recognition models,
not a change to PAM authentication. It neither edits the user's settings nor
imports models into the production registry. Keep weights, camera frames and
JSON reports outside this repository; biometric photos must not be committed.

## Reproduce

Use Python 3.12 in a separate virtual environment. Install `requirements.txt`.
For FaceLiVT export, additionally install `torch==2.6.0` and
`torchvision==0.21.0` from `https://download.pytorch.org/whl/cpu`.

Sources used for the initial evaluation:

- [FaceLiVT](https://github.com/novendrastywn/FaceLiVT), revision
  `d99d86607c7c05540c74e815e5a88847f7e667db`.
- Official [`facelivtv2-s.pt`](https://huggingface.co/novendrastywn/FaceLiVT/resolve/cec8aee5341fb4fede121a960a418b9e6163cc5c/facelivtv2-s.pt).
- OpenCV Zoo's [`face_detection_yunet_2023mar.onnx`](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet).
- The already installed EdgeFace-S and YOLOv8n-Face models.

Artifact SHA-256 values for this run:

- FaceLiVTv2-S checkpoint: `ec659a5f84476e39a34b2f034f9022a094936d0e8b5429199e2a0db6d686ad6f`.
- YuNet detector: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.

Across all eighteen usable images, both preprocessing paths and both recognizers,
normalized Python/native embedding component differences were below `2.4e-8`.
Exported ONNX/PyTorch component differences for the three export checks were below
`3.4e-5` before embedding normalization.

The FaceLiVT source must be reviewed before execution. Its license and training
data/model terms must be reviewed separately before distributing weights.
The export loads checkpoint tensors with `weights_only=True`, requires a strict
state-dict match, fuses the official deployment branches and verifies three
deterministic samples against both PyTorch and ONNX Runtime.

```sh
python export_facelivt.py --source /path/to/FaceLiVT \
  --checkpoint /path/to/facelivtv2-s.pt --output /outside/repo/facelivtv2-s.onnx

python -m unittest discover -s . -p 'test_*.py' -v

python evaluate.py --faces /path/to/biopass/faces \
  --probes /outside/repo/probes --negatives /outside/repo/negatives \
  --landmark-model /outside/repo/yunet.onnx \
  --crop-helper /usr/bin/biopass-helper --crop-model /path/to/yolov8n-face.onnx \
  --native-probe /path/to/auth/build/test/backend/recognition_probe \
  --model edgeface-s=/path/to/edgeface_s_gamma_05.onnx \
  --model facelivtv2-s=/outside/repo/facelivtv2-s.onnx \
  --output /outside/repo/comparison.json
```

`recognition_probe` is built with `BUILD_TESTS=ON`. Parity checks compare
normalized embeddings from Python with the actual C++ recognizer, using
lossless decoded inputs. They cover both cropped and aligned images. Evaluation
fails if the maximum component difference exceeds `1e-4`.

For optional camera samples, announce **each pose immediately before** running
its ten-second capture. Obtain readiness first. Do not infer a change of pose
from an elapsed timer or from a label printed in tool output.

```sh
timeout 20 python capture_probes.py --pose frontal --output /outside/repo/probes
# Announce left tilt and wait until the preceding capture has finished.
timeout 20 python capture_probes.py --pose tilt-left --output /outside/repo/probes
# Announce right tilt.
timeout 20 python capture_probes.py --pose tilt-right --output /outside/repo/probes
```

## What is compared

Existing enrolled images are already cropped: the baseline retains that crop
and reproduces BioPass's bilinear, aspect-preserving black-padded resize. New
full-frame probes use the production YOLO helper when `--crop-helper` is supplied.
Without it, the baseline uses YuNet crops and is **not** the production pipeline.

The aligned path detects five landmarks with YuNet and uses scikit-image's
similarity transform and OpenCV's affine warp to the standard 112px ArcFace
reference. The transform uses translation, uniform scale and rotation. Images
with missing/multiple faces, invalid landmarks or large fitting residuals are
reported as failures instead of silently mixing aligned and unaligned inputs.

Both recognizers run on the same RGB inputs normalized to `[-1, 1]`, using ONNX
Runtime 1.19.2 and one CPU inference thread. Latencies use five warm-up iterations
and 100 timed runs. Report model loading and alignment separately. Inference
timing excludes camera initialization, IR checks and PAM/GNOME overhead.

For each probe, `probe_best_matches` reports the highest score against the
enrolled images, mirroring BioPass's any-reference acceptance rule. Repeated
shots are correlated: pair counts are not independent sample counts. Cosine
scores and thresholds must not be compared as calibrated probabilities across
different models. Failed images are excluded from scores but explicitly listed;
their count must be included when discussing usability.

## Initial Surface evaluation (2026-10-02)

Four enrolled crops, twelve explicitly cued new shots (four per pose), and two
public OpenCV sample portraits were usable; no landmark detections failed.

| Path | Frontal median best score | Left tilt | Right tilt | Median embedding time |
| --- | ---: | ---: | ---: | ---: |
| EdgeFace-S, production crops | 0.830 | 0.397 | 0.359 | about 9 ms |
| EdgeFace-S, aligned | 0.845 | 0.730 | 0.781 | about 9 ms |
| FaceLiVTv2-S, production crops | 0.701 | 0.286 | 0.170 | about 8 ms |
| FaceLiVTv2-S, aligned | 0.704 | 0.566 | 0.638 | about 8 ms |

Using the existing EdgeFace threshold of `0.5`, four of twelve production-crop
probes passed, versus twelve of twelve aligned probes. The two diagnostic other
identities remained below that threshold. **This does not establish a false
acceptance rate or security improvement.** In particular, these observations do
not calibrate a FaceLiVT threshold, certify anti-spoofing, or establish behavior
on other hardware, lighting or users. The public negative images were OpenCV's
`lena.jpg` and `messi5.jpg`; they are diagnostic examples, not a benchmark set.

The practical finding is that alignment improves this user's tilted-head
matching much more than switching recognition models. FaceLiVT's few
milliseconds of inference savings are small compared with camera/IR startup.

## Before production integration

Apply the same alignment to enrollment and live recognition. Keep the original
RGB crop for AI anti-spoofing: its expected framing must not change accidentally.
Keep RGB/IR checks intact. Treat failed alignment as retry/unavailable rather
than comparing different preprocessing modes. Make detector/recognizer input
contracts explicit; importing an arbitrary ONNX file is not enough.

Evaluate held-out identities at the intended false-acceptance operating point,
camera/lighting variation, unsuccessful detections and full authentication
latency before changing defaults. Reuse the standard transformation algorithm
in the native implementation rather than inventing a new alignment method.
