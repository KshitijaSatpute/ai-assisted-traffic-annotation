
from functools import lru_cache
from pathlib import Path
from threading import Lock
from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query
from ultralytics import YOLOWorld

from backend.main import validate_image, UPLOAD_DIR, get_db

router = APIRouter(tags=["Generalized AI"])

MODEL_PATH = (
    Path(__file__).resolve().parent.parent
    / "models"
    / "yolov8s-worldv2.pt"
)

MODEL_LOCK = Lock()


@lru_cache(maxsize=1)
def get_model():
    if not MODEL_PATH.is_file():
        raise HTTPException(
            status_code=503,
            detail="YOLO-World model weights not found.",
        )

    return YOLOWorld(str(MODEL_PATH))


@router.post("/projects/{project_id}/images/{image_id}/predict")
def predict_project_image(
    project_id: str,
    image_id: str,
    conf: float = Query(default=0.25, ge=0.01, le=1.0),
):
    canonical_id, (width, height) = validate_image(image_id)

    with get_db() as db:
        association = db.execute(
            """
            SELECT 1
            FROM project_images
            WHERE project_id = ? AND image_id = ?
            """,
            (project_id, canonical_id),
        ).fetchone()

        if association is None:
            raise HTTPException(
                status_code=404,
                detail="Image not found in this project.",
            )

        labels = [
            row[0]
            for row in db.execute(
                """
                SELECT label
                FROM project_labels
                WHERE project_id = ?
                ORDER BY label
                """,
                (project_id,),
            ).fetchall()
        ]

    if not labels:
        raise HTTPException(
            status_code=422,
            detail="Add project labels before AI prediction.",
        )

    image_path = next(
        (
            UPLOAD_DIR / f"{canonical_id}{ext}"
            for ext in (".jpg", ".png")
            if (UPLOAD_DIR / f"{canonical_id}{ext}").is_file()
        ),
        None,
    )

    if image_path is None:
        raise HTTPException(
            status_code=404,
            detail="Image file not found.",
        )

    model = get_model()

    try:
        start = perf_counter()

        with MODEL_LOCK:
            model.set_classes(labels)

            results = model.predict(
                source=str(image_path),
                conf=conf,
                device="cpu",
                verbose=False,
            )

        inference_ms = round(
            (perf_counter() - start) * 1000, 2
        )

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"AI prediction failed: {type(exc).__name__}",
        ) from exc

    predictions = []

    for box in results[0].boxes:
        class_id = int(box.cls.item())

        if class_id < 0 or class_id >= len(labels):
            continue

        x_min, y_min, x_max, y_max = box.xyxy[0].cpu().tolist()

        x_min = max(0.0, min(float(x_min), width))
        y_min = max(0.0, min(float(y_min), height))
        x_max = max(0.0, min(float(x_max), width))
        y_max = max(0.0, min(float(y_max), height))

        if x_max <= x_min or y_max <= y_min:
            continue

        predictions.append({
            "prediction_id": str(uuid4()),
            "label": labels[class_id],
            "confidence": round(float(box.conf.item()), 6),
            "bbox": {
                "x_min": x_min,
                "y_min": y_min,
                "x_max": x_max,
                "y_max": y_max,
            },
        })

    return {
        "image_id": canonical_id,
        "project_id": project_id,
        "model": "yolov8s-worldv2",
        "labels": labels,
        "confidence_threshold": conf,
        "inference_ms": inference_ms,
        "prediction_count": len(predictions),
        "predictions": predictions,
    }
