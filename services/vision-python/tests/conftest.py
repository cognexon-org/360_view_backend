"""Test-only fallback for environments where the MinIO SDK is not installed.

Production installs ``minio`` from requirements.txt. Unit tests monkeypatch the
storage functions, so a tiny import stub keeps collection independent of network
package availability in constrained build environments.
"""
from __future__ import annotations

import sys
import types

try:
    import minio  # noqa: F401
except ModuleNotFoundError:
    module = types.ModuleType("minio")

    class Minio:  # pragma: no cover - only used to allow test collection
        def __init__(self, *args, **kwargs):
            pass

        def get_object(self, *args, **kwargs):
            raise RuntimeError("MinIO SDK unavailable in this test environment")

        def put_object(self, *args, **kwargs):
            raise RuntimeError("MinIO SDK unavailable in this test environment")

    module.Minio = Minio
    sys.modules["minio"] = module
