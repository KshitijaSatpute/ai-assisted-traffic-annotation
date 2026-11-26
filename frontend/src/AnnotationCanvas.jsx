import { useEffect, useRef, useState } from "react";
import {
  Stage, Layer, Image as KonvaImage, Rect, Transformer,
  Text as KonvaText,
} from "react-konva";

const API_URL = "http://127.0.0.1:8000";
const COLORS = { car: "#22c55e", truck: "#f97316", pedestrian: "#3b82f6" };
const MIN_BOX_SIZE = 5;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const formatTime = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

function annotationToBox(item, scale) {
  return {
    id: String(item.annotation_id),
    label: item.label,
    source: item.source ?? "manual",
    confidence: item.confidence ?? null,
    x: item.bbox.x_min * scale,
    y: item.bbox.y_min * scale,
    width: (item.bbox.x_max - item.bbox.x_min) * scale,
    height: (item.bbox.y_max - item.bbox.y_min) * scale,
  };
}

export default function AnnotationCanvas({ imageUrl, imageId }) {
  const [image, setImage] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [aiSuggestions, setAiSuggestions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedSuggestionId, setSelectedSuggestionId] = useState(null);
  const [label, setLabel] = useState("car");
  const [drawing, setDrawing] = useState(null);
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.25);
  const [loading, setLoading] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [message, setMessage] = useState("");

  const [studyMode, setStudyMode] = useState("manual");
  const [session, setSession] = useState(null);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [inferenceMs, setInferenceMs] = useState(0);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [eventError, setEventError] = useState("");

  const transformerRef = useRef(null);
  const shapeRefs = useRef({});
  const clockRef = useRef({ accrued: 0, since: null });
  const eventsQueueRef = useRef(Promise.resolve());
  const eventFailedRef = useRef(false);
  const sessionRef = useRef(null);
  const sessionBusyRef = useRef(false);
  const inferenceTotalRef = useRef(0);

  const width = image ? Math.min(900, image.width) : 0;
  const scale = image ? width / image.width : 1;
  const height = image ? image.height * scale : 0;
  const selectedSuggestion = aiSuggestions.find((s) => s.id === selectedSuggestionId);
  const visibleSuggestions = aiSuggestions.filter((s) => s.confidence >= confidenceThreshold);

  function clockValue() {
    const c = clockRef.current;
    return c.accrued + (c.since === null ? 0 : performance.now() - c.since);
  }
  function pauseClock() {
    const c = clockRef.current;
    if (c.since !== null) {
      c.accrued += performance.now() - c.since;
      c.since = null;
    }
    setElapsedMs(c.accrued);
  }
  function resumeClock() {
    if (clockRef.current.since === null) clockRef.current.since = performance.now();
  }
  function canEdit() {
    if (sessionBusyRef.current) return false;
    if (sessionRef.current && paused) {
      setMessage("Resume the session before annotating.");
      return false;
    }
    return true;
  }
  useEffect(() => {
    const timer = setInterval(() => setElapsedMs(clockValue()), 250);
    return () => clearInterval(timer);
  }, []);

  // A study session is explicitly started; actions outside a session still work
  // but must never be reported as study measurements.
  async function startSession() {
    if (!image || !imageId || session || sessionBusyRef.current) return;
    if (boxes.length > 0 || aiSuggestions.length > 0) {
      setMessage("For a controlled study, upload a fresh image with no existing labels or suggestions.");
      return;
    }
    sessionBusyRef.current = true;
    setSessionBusy(true);
    try {
      const response = await fetch(`${API_URL}/sessions/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_id: imageId, mode: studyMode }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      sessionRef.current = data;
      setSession(data);
      clockRef.current = { accrued: 0, since: performance.now() };
      inferenceTotalRef.current = 0;
      eventsQueueRef.current = Promise.resolve();
      eventFailedRef.current = false;
      setEventError("");
      setElapsedMs(0);
      setInferenceMs(0);
      setPaused(false);
      setMessage(`Study session started (${data.mode}).`);
    } catch (error) {
      setMessage(`Session start failed: ${error.message}`);
    } finally {
      sessionBusyRef.current = false;
      setSessionBusy(false);
    }
  }

  function togglePause() {
    if (!session || sessionBusyRef.current || predicting) return;
    if (paused) resumeClock();
    else pauseClock();
    setPaused((old) => !old);
  }

  function recordEvent(eventType, annotationId, details = {}) {
    const current = sessionRef.current;
    if (!current) return;
    const payload = {
      event_type: eventType,
      annotation_id: annotationId ? String(annotationId) : null,
      details,
    };
    eventsQueueRef.current = eventsQueueRef.current.then(async () => {
      const response = await fetch(`${API_URL}/sessions/${current.session_id}/events`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`${eventType}: HTTP ${response.status}`);
    }).catch((error) => {
      eventFailedRef.current = true;
      setEventError(`Event logging failed (${error.message}). Do not use this session for evaluation.`);
    });
  }

  async function finishSession() {
    if (!session || sessionBusyRef.current || predicting) return;
    sessionBusyRef.current = true;
    setSessionBusy(true);
    const wasRunning = clockRef.current.since !== null;
    pauseClock();
    try {
      await eventsQueueRef.current;
      if (eventFailedRef.current) throw new Error("Some events were not saved; session cannot be considered valid.");
      // Saving final boxes is mandatory before marking an experiment complete.
      await persistAnnotations();
      const duration = Math.round(clockValue());
      const response = await fetch(`${API_URL}/sessions/${session.session_id}/finish`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          active_duration_ms: duration,
          inference_ms: Number(inferenceTotalRef.current.toFixed(2)),
        }),
      });
      if (!response.ok) throw new Error(`Finish HTTP ${response.status}`);
      const data = await response.json();
      sessionRef.current = null;
      setSession(null);
      setPaused(false);
      setMessage(`Session completed. Human session time: ${formatTime(duration)}. ID: ${data.session_id}`);
    } catch (error) {
      if (wasRunning) resumeClock();
      setMessage(`Finish failed: ${error.message}`);
    } finally {
      sessionBusyRef.current = false;
      setSessionBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const img = new window.Image();
    setImage(null); setBoxes([]); setAiSuggestions([]);
    setSelectedId(null); setSelectedSuggestionId(null); setDrawing(null);
    setMessage(""); shapeRefs.current = {};
    img.onload = () => { if (!cancelled) setImage(img); };
    img.onerror = () => { if (!cancelled) setMessage("Could not load image."); };
    if (imageUrl) img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  useEffect(() => {
    if (!image || !imageId) return;
    let cancelled = false;
    async function restore() {
      try {
        const response = await fetch(`${API_URL}/images/${imageId}/annotations`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const imageScale = Math.min(900, image.width) / image.width;
        if (!cancelled) {
          setBoxes(data.annotations.map((a) => annotationToBox(a, imageScale)));
          setSelectedId(null);
        }
      } catch (error) {
        if (!cancelled) setMessage(`Restore failed: ${error.message}`);
      }
    }
    restore();
    return () => { cancelled = true; };
  }, [image, imageId]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const node = shapeRefs.current[selectedId];
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedId, boxes]);

  function selectBox(box) {
    setSelectedId(box.id); setSelectedSuggestionId(null); setLabel(box.label);
  }
  function selectSuggestion(s) {
    setSelectedSuggestionId(s.id); setSelectedId(null); setLabel(s.label);
  }
  function removeSuggestion(id) {
    setAiSuggestions((all) => all.filter((s) => s.id !== id));
    setSelectedSuggestionId(null);
  }
  async function generateAiSuggestions() {
    if (!image || !imageId || predicting || loading || sessionBusyRef.current) return;
    if (session && session.mode === "manual") {
      setMessage("AI suggestions are disabled during manual-only study sessions.");
      return;
    }
    if (session && paused) {
      setMessage("Resume the session before generating suggestions.");
      return;
    }
    if (aiSuggestions.length > 0 && !window.confirm("Replace pending suggestions?")) return;
    setPredicting(true);
    setMessage("Generating AI suggestions...");
    const shouldResume = Boolean(session && clockRef.current.since !== null);
    if (shouldResume) pauseClock();
    try {
      const response = await fetch(`${API_URL}/images/${imageId}/predict?conf=0.01`, { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setAiSuggestions(data.predictions.map((p) => ({
        id: p.prediction_id, label: p.label, confidence: p.confidence,
        x: p.bbox.x_min * scale, y: p.bbox.y_min * scale,
        width: (p.bbox.x_max - p.bbox.x_min) * scale,
        height: (p.bbox.y_max - p.bbox.y_min) * scale,
      })));
      setSelectedSuggestionId(null); setSelectedId(null);
      if (session) {
        inferenceTotalRef.current += data.inference_ms;
        setInferenceMs(inferenceTotalRef.current);
      }
      setMessage(`Generated ${data.predictions.length} AI suggestions.`);
    } catch (error) {
      setMessage(`Prediction failed: ${error.message}`);
    } finally {
      if (shouldResume) resumeClock();
      setPredicting(false);
    }
  }

  function acceptSuggestion() {
    if (!selectedSuggestion || !canEdit()) return;
    const box = { ...selectedSuggestion, source: "ai_accepted" };
    setBoxes((all) => [...all, box]);
    removeSuggestion(box.id); setSelectedId(box.id);
    recordEvent("ai_accept", box.id, { label: box.label, confidence: box.confidence });
    setMessage("AI suggestion accepted. Save annotations to persist.");
  }
  
function editSuggestion() {
  if (!selectedSuggestion || !canEdit()) return;

  // Select the AI suggestion for editing.
  // Do not count entering edit mode as an explicit acceptance.
  const box = {
    ...selectedSuggestion,
    source: "ai_accepted",
  };

  setBoxes((all) => [...all, box]);
  removeSuggestion(box.id);

  setSelectedId(box.id);
  setLabel(box.label);

  // ai_edit is recorded by updateBox only after a real change.
  setMessage("Edit this box by dragging, resizing, or changing class.");
}

  function rejectSuggestion() {
    if (!selectedSuggestion || !canEdit()) return;
    recordEvent("ai_reject", selectedSuggestion.id, {
      label: selectedSuggestion.label, confidence: selectedSuggestion.confidence,
    });
    removeSuggestion(selectedSuggestion.id);
    setMessage("Suggestion rejected; it will not become a final annotation.");
  }

  function updateBox(id, changes) {
    if (!canEdit()) return;
    const before = boxes.find((b) => b.id === id);
    if (!before) return;
    const changed = Object.entries(changes).some(([key, value]) =>
      typeof value === "number" ? Math.abs(value - before[key]) > 0.5 : before[key] !== value
    );
    if (!changed) return;
    setBoxes((all) => all.map((b) => b.id === id ? {
      ...b, ...changes,
      source: b.source === "ai_accepted" || b.source === "ai_edited" || b.source === "ai"
        ? "ai_edited" : "manual",
    } : b));
    if (before.source === "ai_accepted" || before.source === "ai_edited" || before.source === "ai") {
      recordEvent("ai_edit", id, { changes });
    }
  }
  function changeLabel(next) {
    setLabel(next);
    if (selectedId !== null) {
      updateBox(selectedId, { label: next });
      setMessage("Label changed. Save to persist.");
    }
  }
  function deleteSelected() {
    if (selectedId === null || !canEdit()) return;
    recordEvent("delete", selectedId);
    setBoxes((all) => all.filter((b) => b.id !== selectedId));
    setSelectedId(null);
    setMessage("Final annotation deleted. Save to persist.");
  }
  function startDrawing(event) {
    if (!canEdit() || event.target !== event.target.getStage()) return;
    const p = event.target.getStage().getPointerPosition();
    if (!p || p.x < 0 || p.y < 0 || p.x > width || p.y > height) return;
    setSelectedId(null); setSelectedSuggestionId(null);
    setDrawing({ x: p.x, y: p.y, width: 0, height: 0 });
  }
  function updateDrawing(event) {
    if (!drawing) return;
    const p = event.target.getStage().getPointerPosition();
    if (!p) return;
    const x = clamp(p.x, 0, width), y = clamp(p.y, 0, height);
    setDrawing((curr) => curr ? { ...curr, width: x - curr.x, height: y - curr.y } : null);
  }
  function finishDrawing() {
    if (!drawing) return;
    const x = Math.min(drawing.x, drawing.x + drawing.width);
    const y = Math.min(drawing.y, drawing.y + drawing.height);
    const boxWidth = Math.abs(drawing.width), boxHeight = Math.abs(drawing.height);
    if (boxWidth >= MIN_BOX_SIZE && boxHeight >= MIN_BOX_SIZE && canEdit()) {
      const id = crypto.randomUUID();
      setBoxes((all) => [...all, {
        id, x, y, width: boxWidth, height: boxHeight,
        label, source: "manual", confidence: null,
      }]);
      recordEvent("manual_add", id, { label });
      setMessage("Manual box created. Save to persist.");
    }
    setDrawing(null);
  }

  function serializeBox(box) {
    const xMin = clamp(box.x / scale, 0, image.width);
    const yMin = clamp(box.y / scale, 0, image.height);
    const xMax = clamp((box.x + box.width) / scale, 0, image.width);
    const yMax = clamp((box.y + box.height) / scale, 0, image.height);
    if (xMax <= xMin || yMax <= yMin) throw new Error("Invalid bounding box dimensions.");
    return {
      annotation_id: String(box.id), image_id: imageId,
      label: box.label, source: box.source ?? "manual", confidence: box.confidence ?? null,
      bbox: { x_min: xMin, y_min: yMin, x_max: xMax, y_max: yMax },
    };
  }
  async function persistAnnotations() {
    const response = await fetch(`${API_URL}/images/${imageId}/annotations`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(boxes.map(serializeBox)),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Save HTTP ${response.status}: ${payload.slice(0, 300)}`);
    }
    return response.json();
  }
  async function saveAnnotations() {
    if (!image || !imageId || loading || sessionBusyRef.current) return;
    setLoading(true);
    try {
      const result = await persistAnnotations();
      setMessage(`Saved ${result.saved_count} final annotations.`);
    } catch (error) {
      setMessage(`Save failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }
  async function reloadAnnotations() {
    if (!image || !imageId || loading || sessionBusyRef.current) return;
    if (session && !window.confirm("Reload will overwrite unsaved work in this study session. Continue?")) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/images/${imageId}/annotations`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setBoxes(data.annotations.map((a) => annotationToBox(a, scale)));
      setSelectedId(null);
      setMessage(`Loaded ${data.annotations.length} final annotations.`);
    } catch (error) {
      setMessage(`Reload failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (!image) return <p>{message || "Loading annotation image..."}</p>;
  return (
    <div>
      <h2>Human-in-the-Loop Annotation Editor</h2>
      <div style={{ border: "1px solid #888", borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <strong>Annotation Study Session</strong>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
          <label htmlFor="study-mode">Mode:</label>
          <select id="study-mode" value={studyMode} disabled={Boolean(session) || sessionBusy}
            onChange={(e) => setStudyMode(e.target.value)}>
            <option value="manual">Manual only</option>
            <option value="ai_assisted">AI-assisted</option>
          </select>
          {!session ? <button onClick={startSession} disabled={sessionBusy}>Start Session</button> : <>
            <button onClick={togglePause} disabled={sessionBusy || predicting}>{paused ? "Resume" : "Pause"}</button>
            <button onClick={finishSession} disabled={sessionBusy || predicting}>{sessionBusy ? "Finishing..." : "Finish Session"}</button>
          </>}
        </div>
        <p><strong>Timer:</strong> {formatTime(elapsedMs)} {session ? (paused ? "(paused)" : "(running)") : "(no active session)"}
          {" | "}<strong>YOLO model inference:</strong> {(inferenceMs / 1000).toFixed(2)} s</p>
        {session && <p style={{ fontSize: 12 }}>Session ID: {session.session_id} | Mode: {session.mode}</p>}
        {eventError && <p role="alert" style={{ color: "crimson" }}>{eventError}</p>}
        <p style={{ fontSize: 12 }}>Timer measures unpaused session time, excluding the AI request wait. Pauses are explicit. It is not automatic keyboard/mouse activity detection.</p>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="annotation-label">Object class: </label>
        <select id="annotation-label" value={label} onChange={(e) => changeLabel(e.target.value)}>
          <option value="car">Car</option><option value="truck">Truck</option><option value="pedestrian">Pedestrian</option>
        </select>
        <button type="button" onClick={deleteSelected} disabled={selectedId === null} style={{ marginLeft: 12 }}>Delete Selected Box</button>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <button onClick={saveAnnotations} disabled={loading || sessionBusy}>Save Annotations</button>
        <button onClick={reloadAnnotations} disabled={loading || sessionBusy}>Reload Annotations</button>
        <button onClick={generateAiSuggestions} disabled={predicting || loading || (session && session.mode === "manual") || sessionBusy}>
          {predicting ? "Generating..." : "Generate AI Suggestions"}
        </button>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="confidence-slider">Confidence threshold: <strong>{confidenceThreshold.toFixed(2)}</strong></label>
        <input id="confidence-slider" type="range" min="0.01" max="1" step="0.01"
          value={confidenceThreshold} onChange={(e) => {
            setConfidenceThreshold(Number(e.target.value)); setSelectedSuggestionId(null);
          }} style={{ marginLeft: 12 }}/>
      </div>
      <p><strong>Final annotations:</strong> {boxes.length} {" | "}
        <strong>Pending AI suggestions:</strong> {aiSuggestions.length} {" | "}
        <strong>Visible pending:</strong> {visibleSuggestions.length}</p>
      <p>Yellow dashed = pending AI prediction. Solid colored = human-reviewed or manual box.</p>
      {selectedSuggestion && <div style={{ border: "1px solid #eab308", padding: 12, marginBottom: 12 }}>
        <p><strong>Selected suggestion:</strong> {selectedSuggestion.label} | Confidence: {selectedSuggestion.confidence.toFixed(3)}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={acceptSuggestion}>Accept</button>
          <button onClick={editSuggestion}>Edit</button>
          <button onClick={rejectSuggestion}>Reject</button>
        </div>
      </div>}
      {message && <p role="status">{message}</p>}
      <p>Click a yellow box to review it, or draw and edit a solid box.</p>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <Stage width={width} height={height} onMouseDown={startDrawing}
          onMouseMove={updateDrawing} onMouseUp={finishDrawing}>
          <Layer><KonvaImage image={image} width={width} height={height} listening={false}/></Layer>
          <Layer>
            {visibleSuggestions.map((s) => <Rect key={`pending-${s.id}`} x={s.x} y={s.y}
              width={s.width} height={s.height} dash={[8, 5]}
              stroke={selectedSuggestionId === s.id ? "#f97316" : "#eab308"}
              strokeWidth={selectedSuggestionId === s.id ? 3 : 2}
              onClick={() => selectSuggestion(s)} onTap={() => selectSuggestion(s)}/>)}
            {selectedSuggestion && selectedSuggestion.confidence >= confidenceThreshold &&
              <KonvaText x={selectedSuggestion.x} y={Math.max(0, selectedSuggestion.y - 19)}
                text={`${selectedSuggestion.label} ${selectedSuggestion.confidence.toFixed(2)}`}
                fontSize={15} fill="#eab308" listening={false}/>}
          </Layer>
          <Layer>
            {boxes.map((box) => <Rect key={box.id}
              ref={(node) => { if (node) shapeRefs.current[box.id] = node; else delete shapeRefs.current[box.id]; }}
              x={box.x} y={box.y} width={box.width} height={box.height}
              stroke={COLORS[box.label] ?? "#ffffff"} strokeWidth={2} draggable
              dragBoundFunc={(pos) => ({
                x: clamp(pos.x, 0, Math.max(0, width - box.width)),
                y: clamp(pos.y, 0, Math.max(0, height - box.height)),
              })}
              onClick={() => selectBox(box)} onTap={() => selectBox(box)}
              onDragEnd={(e) => updateBox(box.id, { x: e.target.x(), y: e.target.y() })}
              onTransformEnd={(e) => {
                const node = e.target;
                const rawWidth = node.width() * node.scaleX(), rawHeight = node.height() * node.scaleY();
                node.scaleX(1); node.scaleY(1);
                const x = clamp(node.x(), 0, width - MIN_BOX_SIZE);
                const y = clamp(node.y(), 0, height - MIN_BOX_SIZE);
                const newWidth = clamp(rawWidth, MIN_BOX_SIZE, width - x);
                const newHeight = clamp(rawHeight, MIN_BOX_SIZE, height - y);
                node.x(x); node.y(y); node.width(newWidth); node.height(newHeight);
                updateBox(box.id, { x, y, width: newWidth, height: newHeight });
              }}/>) }
            {drawing && <Rect x={Math.min(drawing.x, drawing.x + drawing.width)}
              y={Math.min(drawing.y, drawing.y + drawing.height)}
              width={Math.abs(drawing.width)} height={Math.abs(drawing.height)}
              stroke={COLORS[label]} strokeWidth={2} dash={[6, 4]} listening={false}/>}
            <Transformer ref={transformerRef} rotateEnabled={false} flipEnabled={false}
              boundBoxFunc={(oldBox, next) => {
                const valid = next.width >= MIN_BOX_SIZE && next.height >= MIN_BOX_SIZE &&
                  next.x >= 0 && next.y >= 0 && next.x + next.width <= width &&
                  next.y + next.height <= height;
                return valid ? next : oldBox;
              }}/>
          </Layer>
        </Stage>
      </div>
    </div>
  );
}
  