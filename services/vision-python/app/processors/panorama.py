from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

from ..storage import get_bytes


def _laplacian_variance(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def analyze_panorama(payload: dict[str, Any]) -> dict[str, Any]:
    raw = get_bytes(str(payload["bucket"]), str(payload["objectKey"]))
    with Image.open(BytesIO(raw)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        width, height = image.size
        array = np.asarray(image)

    gray = cv2.cvtColor(array, cv2.COLOR_RGB2GRAY)
    ratio = width / max(height, 1)
    blur_score = _laplacian_variance(gray)
    mean_brightness = float(gray.mean())
    shadow_ratio = float(np.mean(gray < 20))
    highlight_ratio = float(np.mean(gray > 245))

    seam_width = max(1, int(width * 0.01))
    left = array[:, :seam_width].astype(np.float32)
    right = array[:, -seam_width:].astype(np.float32)
    seam_mean_abs_diff = float(np.mean(np.abs(left - right)))

    issues: list[str] = []
    if width < 2048 or height < 1024:
        issues.append("resolution_too_low")
    if abs(ratio - 2.0) > 0.06:
        issues.append("not_equirectangular_2_to_1")
    if blur_score < 35:
        issues.append("image_may_be_blurry")
    if mean_brightness < 35:
        issues.append("image_too_dark")
    if mean_brightness > 225:
        issues.append("image_too_bright")
    if shadow_ratio > 0.40:
        issues.append("excessive_crushed_shadows")
    if highlight_ratio > 0.35:
        issues.append("excessive_clipped_highlights")
    if seam_mean_abs_diff > 55:
        issues.append("possible_panorama_seam")

    hard_failures = {
        "resolution_too_low",
        "not_equirectangular_2_to_1",
        "image_too_dark",
        "image_too_bright",
    }
    approved = not any(issue in hard_failures for issue in issues)
    quality_score = max(
        0,
        min(
            100,
            100
            - 20 * len([issue for issue in issues if issue in hard_failures])
            - 8 * len([issue for issue in issues if issue not in hard_failures]),
        ),
    )

    return {
        "approved": approved,
        "qualityScore": quality_score,
        "issues": issues,
        "metrics": {
            "width": width,
            "height": height,
            "aspectRatio": round(ratio, 4),
            "blurScore": round(blur_score, 2),
            "meanBrightness": round(mean_brightness, 2),
            "shadowRatio": round(shadow_ratio, 4),
            "highlightRatio": round(highlight_ratio, 4),
            "seamMeanAbsDiff": round(seam_mean_abs_diff, 2),
        },
    }
