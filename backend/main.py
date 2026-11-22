
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
    source: Literal["manual", "ai"]
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
