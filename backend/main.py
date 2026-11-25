
from pathlib import Path
from uuid import uuid4
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError

app = FastAPI(
    title="AI-Assisted Traffic Annotation API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)

UPLOAD_DIR = Path(__file__).resolve().parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_FILE_SIZE = 10 * 1024 * 1024
ALLOWED_FORMATS = {"JPEG": ".jpg", "PNG": ".png"}


class BoundingBox(BaseModel):
    x_min: float = Field(ge=0)
    y_min: float = Field(ge=0)
    x_max: float = Field(ge=0)
    y_max: float = Field(ge=0)



class Annotation(BaseModel):
    annotation_id: str
    image_id: str
    label: Literal["car", "truck", "pedestrian"]
    bbox: BoundingBox
    source: Literal["manual", "ai", "ai_accepted", "ai_edited"]
    confidence: float | None = Field(default=None, ge=0, le=1)


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "service": "traffic-annotation-backend",
        "version": "0.1.0",
    }


@app.post("/images/upload", status_code=201)
async def upload_image(file: UploadFile = File(...)):
    if file.content_type not in {"image/jpeg", "image/png"}:
        raise HTTPException(
            status_code=415,
            detail="Only JPEG and PNG images are supported",
        )

    content = await file.read(MAX_FILE_SIZE + 1)
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="Image exceeds the 10 MB limit",
        )

    from io import BytesIO

    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()

        with Image.open(BytesIO(content)) as image:
            image_format = image.format
            width, height = image.size

    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(
            status_code=422,
            detail="Invalid or corrupted image",
        )

    if image_format not in ALLOWED_FORMATS:
        raise HTTPException(
            status_code=415,
            detail="Unsupported image format",
        )

    image_id = str(uuid4())
    filename = image_id + ALLOWED_FORMATS[image_format]
    (UPLOAD_DIR / filename).write_bytes(content)

    return {
        "image_id": image_id,
        "filename": filename,
        "width": width,
        "height": height,
        "image_url": f"/images/{image_id}",
    }


@app.get("/images/{image_id}")
def get_image(image_id: str):
    for extension in (".jpg", ".png"):
        path = UPLOAD_DIR / f"{image_id}{extension}"
        if path.is_file():
            return FileResponse(path)

    raise HTTPException(status_code=404, detail="Image not found")


import json
import sqlite3
from uuid import UUID

from fastapi import Body
from pydantic import model_validator


DB_PATH = Path(__file__).resolve().parent / "data" / "annotations.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)


def get_db():
    return sqlite3.connect(DB_PATH, timeout=10)


with get_db() as connection:
    connection.execute("""
        CREATE TABLE IF NOT EXISTS image_annotations (
            image_id TEXT PRIMARY KEY,
            annotations_json TEXT NOT NULL
        )
    """)


class SavedAnnotation(Annotation):
    @model_validator(mode="after")
    def validate_box(self):
        box = self.bbox
        if box.x_max <= box.x_min or box.y_max <= box.y_min:
            raise ValueError("Bounding box must have positive area")
        return self


def validate_image(image_id: str):
    try:
        canonical_id = str(UUID(image_id))
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="Invalid image ID",
        )

    for extension in (".jpg", ".png"):
        image_path = UPLOAD_DIR / f"{canonical_id}{extension}"
        if image_path.is_file():
            with Image.open(image_path) as image:
                return canonical_id, image.size

    raise HTTPException(
        status_code=404,
        detail="Image not found",
    )


@app.put("/images/{image_id}/annotations")
def save_annotations(
    image_id: str,
    annotations: list[SavedAnnotation] = Body(...),
):
    canonical_id, (width, height) = validate_image(image_id)

    for annotation in annotations:
        if annotation.image_id != canonical_id:
            raise HTTPException(
                status_code=422,
                detail="Annotation image_id does not match URL",
            )

        box = annotation.bbox

        if box.x_max > width or box.y_max > height:
            raise HTTPException(
                status_code=422,
                detail="Bounding box exceeds image dimensions",
            )

    payload = json.dumps(
        [annotation.model_dump() for annotation in annotations]
    )

    with get_db() as connection:
        connection.execute(
            """
            INSERT INTO image_annotations (image_id, annotations_json)
            VALUES (?, ?)
            ON CONFLICT(image_id)
            DO UPDATE SET annotations_json = excluded.annotations_json
            """,
            (canonical_id, payload),
        )

    return {
        "image_id": canonical_id,
        "saved_count": len(annotations),
        "status": "saved",
    }


