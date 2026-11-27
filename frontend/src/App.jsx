
import { useEffect, useState } from "react";
import AnnotationCanvas from "./AnnotationCanvas";
import "./App.css";

const API_URL = "http://127.0.0.1:8000";

function App() {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadedImage, setUploadedImage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const selectedProject = projects.find(
    (project) => project.project_id === projectId
  );

  async function loadProjects() {
    const response = await fetch(`${API_URL}/projects`);
    if (!response.ok) throw new Error("Cannot load projects.");

    const data = await response.json();
    setProjects(data.projects);
  }

  useEffect(() => {
    loadProjects().catch((err) => setError(err.message));
  }, []);

  async function createProject() {
    const name = projectName.trim();

    if (!name) {
      setError("Enter a project name.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_URL}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) throw new Error("Project creation failed.");

      const project = await response.json();

      await loadProjects();
      setProjectId(project.project_id);
      setUploadedImage(null);
      setSelectedFile(null);
      setProjectName("");
      setMessage("Project created successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function addLabel() {
    const label = newLabel.trim().toLowerCase().replace(/\s+/g, "_");

    if (!projectId || !label) {
      setError("Select a project and enter a label.");
      return;
    }

    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(label)) {
      setError("Use lowercase letters, numbers, _ or -.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/projects/${projectId}/labels`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || "Cannot add label.");
      }

      await loadProjects();
      setNewLabel("");
      setMessage(`Label "${label}" added.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload() {
    if (!selectedFile) {
      setError("Select an image first.");
      return;
    }

    if (projectId && selectedProject?.labels.length === 0) {
      setError("Add at least one project label before uploading.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const endpoint = projectId
        ? `${API_URL}/projects/${projectId}/images/upload`
        : `${API_URL}/images/upload`;

      const response = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Image upload failed.");
      }

      setUploadedImage({
        ...data,
        url: `${API_URL}${data.image_url}`,
        projectId,
      });

      setMessage("Image uploaded successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <header>
        <h1>AI-Assisted Image Annotation Platform</h1>
        <p>
          Create projects, define object labels, and annotate images.
        </p>
      </header>

      <section className="upload-card">
        <h2>1. Select Project</h2>

        <select
          aria-label="Select project"
          value={projectId}
          onChange={(event) => {
            setProjectId(event.target.value);
            setUploadedImage(null);
            setSelectedFile(null);
            setError("");
            setMessage("");
          }}
        >
          <option value="">Legacy Mode (Existing Traffic Study)</option>

          {projects.map((project) => (
            <option key={project.project_id} value={project.project_id}>
              {project.name}
            </option>
          ))}
        </select>

        <h3>Create New Project</h3>

        <input
          type="text"
          placeholder="e.g. Product Annotation"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          maxLength={100}
        />

        <button onClick={createProject} disabled={loading}>
          Create Project
        </button>

        {selectedProject && (
          <div>
            <h2>2. Project Labels</h2>

            <p>
              <strong>Current labels:</strong>{" "}
              {selectedProject.labels.join(", ") || "No labels yet"}
            </p>

            <input
              type="text"
              placeholder="e.g. dog"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              maxLength={50}
            />

            <button onClick={addLabel} disabled={loading}>
              Add Label
            </button>
          </div>
        )}

        <h2>3. Upload Image</h2>

        <input
          key={projectId}
          type="file"
          accept="image/png,image/jpeg"
          onChange={(event) => {
            setSelectedFile(event.target.files?.[0] ?? null);
            setError("");
          }}
        />

        <button onClick={handleUpload} disabled={loading}>
          {loading ? "Uploading..." : "Upload Image"}
        </button>

        {error && <p role="alert" className="error">{error}</p>}
        {message && <p role="status">{message}</p>}

        {uploadedImage && (
          <div className="result">
            <h3>Image Uploaded</h3>

            <p>Image ID: {uploadedImage.image_id}</p>

            <p>
              Dimensions: {uploadedImage.width} x {uploadedImage.height}
            </p>

            <AnnotationCanvas
              key={uploadedImage.image_id}
              imageUrl={uploadedImage.url}
              imageId={uploadedImage.image_id}
              projectLabels={
                uploadedImage.projectId
                  ? selectedProject?.labels ?? []
                  : null
              }
            />
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
