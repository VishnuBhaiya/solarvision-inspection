# Release validation

Checked on 29 October 2026 in an isolated Windows publishing copy.

- Four integration tests passed: routes/static resources; explicit simulation with persistence/report/export; missing-model honesty; invalid request handling.
- Real local YOLO, Faster R-CNN and SSD checkpoints loaded and completed CPU inference on a synthetic image. No benchmark accuracy is inferred from this image.
- Four original checkpoints (449.6 MB) are published in the model-weights-v1 release. The public download helper was run without credentials in an empty folder; all five model destinations, including the shared YOLO/SAHI detector, matched the sizes and SHA-256 digests in model-manifest.json. GitHub release digests also matched.
- Python source and static JavaScript syntax checked; publishing files scanned for credentials.

Not performed: full dataset retraining, a fresh mAP benchmark, physical drone flights, production hosting/security review, or exhaustive video/hardware testing. The lightweight install supports explicit simulation; trained inference needs the optional dependencies and checkpoint download.

Publication fixes: portable SAHI configuration; loopback server with debug disabled; missing real-model weights raise an error; malformed inspect requests are rejected. Private databases, images and environments are excluded.
