
import { useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Rect,
  Transformer,
} from "react-konva";

const API_URL = "http://127.0.0.1:8000";

const COLORS = {
  car: "#22c55e",
  truck: "#f97316",
  pedestrian: "#3b82f6",
};

const MIN_BOX_SIZE = 5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export default function AnnotationCanvas({ imageUrl, imageId }) {
  const [image, setImage] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [label, setLabel] = useState("car");
  const [drawing, setDrawing] = useState(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const transformerRef = useRef(null);
  const shapeRefs = useRef({});

  const width = image ? Math.min(900, image.width) : 0;
  const scale = image ? width / image.width : 1;
  const height = image ? image.height * scale : 0;

  // Load the image when its URL changes.
  useEffect(() => {
    let cancelled = false;

    const img = new window.Image();

    img.onload = () => {
      if (!cancelled) {
        setImage(img);
      }
    };

    img.onerror = () => {
      if (!cancelled) {
        setImage(null);
        setMessage("Could not load the image.");
      }
    };

    setImage(null);
    setBoxes([]);
    setSelectedId(null);
    setDrawing(null);
    setMessage("");
    shapeRefs.current = {};

    if (imageUrl) {
      img.src = imageUrl;
    }

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  // Convert saved original-image coordinates to canvas coordinates.
  function annotationsToBoxes(annotations, imageScale) {
    return annotations.map((annotation) => ({
      id: String(annotation.annotation_id),
      label: annotation.label,
      source: annotation.source ?? "manual",
      confidence: annotation.confidence ?? null,
      x: annotation.bbox.x_min * imageScale,
      y: annotation.bbox.y_min * imageScale,
      width:
        (annotation.bbox.x_max - annotation.bbox.x_min) * imageScale,
      height:
        (annotation.bbox.y_max - annotation.bbox.y_min) * imageScale,
    }));
  }

  // Automatically load saved boxes after the image loads,
  // including after a browser refresh.
  useEffect(() => {
    if (!image || !imageId) return;

    let cancelled = false;

    async function restoreAnnotations() {
      try {
        const response = await fetch(
          `${API_URL}/images/${imageId}/annotations`
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const imageScale = Math.min(900, image.width) / image.width;

        if (!cancelled) {
          setBoxes(
            annotationsToBoxes(data.annotations, imageScale)
          );
          setSelectedId(null);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(`Auto-load failed: ${error.message}`);
        }
      }
    }

    restoreAnnotations();

    return () => {
      cancelled = true;
    };
  }, [image, imageId]);

  // Attach resize handles to the selected rectangle.
  useEffect(() => {
    const transformer = transformerRef.current;

    if (!transformer) return;

    const selectedNode = shapeRefs.current[selectedId];

    transformer.nodes(selectedNode ? [selectedNode] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, boxes]);

  function getPointer(event) {
    const stage = event.target.getStage();
    return stage?.getPointerPosition();
  }

  function startDrawing(event) {
    // Do not create a new box while selecting or dragging a box.
    if (event.target !== event.target.getStage()) return;

    const pointer = getPointer(event);
    if (!pointer) return;

    if (
      pointer.x < 0 ||
      pointer.y < 0 ||
      pointer.x > width ||
      pointer.y > height
    ) {
      return;
    }

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

    const pointer = getPointer(event);
    if (!pointer) return;

    const x = clamp(pointer.x, 0, width);
    const y = clamp(pointer.y, 0, height);

    setDrawing((current) => {
      if (!current) return null;

      return {
        ...current,
        width: x - current.x,
        height: y - current.y,
      };
    });
  }

  function finishDrawing() {
    if (!drawing) return;

    const x = Math.min(
      drawing.x,
      drawing.x + drawing.width
    );

    const y = Math.min(
      drawing.y,
      drawing.y + drawing.height
    );

    const boxWidth = Math.abs(drawing.width);
    const boxHeight = Math.abs(drawing.height);

    if (
      boxWidth >= MIN_BOX_SIZE &&
      boxHeight >= MIN_BOX_SIZE
    ) {
      setBoxes((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          x,
          y,
          width: boxWidth,
          height: boxHeight,
          label,
          source: "manual",
          confidence: null,
        },
      ]);

      setMessage("New annotation created. Save to persist.");
    }

    setDrawing(null);
  }

  function updateBox(id, changes) {
    setBoxes((previous) =>
      previous.map((box) =>
        box.id === id
          ? { ...box, ...changes, source: "manual" }
          : box
      )
    );
  }

  function deleteSelected() {
    if (selectedId === null) return;

    setBoxes((previous) =>
      previous.filter((box) => box.id !== selectedId)
    );

    setSelectedId(null);
    setMessage("Annotation deleted. Save to persist.");
  }

  function changeSelectedLabel(newLabel) {
    setLabel(newLabel);

    if (selectedId !== null) {
      updateBox(selectedId, { label: newLabel });
      setMessage("Label changed. Save to persist.");
    }
  }

  function boxToAnnotation(box) {
    // Save bounding boxes in original image pixel coordinates.
    const xMin = clamp(box.x / scale, 0, image.width);
    const yMin = clamp(box.y / scale, 0, image.height);

    const xMax = clamp(
      (box.x + box.width) / scale,
      0,
      image.width
    );

    const yMax = clamp(
      (box.y + box.height) / scale,
      0,
      image.height
    );

    if (
      xMax <= xMin ||
      yMax <= yMin
    ) {
      throw new Error("Invalid bounding box dimensions.");
    }

    return {
      annotation_id: String(box.id),
      image_id: imageId,
      label: box.label,
      source: box.source ?? "manual",
      confidence: box.confidence ?? null,
      bbox: {
        x_min: xMin,
        y_min: yMin,
        x_max: xMax,
        y_max: yMax,
      },
    };
  }

  async function saveAnnotations() {
    if (!image || !imageId || loading) return;

    setLoading(true);
    setMessage("");

    try {
      const annotations = boxes.map(boxToAnnotation);

      const response = await fetch(
        `${API_URL}/images/${imageId}/annotations`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(annotations),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          JSON.stringify(data.detail ?? "Save failed")
        );
      }

      setMessage(
        `Saved ${data.saved_count} annotations successfully.`
      );
    } catch (error) {
      setMessage(`Save failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function reloadAnnotations() {
    if (!image || !imageId || loading) return;

    setLoading(true);
    setMessage("");

    try {
      const response = await fetch(
        `${API_URL}/images/${imageId}/annotations`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      setBoxes(annotationsToBoxes(data.annotations, scale));
      setSelectedId(null);

      setMessage(
        `Loaded ${data.annotations.length} annotations successfully.`
      );
    } catch (error) {
      setMessage(`Reload failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (!image) {
    return (
      <p>
        {message || "Loading annotation image..."}
      </p>
    );
  }

  return (
    <div>
      <h2>Manual Annotation Editor</h2>

      <div style={{ marginBottom: 15 }}>
        <label htmlFor="annotation-label">
          Object class:{" "}
        </label>

        <select
          id="annotation-label"
          value={label}
          onChange={(event) =>
            changeSelectedLabel(event.target.value)
          }
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
        Draw a box around an object. Click a box to move,
        resize, change its label, or delete it.
      </p>

      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={saveAnnotations}
          disabled={loading}
        >
          {loading ? "Processing..." : "Save Annotations"}
        </button>

        <button
          type="button"
          onClick={reloadAnnotations}
          disabled={loading}
        >
          Reload Annotations
        </button>
      </div>

      {message && (
        <p role="status">{message}</p>
      )}

      <div
        style={{
          overflowX: "auto",
          maxWidth: "100%",
        }}
      >
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
                  if (node) {
                    shapeRefs.current[box.id] = node;
                  } else {
                    delete shapeRefs.current[box.id];
                  }
                }}
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                stroke={COLORS[box.label] ?? "#ffffff"}
                strokeWidth={2}
                draggable
                dragBoundFunc={(position) => ({
                  x: clamp(
                    position.x,
                    0,
                    Math.max(0, width - box.width)
                  ),
                  y: clamp(
                    position.y,
                    0,
                    Math.max(0, height - box.height)
                  ),
                })}
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

                  const rawWidth =
                    node.width() * node.scaleX();

                  const rawHeight =
                    node.height() * node.scaleY();

                  node.scaleX(1);
                  node.scaleY(1);

                  const x = clamp(
                    node.x(),
                    0,
                    width - MIN_BOX_SIZE
                  );

                  const y = clamp(
                    node.y(),
                    0,
                    height - MIN_BOX_SIZE
                  );

                  const newWidth = clamp(
                    rawWidth,
                    MIN_BOX_SIZE,
                    width - x
                  );

                  const newHeight = clamp(
                    rawHeight,
                    MIN_BOX_SIZE,
                    height - y
                  );

                  node.x(x);
                  node.y(y);
                  node.width(newWidth);
                  node.height(newHeight);

                  updateBox(box.id, {
                    x,
                    y,
                    width: newWidth,
                    height: newHeight,
                  });
                }}
              />
            ))}

            {drawing && (
              <Rect
                x={Math.min(
                  drawing.x,
                  drawing.x + drawing.width
                )}
                y={Math.min(
                  drawing.y,
                  drawing.y + drawing.height
                )}
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
              flipEnabled={false}
              boundBoxFunc={(oldBox, newBox) => {
                const validSize =
                  newBox.width >= MIN_BOX_SIZE &&
                  newBox.height >= MIN_BOX_SIZE;

                const withinImage =
                  newBox.x >= 0 &&
                  newBox.y >= 0 &&
                  newBox.x + newBox.width <= width &&
                  newBox.y + newBox.height <= height;

                return validSize && withinImage
                  ? newBox
                  : oldBox;
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
