
import hashlib
import json
import zipfile
from collections import defaultdict
from pathlib import Path

backup = Path(r"C:\Users\admin\AI_Vision_Backup")

datasets = {
    "Food": backup / "Food_Annotation_COCO.zip",
    "Office": backup / "project_293a0d2c-1279-47cc-a099-999b77e487f3_coco.zip",
    "Stationery": backup / "project_f94aafe1-6a3a-4c21-aed1-2ac227deec6a_coco.zip",
}

for name, path in datasets.items():
    with zipfile.ZipFile(path) as archive:
        data = json.loads(archive.read("annotations/instances.json"))
        groups = defaultdict(list)

        for image in data["images"]:
            filename = image["file_name"].lstrip("./")
            archive_path = (
                filename if filename.startswith("images/")
                else f"images/{filename}"
            )

            digest = hashlib.sha256(
                archive.read(archive_path)
            ).hexdigest()

            count = sum(
                ann["image_id"] == image["id"]
                for ann in data["annotations"]
            )

            groups[digest].append((image["id"], count))

        print(f"\n{name}:")
        print("Images:", len(data["images"]))
        print("Unique image contents:", len(groups))
        print("Annotations:", len(data["annotations"]))

        for entries in groups.values():
            if len(entries) > 1:
                print("Duplicate image group:", entries)
