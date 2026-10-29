"""Download the project's published checkpoints and verify their SHA-256 digests."""
import hashlib
import json
import shutil
import urllib.request
import urllib.error
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "model-manifest.json").read_text())
for item in manifest["files"]:
    target = root / item["destination"]
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == item["sha256"]:
        print("Verified:", item["destination"])
        continue
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".download")
    url = "https://github.com/VishnuBhaiya/solarvision-inspection/releases/download/" + manifest["release"] + "/" + item["asset"]
    try:
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            print("Original checkpoints are not published yet. See docs/MODELS.md; use explicit simulation or supply your own compatible checkpoints.", file=sys.stderr)
            raise SystemExit(2) from None
        raise
    if hashlib.sha256(temporary.read_bytes()).hexdigest() != item["sha256"]:
        temporary.unlink()
        raise RuntimeError("Checkpoint checksum mismatch: " + item["asset"])
    temporary.replace(target)
    print("Downloaded and verified:", item["destination"])
