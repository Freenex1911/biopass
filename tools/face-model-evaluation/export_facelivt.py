"""Export an official FaceLiVT checkpoint; verify deployment and ONNX parity."""

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--variant", choices=["xs", "s", "m", "l"], default="s")
    args = parser.parse_args()
    torch.set_num_threads(1)
    torch.manual_seed(0)
    spec = importlib.util.spec_from_file_location(
        "facelivtv2", args.source / "backbones/facelivtv2.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    model = getattr(module, f"facelivtv2_{args.variant}")(pretrained=False)
    weights = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(weights, strict=True)
    model.eval()
    samples = [torch.rand(1, 3, 112, 112) * 2 - 1 for _ in range(3)]
    with torch.no_grad():
        original = [model(x).numpy() for x in samples]
    module.reparameterize(model)
    with torch.no_grad():
        deployed = [model(x).numpy() for x in samples]
    for expected, actual in zip(original, deployed):
        np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        samples[0],
        str(args.output),
        opset_version=17,
        input_names=["input"],
        output_names=["embedding"],
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(args.output))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(
        str(args.output), sess_options=options, providers=["CPUExecutionProvider"]
    )
    errors = []
    for sample, expected in zip(samples, deployed):
        actual = session.run(None, {"input": sample.numpy()})[0]
        np.testing.assert_allclose(actual, expected, atol=1e-4, rtol=1e-4)
        if actual.shape != (1, 512) or not np.isfinite(actual).all():
            raise ValueError("Unexpected or non-finite embedding")
        errors.append(float(np.max(np.abs(actual - expected))))
    print(json.dumps({"output": str(args.output), "parity_max_abs_errors": errors}))


if __name__ == "__main__":
    main()
