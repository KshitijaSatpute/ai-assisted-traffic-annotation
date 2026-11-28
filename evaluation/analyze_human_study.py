
import csv
import json
import statistics
from collections import Counter
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATA = BASE / "results" / "human_study"
OUTPUT = DATA / "analysis_summary.json"


def mean(values):
    return statistics.mean(values)


def summarize(rows):
    times = [r["active_seconds"] for r in rows]
    wall_times = [r["wall_seconds"] for r in rows]

    return {
        "trials": len(rows),
        "total_annotations": sum(r["saved_annotations"] for r in rows),
        "mean_active_seconds": round(mean(times), 3),
        "median_active_seconds": round(statistics.median(times), 3),
        "mean_wall_seconds": round(mean(wall_times), 3),
        "median_wall_seconds": round(statistics.median(wall_times), 3),
        "min_active_seconds": round(min(times), 3),
        "max_active_seconds": round(max(times), 3),
        "annotations_per_active_minute": round(
            60 * sum(r["saved_annotations"] for r in rows)
            / sum(times),
            3,
        ),
    }


def main():
    with (DATA / "study_sessions.csv").open(
        encoding="utf-8-sig", newline=""
    ) as file:
        raw = list(csv.DictReader(file))

    with (DATA / "study_annotations.json").open(
        encoding="utf-8"
    ) as file:
        annotations = json.load(file)

    rows = []

    for r in raw:
        if r["status"] != "completed":
            raise ValueError(f"Incomplete trial: {r['trial']}")

        active = float(r["active_duration_ms"]) / 1000
        inference = float(r["inference_ms"]) / 1000

        rows.append({
            "trial": int(r["trial"]),
            "mode": r["mode"],
            "active_seconds": active,
            "inference_seconds": inference,
            "wall_seconds": active + inference,
            "saved_annotations": int(r["saved_annotations"]),
        })

    if len(rows) != 12:
        raise ValueError(f"Expected 12 trials, found {len(rows)}")

    manual = [r for r in rows if r["mode"] == "manual"]
    assisted = [r for r in rows if r["mode"] == "ai_assisted"]

    if len(manual) != 6 or len(assisted) != 6:
        raise ValueError("Expected 6 manual and 6 AI-assisted trials")

    counts = Counter(a["trial"] for a in annotations)

    for r in rows:
        actual = counts[r["trial"]]
        expected = r["saved_annotations"]

        if actual != expected:
            raise ValueError(
                f"Trial {r['trial']}: "
                f"CSV={expected}, JSON={actual}"
            )

    m = summarize(manual)
    a = summarize(assisted)

    mean_change = 100 * (
        m["mean_active_seconds"] - a["mean_active_seconds"]
    ) / m["mean_active_seconds"]

    median_change = 100 * (
        m["median_active_seconds"] - a["median_active_seconds"]
    ) / m["median_active_seconds"]

    # Sensitivity analysis: remove the longest manual trial only.
    longest_manual = max(
        manual, key=lambda r: r["active_seconds"]
    )
    manual_without_outlier = [
        r for r in manual
        if r["trial"] != longest_manual["trial"]
    ]

    sensitivity_change = 100 * (
        mean(r["active_seconds"] for r in manual_without_outlier)
        - a["mean_active_seconds"]
    ) / mean(r["active_seconds"] for r in manual_without_outlier)

    summary = {
        "manual": m,
        "ai_assisted": a,
        "mean_active_time_reduction_percent": round(
            mean_change, 2
        ),
        "median_active_time_reduction_percent": round(
            median_change, 2
        ),
        "outlier_sensitivity": {
            "excluded_manual_trial": longest_manual["trial"],
            "excluded_duration_seconds": longest_manual[
                "active_seconds"
            ],
            "remaining_manual_trials": len(
                manual_without_outlier
            ),
            "mean_time_reduction_percent": round(
                sensitivity_change, 2
            ),
        },
        "methodology": {
            "design": "Single annotator, 12 trials, 6 per mode",
            "timing": (
                "Active time excludes model inference; "
                "wall time adds recorded inference time"
            ),
            "limitations": [
                "Different images across conditions",
                "Small sample size",
                "Possible image-difficulty imbalance",
                "Possible learning and order effects",
                "Annotation quality not evaluated here",
                "Outlier sensitivity",
            ],
        },
    }

    OUTPUT.write_text(
        json.dumps(summary, indent=2),
        encoding="utf-8",
    )

    print("\nHUMAN STUDY ANALYSIS")
    print("-" * 42)
    print(f"Trials: {len(rows)}")
    print(f"Saved annotations: {len(annotations)}")

    for name, result in [
        ("Manual", m),
        ("AI-assisted", a),
    ]:
        print(f"\n{name}:")
        print(f"  Mean active time: {result['mean_active_seconds']} s")
        print(f"  Median active time: {result['median_active_seconds']} s")
        print(f"  Mean wall time: {result['mean_wall_seconds']} s")
        print(
            "  Annotations/min: "
            f"{result['annotations_per_active_minute']}"
        )

    print(f"\nMean time reduction: {mean_change:.2f}%")
    print(f"Median time reduction: {median_change:.2f}%")
    print(
        f"Without manual trial {longest_manual['trial']}: "
        f"{sensitivity_change:.2f}%"
    )
    print(f"\nSaved: {OUTPUT}")


if __name__ == "__main__":
    main()
