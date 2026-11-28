
import csv
import json
import zipfile
from collections import defaultdict
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
STUDY = ROOT / "study_data"
RESULTS = ROOT / "evaluation" / "results" / "human_study"
GT_ZIP = STUDY / "study_ground_truth_12.zip"

# KITTI-derived class IDs:
# 0=car, 1=van, 2=truck, 3=pedestrian,
# 4=person_sitting, 5=cyclist, 6=tram, 7=misc
TARGET_CLASSES = {
    0: "car",
    2: "truck",
    3: "pedestrian",
}

IOU_THRESHOLD = 0.50
IGNORE_IOA_THRESHOLD = 0.50


def intersection(a, b):
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def iou(a, b):
    overlap = intersection(a, b)
    union = area(a) + area(b) - overlap
    return overlap / union if union > 0 else 0.0


def ioa(annotation, ignored_gt):
    annotation_area = area(annotation)
    return (
        intersection(annotation, ignored_gt) / annotation_area
        if annotation_area > 0
        else 0.0
    )


def read_ground_truth(archive, filename, width, height):
    target = []
    ignored = []

    text = archive.read(f"{Path(filename).stem}.txt").decode("utf-8")

    for line in text.splitlines():
        if not line.strip():
            continue

        values = line.split()
        if len(values) != 5:
            raise ValueError(f"Invalid GT row in {filename}: {line}")

        class_id = int(values[0])
        xc, yc, bw, bh = map(float, values[1:])

        box = [
            (xc - bw / 2) * width,
            (yc - bh / 2) * height,
            (xc + bw / 2) * width,
            (yc + bh / 2) * height,
        ]

        if class_id in TARGET_CLASSES:
            target.append({
                "label": TARGET_CLASSES[class_id],
                "box": box,
            })
        else:
            ignored.append(box)

    return target, ignored


def evaluate_image(predictions, targets, ignored):
    # One-to-one, class-aware greedy matching at IoU >= 0.50.
    candidates = []

    for pi, prediction in enumerate(predictions):
        for gi, target in enumerate(targets):
            if prediction["label"] != target["label"]:
                continue

            score = iou(prediction["box"], target["box"])

            if score >= IOU_THRESHOLD:
                candidates.append((score, pi, gi))

    candidates.sort(reverse=True)

    matched_predictions = set()
    matched_targets = set()
    matched_ious = []

    for score, pi, gi in candidates:
        if pi in matched_predictions or gi in matched_targets:
            continue

        matched_predictions.add(pi)
        matched_targets.add(gi)
        matched_ious.append(score)

    ignored_predictions = 0
    fp = 0

    for pi, prediction in enumerate(predictions):
        if pi in matched_predictions:
            continue

        if any(
            ioa(prediction["box"], gt_box) >= IGNORE_IOA_THRESHOLD
            for gt_box in ignored
        ):
            ignored_predictions += 1
        else:
            fp += 1

    return {
        "tp": len(matched_predictions),
        "fp": fp,
        "fn": len(targets) - len(matched_targets),
        "ignored_predictions": ignored_predictions,
        "matched_ious": matched_ious,
    }


def summarize(rows):
    tp = sum(row["tp"] for row in rows)
    fp = sum(row["fp"] for row in rows)
    fn = sum(row["fn"] for row in rows)

    precision = tp / (tp + fp) if tp + fp else 0
    recall = tp / (tp + fn) if tp + fn else 0

    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0
    )

    all_ious = [
        score
        for row in rows
        for score in row["matched_ious"]
    ]

    return {
        "trials": len(rows),
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "ignored_predictions": sum(
            row["ignored_predictions"] for row in rows
        ),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "mean_matched_iou": (
            round(sum(all_ious) / len(all_ious), 4)
            if all_ious
            else None
        ),
    }


def main():
    with (STUDY / "study_manifest_revised.csv").open(
        encoding="utf-8-sig", newline=""
    ) as file:
        manifest = list(csv.DictReader(file))

    annotations = json.loads(
        (RESULTS / "study_annotations.json").read_text(
            encoding="utf-8"
        )
    )

    with (RESULTS / "study_sessions.csv").open(
        encoding="utf-8-sig", newline=""
    ) as file:
        sessions = list(csv.DictReader(file))

    by_trial = defaultdict(list)

    for annotation in annotations:
        bbox = annotation["bbox"]

        by_trial[int(annotation["trial"])].append({
            "label": annotation["label"],
            "box": [
                bbox["x_min"],
                bbox["y_min"],
                bbox["x_max"],
                bbox["y_max"],
            ],
        })

    session_map = {
        int(session["trial"]): session
        for session in sessions
    }

    if len(manifest) != 12 or len(session_map) != 12:
        raise ValueError("Expected 12 study trials")

    results = []

    with zipfile.ZipFile(GT_ZIP) as archive:
        for record in manifest:
            trial = int(record["trial"])
            filename = record["image"]

            image_path = (
                STUDY / "study_images_revised_12" / filename
            )

            with Image.open(image_path) as image:
                width, height = image.size

            targets, ignored = read_ground_truth(
                archive, filename, width, height
            )

            predictions = by_trial[trial]
            session = session_map[trial]

            if session["mode"] != record["mode"]:
                raise ValueError(
                    f"Mode mismatch in trial {trial}"
                )

            if len(predictions) != int(
                session["saved_annotations"]
            ):
                raise ValueError(
                    f"Annotation count mismatch in trial {trial}"
                )

            metrics = evaluate_image(
                predictions, targets, ignored
            )

            results.append({
                "trial": trial,
                "mode": record["mode"],
                "image": filename,
                "gt_objects": len(targets),
                "saved_annotations": len(predictions),
                **metrics,
            })

    summary = {
        "manual": summarize([
            row for row in results
            if row["mode"] == "manual"
        ]),
        "ai_assisted": summarize([
            row for row in results
            if row["mode"] == "ai_assisted"
        ]),
        "evaluation_policy": {
            "matching": "Class-aware greedy one-to-one matching",
            "iou_threshold": IOU_THRESHOLD,
            "ignore_ioa_threshold": IGNORE_IOA_THRESHOLD,
            "target_classes": TARGET_CLASSES,
            "ignored_classes": [1, 4, 5, 6, 7],
            "note": (
                "Unmatched annotations substantially overlapping "
                "out-of-scope KITTI objects are excluded from FP. "
                "Matched IoU is computed for true positives only."
            ),
        },
    }

    output_json = RESULTS / "quality_summary.json"
    output_json.write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )

    output_csv = RESULTS / "quality_per_trial.csv"

    with output_csv.open(
        "w", encoding="utf-8", newline=""
    ) as file:
        fields = [
            "trial", "mode", "image", "gt_objects",
            "saved_annotations", "tp", "fp", "fn",
            "ignored_predictions",
        ]

        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()

        for row in results:
            writer.writerow({
                field: row[field] for field in fields
            })

    print("\nANNOTATION QUALITY EVALUATION")
    print("-" * 42)

    for mode in ("manual", "ai_assisted"):
        result = summary[mode]

        print(f"\n{mode.upper()}")
        print(
            f"TP={result['tp']} "
            f"FP={result['fp']} "
            f"FN={result['fn']}"
        )
        print(f"Precision: {result['precision']:.4f}")
        print(f"Recall:    {result['recall']:.4f}")
        print(f"F1:        {result['f1']:.4f}")
        print(f"Mean matched IoU: {result['mean_matched_iou']}")

    print("\nSaved:", output_json)
    print("Saved:", output_csv)


if __name__ == "__main__":
    main()
