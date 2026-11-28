
from pathlib import Path
from ultralytics import YOLOWorld

image_path = Path(
    r"C:\Users\admin\AI_Vision_Backup\test_images\360_F_418068474_VIWD3loz21dusicbe43VnAsAc9uZudyF.jpg"
)

if not image_path.is_file():
    raise FileNotFoundError(image_path)

model = YOLOWorld(str(Path(__file__).resolve().parents[2] / "models" / "yolov8s-worldv2.pt"))
model.set_classes(["dog", "cat"])

results = model.predict(
    source=str(image_path),
    conf=0.15,
    device="cpu",
    verbose=False,
)

print("Model:", "YOLO-World")
print("Detected objects:")

for box in results[0].boxes:
    class_id = int(box.cls.item())
    label = results[0].names[class_id]
    confidence = float(box.conf.item())
    print(f"{label}: {confidence:.3f}")

print("Total detections:", len(results[0].boxes))

