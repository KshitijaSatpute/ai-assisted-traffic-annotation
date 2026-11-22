
import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Transformer } from "react-konva";

const COLORS = {
  car: "#22c55e",
  truck: "#f97316",
  pedestrian: "#3b82f6",
};


export default function AnnotationCanvas({ imageUrl, imageId }) {

  const [image, setImage] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [label, setLabel] = useState("car");
  const [drawing, setDrawing] = useState(null);

  const transformerRef = useRef(null);
  const shapeRefs = useRef({});
  const nextId = useRef(1);

  useEffect(() => {
    if (!imageUrl) {
      setImage(null);
      return;
    }

    const img = new window.Image();
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
    img.src = imageUrl;

    setBoxes([]);
    setSelectedId(null);
    nextId.current = 1;
  }, [imageUrl]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const node = shapeRefs.current[selectedId];

    if (transformer) {
      transformer.nodes(node ? [node] : []);
      transformer.getLayer()?.batchDraw();
    }
  }, [selectedId, boxes]);

  if (!image) {
    return <p>Loading annotation image...</p>;
  }

  const width = Math.min(900, image.width);
  const scale = width / image.width;
  const height = image.height * scale;

  function startDrawing(event) {
    if (event.target !== event.target.getStage()) return;

    const pointer = event.target.getStage().getPointerPosition();
    if (!pointer) return;

    setSelectedId(null);
    setDrawing({
      x: pointer.x,
      y: pointer.y,
      width: 0,
      height: 0,
    });
  }

  function updateDrawing(event) {
    if (!drawing) return;

    const pointer = event.target.getStage().getPointerPosition();
    if (!pointer) return;

    setDrawing({
      ...drawing,
      width: pointer.x - drawing.x,
      height: pointer.y - drawing.y,
    });
  }

  function finishDrawing() {
    if (!drawing) return;

    const x = Math.min(drawing.x, drawing.x + drawing.width);
    const y = Math.min(drawing.y, drawing.y + drawing.height);
    const boxWidth = Math.abs(drawing.width);
    const boxHeight = Math.abs(drawing.height);

    if (boxWidth >= 5 && boxHeight >= 5) {
      setBoxes((previous) => [
        ...previous,
        {
          id: nextId.current++,
          x,
          y,
          width: boxWidth,
          height: boxHeight,
          label,
        },
      ]);
    }

    setDrawing(null);
  }

  function updateBox(id, changes) {
    setBoxes((previous) =>
      previous.map((box) =>
        box.id === id ? { ...box, ...changes } : box
      )
    );
  }

  function deleteSelected() {
    setBoxes((previous) =>
      previous.filter((box) => box.id !== selectedId)
    );
    setSelectedId(null);
  }

  async function saveAnnotations() {
    if (!image || !imageId) return;

    const scale = Math.min(900, image.width) / image.width;

    const annotations = boxes.map((box) => ({
      annotation_id: String(box.id),
      image_id: imageId,
      label: box.label,
      source: "manual",
      confidence: null,
      bbox: {
        x_min: box.x / scale,
        y_min: box.y / scale,
        x_max: (box.x + box.width) / scale,
        y_max: (box.y + box.height) / scale,
      },
    }));

    try {
      const response = await fetch(
        `http://127.0.0.1:8000/images/${imageId}/annotations`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(annotations),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(JSON.stringify(data.detail));
      }

      alert(`Saved ${data.saved_count} annotations.`);
    } catch (error) {
      alert(`Save failed: ${error.message}`);
    }
  }

  async function reloadAnnotations() {
    if (!image || !imageId) return;

    try {
      const response = await fetch(
        `http://127.0.0.1:8000/images/${imageId}/annotations`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const scale = Math.min(900, image.width) / image.width;

      const loadedBoxes = data.annotations.map((annotation) => ({
        id: annotation.annotation_id,
        label: annotation.label,
        x: annotation.bbox.x_min * scale,
        y: annotation.bbox.y_min * scale,
        width:
          (annotation.bbox.x_max - annotation.bbox.x_min) * scale,
        height:
          (annotation.bbox.y_max - annotation.bbox.y_min) * scale,
      }));

      setBoxes(loadedBoxes);
      setSelectedId(null);

      alert(`Loaded ${loadedBoxes.length} annotations.`);
    } catch (error) {
      alert(`Reload failed: ${error.message}`);
    }
  }

  return (
    <div>
      <h2>Manual Annotation Editor</h2>

      <div style={{ marginBottom: 15 }}>
        <label htmlFor="annotation-label">Object class: </label>
        <select
          id="annotation-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        >
          <option value="car">Car</option>
          <option value="truck">Truck</option>
          <option value="pedestrian">Pedestrian</option>
        </select>

        <button
          type="button"
          onClick={deleteSelected}
          disabled={selectedId === null}
          style={{ marginLeft: 15 }}
        >
          Delete Selected Box
        </button>
      </div>

      <p>
        Draw a box in an empty area. Click a box to move or resize it.
      </p>


    <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
  <button type="button" onClick={saveAnnotations}>
    Save Annotations
  </button>

  <button type="button" onClick={reloadAnnotations}>
    Reload Annotations
  </button>
</div>

      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <Stage
          width={width}
          height={height}
          onMouseDown={startDrawing}
          onMouseMove={updateDrawing}
          onMouseUp={finishDrawing}
        >
          <Layer>
            <KonvaImage
              image={image}
              width={width}
              height={height}
              listening={false}
            />

            {boxes.map((box) => (
              <Rect
                key={box.id}
                ref={(node) => {
                  if (node) shapeRefs.current[box.id] = node;
                }}
                {...box}
                stroke={COLORS[box.label]}
                strokeWidth={2}
                draggable
                onClick={() => setSelectedId(box.id)}
                onTap={() => setSelectedId(box.id)}
                onDragEnd={(event) => {
                  updateBox(box.id, {
                    x: event.target.x(),
                    y: event.target.y(),
                  });
                }}
                onTransformEnd={(event) => {
                  const node = event.target;
                  const newWidth = Math.max(5, node.width() * node.scaleX());
                  const newHeight = Math.max(5, node.height() * node.scaleY());

                  node.scaleX(1);
                  node.scaleY(1);

                  updateBox(box.id, {
                    x: node.x(),
                    y: node.y(),
                    width: newWidth,
                    height: newHeight,
                  });
                }}
              />
            ))}

            {drawing && (
              <Rect
                x={Math.min(drawing.x, drawing.x + drawing.width)}
                y={Math.min(drawing.y, drawing.y + drawing.height)}
                width={Math.abs(drawing.width)}
                height={Math.abs(drawing.height)}
                stroke={COLORS[label]}
                strokeWidth={2}
                dash={[6, 4]}
                listening={false}
              />
            )}

            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              boundBoxFunc={(oldBox, newBox) => {
                if (newBox.width < 5 || newBox.height < 5) {
                  return oldBox;
                }
                return newBox;
              }}
            />
          </Layer>
        </Stage>
      </div>

      <p>
        <strong>Total annotations:</strong> {boxes.length}
      </p>
    </div>
  );
}
