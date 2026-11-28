
import io
import json
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from PIL import Image

from backend.main import DB_PATH, UPLOAD_DIR, SavedAnnotation
from backend.projects import get_db, validate_project_id, require_project

router = APIRouter(tags=["Project Export"])


@router.get("/projects/{project_id}/export/coco")
def export_project_coco(project_id: str):
    project_id = validate_project_id(project_id)

    with get_db() as db:
        project = require_project(db, project_id)

        labels = [
            row["label"]
            for row in db.execute(
                """
                SELECT label FROM project_labels
                WHERE project_id = ?
                ORDER BY label
                """,
                (project_id,),
            ).fetchall()
        ]

        image_rows = db.execute(
            """
            SELECT pi.image_id, ia.annotations_json
            FROM project_images AS pi
            LEFT JOIN image_annotations AS ia
                ON pi.image_id = ia.image_id
            WHERE pi.project_id = ?
            ORDER BY pi.image_id
            """,
            (project_id,),
        ).fetchall()

    category_ids = {
        label: index
        for index, label in enumerate(labels, start=1)
    }

    coco = {
        "images": [],
        "annotations": [],
        "categories": [
            {
                "id": category_ids[label],
                "name": label,
                "supercategory": "object",
            }
            for label in labels
        ],
    }

    archive_buffer = io.BytesIO()

    with zipfile.ZipFile(
        archive_buffer, "w", zipfile.ZIP_DEFLATED
    ) as archive:

        for image_number, row in enumerate(image_rows, start=1):
            image_id = row["image_id"]

            image_path = next(
                (
                    UPLOAD_DIR / f"{image_id}{extension}"
                    for extension in (".jpg", ".png")
                    if (UPLOAD_DIR / f"{image_id}{extension}").is_file()
                ),
                None,
            )

            if image_path is None:
                raise HTTPException(
                    status_code=409,
                    detail=f"Missing image: {image_id}",
                )

            with Image.open(image_path) as image:
                width, height = image.size

            filename = image_path.name

            coco["images"].append({
                "id": image_number,
                "file_name": filename,
                "width": width,
                "height": height,
            })

            archive.write(
                image_path,
                arcname=f"images/{filename}",
            )

            saved_annotations = json.loads(
                row["annotations_json"] or "[]"
            )

            for raw_annotation in saved_annotations:
                annotation = SavedAnnotation.model_validate(
                    raw_annotation
                )

                if annotation.image_id != image_id:
                    raise HTTPException(
                        status_code=409,
                        detail="Annotation image mismatch",
                    )

                if annotation.label not in category_ids:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "Annotation uses a label outside "
                            "this project's label set"
                        ),
                    )

                box = annotation.bbox
                box_width = box.x_max - box.x_min
                box_height = box.y_max - box.y_min

                if box.x_max > width or box.y_max > height:
                    raise HTTPException(
                        status_code=409,
                        detail="Annotation exceeds image dimensions",
                    )

                coco["annotations"].append({
                    "id": len(coco["annotations"]) + 1,
                    "image_id": image_number,
                    "category_id": category_ids[annotation.label],
                    "bbox": [
                        box.x_min,
                        box.y_min,
                        box_width,
                        box_height,
                    ],
                    "area": box_width * box_height,
                    "segmentation": [],
                    "iscrowd": 0,
                    "attributes": {
                        "source": annotation.source,
                        "confidence": annotation.confidence,
                    },
                })

        archive.writestr(
            "annotations/instances.json",
            json.dumps(coco, indent=2),
        )

    return Response(
        content=archive_buffer.getvalue(),
        media_type="application/zip",
        headers={
            "Content-Disposition":
                f'attachment; filename="project_{project_id}_coco.zip"'
        },
    )
