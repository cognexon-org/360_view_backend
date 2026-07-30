import logging

from fastapi import FastAPI, Header, HTTPException

from .config import settings
from .processors.capture_validation import validate_capture
from .processors.panorama import analyze_panorama
from .processors.privacy import scan_privacy
from .processors.room_shell import generate_room_shell
from .processors.stitch import stitch_panorama
from .schemas import JobType, ProcessRequest, ProcessResponse

logging.basicConfig(level=settings.log_level.upper())
logger = logging.getLogger("propertytour360-vision")

app = FastAPI(title="PropertyTour360 Vision Service", version="1.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/process", response_model=ProcessResponse)
def process(request: ProcessRequest, x_vision_secret: str = Header(default="")) -> ProcessResponse:
    if x_vision_secret != settings.vision_shared_secret:
        raise HTTPException(status_code=401, detail="Invalid service secret")

    logger.info("Processing job %s of type %s", request.jobId, request.type)
    try:
        if request.type == JobType.PANORAMA_STITCH:
            output = stitch_panorama(request.payload)
        elif request.type == JobType.PANORAMA_QA:
            output = analyze_panorama(request.payload)
        elif request.type == JobType.PRIVACY_SCAN:
            output = scan_privacy(request.payload)
        elif request.type == JobType.CAPTURE_VALIDATION:
            output = validate_capture(request.payload)
        elif request.type == JobType.ROOM_SHELL:
            output = generate_room_shell(request.payload)
        else:
            raise ValueError(f"Unsupported job type: {request.type}")
        return ProcessResponse(success=True, output=output)
    except Exception as exc:
        logger.exception("Job %s failed", request.jobId)
        raise HTTPException(status_code=422, detail=str(exc)) from exc
