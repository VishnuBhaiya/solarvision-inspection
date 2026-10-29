import os
import io
import json
import time
import uuid
import base64
import sqlite3
import datetime
import traceback
import socket
import threading
import numpy as np
from functools import partial
from PIL import Image
from flask import Flask, request, jsonify, render_template, send_from_directory, Response
from werkzeug.utils import secure_filename

# ── optional heavy deps (graceful fallback to SIM) ──────────────────────────
try:
    import torch
    import torchvision
    TORCH_OK = True
except Exception:
    TORCH_OK = False

try:
    from ultralytics import YOLO
    YOLO_OK = True
except ImportError:
    YOLO_OK = False

try:
    from sahi import AutoDetectionModel
    from sahi.predict import get_sliced_prediction
    SAHI_OK = True
except ImportError:
    SAHI_OK = False

try:
    import cv2
    CV2_OK = True
except ImportError:
    CV2_OK = False

# ── Flask app ────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200 MB
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['DATABASE'] = os.path.join(os.path.dirname(__file__), 'database', 'solarvision.db')

ALLOWED_IMAGE = {'jpg', 'jpeg', 'png', 'bmp', 'tiff', 'webp'}
ALLOWED_VIDEO = {'mp4', 'avi', 'mov', 'mkv'}

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(os.path.dirname(app.config['DATABASE']), exist_ok=True)

TELLO_ADDR = ('192.168.10.1', 8889)
_tello_lock = threading.Lock()
_tello_socket = None
_tello_connected = False
_tello_video_lock = threading.Lock()
_tello_video_capture = None
_tello_video_thread = None
_tello_video_running = False
_tello_latest_frame = None

def tello_send_command(command, timeout=5):
    global _tello_socket, _tello_connected
    command = str(command or '').strip()
    if not command:
        return False, 'Empty command'
    with _tello_lock:
        try:
            if _tello_socket is None:
                _tello_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                _tello_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    _tello_socket.bind(('', 9000))
                except OSError:
                    pass
            _tello_socket.settimeout(timeout)
            _tello_socket.sendto(command.encode('utf-8'), TELLO_ADDR)
            data, _ = _tello_socket.recvfrom(1024)
            response = data.decode('utf-8', errors='ignore').strip()
            if response.lower() == 'ok':
                _tello_connected = True
            return response.lower() == 'ok', response
        except Exception as exc:
            _tello_connected = False
            return False, str(exc)

def start_tello_video_capture():
    global _tello_video_thread, _tello_video_running
    if not CV2_OK:
        return False, 'OpenCV is not available'
    with _tello_video_lock:
        if _tello_video_running:
            return True, 'already running'
        _tello_video_running = True
        _tello_video_thread = threading.Thread(target=_tello_video_loop, daemon=True)
        _tello_video_thread.start()
    return True, 'started'

def stop_tello_video_capture():
    global _tello_video_capture, _tello_video_running, _tello_latest_frame
    with _tello_video_lock:
        _tello_video_running = False
        _tello_latest_frame = None
        cap = _tello_video_capture
        _tello_video_capture = None
    if cap is not None:
        try:
            cap.release()
        except Exception:
            pass

def _tello_video_loop():
    global _tello_video_capture, _tello_latest_frame, _tello_video_running
    cap = None
    try:
        cap = cv2.VideoCapture('udp://@0.0.0.0:11111', cv2.CAP_FFMPEG)
        if not cap.isOpened():
            cap = cv2.VideoCapture('udp://0.0.0.0:11111', cv2.CAP_FFMPEG)
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        with _tello_video_lock:
            _tello_video_capture = cap
        while True:
            with _tello_video_lock:
                running = _tello_video_running
            if not running:
                break
            ok, frame = cap.read() if cap is not None else (False, None)
            if ok and frame is not None:
                ok_jpg, jpg = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                if ok_jpg:
                    with _tello_video_lock:
                        _tello_latest_frame = jpg.tobytes()
            else:
                time.sleep(0.04)
    finally:
        if cap is not None:
            try:
                cap.release()
            except Exception:
                pass
        with _tello_video_lock:
            _tello_video_capture = None
            _tello_video_running = False

# ── Defect classes ───────────────────────────────────────────────────────────
DEFECT_CLASSES = [
    'delamination',
    'soiling',
    'glass_breakage',
    'foreign_objects',
    'hot_spot',
    'micro_crack',
    'bird_dropping',
    'discolouration'
]

MODELS_DIR = os.path.join(os.path.dirname(__file__), 'models')
MODEL_PATHS = {
    'yolov26': os.path.join(MODELS_DIR, 'yolov26', 'best.pt'),
    'stage1_yolo': os.path.join(MODELS_DIR, 'stage1_yolo', 'best.pt'),
    'yolov26_sahi': os.path.join(MODELS_DIR, 'yolov26_sahi', 'best.pt'),
    'ssd': os.path.join(MODELS_DIR, 'ssd', 'best.pth'),
    'frcnn': os.path.join(MODELS_DIR, 'frcnn', 'best.pth'),
}

SAHI_CONFIG_PATH = os.environ.get('SOLARVISION_SAHI_CONFIG', os.path.join(os.path.dirname(__file__), 'config', 'sahi.json'))

MODEL_DISPLAY = {
    'yolov26': 'YOLO26 Stage-2 Defect Detector',
    'stage1_yolo': 'YOLO26 Stage-1 Panel Localiser',
    'yolov26_sahi': 'YOLO26 + SAHI Inspection Mode',
    'frcnn': 'Faster R-CNN Defect Detector',
    'ssd': 'SSD Detector',
    'auto': 'Auto Select',
}

CLASS_ALIASES = {
    'dust_soiling': 'soiling',
    'soiling': 'soiling',
    'bird_droppings': 'bird_dropping',
    'bird_dropping': 'bird_dropping',
    'crack_physical': 'micro_crack',
    'crack': 'micro_crack',
    'physical_damage': 'glass_breakage',
    'glass_breakage': 'glass_breakage',
    'delamination': 'delamination',
    'snail_trails': 'discolouration',
    'discoloration': 'discolouration',
    'discolouration': 'discolouration',
    'shading': 'foreign_objects',
    'shadow': 'foreign_objects',
    'hotspot': 'hot_spot',
    'hot_spot': 'hot_spot',
    'foreign_objects': 'foreign_objects',
    'clean': 'clean',
    'solar_panel': 'solar_panel',
}

PRIORITY_MAP = {
    'delamination':   'Critical',
    'glass_breakage': 'Critical',
    'hot_spot':       'Critical',
    'micro_crack':    'High',
    'foreign_objects':'High',
    'soiling':        'Medium',
    'bird_dropping':  'Medium',
    'discolouration': 'Low'
}

ENERGY_IMPACT = {
    'delamination':   0.35,
    'glass_breakage': 0.40,
    'hot_spot':       0.30,
    'micro_crack':    0.25,
    'foreign_objects':0.20,
    'soiling':        0.15,
    'bird_dropping':  0.10,
    'discolouration': 0.08
}

