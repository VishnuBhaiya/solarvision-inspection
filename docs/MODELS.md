# Model availability

The original trained checkpoints are available without signing in from the [public model release](https://github.com/VishnuBhaiya/solarvision-inspection/releases/tag/model-weights-v1). Four distinct files total 449,615,296 bytes (449.6 MB). The SAHI configuration uses the same detector checkpoint as YOLO.

From the repository root, run:

```bash
python -m pip install -r requirements-inference.txt
python scripts/download_models.py
python app.py
```

The download helper verifies SHA-256 digests and installs the files at the relative paths in `model-manifest.json`, including both YOLO and SAHI destinations. Training is not required before inference. Existing files with matching hashes are reused.

These research checkpoints were tested locally with YOLO, Faster R-CNN and SSD CPU inference on a synthetic image. This check does not establish accuracy on new inspection images. See [validation](VALIDATION.md) for limits. The application also offers an explicitly labelled simulation mode; a real-model request never silently substitutes simulated detections.
