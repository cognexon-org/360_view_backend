from __future__ import annotations

from typing import Any
import numpy as np


def _point(value: Any) -> np.ndarray:
    arr = np.asarray(value, dtype=float)
    if arr.shape != (3,) or not np.isfinite(arr).all():
        raise ValueError('Each anchor point must be a finite [x,y,z] vector')
    return arr


def _matrix4(rotation: np.ndarray, translation: np.ndarray) -> list[list[float]]:
    matrix = np.eye(4, dtype=float)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = translation
    return [[float(v) for v in row] for row in matrix]


def estimate_registration(payload: dict[str, Any]) -> dict[str, Any]:
    """Estimate a conservative rigid source->target transform from matched 3D anchors.

    One or two anchors produce translation-only alignment. Three or more anchors use
    Kabsch/SVD rigid alignment. Scale is intentionally fixed to 1.0 so ProgressionAi
    never hides dimensional disagreement by stretching one capture to fit another.
    """
    anchors = payload.get('anchors') or []
    if not isinstance(anchors, list) or not anchors:
        raise ValueError('At least one matched anchor is required')

    source = np.stack([_point(item.get('source')) for item in anchors])
    target = np.stack([_point(item.get('target')) for item in anchors])

    if len(anchors) < 3:
        rotation = np.eye(3)
        translation = target.mean(axis=0) - source.mean(axis=0)
        method = 'ANCHOR_TRANSLATION'
    else:
        source_centroid = source.mean(axis=0)
        target_centroid = target.mean(axis=0)
        src0 = source - source_centroid
        tgt0 = target - target_centroid
        covariance = src0.T @ tgt0
        u, _s, vt = np.linalg.svd(covariance)
        rotation = vt.T @ u.T
        if np.linalg.det(rotation) < 0:
            vt[-1, :] *= -1
            rotation = vt.T @ u.T
        translation = target_centroid - rotation @ source_centroid
        method = 'ANCHOR_RIGID'

    projected = (rotation @ source.T).T + translation
    errors = np.linalg.norm(projected - target, axis=1)
    rms = float(np.sqrt(np.mean(errors ** 2)))
    max_error = float(np.max(errors))

    # Confidence is deliberately conservative and easy to reason about. 0 cm => 1,
    # ~5 cm => ~0.61, ~10 cm => ~0.37, ~20 cm => ~0.14.
    confidence = float(np.clip(np.exp(-rms / 0.10), 0.0, 1.0))
    if len(anchors) < 3:
        confidence *= 0.65

    return {
        'transform': {
            'matrix4': _matrix4(rotation, translation),
            'translationM': [float(v) for v in translation],
            'rotation3x3': [[float(v) for v in row] for row in rotation],
            'scale': 1.0,
            'convention': 'SOURCE_TO_TARGET_COLUMN_VECTOR'
        },
        'confidence': round(confidence, 6),
        'overlap': payload.get('overlap'),
        'method': method,
        'diagnostics': {
            'anchorCount': len(anchors),
            'rmsErrorM': round(rms, 6),
            'maxErrorM': round(max_error, 6),
            'perAnchorErrorM': [round(float(v), 6) for v in errors],
            'scaleLocked': True,
            'warning': None if len(anchors) >= 3 else 'Fewer than 3 anchors: translation-only registration.'
        }
    }
