# Labelix AI — Intelligent Image Annotation Studio

A human-in-the-loop, AI-assisted image annotation platform developed for an MSc Applied AI and Data Science project.

Labelix AI allows users to create annotation projects, define object categories, upload images, generate AI bounding-box suggestions, review and correct predictions, and export project datasets in COCO format.

## Features

- **Project management:** Create projects with configurable object labels.
- **Image gallery:** Upload, browse, and reopen project images.
- **AI-assisted annotation:** Generate bounding-box suggestions using YOLO-World with project-specific classes.
- **Human review:** Accept, edit, or reject AI suggestions.
- **Manual annotation:** Draw, move, resize, relabel, and delete bounding boxes.
- **Annotation persistence:** Save and reload annotations.
- **Dataset export:** Download project-specific COCO ZIP archives containing images and annotations.
- **Dataset validation:** Check exported COCO files for structural errors.
- **Evaluation:** Reproduce annotation-time and quality analyses from a 12-trial human study.

## Technology Stack

| Component | Technology |
|---|---|
| Frontend | React, Vite, React-Konva |
| Backend | Python, FastAPI |
| Database | SQLite |
| Open-vocabulary AI | YOLO-World |
| Traffic baseline | YOLO11n |
| Evaluation | Python, Matplotlib |
| Containerization | Docker Compose |

## Architecture

```text
React Frontend
     |
     | HTTP / JSON
     v
FastAPI Backend
     |
     +-- Project and Label Management
     +-- Image Upload and Retrieval
     +-- YOLO-World / YOLO11n Inference
     +-- Annotation Save and Reload
     +-- COCO Dataset Export
     |
     v
SQLite Database + Image Files
```

AI suggestions remain provisional until reviewed by the annotator. The platform does not assume that model predictions are correct.

## Local Setup

### Requirements

- Python 3.11
- Node.js with npm
- Model weight files

Place the pretrained weight files at:

```text
yolo11n.pt
models/yolov8s-worldv2.pt
```

Model weights are excluded from Git because of their file sizes. Use the corresponding official Ultralytics pretrained models and respect their applicable licenses.

### Backend — Windows PowerShell

From the repository root:

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Backend API documentation: http://127.0.0.1:8000/docs

### Frontend

Open a second terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Application: http://localhost:5173

The application stores annotations in SQLite and uploaded images on disk. These runtime files are excluded from Git.

## Docker Compose

Docker configuration is provided for containerized deployment.

From the repository root:

```bash
docker compose up --build
```

Configured endpoints:

- Frontend: http://localhost:5174
- Backend API: http://localhost:8001/docs

The configuration uses separate Docker volumes for annotations and uploaded images. The model weights must exist in the expected local paths.

**Status:** Docker configuration has passed syntax validation, but end-to-end startup and inference testing are still pending. Do not treat Docker deployment as verified until those checks pass.

## Annotation Workflow

1. Create or select an annotation project.
2. Add object classes.
3. Upload an image or reopen one from the gallery.
4. Generate AI suggestions using the confidence threshold.
5. Accept, edit, or reject suggestions.
6. Manually annotate objects the model missed.
7. Save and reload annotations.
8. Export the project dataset as a COCO ZIP.

## Dataset Format

Project export endpoint:

```text
GET /projects/{project_id}/export/coco
```

The resulting ZIP contains:

```text
annotations/
    instances.json
images/
    ...
```

COCO annotations include image references, category IDs, and bounding boxes.

Validate an exported ZIP using:

```bash
python evaluation/validate_coco.py path/to/dataset.zip
```

The validator checks image references, category IDs, bounding-box coordinates, and selected duplicate-annotation conditions. It does not establish semantic label correctness or detect identical images with different filenames.

## Human-Study Evaluation

The evaluation dataset contains 12 annotation trials: 6 manual and 6 AI-assisted, conducted by a single annotator on different KITTI-derived images.

### Annotation Time

| Metric | Manual | AI-assisted |
|---|---:|---:|
| Mean active time | 107.88 s | 92.31 s |
| Median active time | 60.03 s | 87.32 s |
| Annotations/minute | 2.78 | 3.25 |

The mean active-time comparison suggests a 14.43% reduction with AI assistance. However, the median indicates slower AI-assisted annotation. Excluding one unusually long manual trial reverses the mean comparison.

Therefore, the study does **not** establish a consistent or causal time-saving benefit.

### Annotation Quality

Quality is assessed against KITTI-derived ground-truth bounding boxes using class-aware, one-to-one matching at IoU ≥ 0.50.

| Metric | Manual | AI-assisted |
|---|---:|---:|
| Precision | 0.6667 | 0.6800 |
| Recall | 0.7500 | 0.7083 |
| F1-score | 0.7059 | 0.6939 |
| Mean matched IoU | 0.6720 | 0.7515 |

Mean matched IoU measures localization quality only for successfully matched boxes. It does not account for missed objects by itself.

Out-of-scope KITTI categories are handled using an explicitly defined intersection-over-annotation-area (IoA) exclusion policy.

### Reproduce Evaluation

```bash
python evaluation/analyze_human_study.py
python evaluation/evaluate_annotation_quality.py
python evaluation/plot_results.py
```

The timing and plot scripts use committed human-study results. Quality evaluation also requires the study images, revised manifest, and KITTI-derived ground-truth ZIP in `study_data/`. These large or dataset-derived files are not included in Git.

Results are stored in:

```text
evaluation/results/human_study/
```

Generated figures are stored in:

```text
evaluation/results/human_study/figures/
```

## Cross-Domain Functional Tests

Labelix AI was tested on multiple annotation domains:

- **Animals:** Cat and dog annotations.
- **Food:** Apple, banana, and orange.
- **Office objects:** Laptop, keyboard, and mouse.
- **Stationery:** Notebook, pen, and pencil.

In the stationery test, the model produced zero suggestions at confidence 0.25, while manual annotation remained functional. This demonstrates an important limitation of open-vocabulary detection on small or difficult objects.

These tests demonstrate functionality across domains; they are not a statistically representative general-purpose detection benchmark.

## Limitations

- Model predictions can be incorrect, incomplete, or duplicated.
- Open-vocabulary detection performance varies across object classes and images.
- Small or thin objects may be missed.
- Annotation quality still requires human review.
- The human study has a small sample size and a single annotator.
- Manual and AI-assisted trials used different images, introducing potential difficulty imbalance.
- Trial order and learning effects may affect completion times.
- The recorded timing comparison is sensitive to outliers.
- Dataset exports require structural and visual validation before downstream training.

## Academic Context

Developed as an individual MSc Applied AI and Data Science project.

The implementation integrates pretrained computer-vision models rather than training a new detector from scratch. The main contribution is the human-in-the-loop annotation workflow, project-level class configuration, dataset export, and empirical evaluation.

## References

- Ultralytics documentation: https://docs.ultralytics.com/
- COCO dataset and annotation format: https://cocodataset.org/
- KITTI Vision Benchmark Suite: https://www.cvlibs.net/datasets/kitti/
- YOLO-World project: https://github.com/AILab-CVC/YOLO-World
