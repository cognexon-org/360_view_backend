from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..storage import get_bytes


def scan_privacy(payload: dict[str, Any]) -> dict[str, Any]:
    raw = get_bytes(str(payload["bucket"]), str(payload["objectKey"]))
    with Image.open(BytesIO(raw)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        array = np.asarray(image)

    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(cascade_path)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40))
    boxes = [
        {"x": int(x), "y": int(y), "width": int(w), "height": int(h), "type": "possible_face"}
        for x, y, w, h in faces
    ]
    return {
        "requiresReview": len(boxes) > 0,
        "detections": boxes,
        "warning": "Heuristic face detection only. Documents, screens, plates and text require a production privacy model or human review.",
    }