@app.get("/images/{image_id}/annotations")
def load_annotations(image_id: str):
    canonical_id, _ = validate_image(image_id)

    with get_db() as connection:
        row = connection.execute(
            """
            SELECT annotations_json
            FROM image_annotations
            WHERE image_id = ?
            """,
            (canonical_id,),
        ).fetchone()

    return {
        "image_id": canonical_id,
        "annotations": json.loads(row[0]) if row else [],
    }

# ---------------------------------------------------------
# YOLO11n AI suggestion endpoint
# ---------------------------------------------------------

from functools import lru_cache
from threading import Lock
from time import perf_counter

from fastapi import Query
from ultralytics import YOLO


MODEL_PATH = Path(__file__).resolve().parent.parent / "yolo11n.pt"

COCO_TO_APP_LABEL = {
    0: "pedestrian",
    2: "car",
    7: "truck",
}

MODEL_LOCK = Lock()


@lru_cache(maxsize=1)
def get_yolo_model():
    if not MODEL_PATH.is_file():
        raise HTTPException(
            status_code=503,
            detail="YOLO11n weights not found. Expected yolo11n.pt in project root.",
        )

    return YOLO(str(MODEL_PATH))


@app.post("/images/{image_id}/predict")
def predict_image(
    image_id: str,
    conf: float = Query(default=0.25, ge=0.01, le=1.0),
):
    canonical_id, (width, height) = validate_image(image_id)

    image_path = None

    for extension in (".jpg", ".png"):
        candidate = UPLOAD_DIR / f"{canonical_id}{extension}"

        if candidate.is_file():
            image_path = candidate
            break

    if image_path is None:
        raise HTTPException(
            status_code=404,
            detail="Image not found",
        )

    model = get_yolo_model()

    try:
        start = perf_counter()

        # Serialize access to the shared YOLO model.
        with MODEL_LOCK:
            results = model.predict(
                source=str(image_path),
                conf=conf,
                classes=list(COCO_TO_APP_LABEL.keys()),
                device="cpu",
                verbose=False,
            )

        inference_ms = round(
            (perf_counter() - start) * 1000,
            2,
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Model inference failed: {type(exc).__name__}",
        ) from exc

    predictions = []

    for box in results[0].boxes:
        class_id = int(box.cls.item())

        if class_id not in COCO_TO_APP_LABEL:
            continue

        x_min, y_min, x_max, y_max = (
            box.xyxy[0].cpu().tolist()
        )

        # Keep coordinates within the original image.
        x_min = max(0.0, min(float(x_min), width))
        y_min = max(0.0, min(float(y_min), height))
        x_max = max(0.0, min(float(x_max), width))
        y_max = max(0.0, min(float(y_max), height))

        if x_max <= x_min or y_max <= y_min:
            continue

        predictions.append({
            "prediction_id": str(uuid4()),
            "label": COCO_TO_APP_LABEL[class_id],
            "confidence": round(
                float(box.conf.item()), 6
            ),
            "bbox": {
                "x_min": x_min,
                "y_min": y_min,
                "x_max": x_max,
                "y_max": y_max,
            },
        })

    return {
        "image_id": canonical_id,
        "model": "yolo11n",
        "confidence_threshold": conf,
        "inference_ms": inference_ms,
        "prediction_count": len(predictions),
        "predictions": predictions,
    }

# ---------------------------------------------------------
# Annotation study: session and correction-event storage
# ---------------------------------------------------------

