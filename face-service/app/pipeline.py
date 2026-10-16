"""Face detection, quality checks, baseline liveness, and 512-d embeddings.

The default embedder is a histogram-of-gradients descriptor. It is deterministic
and runs on ordinary CPUs. Swap `embed_crop` for an ArcFace / InsightFace model
and change MODEL_VERSION when you move to production recognition.
"""

import math

import cv2
import numpy as np

MODEL_VERSION = "hog-nn-v1"
_CASCADE = None


def cascade():
    global _CASCADE
    if _CASCADE is None:
        path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        loaded = cv2.CascadeClassifier(path)
        if loaded.empty():
            raise RuntimeError("Face detector cascade is missing")
        _CASCADE = loaded
    return _CASCADE


def decode_image(data: bytes):
    if not data:
        raise ValueError("Empty image")
    if len(data) > 6_000_000:
        raise ValueError("Image is larger than 6 MB")
    arr = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not read that image")
    height, width = image.shape[:2]
    if width > 1280:
        scale = 1280 / width
        image = cv2.resize(image, (1280, max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
    return image


def detect_faces(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    detector = cascade()
    found = detector.detectMultiScale(enhanced, scaleFactor=1.08, minNeighbors=4, minSize=(40, 40))
    if len(found) == 0:
        found = detector.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=4, minSize=(40, 40))
    boxes = sorted(found, key=lambda box: int(box[2]) * int(box[3]), reverse=True)[:40]
    return [(int(x), int(y), int(w), int(h)) for x, y, w, h in boxes]


def crop_face(image, box, margin=0.15):
    x, y, w, h = box
    pad_x = int(w * margin)
    pad_y = int(h * margin)
    height, width = image.shape[:2]
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(width, x + w + pad_x)
    y1 = min(height, y + h + pad_y)
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        raise ValueError("Face crop is empty")
    return crop


def to_luma(bgr):
    blue = bgr[:, :, 0].astype(np.float32)
    green = bgr[:, :, 1].astype(np.float32)
    red = bgr[:, :, 2].astype(np.float32)
    luma = 0.114 * blue + 0.587 * green + 0.299 * red
    return np.clip(np.rint(luma), 0, 255).astype(np.uint8)


def nn_resize(img, size=64):
    height, width = img.shape[:2]
    ys = np.minimum(height - 1, (np.arange(size) * height // size)).astype(np.int32)
    xs = np.minimum(width - 1, (np.arange(size) * width // size)).astype(np.int32)
    return img[ys][:, xs]


def equalize(img):
    hist = np.bincount(img.ravel(), minlength=256)
    cdf = np.cumsum(hist)
    nonzero = np.flatnonzero(cdf)
    if nonzero.size == 0:
        return img.copy()
    cdf_min = int(cdf[nonzero[0]])
    total = int(img.size)
    if total == cdf_min:
        return img.copy()
    lut = ((cdf - cdf_min) * 255 // (total - cdf_min)).astype(np.int32)
    lut = np.clip(lut, 0, 255).astype(np.uint8)
    return lut[img]


def embed_gray(img):
    values = img.astype(np.float32)
    gx = np.zeros_like(values)
    gy = np.zeros_like(values)
    gx[:, 1:-1] = values[:, 2:] - values[:, :-2]
    gy[1:-1, :] = values[2:, :] - values[:-2, :]
    gx[:, 0] = values[:, 1] - values[:, 0]
    gx[:, -1] = values[:, -1] - values[:, -2]
    gy[0, :] = values[1, :] - values[0, :]
    gy[-1, :] = values[-1, :] - values[-2, :]
    magnitude = np.sqrt(gx * gx + gy * gy)
    angle = np.arctan2(gy, gx)
    bins = np.floor((angle + np.pi) / (2 * np.pi) * 8).astype(np.int32)
    bins = np.clip(bins, 0, 7)
    hist = np.zeros(512, dtype=np.float64)
    for by in range(8):
        for bx in range(8):
            cell_mag = magnitude[by * 8:(by + 1) * 8, bx * 8:(bx + 1) * 8]
            cell_bins = bins[by * 8:(by + 1) * 8, bx * 8:(bx + 1) * 8]
            base = (by * 8 + bx) * 8
            for index in range(8):
                hist[base + index] = float(cell_mag[cell_bins == index].sum())
    norm = float(np.linalg.norm(hist))
    if norm < 1e-8:
        return [0.0] * 512
    scaled = hist / norm
    return [round(float(value), 6) for value in scaled]


def embed_crop(crop_bgr):
    luma = to_luma(crop_bgr)
    small = nn_resize(luma, 64)
    return embed_gray(equalize(small))


def cosine(left, right):
    if not left or not right:
        return 0.0
    dot = 0.0
    left_norm = 0.0
    right_norm = 0.0
    for a, b in zip(left, right):
        dot += a * b
        left_norm += a * a
        right_norm += b * b
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / math.sqrt(left_norm * right_norm)


def assess(image, box, mode):
    crop = crop_face(image, box)
    luma = to_luma(crop)
    blur = float(cv2.Laplacian(luma, cv2.CV_64F).var())
    brightness = float(luma.mean())
    energy = float(np.mean(np.abs(cv2.Laplacian(luma, cv2.CV_64F))))
    height, width = image.shape[:2]
    _, _, box_w, box_h = box
    ratio = (box_w * box_h) / float(width * height)
    issues = []
    min_blur = 30 if mode == "enroll" else 12
    min_side = 80 if mode == "enroll" else 40
    if blur < min_blur:
        issues.append("Photo is too blurry")
    if brightness < (50 if mode == "enroll" else 35):
        issues.append("Photo is too dark")
    if brightness > (210 if mode == "enroll" else 230):
        issues.append("Photo is too bright")
    if min(box_w, box_h) < min_side:
        issues.append("Face is too small")
    if mode == "enroll" and ratio < 0.04:
        issues.append("Move closer so your face fills more of the frame")
    spoof = energy < 1.2
    return {
        "crop": crop,
        "quality": {
            "ok": len(issues) == 0,
            "blur": round(blur, 2),
            "brightness": round(brightness, 2),
            "faceRatio": round(ratio, 4),
            "issues": issues,
        },
        "liveness": {
            "passed": not spoof,
            "score": round(max(0.0, min(1.0, energy / 15)), 4),
            "spoofSuspect": spoof,
            "method": "texture",
        },
    }


def describe_face(image, box, mode):
    assessed = assess(image, box, mode)
    embedding = embed_crop(assessed["crop"])
    return {
        "box": list(box),
        "quality": assessed["quality"],
        "liveness": assessed["liveness"],
        "embedding": embedding,
    }


def analyze_image(data: bytes, mode="recognize"):
    image = decode_image(data)
    faces = [describe_face(image, box, mode) for box in detect_faces(image)]
    return {"modelVersion": MODEL_VERSION, "faces": faces}


def analyze_pair(first: bytes, second: bytes):
    image_a = decode_image(first)
    image_b = decode_image(second)
    boxes_a = detect_faces(image_a)
    boxes_b = detect_faces(image_b)
    if not boxes_a or not boxes_b:
        return {
            "modelVersion": MODEL_VERSION,
            "passed": False,
            "reason": "A face must be visible in both photos",
            "faces": [],
        }
    box_a = boxes_a[0]
    box_b = boxes_b[0]
    face_a = describe_face(image_a, box_a, "recognize")
    face_b = describe_face(image_b, box_b, "recognize")
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    center_a = (ax + aw / 2, ay + ah / 2)
    center_b = (bx + bw / 2, by + bh / 2)
    distance = math.hypot(center_a[0] - center_b[0], center_a[1] - center_b[1])
    width = max(image_a.shape[1], image_b.shape[1], 1)
    moved = distance >= 0.015 * width
    same_person = cosine(face_a["embedding"], face_b["embedding"]) >= 0.7
    texture_ok = face_a["liveness"]["passed"] and face_b["liveness"]["passed"]
    passed = bool(moved and same_person and texture_ok)
    if passed:
        reason = "Head movement confirmed"
    elif not same_person:
        reason = "The two photos do not look like the same person"
    elif not moved:
        reason = "Turn your head slightly between the two photos"
    else:
        reason = "Those photos look like a printed photo or a screen"
    chosen = face_b if face_b["quality"]["ok"] or not face_a["quality"]["ok"] else face_a
    chosen["liveness"] = {
        "passed": passed,
        "score": round(min(1.0, distance / width * 8), 4),
        "spoofSuspect": not texture_ok,
        "method": "head-turn",
    }
    return {
        "modelVersion": MODEL_VERSION,
        "passed": passed,
        "reason": reason,
        "faces": [chosen],
    }
