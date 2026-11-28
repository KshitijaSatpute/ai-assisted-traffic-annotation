
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")

import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "evaluation" / "results" / "human_study"
FIGURES = RESULTS / "figures"
FIGURES.mkdir(parents=True, exist_ok=True)

with (RESULTS / "study_sessions.csv").open(
    encoding="utf-8-sig", newline=""
) as file:
    sessions = list(csv.DictReader(file))

timing = json.loads(
    (RESULTS / "analysis_summary.json").read_text(encoding="utf-8")
)
quality = json.loads(
    (RESULTS / "quality_summary.json").read_text(encoding="utf-8")
)

manual_color = "#647d70"
ai_color = "#d49a49"

plt.rcParams.update({
    "figure.dpi": 130,
    "savefig.dpi": 200,
    "font.size": 11,
    "axes.spines.top": False,
    "axes.spines.right": False,
})


def save(name):
    plt.tight_layout()
    plt.savefig(FIGURES / name, bbox_inches="tight")
    plt.close()
    print("Saved:", name)


# Figure 1: Mean vs median timing.
fig, ax = plt.subplots(figsize=(8, 5))
labels = ["Mean active time", "Median active time"]
manual = [
    timing["manual"]["mean_active_seconds"],
    timing["manual"]["median_active_seconds"],
]
assisted = [
    timing["ai_assisted"]["mean_active_seconds"],
    timing["ai_assisted"]["median_active_seconds"],
]

positions = range(len(labels))
width = 0.34

ax.bar(
    [x - width / 2 for x in positions],
    manual,
    width,
    label="Manual",
    color=manual_color,
)
ax.bar(
    [x + width / 2 for x in positions],
    assisted,
    width,
    label="AI-assisted",
    color=ai_color,
)

ax.set_xticks(list(positions), labels)
ax.set_ylabel("Active annotation time (seconds)")
ax.set_title("Annotation time: mean vs median")
ax.legend()
save("01_time_comparison.png")


# Figure 2: Individual trial durations.
fig, ax = plt.subplots(figsize=(10, 5))
sessions.sort(key=lambda row: int(row["trial"]))

trial_numbers = [int(row["trial"]) for row in sessions]
seconds = [
    float(row["active_duration_ms"]) / 1000
    for row in sessions
]
colors = [
    manual_color if row["mode"] == "manual" else ai_color
    for row in sessions
]

ax.bar(trial_numbers, seconds, color=colors)
ax.set_xticks(trial_numbers)
ax.set_xlabel("Trial number")
ax.set_ylabel("Active annotation time (seconds)")
ax.set_title("Per-trial annotation time (Trial 4 is an outlier)")
save("02_trial_durations.png")


# Figure 3: Precision, recall and F1.
fig, ax = plt.subplots(figsize=(8, 5))
metrics = ["precision", "recall", "f1"]

m = [quality["manual"][key] for key in metrics]
a = [quality["ai_assisted"][key] for key in metrics]

positions = range(len(metrics))

ax.bar(
    [x - width / 2 for x in positions],
    m,
    width,
    label="Manual",
    color=manual_color,
)
ax.bar(
    [x + width / 2 for x in positions],
    a,
    width,
    label="AI-assisted",
    color=ai_color,
)

ax.set_xticks(list(positions), ["Precision", "Recall", "F1"])
ax.set_ylabel("Score")
ax.set_ylim(0, 1)
ax.set_title("Annotation quality at IoU ≥ 0.50")
ax.legend()
save("03_quality_metrics.png")


# Figure 4: Matched-box mean IoU.
fig, ax = plt.subplots(figsize=(6, 5))
values = [
    quality["manual"]["mean_matched_iou"],
    quality["ai_assisted"]["mean_matched_iou"],
]

bars = ax.bar(
    ["Manual", "AI-assisted"],
    values,
    color=[manual_color, ai_color],
    width=0.55,
)

for bar, value in zip(bars, values):
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        value + 0.02,
        f"{value:.3f}",
        ha="center",
    )

ax.set_ylim(0, 1)
ax.set_ylabel("Mean IoU of matched boxes")
ax.set_title("Bounding-box localization quality")
save("04_matched_iou.png")

print("\nAll 4 evaluation figures generated.")
