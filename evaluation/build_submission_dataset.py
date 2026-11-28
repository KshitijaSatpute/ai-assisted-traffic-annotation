
import hashlib
import io
import json
import zipfile
from pathlib import Path

BACKUP = Path(r"C:\Users\admin\AI_Vision_Backup")
OUTPUT = BACKUP / "Labelix_AI_Final_Dataset.zip"

SOURCES = {
    "food": BACKUP / "Food_Annotation_COCO.zip",
    "office": BACKUP / "project_293a0d2c-1279-47cc-a099-999b77e487f3_coco.zip",
    "stationery": BACKUP / "project_f94aafe1-6a3a-4c21-aed1-2ac227deec6a_coco.zip",
}

combined = {
    "images": [],
    "annotations": [],
    "categories": [],
}

category_map = {}
image_contents = {}
next_image_id = 1
next_annotation_id = 1

for project, zip_path in SOURCES.items():
    with zipfile.ZipFile(zip_path) as archive:
        data = json.loads(archive.read("annotations/instances.json"))

        source_categories = {
            category["id"]: category["name"]
            for category in data["categories"]
        }

        for name in source_categories.values():
            if name not in category_map:
                category_id = len(category_map) + 1
                category_map[name] = category_id
                combined["categories"].append({
                    "id": category_id,
                    "name": name,
                    "supercategory": "object",
                })

        annotations_by_image = {}

        for ann in data["annotations"]:
            annotations_by_image.setdefault(
                ann["image_id"], []
            ).append(ann)

        seen_hashes = set()

        for image in data["images"]:
            filename = image["file_name"].lstrip("./")
            source_path = (
                filename if filename.startswith("images/")
                else f"images/{filename}"
            )

            content = archive.read(source_path)
            digest = hashlib.sha256(content).hexdigest()

            if digest in seen_hashes:
                if annotations_by_image.get(image["id"]):
                    raise ValueError(
                        f"Duplicate annotated image in {project}"
                    )
                continue

            seen_hashes.add(digest)

            new_image_id = next_image_id
            next_image_id += 1

            suffix = Path(filename).suffix.lower()
            new_filename = (
                f"{project}_{new_image_id}{suffix}"
            )

            combined["images"].append({
                "id": new_image_id,
                "file_name": new_filename,
                "width": image["width"],
                "height": image["height"],
            })

            image_contents[
                f"images/{new_filename}"
            ] = content

            for ann in annotations_by_image.get(image["id"], []):
                new_ann = dict(ann)
                new_ann["id"] = next_annotation_id
                new_ann["image_id"] = new_image_id

                old_name = source_categories[ann["category_id"]]
                new_ann["category_id"] = category_map[old_name]

                combined["annotations"].append(new_ann)
                next_annotation_id += 1

with zipfile.ZipFile(
    OUTPUT, "w", zipfile.ZIP_DEFLATED
) as output:
    output.writestr(
        "annotations/instances.json",
        json.dumps(combined, indent=2),
    )

    for path, content in image_contents.items():
        output.writestr(path, content)

print("Created:", OUTPUT)
print("Images:", len(combined["images"]))
print("Annotations:", len(combined["annotations"]))
print("Categories:", len(combined["categories"]))
print("Category names:", sorted(category_map))