def initialize_study_tables():
    with get_db() as connection:
        connection.execute("PRAGMA foreign_keys = ON")

        connection.execute("""
            CREATE TABLE IF NOT EXISTS annotation_sessions (
                session_id TEXT PRIMARY KEY,
                image_id TEXT NOT NULL,
                mode TEXT NOT NULL
                    CHECK (mode IN ('manual', 'ai_assisted')),
                started_at TEXT NOT NULL,
                finished_at TEXT,
                active_duration_ms INTEGER,
                inference_ms REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed'))
            )
        """)

        connection.execute("""
            CREATE TABLE IF NOT EXISTS annotation_events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                annotation_id TEXT,
                event_type TEXT NOT NULL
                    CHECK (
                        event_type IN (
                            'manual_add',
                            'ai_accept',
                            'ai_edit',
                            'ai_reject',
                            'delete'
                        )
                    ),
                created_at TEXT NOT NULL,
                details_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (session_id)
                    REFERENCES annotation_sessions(session_id)
            )
        """)

        connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_session
            ON annotation_events(session_id)
        """)


initialize_study_tables()

# ---------------------------------------------------------
# Annotation study API
# ---------------------------------------------------------

from datetime import datetime, timezone


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class StartSessionRequest(BaseModel):
    image_id: str
    mode: Literal["manual", "ai_assisted"]


class AnnotationEventRequest(BaseModel):
    event_type: Literal[
        "manual_add",
        "ai_accept",
        "ai_edit",
        "ai_reject",
        "delete",
    ]
    annotation_id: str | None = None
    details: dict = Field(default_factory=dict)


class FinishSessionRequest(BaseModel):
    active_duration_ms: int = Field(ge=0)
    inference_ms: float = Field(default=0, ge=0)


@app.post("/sessions/start", status_code=201)
def start_annotation_session(payload: StartSessionRequest):
    canonical_id, _ = validate_image(payload.image_id)
    session_id = str(uuid4())

    with get_db() as connection:
        connection.execute(
            """
            INSERT INTO annotation_sessions
                (session_id, image_id, mode, started_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                session_id,
                canonical_id,
                payload.mode,
                utc_now(),
            ),
        )

    return {
        "session_id": session_id,
        "image_id": canonical_id,
        "mode": payload.mode,
        "status": "active",
    }


@app.post("/sessions/{session_id}/events", status_code=201)
def record_annotation_event(
    session_id: str,
    payload: AnnotationEventRequest,
):
    with get_db() as connection:
        session = connection.execute(
            """
            SELECT status
            FROM annotation_sessions
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()

        if not session:
            raise HTTPException(
                status_code=404,
                detail="Session not found",
            )

        if session[0] != "active":
            raise HTTPException(
                status_code=409,
                detail="Cannot add events to a completed session",
            )

        event_id = str(uuid4())

        connection.execute(
            """
            INSERT INTO annotation_events
                (
                    event_id,
                    session_id,
                    annotation_id,
                    event_type,
                    created_at,
                    details_json
                )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                session_id,
                payload.annotation_id,
                payload.event_type,
                utc_now(),
                json.dumps(payload.details),
            ),
        )

    return {
        "event_id": event_id,
        "session_id": session_id,
        "event_type": payload.event_type,
        "status": "recorded",
    }


@app.post("/sessions/{session_id}/finish")
def finish_annotation_session(
    session_id: str,
    payload: FinishSessionRequest,
):
    with get_db() as connection:
        result = connection.execute(
            """
            UPDATE annotation_sessions
            SET
                finished_at = ?,
                active_duration_ms = ?,
                inference_ms = ?,
                status = 'completed'
            WHERE session_id = ?
              AND status = 'active'
            """,
            (
                utc_now(),
                payload.active_duration_ms,
                payload.inference_ms,
                session_id,
            ),
        )

        if result.rowcount == 0:
            raise HTTPException(
                status_code=404,
                detail="Active session not found",
            )

    return {
        "session_id": session_id,
        "status": "completed",
        "active_duration_ms": payload.active_duration_ms,
        "inference_ms": payload.inference_ms,
    }


@app.get("/sessions/{session_id}")
def get_annotation_session(session_id: str):
    with get_db() as connection:
        connection.row_factory = sqlite3.Row

        session = connection.execute(
            """
            SELECT *
            FROM annotation_sessions
            WHERE session_id = ?
            """,
            (session_id,),
        ).fetchone()

        if session is None:
            raise HTTPException(
                status_code=404,
                detail="Session not found",
            )

        events = connection.execute(
            """
            SELECT
                event_id,
                annotation_id,
                event_type,
                created_at,
                details_json
            FROM annotation_events
            WHERE session_id = ?
            ORDER BY created_at, event_id
            """,
            (session_id,),
        ).fetchall()

    event_list = [
        {
            "event_id": row["event_id"],
            "annotation_id": row["annotation_id"],
            "event_type": row["event_type"],
            "created_at": row["created_at"],
            "details": json.loads(row["details_json"]),
        }
        for row in events
    ]

    event_counts = {
        event_type: sum(
            event["event_type"] == event_type
            for event in event_list
        )
        for event_type in [
            "manual_add",
            "ai_accept",
            "ai_edit",
            "ai_reject",
            "delete",
        ]
    }

    return {
        "session": dict(session),
        "event_counts": event_counts,
        "events": event_list,
    }
