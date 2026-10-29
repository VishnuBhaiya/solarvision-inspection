# SolarVision

AI-assisted solar-panel inspection with a Flask dashboard, two-stage panel localisation and defect detection, image/video workflows, maintenance work orders and inspection reports.

## Explore the application

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000. The lightweight installation supports the explicitly labelled simulation workflow. Simulated defects and energy/ROI estimates are illustrative, not measured engineering results.

For real image inference, install the optional dependencies and download the original trained checkpoints from the [public model release](https://github.com/VishnuBhaiya/solarvision-inspection/releases/tag/model-weights-v1):

```bash
python -m pip install -r requirements-inference.txt
python scripts/download_models.py
python app.py
```

The download helper installs the checkpoints at the paths in `model-manifest.json` and verifies their SHA-256 checksums. No retraining is required to use these checkpoints. See [model availability](docs/MODELS.md). The SAHI branch reuses the YOLO detector with sliced inference. Missing weights produce an error when real inference is requested; they do not silently turn into simulated results.

## Features

- Panel localisation followed by defect detection with YOLO, SAHI, Faster R-CNN or SSD.
- Eight normalised application defect categories, with checkpoint labels mapped into the UI taxonomy.
- Image/video review, confidence controls, analytics, maintenance scheduling and printable reports.
- SQLite persistence created locally on first use; no private inspection database is included.
- Optional Tello integration. Hardware control requires a physically connected drone and has not been exercised by the portable smoke suite.

## Verify

```bash
python -m unittest discover -s tests -v
```

See [validation](docs/VALIDATION.md) for the exact checks and limits. Full dataset performance, drone operation and long video inference require separate validation. Report text and financial/energy estimates are project heuristics, not professional inspection advice. This is a local prototype; the development server is bound to loopback and is not an authenticated production hosting service.

Author: Vishnu Bhaiya. Dataset material, private uploads and virtual environments are excluded.
