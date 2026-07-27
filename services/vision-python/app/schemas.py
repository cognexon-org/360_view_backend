from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class JobType(StrEnum):
    PANORAMA_STITCH = "PANORAMA_STITCH"
    PANORAMA_QA = "PANORAMA_QA"
    PRIVACY_SCAN = "PRIVACY_SCAN"
    CAPTURE_VALIDATION = "CAPTURE_VALIDATION"
    ROOM_SHELL = "ROOM_SHELL"


class ProcessRequest(BaseModel):
    jobId: str = Field(min_length=1)
    type: JobType
    payload: dict[str, Any]


class ProcessResponse(BaseModel):
    success: bool
    output: dict[str, Any]
