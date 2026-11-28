
import argparse
import json
import math
import sys
import zipfile
from collections import Counter
from pathlib import Path


def validate(zip_path):
    errors = []
    warnings = []

    with zipfile.ZipFile(zip_path) as archive:
        members = set(archive.namelist())
        annotation_path = "annotations/instances.json"

        if annotation_path not in members:
            raise ValueError(f"Missing {annotation_path}")

        data = json.loads(archive.read(annotation_path))

        images = data.get("images", [])
        annotations = data.get("annotations", [])
        categories = data.get("categories", [])

        image_map = {}
        for image in images:
            image_id = image.get("id")
            filename = image.get("file_name")

            if image_id in image_map:
                errors.append(f"Duplicate image ID: {image_id}")

            image_map[image_id] = image

            if not isinstance(filename, str):
                errors.append(f"Invalid filename: {filename}")
                continue

            normalized = filename.lstrip("./")
            possible_paths = {
                normalized,
                f"images/{normalized}",
            }

            if not any(path in members for path in possible_paths):
                errors.append(f"Missing image: {filename}")

            if not isinstance(image.get("width"), (int, float)) or image["width"] <= 0:
                errors.append(f"Invalid width: {image_id}")

            if not isinstance(image.get("height"), (int, float)) or image["height"] <= 0:
                errors.append(f"Invalid height: {image_id}")

        category_ids = [category.get("id") for category in categories]
        if len(category_ids) != len(set(category_ids)):
            errors.append("Duplicate category IDs")

        valid_categories = set(category_ids)
        annotation_ids = set()
        duplicate_boxes = Counter()

        for ann in annotations:
            ann_id = ann.get("id")

            if ann_id in annotation_ids:
                errors.append(f"Duplicate annotation ID: {ann_id}")
            annotation_ids.add(ann_id)

            image_id = ann.get("image_id")
            category_id = ann.get("category_id")

            if image_id not in image_map:
                errors.append(f"Unknown image ID: {image_id}")
                continue

            if category_id not in valid_categories:
                errors.append(f"Unknown category ID: {category_id}")

            bbox = ann.get("bbox")

            if not isinstance(bbox, list) or len(bbox) != 4:
                errors.append(f"Invalid bbox: annotation {ann_id}")
                continue

            if not all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
                for value in bbox
            ):
                errors.append(f"Non-numeric bbox: annotation {ann_id}")
                continue

            x, y, w, h = bbox
            image = image_map[image_id]
            width = image.get("width")
            height = image.get("height")

            if w <= 0 or h <= 0:
                errors.append(f"Non-positive bbox: annotation {ann_id}")
                continue

            if (
                isinstance(width, (int, float))
                and isinstance(height, (int, float))
                and (x < 0 or y < 0 or x + w > width + 1e-4 or y + h > height + 1e-4)
            ):
                errors.append(f"Out-of-bounds bbox: annotation {ann_id}")

            duplicate_boxes[
                (image_id, category_id, tuple(round(v, 2) for v in bbox))
            ] += 1

        for key, count in duplicate_boxes.items():
            if count > 1:
                warnings.append(
                    f"Duplicate annotation candidate: {key}, count={count}"
                )

        image_filenames = [img.get("file_name") for img in images]
        if len(image_filenames) != len(set(image_filenames)):
            warnings.append("Repeated image filenames")

        print("\nCOCO DATASET VALIDATION")
        print("-" * 36)
        print(f"ZIP: {zip_path}")
        print(f"Images: {len(images)}")
        print(f"Annotations: {len(annotations)}")
        print(f"Categories: {len(categories)}")
        print(f"Errors: {len(errors)}")
        print(f"Warnings: {len(warnings)}")

        for error in errors[:20]:
            print(f"ERROR: {error}")

        for warning in warnings[:20]:
            print(f"WARNING: {warning}")

        return not errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("zip_path", type=Path)
    args = parser.parse_args()

    try:
        valid = validate(args.zip_path)
        sys.exit(0 if valid else 1)
    except (OSError, ValueError, zipfile.BadZipFile, json.JSONDecodeError) as exc:
        print(f"Validation failed: {exc}")
        sys.exit(1)