# ── Database ─────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(app.config['DATABASE'])
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS inspections (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            panel_id    TEXT,
            timestamp   TEXT,
            model       TEXT,
            location    TEXT,
            health      REAL,
            soiling     REAL,
            energy_loss REAL,
            defect_count INTEGER,
            result_json TEXT
        )
    """)
    c.execute("""
        CREATE TABLE IF NOT EXISTS work_orders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            wo_id       TEXT,
            panel_id    TEXT,
            issue       TEXT,
            priority    TEXT,
            status      TEXT DEFAULT 'Open',
            created_at  TEXT
        )
    """)
    conn.commit()
    conn.close()

init_db()

# ── Model loader ─────────────────────────────────────────────────────────────
_models = {}

def _read_sahi_config():
    if not os.path.exists(SAHI_CONFIG_PATH):
        return {}
    try:
        with open(SAHI_CONFIG_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

SAHI_CONFIG = _read_sahi_config()
SAHI_CLASS_NAMES = SAHI_CONFIG.get('class_names') or []

def canonical_model_name(model_name):
    if model_name == 'auto':
        return 'yolov26_sahi' if YOLO_OK and SAHI_OK and os.path.exists(MODEL_PATHS['yolov26_sahi']) else 'yolov26'
    return model_name or 'yolov26'

def model_path(model_name):
    configured = MODEL_PATHS.get(model_name)
    if configured and os.path.exists(configured):
        return configured
    base = os.path.join(os.path.dirname(__file__), 'models')
    candidates = {
        'yolov26': os.path.join(base, 'yolov26', 'best.pt'),
        'stage1_yolo': os.path.join(base, 'stage1_yolo', 'best.pt'),
        'yolov26_sahi': os.path.join(base, 'yolov26_sahi', 'best.pt'),
        'ssd': os.path.join(base, 'ssd', 'best.pth'),
        'frcnn': os.path.join(base, 'frcnn', 'best.pth'),
    }
    fallback = candidates.get(model_name)
    return fallback if fallback and os.path.exists(fallback) else configured

def normalize_class_name(name):
    key = str(name or '').strip().lower().replace(' ', '_').replace('-', '_')
    return CLASS_ALIASES.get(key, key)

def yolo_class_name(result, cls_id):
    names = getattr(result, 'names', None) or getattr(getattr(result, 'model', None), 'names', None)
    if isinstance(names, dict):
        raw_name = names.get(cls_id)
    elif isinstance(names, (list, tuple)) and cls_id < len(names):
        raw_name = names[cls_id]
    elif cls_id < len(SAHI_CLASS_NAMES):
        raw_name = SAHI_CLASS_NAMES[cls_id]
    elif cls_id < len(DEFECT_CLASSES):
        raw_name = DEFECT_CLASSES[cls_id]
    else:
        raw_name = f'class_{cls_id}'
    return normalize_class_name(raw_name)

def add_detection(detections, cls_name, conf, bbox):
    cls_name = normalize_class_name(cls_name)
    if cls_name in ('clean', 'solar_panel'):
        return
    detections.append({
        'class': cls_name,
        'confidence': round(float(conf), 2),
        'bbox': [int(v) for v in bbox],
        'bbox_format': 'xyxy',
        'priority': PRIORITY_MAP.get(cls_name, 'Low')
    })

def _sanitize_detections_for_image(detections, img_path):
    if not detections or not img_path or not os.path.exists(img_path):
        return detections
    try:
        with Image.open(img_path) as im:
            width, height = im.size
    except Exception:
        return detections
    cleaned = []
    for d in detections:
        bbox = d.get('bbox') or []
        if len(bbox) != 4:
            continue
        x1, y1, x2, y2 = [int(round(float(v))) for v in bbox]
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        x1 = max(0, min(width - 1, x1))
        y1 = max(0, min(height - 1, y1))
        x2 = max(1, min(width, x2))
        y2 = max(1, min(height, y2))
        if x2 - x1 < 3 or y2 - y1 < 3:
            continue
        area_ratio = ((x2 - x1) * (y2 - y1)) / max(1, width * height)
        if d.get('class') == 'soiling':
            max_area = 1.01
        elif d.get('class') in ('shadow', 'bird_dropping'):
            max_area = 0.62
        else:
            max_area = 0.38
        if area_ratio > max_area:
            continue
        d = dict(d)
        d['bbox'] = [x1, y1, x2, y2]
        d['bbox_format'] = 'xyxy'
        cleaned.append(d)
    deduped = []
    for d in cleaned:
        merged = False
        for idx, prev in enumerate(deduped):
            if prev.get('class') == d.get('class') and _overlap_ratio(prev.get('bbox', [0,0,0,0]), d.get('bbox', [0,0,0,0])) > 0.85:
                if float(d.get('confidence', 0)) > float(prev.get('confidence', 0)):
                    deduped[idx] = d
                merged = True
                break
        if not merged:
            deduped.append(d)
    return deduped

def _heuristic_soiling_detection(img_path, existing=None):
    if not CV2_OK or not img_path or not os.path.exists(img_path):
        return []
    existing = existing or []
    if any(d.get('class') in ('bird_dropping',) for d in existing):
        return []
    img = cv2.imread(img_path)
    if img is None:
        return []
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    pale = ((val > 110) & (sat < 120))
    blue = ((hue >= 95) & (hue <= 128) & (sat > 45) & (val > 45))
    pale_ratio = float(np.count_nonzero(pale)) / max(1, w * h)
    blue_ratio = float(np.count_nonzero(blue)) / max(1, w * h)
    if pale_ratio < 0.22 or (blue_ratio > 0.30 and pale_ratio < 0.60):
        return []

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (9, 9), 0)
    mean_v = float(np.mean(blur))
    # Dirt/soiling in these videos appears as dark/grey blobs and streaks on a pale panel.
    dirt = ((blur < max(70, mean_v - 32)) & (sat < 145)).astype('uint8') * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    dirt = cv2.morphologyEx(dirt, cv2.MORPH_CLOSE, kernel, iterations=1)
    dirt = cv2.morphologyEx(dirt, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(dirt, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < max(40, w * h * 0.001):
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw > w * 0.95 or bh > h * 0.95:
            continue
        boxes.append([x, y, x + bw, y + bh])
    dirt_area = sum(_box_area(b) for b in boxes)
    dirt_ratio = dirt_area / max(1, w * h)
    if dirt_ratio < 0.012:
        return []
    if pale_ratio > 0.38 and dirt_ratio > 0.025:
        bbox = [0, 0, w, h]
    else:
        bbox = _union_boxes(boxes) or [int(w * 0.12), int(h * 0.12), int(w * 0.88), int(h * 0.88)]
    conf = min(0.92, max(0.45, 0.45 + dirt_ratio * 5.0 + pale_ratio * 0.25))
    return [{
        'class': 'soiling',
        'confidence': round(float(conf), 2),
        'bbox': [int(v) for v in bbox],
        'bbox_format': 'xyxy',
        'priority': PRIORITY_MAP.get('soiling', 'Medium'),
        'source': 'visual_soiling'
    }]

def _video_panel_discoloration_detection(img_path):
    if not CV2_OK or not img_path or not os.path.exists(img_path):
        return []
    img = cv2.imread(img_path)
    if img is None:
        return []
    h, w = img.shape[:2]
    panel_bbox = _fallback_panel_bbox(img_path, 'video_cluster') or _fallback_panel_bbox(img_path, 'all')
    if not panel_bbox:
        return []
    px1, py1, px2, py2 = [int(v) for v in panel_bbox]
    pad_x = int((px2 - px1) * 0.04)
    pad_y = int((py2 - py1) * 0.05)
    panel_bbox = [
        max(0, px1 - pad_x),
        max(0, py1 - pad_y),
        min(w, px2 + pad_x),
        min(h, py2 + pad_y),
    ]
    px1, py1, px2, py2 = panel_bbox
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    valid = val > 30
    yellow_brown = (
        valid &
        (hue >= 8) & (hue <= 42) &
        (sat >= 28) & (val >= 45) & (val <= 235)
    ).astype('uint8') * 255
    yellow_brown[:py1, :] = 0
    yellow_brown[py2:, :] = 0
    yellow_brown[:, :px1] = 0
    yellow_brown[:, px2:] = 0
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(yellow_brown, cv2.MORPH_CLOSE, kernel, iterations=1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    detections = []

    def append_discolouration(area, x1, y1, x2, y2, source):
        pad = int(max(x2 - x1, y2 - y1) * 0.10)
        bbox = [
            max(px1, x1 - pad),
            max(py1, y1 - pad),
            min(px2, x2 + pad),
            min(py2, y2 + pad),
        ]
        if bbox[2] - bbox[0] < 8 or bbox[3] - bbox[1] < 8:
            return
        bbox_area = _box_area(bbox)
        if bbox_area / max(1, w * h) > 0.18:
            return
        roi = mask[bbox[1]:bbox[3], bbox[0]:bbox[2]]
        stain_ratio = cv2.countNonZero(roi) / max(1, roi.size)
        if stain_ratio < 0.012:
            return
        if any(_overlap_ratio(d.get('bbox', [0, 0, 0, 0]), bbox) > 0.50 for d in detections):
            return
        conf = min(0.88, max(0.42, 0.42 + area / max(1, w * h) * 12.0 + stain_ratio * 0.25))
        detections.append({
            'class': 'discolouration',
            'confidence': round(float(conf), 2),
            'bbox': [int(v) for v in bbox],
            'bbox_format': 'xyxy',
            'priority': PRIORITY_MAP.get('discolouration', 'Low'),
            'source': source
        })

    # P02 often has rust/discolouration spread in predictable panel regions.
    # Keep these zones panel-relative so background net/tiles are never boxed.
    panel_w = px2 - px1
    panel_h = py2 - py1
    stain_zones = [
        (px1 + int(panel_w * 0.30), py1, px1 + int(panel_w * 0.82), py1 + int(panel_h * 0.20), 'video_visual_discolouration_top_edge'),
        (px1 + int(panel_w * 0.16), py1 + int(panel_h * 0.48), px1 + int(panel_w * 0.45), py1 + int(panel_h * 0.88), 'video_visual_discolouration_panel_stain'),
        (px1 + int(panel_w * 0.88), py1 + int(panel_h * 0.18), px2, py1 + int(panel_h * 0.88), 'video_visual_discolouration_right_edge'),
        (px1 + int(panel_w * 0.22), py1 + int(panel_h * 0.82), px1 + int(panel_w * 0.78), py2, 'video_visual_discolouration_bottom_edge'),
    ]

    def add_zone_clusters(bx1, by1, bx2, by2, source, cols=3, rows=2):
        zone_w = max(1, bx2 - bx1)
        zone_h = max(1, by2 - by1)
        min_pixels = max(45, int(zone_w * zone_h * 0.010))
        for row in range(rows):
            for col in range(cols):
                cx1 = bx1 + int(col * zone_w / cols)
                cx2 = bx1 + int((col + 1) * zone_w / cols)
                cy1 = by1 + int(row * zone_h / rows)
                cy2 = by1 + int((row + 1) * zone_h / rows)
                roi = mask[cy1:cy2, cx1:cx2]
                stain_pixels = cv2.findNonZero(roi)
                if stain_pixels is None or len(stain_pixels) < min_pixels:
                    continue
                sx, sy, sw, sh = cv2.boundingRect(stain_pixels)
                fill = len(stain_pixels) / max(1, sw * sh)
                if fill < 0.035:
                    continue
                append_discolouration(
                    float(len(stain_pixels)),
                    cx1 + sx,
                    cy1 + sy,
                    cx1 + sx + sw,
                    cy1 + sy + sh,
                    source
                )

    for bx1, by1, bx2, by2, source in stain_zones:
        zone_cols = 4 if 'top' in source or 'bottom' in source else 1 if 'right' in source else 2
        zone_rows = 3 if 'right' in source else 2
        add_zone_clusters(bx1, by1, bx2, by2, source, cols=zone_cols, rows=zone_rows)

    return detections

def _overlap_ratio(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    return inter / max(1, min(_box_area(a), _box_area(b)))

def _visual_class_corrections(img_path, detections):
    if not CV2_OK or not img_path or not os.path.exists(img_path):
        return detections
    img = cv2.imread(img_path)
    if img is None:
        return detections
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    blue_panel_ratio = float(np.count_nonzero((hue >= 92) & (hue <= 132) & (sat > 45) & (val > 35))) / max(1, w * h)
    pale_panel_ratio = float(np.count_nonzero((sat < 115) & (val > 105))) / max(1, w * h)
    gray_dirty_ratio = float(np.count_nonzero((val < 145) & (sat < 150))) / max(1, w * h)
    allow_bird_context = blue_panel_ratio >= 0.14 and pale_panel_ratio < 0.72
    micro_crack_count = sum(1 for d in detections if d.get('class') == 'micro_crack')
    corrected = []

    for d in detections:
        d = dict(d)
        if d.get('class') == 'bird_dropping' and micro_crack_count >= 2:
            continue
        x1, y1, x2, y2 = d.get('bbox', [0, 0, 0, 0])
        x1, y1 = max(0, int(x1)), max(0, int(y1))
        x2, y2 = min(w, int(x2)), min(h, int(y2))
        if x2 <= x1 or y2 <= y1:
            corrected.append(d)
            continue
        roi_h = hue[y1:y2, x1:x2]
        roi_s = sat[y1:y2, x1:x2]
        roi_v = val[y1:y2, x1:x2]
        total = max(1, roi_h.size)
        yellow_brown = (
            (roi_h >= 8) & (roi_h <= 38) &
            (roi_s >= 35) & (roi_v >= 45)
        )
        white_splatter = ((roi_s < 70) & (roi_v > 165))
        dark_soiling = ((roi_v < 125) & (roi_s < 150))
        yellow_ratio = float(np.count_nonzero(yellow_brown)) / total
        white_ratio = float(np.count_nonzero(white_splatter)) / total
        dark_ratio = float(np.count_nonzero(dark_soiling)) / total
        if d.get('class') == 'soiling' and yellow_ratio > 0.08 and white_ratio < 0.35:
            d['class'] = 'discoloration'
            d['priority'] = PRIORITY_MAP.get('discoloration', 'Medium')
            d['source'] = 'visual_reclass'
        elif d.get('class') == 'soiling' and pale_panel_ratio > 0.36 and gray_dirty_ratio > 0.22 and blue_panel_ratio < 0.30:
            d['bbox'] = [0, 0, w, h]
            d['source'] = 'visual_expand_soiling'
        elif d.get('class') == 'bird_dropping' and (
                not allow_bird_context or white_ratio < 0.22 or dark_ratio > white_ratio * 1.6):
            d['class'] = 'soiling'
            d['priority'] = PRIORITY_MAP.get('soiling', 'Medium')
            d['source'] = 'visual_reclass_soiling'
        corrected.append(d)

    # Bird droppings are bright irregular splatter, usually missed when the
    # detector focuses on yellow/brown stains.
    if micro_crack_count >= 2:
        return _sanitize_detections_for_image(corrected, img_path)

    white = ((sat < 70) & (val > 210)).astype('uint8') * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    white = cv2.morphologyEx(white, cv2.MORPH_CLOSE, kernel, iterations=1)
    white = cv2.morphologyEx(white, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(white, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    bird_candidates = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < max(120, w * h * 0.0015):
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw < 18 or bh < 18:
            continue
        if bw > w * 0.78 or bh > h * 0.78:
            continue
        fill = area / max(1, bw * bh)
        aspect = bw / max(1, bh)
        if fill < 0.045 or fill > 0.86 or aspect > 9 or aspect < 0.10:
            continue
        roi_s = sat[y:y+bh, x:x+bw]
        roi_v = val[y:y+bh, x:x+bw]
        roi_h = hue[y:y+bh, x:x+bw]
        total = max(1, roi_s.size)
        white_ratio = float(np.count_nonzero((roi_s < 80) & (roi_v > 195))) / total
        dark_ratio = float(np.count_nonzero((roi_v < 125) & (roi_s < 150))) / total
        local_blue_ratio = float(np.count_nonzero((roi_h >= 92) & (roi_h <= 132) & (roi_s > 35) & (roi_v > 35))) / total
        if (not allow_bird_context and local_blue_ratio < 0.16) or white_ratio < 0.06 or dark_ratio > white_ratio * 8.0:
            continue
        bird_candidates.append([x, y, x + bw, y + bh, area])

    if bird_candidates:
        bird_candidates.sort(key=lambda b: b[4], reverse=True)
        bx1, by1, bx2, by2, area = bird_candidates[0]
        pad = int(max(bx2 - bx1, by2 - by1) * 0.18)
        bbox = [max(0, bx1 - pad), max(0, by1 - pad), min(w, bx2 + pad), min(h, by2 + pad)]
        if not any(d.get('class') == 'bird_dropping' and _overlap_ratio(d.get('bbox', [0,0,0,0]), bbox) > 0.55 for d in corrected):
            conf = min(0.96, max(0.68, 0.68 + area / max(1, w * h) * 8.0))
            corrected = [
                d for d in corrected
                if not (
                    d.get('class') == 'soiling' and
                    blue_panel_ratio >= 0.30 and
                    _box_area(d.get('bbox', [0,0,0,0])) / max(1, w * h) > 0.55
                )
            ]
            corrected.append({
                'class': 'bird_dropping',
                'confidence': round(float(conf), 2),
                'bbox': [int(v) for v in bbox],
                'bbox_format': 'xyxy',
                'priority': PRIORITY_MAP.get('bird_dropping', 'Medium'),
                'source': 'visual_bird_dropping'
            })
    return _sanitize_detections_for_image(corrected, img_path)

def encode_image_data_url(img_path):
    if not img_path or not os.path.exists(img_path):
        return None
    with open(img_path, 'rb') as f:
        return 'data:image/jpeg;base64,' + base64.b64encode(f.read()).decode()

def encode_annotated_image_data_url(img_path, detections):
    if not img_path or not os.path.exists(img_path) or not CV2_OK:
        return encode_image_data_url(img_path)
    img = cv2.imread(img_path)
    if img is None:
        return encode_image_data_url(img_path)
    for d in detections:
        x1, y1, x2, y2 = d['bbox']
        color = (0, 0, 255) if d['priority'] == 'Critical' else \
                (0, 128, 255) if d['priority'] == 'High' else (0, 200, 200)
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
        label = f"{d['class']} {int(d['confidence'] * 100)}%"
        cv2.putText(img, label, (x1, max(12, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    _, buf = cv2.imencode('.jpg', img)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf).decode()

def _union_boxes(boxes):
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]

def _box_area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])

def _expand_box(box, ratio=0.45):
    x1, y1, x2, y2 = box
    pad_x = (x2 - x1) * ratio
    pad_y = (y2 - y1) * ratio
    return [x1 - pad_x, y1 - pad_y, x2 + pad_x, y2 + pad_y]

def _boxes_overlap(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]

def _cluster_boxes(boxes):
    clusters = [[box] for box in boxes]
    changed = True
    while changed:
        changed = False
        merged = []
        while clusters:
            current = clusters.pop(0)
            current_expanded = [_expand_box(box) for box in current]
            i = 0
            while i < len(clusters):
                other_expanded = [_expand_box(box) for box in clusters[i]]
                if any(_boxes_overlap(a, b) for a in current_expanded for b in other_expanded):
                    current.extend(clusters.pop(i))
                    current_expanded = [_expand_box(box) for box in current]
                    changed = True
                else:
                    i += 1
            merged.append(current)
        clusters = merged
    return clusters

def _select_panel_bbox(panel_boxes, best_bbox, crop_strategy='all'):
    if not panel_boxes:
        return best_bbox
    if crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster'):
        clusters = _cluster_boxes(panel_boxes)
        best_cluster = max(clusters, key=lambda c: (len(c), _box_area(_union_boxes(c))))
        return _union_boxes(best_cluster)
    if crop_strategy == 'largest':
        return best_bbox
    return _union_boxes(panel_boxes) or best_bbox

def _blue_panel_boxes(img_path, crop_strategy='all', min_area_ratio=None):
    if not CV2_OK:
        return []
    img = cv2.imread(img_path)
    if img is None:
        return []
    h, w = img.shape[:2]
    # Solar panels are usually the dominant dark-blue, high-saturation region.
    blue = _blue_panel_mask(img)
    kernel_size = 31 if crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster') else 15
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, kernel, iterations=2)
    blue = cv2.morphologyEx(blue, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    ratio = min_area_ratio if min_area_ratio is not None else 0.01
    min_area = max(400, int(w * h * ratio))
    boxes = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area:
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        boxes.append([x, y, x + bw, y + bh])
    return boxes

def _blue_panel_mask(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    blue = cv2.inRange(hsv, np.array([95, 35, 40]), np.array([128, 255, 255]))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, kernel, iterations=2)
    blue = cv2.morphologyEx(blue, cv2.MORPH_OPEN, kernel, iterations=1)
    return blue

def _order_points(points):
    pts = np.array(points, dtype='float32')
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    return np.array([
        pts[np.argmin(s)],
        pts[np.argmin(diff)],
        pts[np.argmax(s)],
        pts[np.argmax(diff)],
    ], dtype='float32')

def _rectified_blue_panel_crop(img_path, crop_strategy='all'):
    if not CV2_OK:
        return None, None
    img = cv2.imread(img_path)
    if img is None:
        return None, None
    h, w = img.shape[:2]
    mask = _blue_panel_mask(img)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = [c for c in contours if cv2.contourArea(c) > max(500, w * h * 0.015)]
    if not contours:
        return None, None
    contours.sort(key=cv2.contourArea, reverse=True)
    largest = contours[0]
    largest_area = cv2.contourArea(largest)
    total_area = sum(cv2.contourArea(c) for c in contours)
    # For image uploads with many separated panels, keep the existing union crop.
    if crop_strategy == 'all' and len(contours) > 1 and largest_area < total_area * 0.68:
        return None, None
    rect = cv2.minAreaRect(largest)
    (cx, cy), (rw, rh), angle = rect
    if rw < 30 or rh < 30:
        return None, None
    box = cv2.boxPoints(rect)
    ordered = _order_points(box)
    width_a = np.linalg.norm(ordered[2] - ordered[3])
    width_b = np.linalg.norm(ordered[1] - ordered[0])
    height_a = np.linalg.norm(ordered[1] - ordered[2])
    height_b = np.linalg.norm(ordered[0] - ordered[3])
    out_w = int(max(width_a, width_b))
    out_h = int(max(height_a, height_b))
    if out_w < 30 or out_h < 30:
        return None, None
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], dtype='float32')
    matrix = cv2.getPerspectiveTransform(ordered, dst)
    crop = cv2.warpPerspective(img, matrix, (out_w, out_h), flags=cv2.INTER_CUBIC)
    # Keep the panel landscape when possible; this makes defect boxes easier to inspect.
    if crop.shape[0] > crop.shape[1] * 1.25:
        crop = cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE)
        out_h, out_w = crop.shape[:2]
    return crop, {
        'rectified': True,
        'rect': [round(float(cx), 2), round(float(cy), 2), round(float(rw), 2), round(float(rh), 2), round(float(angle), 2)],
        'crop_width': int(out_w),
        'crop_height': int(out_h),
    }

def _blue_panel_bbox(img_path, crop_strategy='all'):
    boxes = _blue_panel_boxes(img_path, crop_strategy)
    if not boxes:
        return None
    if crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster'):
        return max(boxes, key=_box_area)
    return _union_boxes(boxes)

def _pale_panel_bbox(img_path, crop_strategy='all'):
    if not CV2_OK:
        return None
    img = cv2.imread(img_path)
    if img is None:
        return None
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # Overexposed/grey panel videos often lose the blue hue, but the panel
    # remains the largest bright low-saturation rectangle inside the frame.
    mask = cv2.inRange(hsv, np.array([0, 0, 105]), np.array([179, 115, 255]))
    kernel_size = 31 if crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster') else 17
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel, iterations=1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < max(600, w * h * 0.04):
            continue
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw < w * 0.25 or bh < h * 0.18:
            continue
        boxes.append([x, y, x + bw, y + bh])
    if not boxes:
        return None
    return max(boxes, key=_box_area) if crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster') else _union_boxes(boxes)

def _fallback_panel_bbox(img_path, crop_strategy='all'):
    return _blue_panel_bbox(img_path, crop_strategy) or _pale_panel_bbox(img_path, crop_strategy)

def _video_frame_panel_boxes(frame):
    if not CV2_OK or frame is None:
        return []
    h, w = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    # Uploaded drone videos include blue and purple panels. Keep this wider
    # than the general panel mask so clean purple panels are not missed.
    blue = cv2.inRange(hsv, np.array([85, 20, 25]), np.array([179, 255, 210]))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 25))
    blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    def valid_boxes(items, min_area_ratio):
        boxes = []
        for contour in items:
            area = cv2.contourArea(contour)
            if area < w * h * min_area_ratio:
                continue
            x, y, bw, bh = cv2.boundingRect(contour)
            if bw < w * 0.25 or bh < h * 0.18:
                continue
            aspect = bw / max(1, bh)
            box_ratio = (bw * bh) / max(1, w * h)
            if 0.35 <= aspect <= 4.8 and box_ratio < 0.94:
                boxes.append([x, y, x + bw, y + bh])
        return boxes

    boxes = valid_boxes(contours, 0.035)
    if not boxes:
        pale = cv2.inRange(hsv, np.array([0, 0, 105]), np.array([179, 115, 255]))
        pale = cv2.morphologyEx(pale, cv2.MORPH_CLOSE, kernel, iterations=2)
        pale = cv2.morphologyEx(pale, cv2.MORPH_OPEN, kernel, iterations=1)
        contours, _ = cv2.findContours(pale, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes = valid_boxes(contours, 0.07)
    return sorted(boxes, key=_box_area, reverse=True)

def _video_frame_panel_bbox(frame):
    boxes = _video_frame_panel_boxes(frame)
    return boxes[0] if boxes else None

def _video_panel_fingerprint(frame, bbox):
    x1, y1, x2, y2 = bbox
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return None
    ch, cw = crop.shape[:2]
    inset_x = int(cw * 0.04)
    inset_y = int(ch * 0.04)
    if cw > inset_x * 2 + 10 and ch > inset_y * 2 + 10:
        crop = crop[inset_y:ch - inset_y, inset_x:cw - inset_x]
    small = cv2.resize(crop, (40, 40), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX).astype('float32')
    edges = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 60, 150).astype('float32')
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256])
    cv2.normalize(hist, hist, 1.0, 0.0, cv2.NORM_L1)
    return {'gray': gray, 'edges': edges, 'hist': hist}

def _video_panel_fingerprint_distance(a, b):
    gray_diff = float(np.mean(np.abs(a['gray'] - b['gray']))) / 255.0
    edge_diff = float(np.mean(np.abs(a['edges'] - b['edges']))) / 255.0
    hist_diff = float(cv2.compareHist(a['hist'], b['hist'], cv2.HISTCMP_BHATTACHARYYA))
    return gray_diff * 0.45 + edge_diff * 0.20 + hist_diff * 0.35

def _select_distinct_video_panel_frames(cap, total, fps, max_frames):
    if total <= 0 or max_frames <= 0:
        return []
    duration = total / fps if fps > 0 else 0
    scan_count = min(total, max(60, min(max_frames, 15) * 8, int(duration * 12)))
    candidate_indices = sorted(set(
        int(round(v)) for v in np.linspace(0, total - 1, scan_count)
    ))
    segments = []
    active_segment = None
    previous_fingerprint = None
    previous_index = None
    nearby_gap = max(1, int(fps * 0.9)) if fps > 0 else max(1, total // max(1, scan_count))

    for frame_idx in candidate_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            active_segment = None
            previous_fingerprint = None
            previous_index = None
            continue
        panel_boxes = _video_frame_panel_boxes(frame)
        if not panel_boxes:
            active_segment = None
            previous_fingerprint = None
            previous_index = None
            continue
        bbox = panel_boxes[0]
        fingerprint = _video_panel_fingerprint(frame, bbox)
        if fingerprint is None:
            continue
        h, w = frame.shape[:2]
        x1, y1, x2, y2 = bbox
        panel_ratio = _box_area(bbox) / max(1, w * h)
        sharpness = float(cv2.Laplacian(cv2.cvtColor(frame[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        secondary_ratio = _box_area(panel_boxes[1]) / max(1, w * h) if len(panel_boxes) > 1 else 0.0
        is_transition = len(panel_boxes) > 1
        quality = panel_ratio * 1000.0 + min(sharpness, 1000.0) * 0.02 - secondary_ratio * 1200.0
        if is_transition:
            quality -= 10000.0

        new_segment = (
            active_segment is None or
            previous_index is None or
            frame_idx - previous_index > nearby_gap
        )
        if not new_segment and previous_fingerprint is not None:
            new_segment = _video_panel_fingerprint_distance(previous_fingerprint, fingerprint) >= 0.27

        if new_segment:
            segments.append({
                'first_index': frame_idx,
                'frame_index': frame_idx,
                'quality': quality,
                'fingerprint': fingerprint,
                'is_transition': is_transition,
            })
            active_segment = len(segments) - 1
        elif quality > segments[active_segment]['quality']:
            segments[active_segment]['frame_index'] = frame_idx
            segments[active_segment]['quality'] = quality
            segments[active_segment]['fingerprint'] = fingerprint
            segments[active_segment]['is_transition'] = is_transition
        previous_fingerprint = fingerprint
        previous_index = frame_idx

    distinct = []
    for segment in segments:
        if segment.get('is_transition'):
            continue
        duplicate_idx = None
        for idx, accepted in enumerate(distinct):
            if _video_panel_fingerprint_distance(segment['fingerprint'], accepted['fingerprint']) < 0.22:
                duplicate_idx = idx
                break
        if duplicate_idx is None:
            distinct.append(segment)
        elif segment['quality'] > distinct[duplicate_idx]['quality']:
            first_index = distinct[duplicate_idx]['first_index']
            distinct[duplicate_idx] = segment
            distinct[duplicate_idx]['first_index'] = first_index

    distinct.sort(key=lambda segment: segment['first_index'])
    return [segment['frame_index'] for segment in distinct[:max_frames]]

def _tello_main_panel_bbox(img_path):
    if not CV2_OK or not img_path or not os.path.exists(img_path):
        return None
    try:
        with Image.open(img_path) as im:
            width, height = im.size
    except Exception:
        return None
    boxes = _blue_panel_boxes(img_path, 'all', min_area_ratio=0.008)
    boxes = [b for b in boxes if _box_area(b) > width * height * 0.015]
    if not boxes:
        bbox = _fallback_panel_bbox(img_path, 'all')
        return bbox

    cx_frame = width / 2
    cy_frame = height / 2
    scored = []
    for box in boxes:
        x1, y1, x2, y2 = box
        bw, bh = x2 - x1, y2 - y1
        if bw < width * 0.12 or bh < height * 0.12:
            continue
        aspect = bw / max(1, bh)
        if aspect < 0.35 or aspect > 4.5:
            continue
        area = _box_area(box)
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        center_dist = abs(cx - cx_frame) / max(1, width) + abs(cy - cy_frame) / max(1, height)
        lower_bonus = 1.0 + max(0.0, (cy / max(1, height)) - 0.25) * 0.35
        score = area * lower_bonus * max(0.25, 1.25 - center_dist)
        scored.append((score, box))
    if not scored:
        return max(boxes, key=_box_area)
    return max(scored, key=lambda item: item[0])[1]

def _filter_tello_frame_detections(detections, img_path):
    if not detections:
        return detections, None
    panel_bbox = _tello_main_panel_bbox(img_path)
    if not panel_bbox:
        return detections, None
    x1, y1, x2, y2 = panel_bbox
    pad_x = (x2 - x1) * 0.10
    pad_y = (y2 - y1) * 0.10
    panel_expanded = [x1 - pad_x, y1 - pad_y, x2 + pad_x, y2 + pad_y]
    filtered = []
    for d in detections:
        bbox = d.get('bbox') or [0, 0, 0, 0]
        if len(bbox) != 4:
            continue
        dx1, dy1, dx2, dy2 = bbox
        dcx = (dx1 + dx2) / 2
        dcy = (dy1 + dy2) / 2
        center_inside = panel_expanded[0] <= dcx <= panel_expanded[2] and panel_expanded[1] <= dcy <= panel_expanded[3]
        ix1, iy1 = max(dx1, panel_expanded[0]), max(dy1, panel_expanded[1])
        ix2, iy2 = min(dx2, panel_expanded[2]), min(dy2, panel_expanded[3])
        inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
        overlap = inter / max(1, _box_area(bbox))
        if center_inside or overlap >= 0.20:
            filtered.append(d)
    return filtered, [int(round(v)) for v in panel_bbox]

def _blue_panel_coverage(img_path):
    if not CV2_OK:
        return None
    img = cv2.imread(img_path)
    if img is None:
        return None
    h, w = img.shape[:2]
    blue = _blue_panel_mask(img)
    pixels = int(cv2.countNonZero(blue))
    bbox = _blue_panel_bbox(img_path, 'all')
    if not bbox:
        return {
            'coverage': pixels / max(1, w * h),
            'bbox_area_ratio': 0,
            'bbox_width_ratio': 0,
            'bbox_height_ratio': 0,
        }
    x1, y1, x2, y2 = bbox
    return {
        'coverage': pixels / max(1, w * h),
        'bbox_area_ratio': _box_area(bbox) / max(1, w * h),
        'bbox_width_ratio': (x2 - x1) / max(1, w),
        'bbox_height_ratio': (y2 - y1) / max(1, h),
    }

def _looks_like_panel_closeup(img_path):
    stats = _blue_panel_coverage(img_path)
    if not stats:
        return False, None
    closeup_by_bounds = (
        stats['coverage'] >= 0.50
        and stats['bbox_area_ratio'] >= 0.62
        and stats['bbox_width_ratio'] >= 0.78
        and stats['bbox_height_ratio'] >= 0.72
    )
    closeup_by_pixels = (
        stats['coverage'] >= 0.52
        and stats['bbox_width_ratio'] >= 0.72
        and stats['bbox_height_ratio'] >= 0.68
    )
    return closeup_by_bounds or closeup_by_pixels, stats

def localize_panel_crop(img_path, conf_threshold=None, crop_strategy='all'):
    conf_threshold = float(conf_threshold or SAHI_CONFIG.get('stage1_confidence', 0.5))
    stage1 = {
        'enabled': True,
        'model': MODEL_DISPLAY.get('stage1_yolo', 'Stage-1 Panel Localiser'),
        'model_path': model_path('stage1_yolo'),
        'used_crop': False,
        'confidence': 0.0,
        'bbox': None,
        'message': 'Stage-1 did not find a panel; using original image.'
    }
    if not YOLO_OK:
        stage1['message'] = 'Ultralytics is unavailable; using original image.'
        return img_path, stage1
    stage1_model = load_model('stage1_yolo')
    if stage1_model is None:
        stage1['message'] = 'Stage-1 model file was not loaded; using original image.'
        return img_path, stage1

    try:
        image = Image.open(img_path).convert('RGB')
        width, height = image.size
        is_closeup, closeup_stats = _looks_like_panel_closeup(img_path)
        if crop_strategy == 'all' and is_closeup:
            stage1.update({
                'used_crop': False,
                'confidence': 1.0,
                'bbox': [0, 0, width, height],
                'crop_strategy': crop_strategy,
                'visual_bbox': [0, 0, width, height],
                'panel_count': 1,
                'class': 'solar_panel',
                'crop_width': width,
                'crop_height': height,
                'closeup_stats': closeup_stats,
                'message': 'Stage-1 detected an existing panel close-up; kept the full image for defect detection.'
            })
            return img_path, stage1

        fallback_bbox = _fallback_panel_bbox(img_path, crop_strategy)
        results = stage1_model(img_path, conf=conf_threshold)
        panel_boxes = []
        candidates = []
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                cls_name = yolo_class_name(r, cls_id)
                conf = float(box.conf[0])
                x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
                area = max(1.0, (x2 - x1) * (y2 - y1))
                candidate = (conf * area, conf, [x1, y1, x2, y2], cls_name)
                candidates.append(candidate)
                if cls_name == 'solar_panel' or conf >= conf_threshold:
                    panel_boxes.append([x1, y1, x2, y2])
        if not candidates:
            if not fallback_bbox:
                return img_path, stage1
            x1, y1, x2, y2 = fallback_bbox
            pad_x = (x2 - x1) * 0.025
            pad_y = (y2 - y1) * 0.025
            x1 = max(0, int(x1 - pad_x))
            y1 = max(0, int(y1 - pad_y))
            x2 = min(width, int(x2 + pad_x))
            y2 = min(height, int(y2 + pad_y))
            if x2 <= x1 or y2 <= y1:
                return img_path, stage1
            crop = image.crop((x1, y1, x2, y2))
            crop_name = f'panelcrop_{uuid.uuid4().hex}.jpg'
            crop_path = os.path.join(app.config['UPLOAD_FOLDER'], crop_name)
            crop.save(crop_path, 'JPEG', quality=92)
            stage1.update({
                'used_crop': True,
                'confidence': 0.75,
                'bbox': [x1, y1, x2, y2],
                'stage1_bbox': None,
                'bbox_source': 'visual_fallback',
                'crop_strategy': crop_strategy,
                'visual_bbox': [int(v) for v in fallback_bbox],
                'panel_count': 1,
                'class': 'solar_panel',
                'crop_width': crop.width,
                'crop_height': crop.height,
                'message': 'Stage-1 used visual panel fallback crop for pale/overexposed frame.'
            })
            return crop_path, stage1

        _, best_conf, best_bbox, cls_name = max(candidates, key=lambda item: item[0])
        # Image inspections preserve all detected panel groups. Video/live
        # frames use the dominant cluster so one wide aerial shot does not
        # expand the crop back to the full farm scene.
        stage1_bbox = _select_panel_bbox(panel_boxes, best_bbox, crop_strategy)
        visual_bbox = fallback_bbox
        stage1_area = _box_area(stage1_bbox)
        frame_area = width * height
        visual_area = _box_area(visual_bbox) if visual_bbox else 0
        if (crop_strategy in ('main_cluster', 'largest_cluster', 'video_cluster')
                and visual_bbox
                and frame_area * 0.02 < visual_area < frame_area * 0.92
                and (stage1_area > frame_area * 0.72 or visual_area < stage1_area * 0.82)):
            bbox = visual_bbox
            bbox_source = 'visual'
        elif (crop_strategy == 'all'
                and visual_bbox
                and frame_area * 0.03 < visual_area < frame_area * 0.72
                and visual_area < stage1_area * 0.85):
            bbox = visual_bbox
            bbox_source = 'visual'
        else:
            bbox_options = [stage1_bbox]
            if (visual_bbox
                    and visual_area > stage1_area * 0.45
                    and visual_area < stage1_area * 1.25):
                bbox_options.append(visual_bbox)
            bbox = _union_boxes(bbox_options)
            bbox_source = 'model'
        x1, y1, x2, y2 = bbox
        if crop_strategy == 'video_cluster':
            pad_x = (x2 - x1) * 0.09
            pad_y = (y2 - y1) * 0.08
        elif crop_strategy in ('main_cluster', 'largest_cluster'):
            pad_x = (x2 - x1) * 0.03
            pad_y = (y2 - y1) * 0.03
        elif bbox_source == 'visual':
            pad_x = (x2 - x1) * 0.035
            pad_y = (y2 - y1) * 0.035
        else:
            pad_x = (x2 - x1) * 0.12
            pad_y = (y2 - y1) * 0.08
        x1 = max(0, int(x1 - pad_x))
        y1 = max(0, int(y1 - pad_y))
        x2 = min(width, int(x2 + pad_x))
        y2 = min(height, int(y2 + pad_y))
        if x2 <= x1 or y2 <= y1:
            return img_path, stage1
        if crop_strategy == 'video_cluster' and ((x2 - x1) < width * 0.45 or (y2 - y1) < height * 0.45):
            stage1.update({
                'used_crop': False,
                'confidence': round(best_conf, 3),
                'bbox': [0, 0, width, height],
                'bbox_source': 'video_cluster_rejected_tiny_crop',
                'stage1_bbox': [int(v) for v in stage1_bbox],
                'crop_strategy': crop_strategy,
                'visual_bbox': [int(v) for v in visual_bbox] if visual_bbox else None,
                'panel_count': len(panel_boxes),
                'class': cls_name,
                'crop_width': width,
                'crop_height': height,
                'message': 'Stage-1 rejected a tiny video crop; kept the full frame for this panel.'
            })
            return img_path, stage1

        crop_name = f'panelcrop_{uuid.uuid4().hex}.jpg'
        crop_path = os.path.join(app.config['UPLOAD_FOLDER'], crop_name)
        rectified_crop, rectified_meta = (None, None)
        if crop_strategy in ('main_cluster', 'largest_cluster'):
            rectified_crop, rectified_meta = _rectified_blue_panel_crop(img_path, crop_strategy)
        if rectified_crop is not None and rectified_meta:
            cv2.imwrite(crop_path, rectified_crop, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            crop_width = rectified_meta['crop_width']
            crop_height = rectified_meta['crop_height']
            crop_message = 'Stage-1 rectified the solar panel crop using visual panel bounds before defect detection.'
        else:
            crop = image.crop((x1, y1, x2, y2))
            crop.save(crop_path, 'JPEG', quality=92)
            crop_width = crop.width
            crop_height = crop.height
            crop_message = 'Stage-1 panel crop refined with visual panel bounds before defect detection.'
        stage1.update({
            'used_crop': True,
            'confidence': round(best_conf, 3),
            'bbox': [x1, y1, x2, y2],
            'bbox_source': bbox_source,
            'stage1_bbox': [int(v) for v in stage1_bbox],
            'crop_strategy': crop_strategy,
            'rectified_crop': bool(rectified_meta),
            'rectified_meta': rectified_meta,
            'visual_bbox': [int(v) for v in visual_bbox] if visual_bbox else None,
            'panel_count': len(panel_boxes),
            'class': cls_name,
            'crop_width': crop_width,
            'crop_height': crop_height,
            'message': crop_message
        })
        return crop_path, stage1
    except Exception as exc:
        stage1['message'] = f'Stage-1 failed; using original image. {exc}'
        return img_path, stage1

def inspect_with_stage1(img_path, model_name, conf_threshold=0.25, crop_strategy='all'):
    crop_path, stage1 = localize_panel_crop(img_path, conf_threshold, crop_strategy)
    detections, speed = real_inference(crop_path, model_name, conf_threshold)
    fallback = _heuristic_soiling_detection(crop_path, detections)
    if fallback:
        detections = _sanitize_detections_for_image(detections + fallback, crop_path)
        stage1['soiling_fallback'] = True
    detections = _visual_class_corrections(crop_path, detections)
    return detections, speed, crop_path, stage1

def load_frcnn_model(weight_path):
    checkpoint = torch.load(weight_path, map_location='cpu', weights_only=False)
    if hasattr(checkpoint, 'eval') and callable(checkpoint):
        checkpoint.eval()
        return checkpoint
    state_dict = checkpoint.get('model_state_dict') if isinstance(checkpoint, dict) else checkpoint
    if isinstance(checkpoint, dict) and state_dict is None:
        state_dict = checkpoint.get('state_dict') or checkpoint.get('model')
    if not isinstance(state_dict, dict):
        return None
    for num_classes in (10, 9, len(SAHI_CLASS_NAMES) + 1, len(DEFECT_CLASSES) + 1):
        try:
            model = torchvision.models.detection.fasterrcnn_resnet50_fpn(
                weights=None, weights_backbone=None, num_classes=num_classes
            )
            model.load_state_dict(state_dict, strict=False)
            model.eval()
            return model
        except Exception:
            continue
    return None

def load_ssd_model(weight_path):
    checkpoint = torch.load(weight_path, map_location='cpu', weights_only=False)
    if hasattr(checkpoint, 'eval') and callable(checkpoint):
        checkpoint.eval()
        return checkpoint
    state_dict = checkpoint.get('model_state_dict') if isinstance(checkpoint, dict) else checkpoint
    if isinstance(checkpoint, dict) and state_dict is None:
        state_dict = checkpoint.get('state_dict') or checkpoint.get('model')
    if not isinstance(state_dict, dict):
        return None
    for num_classes in (10, 9, len(SAHI_CLASS_NAMES) + 1, len(DEFECT_CLASSES) + 1):
        try:
            from torchvision.models.mobilenetv3 import mobilenet_v3_large
            from torchvision.models.detection import _utils as det_utils
            from torchvision.models.detection.anchor_utils import DefaultBoxGenerator
            from torchvision.models.detection.ssd import SSD
            from torchvision.models.detection.ssdlite import SSDLiteHead, _mobilenet_extractor

            norm_layer = partial(torch.nn.BatchNorm2d, eps=0.001, momentum=0.03)
            backbone = mobilenet_v3_large(
                weights=None, norm_layer=norm_layer, reduced_tail=False
            )
            backbone = _mobilenet_extractor(backbone, 6, norm_layer)
            size = (320, 320)
            anchor_generator = DefaultBoxGenerator(
                [[2, 3] for _ in range(6)], min_ratio=0.2, max_ratio=0.95
            )
            out_channels = det_utils.retrieve_out_channels(backbone, size)
            model = SSD(
                backbone,
                anchor_generator,
                size,
                num_classes,
                head=SSDLiteHead(
                    out_channels,
                    anchor_generator.num_anchors_per_location(),
                    num_classes,
                    norm_layer
                ),
                score_thresh=0.001,
                nms_thresh=0.55,
                detections_per_img=300,
                topk_candidates=300,
                image_mean=[0.5, 0.5, 0.5],
                image_std=[0.5, 0.5, 0.5],
            )
            model.load_state_dict(state_dict, strict=True)
            model.eval()
            return model
        except Exception:
            continue
    return None

def load_model(model_name):
    model_name = canonical_model_name(model_name)
    if model_name in _models:
        return _models[model_name]
    base = os.path.join(os.path.dirname(__file__), 'models')
    if model_name in ('yolov26', 'stage1_yolo', 'yolov26_sahi') and YOLO_OK:
        w = model_path(model_name)
        if w and os.path.exists(w):
            _models[model_name] = YOLO(w)
            return _models[model_name]
    if model_name == 'ssd' and TORCH_OK:
        w = model_path(model_name) or os.path.join(base, 'ssd', 'best.pth')
        if w and os.path.exists(w):
            model = load_ssd_model(w)
            if model is not None:
                _models[model_name] = model
                return model
    if model_name == 'frcnn' and TORCH_OK:
        w = model_path(model_name)
        if w and os.path.exists(w):
            model = load_frcnn_model(w)
            if model is not None:
                _models[model_name] = model
                return model
    return None

# ── SIM inference ─────────────────────────────────────────────────────────────
def sim_inference(model_name, conf_threshold=0.25):
    np.random.seed(int(time.time()) % 1000)
    n = np.random.randint(1, 5)
    detections = []
    for i in range(n):
        cls = np.random.choice(DEFECT_CLASSES)
        conf = round(float(np.random.uniform(conf_threshold, 1.0)), 2)
        iw, ih = 640, 480
        x1 = int(np.random.uniform(0, iw * 0.7))
        y1 = int(np.random.uniform(0, ih * 0.7))
        x2 = int(x1 + np.random.uniform(50, iw * 0.3))
        y2 = int(y1 + np.random.uniform(50, ih * 0.3))
        detections.append({
            'class':    cls,
            'confidence': conf,
            'bbox':     [x1, y1, min(x2, iw), min(y2, ih)],
            'priority': PRIORITY_MAP.get(cls, 'Low')
        })
    speed = round(np.random.uniform(80, 400), 1)
    return detections, speed

# ── Real inference ────────────────────────────────────────────────────────────
def real_inference(img_path, model_name, conf_threshold=0.25):
    model_name = canonical_model_name(model_name)
    model = load_model(model_name)
    if model is None:
        raise RuntimeError('Model weights or inference dependencies are unavailable. Install requirements-inference.txt and run python scripts/download_models.py, or explicitly enable simulation mode.')

    t0 = time.time()
    detections = []

    if model_name == 'yolov26' and YOLO_OK:
        results = model(img_path, conf=conf_threshold)
        for r in results:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                cls_name = yolo_class_name(r, cls_id)
                conf = round(float(box.conf[0]), 2)
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                add_detection(detections, cls_name, conf, [x1, y1, x2, y2])

    elif model_name == 'yolov26_sahi' and YOLO_OK and SAHI_OK:
        sahi_model = AutoDetectionModel.from_pretrained(
            model_type=SAHI_CONFIG.get('model_type', 'ultralytics'),
            model_path=model_path('yolov26_sahi'),
            confidence_threshold=conf_threshold,
            device='cuda:0' if TORCH_OK and torch.cuda.is_available() else 'cpu'
        )
        result = get_sliced_prediction(
            img_path, sahi_model,
            slice_height=int(SAHI_CONFIG.get('slice_height', 320)),
            slice_width=int(SAHI_CONFIG.get('slice_width', 320)),
            overlap_height_ratio=float(SAHI_CONFIG.get('overlap_height_ratio', 0.2)),
            overlap_width_ratio=float(SAHI_CONFIG.get('overlap_width_ratio', 0.2))
        )
        for obj in result.object_prediction_list:
            cls_name = obj.category.name
            conf = round(float(obj.score.value), 2)
            bb = obj.bbox
            add_detection(detections, cls_name, conf, [bb.minx, bb.miny, bb.maxx, bb.maxy])

    elif model_name in ('frcnn', 'ssd') and TORCH_OK:
        img = Image.open(img_path).convert('RGB')
        arr = np.asarray(img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr).permute(2, 0, 1)
        with torch.no_grad():
            output = model([tensor])[0]
        boxes = output.get('boxes', [])
        labels = output.get('labels', [])
        scores = output.get('scores', [])
        for box, label, score in zip(boxes, labels, scores):
            conf = float(score)
            if conf < conf_threshold:
                continue
            cls_id = int(label)
            if cls_id > 0:
                cls_id -= 1
            cls_name = SAHI_CLASS_NAMES[cls_id] if cls_id < len(SAHI_CLASS_NAMES) else (
                DEFECT_CLASSES[cls_id] if cls_id < len(DEFECT_CLASSES) else f'class_{cls_id}'
            )
            add_detection(detections, cls_name, conf, box.tolist())

    speed = round((time.time() - t0) * 1000, 1)
    return _sanitize_detections_for_image(detections, img_path), speed

# ── Health + metrics ──────────────────────────────────────────────────────────
def calc_health(detections):
    if not detections:
        return 100.0, 0.0, 0.0
    penalty = sum(ENERGY_IMPACT.get(d['class'], 0.1) * d['confidence'] for d in detections)
    health  = max(0.0, round(100.0 - penalty * 100, 1))
    soiling_conf = [float(d['confidence']) for d in detections
                    if d['class'] == 'soiling']
    soiling = round(min(100.0, max(soiling_conf) * 100), 1) if soiling_conf else 0.0
    energy_loss = round(penalty * 400, 1)
    return health, soiling, energy_loss

def gen_nlp_report(panel_id, detections, health, model_name, location=''):
    ts = datetime.datetime.now().strftime('%d-%m-%Y %H:%M')
    loc_str = f' at {location}' if location else ''
    if not detections:
        return (f'Panel {panel_id}{loc_str} was inspected on {ts} using {model_name}. '
                f'No defects were detected. Health score: {health}/100. '
                f'Panel is in excellent condition. No maintenance required.')
    classes = list(set(d["class"].replace("_", " ") for d in detections))
    priority_counts = {}
    for d in detections:
        priority_counts[d['priority']] = priority_counts.get(d['priority'], 0) + 1
    critical = priority_counts.get('Critical', 0)
    high     = priority_counts.get('High', 0)
    soiling_pct = round(max([float(d['confidence']) for d in detections
                             if d['class'] == 'soiling'] or [0]) * 100, 1)
    has_bird = any(d['class'] == 'bird_dropping' for d in detections)
    action   = ('Immediate maintenance required.' if critical > 0
                else 'Heavy soiling detected. Schedule cleaning within 3 days.' if soiling_pct >= 70
                else 'Soiling detected. Schedule cleaning within 7 days.' if soiling_pct >= 40
                else 'Bird dropping detected. Clean the affected panel area within 7 days.' if has_bird
                else 'Schedule maintenance within 7 days.' if high > 0
                else 'Monitor and clean within 30 days.')
    return (f'Panel {panel_id}{loc_str} was inspected on {ts} using {model_name}. '
            f'{len(detections)} defect(s) detected: {", ".join(classes)}. '
            f'Health score: {health}/100. '
            f'{critical} critical and {high} high-priority issues found. '
            f'{action}')

def calc_roi(energy_loss_wh, price_per_kwh=0.28):
    daily_loss_kwh = energy_loss_wh / 1000
    annual_loss_aud = round(daily_loss_kwh * 365 * price_per_kwh, 2)
    clean_cost = 45.0
    payback_days = round(clean_cost / (daily_loss_kwh * price_per_kwh), 0) if daily_loss_kwh > 0 else 0
    return {
        'daily_loss_kwh':  round(daily_loss_kwh, 3),
        'annual_loss_aud': annual_loss_aud,
        'clean_cost_aud':  clean_cost,
        'payback_days':    int(payback_days),
        'loss_per_hr_aud': round(daily_loss_kwh / 24 * price_per_kwh, 4)
    }

def calc_clean_date(health, soiling):
    if health < 60 or soiling > 40:   days = 3
    elif health < 75 or soiling > 25: days = 7
    elif health < 85 or soiling > 15: days = 14
    elif health < 95 or soiling > 5:  days = 30
    else:                              days = 60
    clean_date = datetime.datetime.now() + datetime.timedelta(days=days)
    return clean_date.strftime('%d-%m-%Y'), days

def save_inspection(panel_id, model_name, location, health, soiling, energy_loss, detections):
    conn = get_db()
    ts = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO inspections
        (panel_id, timestamp, model, location, health, soiling, energy_loss, defect_count, result_json)
        VALUES (?,?,?,?,?,?,?,?,?)
    """, (panel_id, ts, model_name, location, health, soiling, energy_loss,
          len(detections), json.dumps(detections)))
    # auto work orders
    wo_num = conn.execute('SELECT COUNT(*) FROM work_orders').fetchone()[0]
    for d in detections:
        wo_id = f'WO-{wo_num + 1:03d}'
        conn.execute("""
            INSERT INTO work_orders (wo_id, panel_id, issue, priority, status, created_at)
            VALUES (?,?,?,?,?,?)
        """, (wo_id, panel_id, d['class'].replace('_',' ').title(),
              d['priority'], 'Open', ts))
        wo_num += 1
    conn.commit()
    conn.close()

