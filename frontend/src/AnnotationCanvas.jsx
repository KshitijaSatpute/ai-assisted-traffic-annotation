
import { useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Image as KonvaImage,
  Rect,
  Transformer,
  Text as KonvaText,
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

function toCanvasBox(annotation, scale) {
  return {
    id: String(annotation.annotation_id),
    label: annotation.label,
    source: annotation.source ?? "manual",
    confidence: annotation.confidence ?? null,
    x: annotation.bbox.x_min * scale,
    y: annotation.bbox.y_min * scale,
    width:
      (annotation.bbox.x_max - annotation.bbox.x_min) * scale,
    height:
      (annotation.bbox.y_max - annotation.bbox.y_min) * scale,
  };
}

export default function AnnotationCanvas({ imageUrl, imageId }) {
  const [image, setImage] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [aiSuggestions, setAiSuggestions] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  const [selectedSuggestionId, setSelectedSuggestionId] =
    useState(null);

  const [label, setLabel] = useState("car");
  const [drawing, setDrawing] = useState(null);
  const [confidenceThreshold, setConfidenceThreshold] =
    useState(0.25);

  const [loading, setLoading] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [message, setMessage] = useState("");

  const transformerRef = useRef(null);
  const shapeRefs = useRef({});

  const width = image ? Math.min(900, image.width) : 0;
  const scale = image ? width / image.width : 1;
  const height = image ? image.height * scale : 0;

  const selectedSuggestion = aiSuggestions.find(
    (suggestion) => suggestion.id === selectedSuggestionId
  );

  const visibleSuggestions = aiSuggestions.filter(
    (suggestion) =>
      suggestion.confidence >= confidenceThreshold
  );

  // Load the uploaded image.
  useEffect(() => {
    let cancelled = false;
    const img = new window.Image();

    setImage(null);
    setBoxes([]);
    setAiSuggestions([]);
    setSelectedId(null);
    setSelectedSuggestionId(null);
    setDrawing(null);
    setMessage("");
    shapeRefs.current = {};

    img.onload = () => {
      if (!cancelled) setImage(img);
    };

    img.onerror = () => {
      if (!cancelled) {
        setImage(null);
        setMessage("Could not load image.");
      }
    };

    if (imageUrl) img.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  // Restore final annotations, never pending AI suggestions.
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
        const imageScale =
          Math.min(900, image.width) / image.width;

        if (!cancelled) {
          setBoxes(
            data.annotations.map((item) =>
              toCanvasBox(item, imageScale)
            )
          );
          setSelectedId(null);
        }
      } catch (error) {
        if (!cancelled) {
          setMessage(`Restore failed: ${error.message}`);
        }
      }
    }

    restoreAnnotations();

    return () => {
      cancelled = true;
    };
  }, [image, imageId]);

  // Connect the transformer to a selected final box.
  useEffect(() => {
    const transformer = transformerRef.current;

    if (!transformer) return;

    const node = shapeRefs.current[selectedId];

    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, boxes]);

  function selectFinalBox(box) {
    setSelectedId(box.id);
    setSelectedSuggestionId(null);
    setLabel(box.label);
  }

  function selectSuggestion(suggestion) {
    setSelectedSuggestionId(suggestion.id);
    setSelectedId(null);
    setLabel(suggestion.label);
  }

  function removeSuggestion(id) {
    setAiSuggestions((previous) =>
      previous.filter((item) => item.id !== id)
    );
    setSelectedSuggestionId(null);
  }

  async function generateAiSuggestions() {
    if (!image || !imageId || predicting || loading) return;

    if (aiSuggestions.length > 0) {
      const proceed = window.confirm(
        "Generate again? Existing pending suggestions will be replaced."
      );
      if (!proceed) return;
    }

    setPredicting(true);
    setMessage("Generating AI suggestions...");

    try {
      const response = await fetch(
        `${API_URL}/images/${imageId}/predict?conf=0.01`,
        { method: "POST" }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      const suggestions = data.predictions.map(
        (prediction) => ({
          id: prediction.prediction_id,
          label: prediction.label,
          confidence: prediction.confidence,
          x: prediction.bbox.x_min * scale,
          y: prediction.bbox.y_min * scale,
          width:
            (prediction.bbox.x_max -
              prediction.bbox.x_min) * scale,
          height:
            (prediction.bbox.y_max -
              prediction.bbox.y_min) * scale,
        })
      );

      setAiSuggestions(suggestions);
      setSelectedSuggestionId(null);
      setSelectedId(null);

      setMessage(
        `${suggestions.length} predictions generated. Review suggestions before saving.`
      );
    } catch (error) {
      setMessage(`Prediction failed: ${error.message}`);
    } finally {
      setPredicting(false);
    }
  }

  function acceptSuggestion() {
    if (!selectedSuggestion) return;

    const finalBox = {
      ...selectedSuggestion,
      source: "ai_accepted",
    };

    setBoxes((previous) => [...previous, finalBox]);
    removeSuggestion(selectedSuggestion.id);
    setSelectedId(finalBox.id);

    setMessage(
      "AI prediction accepted. Save annotations to persist."
    );
  }

  function editSuggestion() {
    if (!selectedSuggestion) return;

    const editableBox = {
      ...selectedSuggestion,
      source: "ai_edited",
    };

    setBoxes((previous) => [...previous, editableBox]);
    removeSuggestion(selectedSuggestion.id);
    setSelectedId(editableBox.id);
    setLabel(editableBox.label);

    setMessage(
      "AI box is now editable. Drag, resize, or change its class, then Save."
    );
  }

  function rejectSuggestion() {
    if (!selectedSuggestion) return;

    removeSuggestion(selectedSuggestion.id);

    setMessage(
      "AI suggestion rejected. It will not be saved."
    );
  }

  function updateBox(id, changes) {
    setBoxes((previous) =>
      previous.map((box) => {
        if (box.id !== id) return box;

        // Preserve the AI provenance when a human edits the box.
        const source =
          box.source === "ai_accepted" ||
          box.source === "ai_edited" ||
          box.source === "ai"
            ? "ai_edited"
            : "manual";

        return {
          ...box,
          ...changes,
          source,
        };
      })
    );
  }

  function changeLabel(newLabel) {
    setLabel(newLabel);

    if (selectedId !== null) {
      updateBox(selectedId, { label: newLabel });
      setMessage("Label changed. Save to persist.");
    }
  }

  function deleteSelected() {
    if (selectedId === null) return;

    setBoxes((previous) =>
      previous.filter((box) => box.id !== selectedId)
    );

    setSelectedId(null);
    setMessage("Final annotation deleted. Save to persist.");
  }

  function startDrawing(event) {
    if (event.target !== event.target.getStage()) return;

    const pointer =
      event.target.getStage().getPointerPosition();

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
    setSelectedSuggestionId(null);

    setDrawing({
      x: pointer.x,
      y: pointer.y,
      width: 0,
      height: 0,
    });
  }

  function updateDrawing(event) {
    if (!drawing) return;

    const pointer =
      event.target.getStage().getPointerPosition();

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

      setMessage(
        "Manual annotation created. Save to persist."
      );
    }

    setDrawing(null);
  }

  function boxToAnnotation(box) {
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

    if (xMax <= xMin || yMax <= yMin) {
      throw new Error("Invalid bounding box.");
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
      // Only reviewed or manually created boxes are saved.
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
        `Saved ${data.saved_count} final annotations.`
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

      setBoxes(
        data.annotations.map((item) =>
          toCanvasBox(item, scale)
        )
      );

      setSelectedId(null);

      setMessage(
        `Loaded ${data.annotations.length} final annotations.`
      );
    } catch (error) {
      setMessage(`Reload failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (!image) {
    return (
      <p>{message || "Loading annotation image..."}</p>
    );
  }

  return (
    <div>
      <h2>Human-in-the-Loop Annotation Editor</h2>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="annotation-label">
          Object class:{" "}
        </label>

        <select
          id="annotation-label"
          value={label}
          onChange={(event) =>
            changeLabel(event.target.value)
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
          style={{ marginLeft: 12 }}
        >
          Delete Selected Box
        </button>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 12,
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

        <button
          type="button"
          onClick={generateAiSuggestions}
          disabled={predicting || loading}
        >
          {predicting
            ? "Generating..."
            : "Generate AI Suggestions"}
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="confidence-slider">
          Confidence threshold:{" "}
          <strong>{confidenceThreshold.toFixed(2)}</strong>
        </label>

        <input
          id="confidence-slider"
          type="range"
          min="0.01"
          max="1"
          step="0.01"
          value={confidenceThreshold}
          onChange={(event) => {
            setConfidenceThreshold(
              Number(event.target.value)
            );
            setSelectedSuggestionId(null);
          }}
          style={{ marginLeft: 12 }}
        />
      </div>

      <p>
        <strong>Final annotations:</strong> {boxes.length}
        {" | "}
        <strong>Pending AI suggestions:</strong>{" "}
        {aiSuggestions.length}
        {" | "}
        <strong>Visible pending:</strong>{" "}
        {visibleSuggestions.length}
      </p>

      <p>
        Yellow dashed = pending AI prediction.
        Solid colored = final annotation.
      </p>

      {selectedSuggestion && (
        <div
          style={{
            border: "1px solid #eab308",
            padding: 12,
            marginBottom: 12,
          }}
        >
          <p>
            <strong>Selected AI suggestion:</strong>{" "}
            {selectedSuggestion.label}
            {" | "}
            Confidence:{" "}
            {selectedSuggestion.confidence.toFixed(3)}
          </p>

          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={acceptSuggestion}
            >
              Accept
            </button>

            <button
              type="button"
              onClick={editSuggestion}
            >
              Edit
            </button>

            <button
              type="button"
              onClick={rejectSuggestion}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {message && <p role="status">{message}</p>}

      <p>
        Click a yellow AI box to review it.
        Click a solid box to move, resize, or relabel it.
      </p>

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
          </Layer>

          {/* Pending predictions stay separate from final boxes. */}
          <Layer>
            {visibleSuggestions.map((suggestion) => (
              <Rect
                key={`pending-${suggestion.id}`}
                x={suggestion.x}
                y={suggestion.y}
                width={suggestion.width}
                height={suggestion.height}
                stroke={
                  selectedSuggestionId === suggestion.id
                    ? "#f97316"
                    : "#eab308"
                }
                strokeWidth={
                  selectedSuggestionId === suggestion.id
                    ? 3
                    : 2
                }
                dash={[8, 5]}
                onClick={() =>
                  selectSuggestion(suggestion)
                }
                onTap={() =>
                  selectSuggestion(suggestion)
                }
              />
            ))}

            {selectedSuggestion &&
              selectedSuggestion.confidence >=
                confidenceThreshold && (
                <KonvaText
                  x={selectedSuggestion.x}
                  y={Math.max(
                    0,
                    selectedSuggestion.y - 19
                  )}
                  text={`${selectedSuggestion.label} ${selectedSuggestion.confidence.toFixed(2)}`}
                  fontSize={15}
                  fill="#eab308"
                  listening={false}
                />
              )}
          </Layer>

          {/* Final human annotations. */}
          <Layer>
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
                stroke={
                  COLORS[box.label] ?? "#ffffff"
                }
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
                onClick={() => selectFinalBox(box)}
                onTap={() => selectFinalBox(box)}
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
    </div>
  );
}