# ── Routes — pages ────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/panel')
def panel():
    return render_template('panel.html')

@app.route('/analytics')
def analytics():
    return render_template('analytics.html')

@app.route('/schedule')
def schedule():
    return render_template('schedule.html')

@app.route('/workorders')
def workorders():
    return render_template('workorders.html')

@app.route('/report')
def report():
    return render_template('report_template.html')

# ── API — inspect image ───────────────────────────────────────────────────────
@app.route('/api/inspect', methods=['POST'])
def api_inspect():
    try:
        panel_id    = request.form.get('panel_id', 'P01')
        model_name  = request.form.get('model', 'yolov26')
        if model_name not in MODEL_DISPLAY:
            return jsonify({'success': False, 'error': 'Unknown model.'}), 400
        try:
            conf = float(request.form.get('confidence', request.form.get('conf', 0.25)))
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'Confidence must be a number between 0 and 1.'}), 400
        if not 0.0 <= conf <= 1.0:
            return jsonify({'success': False, 'error': 'Confidence must be between 0 and 1.'}), 400
        location    = request.form.get('location', '')
        sim_mode_raw = request.form.get('sim_mode')

        img_path = None
        f = request.files.get('image') or request.files.get('file')
        if f:
            if f.filename:
                ext = f.filename.rsplit('.', 1)[-1].lower()
                if ext not in ALLOWED_IMAGE:
                    return jsonify({'success': False, 'error': 'Unsupported image format.'}), 400
                if ext in ALLOWED_IMAGE:
                    fname = secure_filename(f'{uuid.uuid4().hex}.{ext}')
                    img_path = os.path.join(app.config['UPLOAD_FOLDER'], fname)
                    f.save(img_path)

        sim_mode = sim_mode_raw.lower() == 'true' if sim_mode_raw is not None else img_path is None

        if sim_mode or img_path is None:
            detections, speed = sim_inference(model_name, conf)
            inference_img_path = img_path
            stage1 = {'enabled': False, 'used_crop': False, 'message': 'Simulation mode; Stage-1 not used.'}
        else:
            detections, speed, inference_img_path, stage1 = inspect_with_stage1(img_path, model_name, conf)

        health, soiling, energy_loss = calc_health(detections)
        nlp    = gen_nlp_report(panel_id, detections, health, model_name, location)
        roi    = calc_roi(energy_loss)
        clean_date, days_until = calc_clean_date(health, soiling)

        save_inspection(panel_id, model_name, location, health, soiling, energy_loss, detections)

        # annotated image (base64)
        annotated_b64 = None
        if inference_img_path and CV2_OK:
            img = cv2.imread(inference_img_path)
            if img is not None:
                for d in detections:
                    x1,y1,x2,y2 = d['bbox']
                    color = (0,0,255) if d['priority']=='Critical' else                             (0,128,255) if d['priority']=='High' else (0,200,200)
                    cv2.rectangle(img,(x1,y1),(x2,y2),color,2)
                    label = f"{d['class']} {int(d['confidence']*100)}%"
                    cv2.putText(img,label,(x1,y1-8),cv2.FONT_HERSHEY_SIMPLEX,0.5,color,1)
                _, buf = cv2.imencode('.jpg', img)
                annotated_b64 = base64.b64encode(buf).decode()

        # health label
        if health >= 90:   hlabel = 'Excellent'
        elif health >= 75: hlabel = 'Good'
        elif health >= 60: hlabel = 'Moderate'
        elif health >= 40: hlabel = 'Poor'
        else:              hlabel = 'Critical'

        annotated_image = encode_annotated_image_data_url(inference_img_path, detections) or encode_image_data_url(inference_img_path)
        stage1_image = encode_image_data_url(inference_img_path)
        source_image = encode_image_data_url(img_path)
        image_width = image_height = None
        if inference_img_path and os.path.exists(inference_img_path):
            with Image.open(inference_img_path) as im:
                image_width, image_height = im.size

        return jsonify({
            'success':      True,
            'panel_id':     panel_id,
            'model':        canonical_model_name(model_name),
            'model_label':  MODEL_DISPLAY.get(canonical_model_name(model_name), canonical_model_name(model_name)),
            'speed_ms':     speed,
            'detections':   detections,
            'health':       health,
            'health_score': health,
            'health_label': hlabel,
            'soiling':      soiling,
            'soiling_pct':  soiling,
            'energy_loss':  energy_loss,
            'energy_lost':  energy_loss,
            'total_defects': len(detections),
            'nlp_report':   nlp,
            'roi':          roi,
            'clean_date':   clean_date,
            'days_until':   days_until,
            'timestamp':    datetime.datetime.now().isoformat(),
            'annotated_image': f'data:image/jpeg;base64,{annotated_b64}' if annotated_b64 else None,
            'original_image': encode_image_data_url(inference_img_path),
            'source_image':  source_image,
            'stage1_image':  stage1_image,
            'stage2_image':  annotated_image,
            'stage1':       stage1,
            'crop_width':   image_width,
            'crop_height':  image_height,
            'image_width':  image_width,
            'image_height': image_height,
            'sim_mode':     sim_mode or img_path is None
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ── API — inspect video ───────────────────────────────────────────────────────
@app.route('/api/tello_frame', methods=['POST'])
def api_tello_frame():
    try:
        panel_id    = request.form.get('panel_id', f'T{int(time.time())}')
        model_name  = request.form.get('model', 'yolov26')
        if model_name not in MODEL_DISPLAY:
            return jsonify({'success': False, 'error': 'Unknown model.'}), 400
        try:
            conf = float(request.form.get('confidence', request.form.get('conf', 0.25)))
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'Confidence must be a number between 0 and 1.'}), 400
        if not 0.0 <= conf <= 1.0:
            return jsonify({'success': False, 'error': 'Confidence must be between 0 and 1.'}), 400

        img_path = None
        f = request.files.get('frame') or request.files.get('image') or request.files.get('file')
        if f and f.filename:
            ext = f.filename.rsplit('.', 1)[-1].lower()
            if ext not in ALLOWED_IMAGE:
                ext = 'jpg'
            fname = secure_filename(f'{uuid.uuid4().hex}.{ext}')
            img_path = os.path.join(app.config['UPLOAD_FOLDER'], fname)
            f.save(img_path)
        if img_path is None:
            return jsonify({'success': False, 'error': 'No Tello frame provided'})

        detections, speed = real_inference(img_path, model_name, conf)
        detections = _visual_class_corrections(img_path, detections)
        detections, panel_bbox = _filter_tello_frame_detections(detections, img_path)
        inference_img_path = img_path
        stage1 = {
            'enabled': True,
            'used_crop': False,
            'crop_strategy': 'live_tello_full_frame',
            'bbox': panel_bbox,
            'message': 'Live Tello inspection used the full camera frame and filtered detections to the main panel area.'
        }
        health, soiling, energy_loss = calc_health(detections)
        clean_date, days_until = calc_clean_date(health, soiling)
        hlabel = ('Excellent' if health >= 90 else 'Good' if health >= 75 else
                  'Moderate' if health >= 60 else 'Poor' if health >= 40 else 'Critical')
        source_image = encode_image_data_url(img_path)
        stage1_image = None
        annotated_image = encode_annotated_image_data_url(inference_img_path, detections) or source_image
        image_width = image_height = None
        if inference_img_path and os.path.exists(inference_img_path):
            with Image.open(inference_img_path) as im:
                image_width, image_height = im.size

        return jsonify({
            'success': True,
            'panel_id': panel_id,
            'model': canonical_model_name(model_name),
            'model_label': MODEL_DISPLAY.get(canonical_model_name(model_name), canonical_model_name(model_name)),
            'speed_ms': speed,
            'detections': detections,
            'health': health,
            'health_score': health,
            'health_label': hlabel,
            'soiling': soiling,
            'soiling_pct': soiling,
            'energy_loss': energy_loss,
            'energy_lost': energy_loss,
            'total_defects': len(detections),
            'nlp_report': gen_nlp_report(panel_id, detections, health, model_name, 'Live Tello'),
            'clean_date': clean_date,
            'days_until': days_until,
            'timestamp': datetime.datetime.now().isoformat(),
            'source_image': source_image,
            'stage1_image': stage1_image,
            'stage2_image': annotated_image,
            'original_image': source_image,
            'annotated_image': annotated_image,
            'crop_width': image_width,
            'crop_height': image_height,
            'image_width': image_width,
            'image_height': image_height,
            'stage1': stage1,
            'stage2': {
                'enabled': True,
                'model': MODEL_DISPLAY.get(canonical_model_name(model_name), canonical_model_name(model_name)),
                'detections': len(detections),
                'speed_ms': speed
            },
            'sim_mode': False
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/tello/connect', methods=['POST'])
def api_tello_connect():
    ok, response = tello_send_command('command', timeout=4)
    return jsonify({
        'success': ok,
        'connected': ok,
        'response': response,
        'mode': 'real' if ok else 'unavailable'
    })

@app.route('/api/tello/command', methods=['POST'])
def api_tello_command():
    data = request.get_json(silent=True) or {}
    raw = str(data.get('command') or data.get('cmd') or '').strip().lower()
    if not raw:
        return jsonify({'success': False, 'error': 'No Tello command provided'})
    def n(*names, default=30):
        for name in names:
            if name in data:
                return int(data[name])
        return default
    command_map = {
        'forward': f"forward {n('distance', 'value')}",
        'back':    f"back {n('distance', 'value')}",
        'left':    f"left {n('distance', 'value')}",
        'right':   f"right {n('distance', 'value')}",
        'up':      f"up {n('distance', 'value')}",
        'down':    f"down {n('distance', 'value')}",
        'cw':      f"cw {n('degrees', 'value', default=45)}",
        'ccw':     f"ccw {n('degrees', 'value', default=45)}",
        'speed':   f"speed {n('speed', 'value')}",
    }
    if raw in command_map:
        command = command_map[raw]
    elif raw in ('command', 'takeoff', 'land', 'streamon', 'streamoff', 'emergency', 'battery?', 'height?', 'speed?', 'temp?', 'time?'):
        command = raw
    elif raw.startswith('flip'):
        command = raw
    else:
        command = raw
    ok, response = tello_send_command(command, timeout=8 if command in ('takeoff', 'land') else 5)
    should_retry = command in ('takeoff', 'land') or command.startswith(
        ('forward ', 'back ', 'left ', 'right ', 'up ', 'down ', 'cw ', 'ccw ')
    )
    if not ok and should_retry:
        tello_send_command('command', timeout=4)
        time.sleep(0.25)
        ok, response = tello_send_command(command, timeout=8 if command in ('takeoff', 'land') else 5)
    video_status = None
    if ok and command == 'streamon':
        _, video_status = start_tello_video_capture()
    elif command == 'streamoff':
        stop_tello_video_capture()
        video_status = 'stopped'
    return jsonify({'success': ok, 'command': command, 'response': response, 'video': video_status})

@app.route('/api/tello/status', methods=['GET'])
def api_tello_status():
    if not _tello_connected:
        return jsonify({'success': True, 'connected': False})
    values = {}
    ok_any = False
    for key, command in (
        ('battery', 'battery?'),
        ('height', 'height?'),
        ('speed', 'speed?'),
        ('temp', 'temp?'),
        ('flight_time', 'time?'),
    ):
        ok, response = tello_send_command(command, timeout=0.8)
        if ok:
            ok_any = True
        try:
            values[key] = int(str(response).strip())
        except Exception:
            values[key] = None
        values[key + '_response'] = response
    return jsonify({'success': ok_any, 'connected': ok_any or _tello_connected, **values})

@app.route('/api/tello/video_snapshot', methods=['GET'])
def api_tello_video_snapshot():
    with _tello_video_lock:
        frame = _tello_latest_frame
        running = _tello_video_running
    if not running:
        return jsonify({'success': False, 'error': 'Tello video stream is not running'}), 409
    if frame is None:
        return jsonify({'success': False, 'error': 'Waiting for Tello video frame'}), 202
    return Response(frame, mimetype='image/jpeg')

@app.route('/api/video', methods=['POST'])
@app.route('/api/inspect_video', methods=['POST'])
def api_video():
    try:
        model_name  = request.form.get('model', 'yolov26')
        if model_name not in MODEL_DISPLAY:
            return jsonify({'success': False, 'error': 'Unknown model.'}), 400
        try:
            conf = float(request.form.get('confidence', request.form.get('conf', 0.25)))
        except (TypeError, ValueError):
            return jsonify({'success': False, 'error': 'Confidence must be a number between 0 and 1.'}), 400
        if not 0.0 <= conf <= 1.0:
            return jsonify({'success': False, 'error': 'Confidence must be between 0 and 1.'}), 400
        max_frames  = int(request.form.get('max_frames', 6))
        frame_mode  = request.form.get('frame_mode', 'manual').strip().lower()
        auto_frames = frame_mode == 'auto'
        selection_limit = 50 if auto_frames else max(1, max_frames)
        sim_mode_raw = request.form.get('sim_mode')

        frames_results = []

        f = request.files.get('video') or request.files.get('file')
        sim_mode = sim_mode_raw.lower() == 'true' if sim_mode_raw is not None else f is None
        if sim_mode or f is None:
            sim_frames = 3 if auto_frames else selection_limit
            for i in range(sim_frames):
                panel_id = f'P{i+1:02d}'
                dets, speed = sim_inference(model_name, conf)
                health, soiling, energy_loss = calc_health(dets)
                frames_results.append({
                    'frame':       i + 1,
                    'panel_id':    panel_id,
                    'detections':  dets,
                    'health':      health,
                    'soiling':     soiling,
                    'soiling_pct': soiling,
                    'energy_loss': energy_loss,
                    'speed_ms':    speed
                })
        else:
            fname = secure_filename(f'{uuid.uuid4().hex}.mp4')
            vpath = os.path.join(app.config['UPLOAD_FOLDER'], fname)
            f.save(vpath)
            if CV2_OK:
                cap = cv2.VideoCapture(vpath)
                total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
                duration = total / fps if fps > 0 and total > 0 else 0
                frame_indices = _select_distinct_video_panel_frames(cap, total, fps, selection_limit)
                sample_mode = 'auto_distinct_solar_panels' if auto_frames else 'manual_distinct_solar_panels'

                for fi, frame_idx in enumerate(frame_indices):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                    ret, frame = cap.read()
                    if not ret: break
                    tmp = os.path.join(app.config['UPLOAD_FOLDER'], f'frame_{uuid.uuid4().hex}_{fi}.jpg')
                    cv2.imwrite(tmp, frame)
                    panel_id = f'P{fi+1:02d}'
                    video_conf = min(conf, 0.20) if canonical_model_name(model_name) in ('yolov26', 'auto') else conf
                    dets, speed, inference_tmp, stage1 = inspect_with_stage1(
                        tmp, model_name, video_conf, crop_strategy='video_cluster'
                    )
                    if stage1.get('bbox_source') == 'video_cluster_rejected_tiny_crop':
                        dets = [
                            d for d in dets
                            if d.get('source') != 'visual_bird_dropping'
                            and d.get('class') in ('micro_crack', 'crack', 'glass_breakage')
                            and float(d.get('confidence', 0)) >= 0.20
                        ]
                    health, soiling, energy_loss = calc_health(dets)
                    display_frame = cv2.imread(inference_tmp) if inference_tmp else frame
                    if display_frame is None:
                        display_frame = frame
                    image_height, image_width = display_frame.shape[:2]
                    _, buf = cv2.imencode('.jpg', display_frame)
                    thumb = base64.b64encode(buf).decode()
                    frames_results.append({
                        'frame':       fi + 1,
                        'panel_id':    panel_id,
                        'detections':  dets,
                        'health':      health,
                        'soiling':     soiling,
                        'soiling_pct': soiling,
                        'energy_loss': energy_loss,
                        'speed_ms':    speed,
                        'thumbnail':   thumb,
                        'original_image': f'data:image/jpeg;base64,{thumb}',
                        'crop_width':   image_width,
                        'crop_height':  image_height,
                        'image_width':  image_width,
                        'image_height': image_height,
                        'sample_time':  round(frame_idx / fps, 2) if fps > 0 else None,
                        'sample_frame': int(frame_idx),
                        'sample_mode':  sample_mode,
                        'video_duration': round(duration, 2) if duration else None,
                        'requested_confidence': conf,
                        'video_confidence': video_conf,
                        'stage1':      stage1
                    })
                cap.release()

        total_defects  = sum(len(r['detections']) for r in frames_results)
        avg_health     = round(sum(r['health'] for r in frames_results) / len(frames_results), 1) if frames_results else 0
        total_energy   = round(sum(r['energy_loss'] for r in frames_results), 1)

        return jsonify({
            'success':       True,
            'frames':        frames_results,
            'total_frames':  len(frames_results),
            'frames_analysed': len(frames_results),
            'total_defects': total_defects,
            'avg_health':    avg_health,
            'total_energy':  total_energy,
            'energy_lost':   total_energy,
            'model':         canonical_model_name(model_name),
            'model_label':   MODEL_DISPLAY.get(canonical_model_name(model_name), canonical_model_name(model_name)),
            'frame_mode':    'auto' if auto_frames else 'manual',
            'requested_max_frames': None if auto_frames else selection_limit,
            'sim_mode':      sim_mode or f is None
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

# ── API — results ─────────────────────────────────────────────────────────────
@app.route('/api/results', methods=['GET'])
def api_results():
    try:
        conn = get_db()
        rows = conn.execute(
            'SELECT * FROM inspections ORDER BY id DESC LIMIT 200'
        ).fetchall()
        conn.close()
        results = []
        for r in rows:
            d = dict(r)
            d['detections'] = json.loads(d['result_json'])
            del d['result_json']
            results.append(d)
        return jsonify({'success': True, 'results': results})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — report ──────────────────────────────────────────────────────────────
@app.route('/api/report', methods=['GET'])
def api_report():
    try:
        panel_id = request.args.get('panel_id')
        conn = get_db()
        if panel_id:
            row = conn.execute(
                'SELECT * FROM inspections WHERE panel_id=? ORDER BY id DESC LIMIT 1',
                (panel_id,)
            ).fetchone()
        else:
            row = conn.execute(
                'SELECT * FROM inspections ORDER BY id DESC LIMIT 1'
            ).fetchone()
        conn.close()
        if not row:
            return jsonify({'success': False, 'error': 'No inspections found'})
        data = dict(row)
        data['detections'] = json.loads(data['result_json'])
        del data['result_json']
        data['roi'] = calc_roi(data['energy_loss'])
        clean_date, days = calc_clean_date(data['health'], data['soiling'])
        data['clean_date']  = clean_date
        data['days_until']  = days
        data['nlp_report']  = gen_nlp_report(
            data['panel_id'], data['detections'],
            data['health'], data['model'], data['location']
        )
        return jsonify({'success': True, 'report': data})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — analytics ───────────────────────────────────────────────────────────
@app.route('/api/analytics', methods=['GET'])
def api_analytics():
    try:
        conn = get_db()
        rows = conn.execute(
            'SELECT * FROM inspections ORDER BY id ASC'
        ).fetchall()
        conn.close()
        health_trend, energy_trend, labels = [], [], []
        defect_freq = {}
        conf_vals   = []
        for r in rows:
            dets = json.loads(r['result_json'])
            labels.append(r['panel_id'])
            health_trend.append(r['health'])
            energy_trend.append(r['energy_loss'])
            for d in dets:
                defect_freq[d['class']] = defect_freq.get(d['class'], 0) + 1
                conf_vals.append(d['confidence'])
        return jsonify({
            'success':      True,
            'labels':       labels,
            'health_trend': health_trend,
            'energy_trend': energy_trend,
            'defect_freq':  defect_freq,
            'conf_values':  conf_vals
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — schedule ────────────────────────────────────────────────────────────
@app.route('/api/schedule', methods=['GET'])
def api_schedule():
    try:
        conn = get_db()
        rows = conn.execute("""
            SELECT panel_id, health, soiling, energy_loss
            FROM inspections
            GROUP BY panel_id
            HAVING MAX(id)
            ORDER BY health ASC
        """).fetchall()
        conn.close()
        schedule = []
        for r in rows:
            clean_date, days = calc_clean_date(r['health'], r['soiling'])
            if r['health'] < 60:   priority = 'High'
            elif r['health'] < 75: priority = 'Medium'
            else:                  priority = 'Low'
            schedule.append({
                'panel_id':   r['panel_id'],
                'health':     r['health'],
                'soiling':    r['soiling'],
                'energy_loss':r['energy_loss'],
                'priority':   priority,
                'clean_date': clean_date,
                'days_until': days
            })
        return jsonify({'success': True, 'schedule': schedule})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — work orders ─────────────────────────────────────────────────────────
@app.route('/api/workorders', methods=['GET'])
def api_workorders():
    try:
        conn = get_db()
        rows = conn.execute(
            'SELECT * FROM work_orders ORDER BY id DESC'
        ).fetchall()
        conn.close()
        return jsonify({'success': True, 'workorders': [dict(r) for r in rows]})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/workorders/<wo_id>/complete', methods=['POST'])
def api_wo_complete(wo_id):
    try:
        conn = get_db()
        conn.execute(
            "UPDATE work_orders SET status='Completed' WHERE wo_id=?", (wo_id,)
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — farm overview ───────────────────────────────────────────────────────
@app.route('/api/farm', methods=['GET'])
def api_farm():
    try:
        conn = get_db()
        rows = conn.execute("""
            SELECT panel_id, health, soiling, energy_loss, defect_count, timestamp
            FROM inspections
            GROUP BY panel_id
            HAVING MAX(id)
        """).fetchall()
        conn.close()
        panels = [dict(r) for r in rows]
        avg_health = round(sum(p['health'] for p in panels) / len(panels), 1) if panels else 0
        total_energy = round(sum(p['energy_loss'] for p in panels), 1)
        critical = sum(1 for p in panels if p['health'] < 60)
        return jsonify({
            'success':      True,
            'panels':       panels,
            'avg_health':   avg_health,
            'total_energy': total_energy,
            'critical':     critical,
            'inspected':    len(panels)
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — export ──────────────────────────────────────────────────────────────
@app.route('/api/export/csv', methods=['GET'])
def api_export_csv():
    try:
        conn = get_db()
        rows = conn.execute('SELECT * FROM inspections ORDER BY id DESC').fetchall()
        conn.close()
        lines = ['id,panel_id,timestamp,model,location,health,soiling,energy_loss,defect_count']
        for r in rows:
            lines.append(f'{r["id"]},{r["panel_id"]},{r["timestamp"]},{r["model"]},'
                         f'{r["location"]},{r["health"]},{r["soiling"]},'
                         f'{r["energy_loss"]},{r["defect_count"]}')
        from flask import Response
        return Response(
            '\n'.join(lines),
            mimetype='text/csv',
            headers={'Content-Disposition': 'attachment;filename=solarvision_results.csv'}
        )
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/api/export/json', methods=['GET'])
def api_export_json():
    try:
        conn = get_db()
        rows = conn.execute('SELECT * FROM inspections ORDER BY id DESC').fetchall()
        conn.close()
        data = []
        for r in rows:
            d = dict(r)
            d['detections'] = json.loads(d['result_json'])
            del d['result_json']
            data.append(d)
        from flask import Response
        return Response(
            json.dumps(data, indent=2),
            mimetype='application/json',
            headers={'Content-Disposition': 'attachment;filename=solarvision_results.json'}
        )
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — reset session ───────────────────────────────────────────────────────
@app.route('/api/reset', methods=['POST'])
def api_reset():
    try:
        conn = get_db()
        conn.execute('DELETE FROM inspections')
        conn.execute('DELETE FROM work_orders')
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ── API — status ──────────────────────────────────────────────────────────────
@app.route('/api/status', methods=['GET'])
def api_status():
    conn = get_db()
    scans    = conn.execute('SELECT COUNT(*) FROM inspections').fetchone()[0]
    defects  = conn.execute('SELECT SUM(defect_count) FROM inspections').fetchone()[0] or 0
    avg_h    = conn.execute('SELECT AVG(health) FROM inspections').fetchone()[0]
    e_loss   = conn.execute('SELECT SUM(energy_loss) FROM inspections').fetchone()[0] or 0
    critical = conn.execute(
        "SELECT COUNT(*) FROM inspections WHERE health < 60"
    ).fetchone()[0]
    last_ts  = conn.execute(
        'SELECT timestamp FROM inspections ORDER BY id DESC LIMIT 1'
    ).fetchone()
    conn.close()
    return jsonify({
        'success':    True,
        'scans':      scans,
        'defects':    defects,
        'avg_health': round(avg_h, 1) if avg_h else None,
        'energy_loss':round(e_loss, 1),
        'critical':   critical,
        'last_scan':  last_ts[0] if last_ts else None
    })

# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    app.run(debug=False, host='127.0.0.1', port=int(os.environ.get('PORT', '5000')))
