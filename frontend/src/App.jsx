
import { useEffect, useState } from "react";
import AnnotationCanvas from "./AnnotationCanvas";
import "./App.css";

const API_URL = "http://127.0.0.1:8000";

function App() {
  const [projects, setProjects] = useState([]);
  const [projectImages, setProjectImages] = useState([]);
const [galleryRefresh, setGalleryRefresh] = useState(0);
const [galleryLoading, setGalleryLoading] = useState(false);
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

useEffect(() => {
  let cancelled = false;

  if (!projectId) {
    setProjectImages([]);
    setGalleryLoading(false);
    return;
  }

  async function fetchProjectImages() {
    setGalleryLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/projects/${projectId}/images`
      );

      if (!response.ok) {
        throw new Error("Cannot load project images.");
      }

      const data = await response.json();

      if (!cancelled) {
        setProjectImages(data.images);
      }
    } catch (err) {
      if (!cancelled) {
        setError(err.message);
        setProjectImages([]);
      }
    } finally {
      if (!cancelled) {
        setGalleryLoading(false);
      }
    }
  }

  fetchProjectImages();

  return () => {
    cancelled = true;
  };
}, [projectId, galleryRefresh]);

function openGalleryImage(image) {
  setUploadedImage({
    image_id: image.image_id,
    image_url: image.image_url,
    url: `${API_URL}${image.image_url}`,
    projectId,
    width: null,
    height: null,
  });

  setMessage("Image opened. Existing annotations will load.");
  setError("");
}


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
setGalleryRefresh((value) => value + 1);
      setMessage("Image uploaded successfully.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <header className="studio-header">
        <div>
          <h1>Labelix AI</h1>
          <p>Intelligent Image Annotation Studio</p>
        </div>

        <span className="studio-header-tag">
          Human-in-the-Loop AI
        </span>
      </header>

      <div className="studio-layout">
        <aside className="studio-sidebar">
          <div className="sidebar-heading">
            <h2>Project Setup</h2>
            <p>Manage your annotation workspace</p>
          </div>

          <section className="sidebar-section">
            <h3>01 / Select Project</h3>

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
              <option value="">
                Legacy Mode (Traffic Study)
              </option>

              {projects.map((project) => (
                <option
                  key={project.project_id}
                  value={project.project_id}
                >
                  {project.name}
                </option>
              ))}
            </select>

            <label className="field-label" htmlFor="project-name">
              Create New Project
            </label>

            <input
              id="project-name"
              type="text"
              placeholder="Project name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              maxLength={100}
            />

            <button onClick={createProject} disabled={loading}>
              Create Project
            </button>
          </section>

          {selectedProject && (
            <section className="sidebar-section">
              <h3>02 / Project Labels</h3>

              <div className="label-list">
                {selectedProject.labels.length > 0
                  ? selectedProject.labels.map((name) => (
                      <span className="label-chip" key={name}>
                        {name}
                      </span>
                    ))
                  : <p>No labels added yet.</p>}
              </div>

              <label className="field-label" htmlFor="new-project-label">
                Add Object Class
              </label>

              <input
                id="new-project-label"
                type="text"
                placeholder="e.g. bottle"
                value={newLabel}
                onChange={(event) => setNewLabel(event.target.value)}
                maxLength={50}
              />

              <button onClick={addLabel} disabled={loading}>
                Add Label
              </button>
            </section>
          )}

          <section className="sidebar-section">
            <h3>03 / Upload Image</h3>

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
          </section>

{projectId && (
  <section className="sidebar-section">
    <h3>04 / My Images</h3>

    {galleryLoading && <p>Loading images...</p>}

    {!galleryLoading && projectImages.length === 0 && (
      <p className="gallery-empty">No images uploaded yet.</p>
    )}

    <div className="image-gallery">
      {projectImages.map((image) => (
        <button
          key={image.image_id}
          type="button"
          className="gallery-item"
          onClick={() => openGalleryImage(image)}
          title={`Open image ${image.image_id}`}
        >
          <img
            src={`${API_URL}${image.image_url}`}
            alt="Project upload"
            loading="lazy"
          />
          <span>{image.image_id.slice(0, 8)}</span>
        </button>
      ))}
    </div>
  </section>
)}
{projectId && (
  <section className="sidebar-section">
    <h3>05 / Export Dataset</h3>

    <p className="gallery-empty">
      Download project annotations with source images.
    </p>

    <a
      className="dataset-export-button"
      href={`${API_URL}/projects/${projectId}/export/coco`}
      download
    >
      Download COCO Dataset ZIP
    </a>
  </section>
)}
          {error && <p role="alert" className="error">{error}</p>}
          {message && <p role="status" className="studio-message">{message}</p>}
        </aside>

        <section className="studio-main">
          <div className="workspace-heading">
            <div>
              <h2>Annotation Workspace</h2>
              <p>
                Draw bounding boxes, review AI suggestions,
                and export annotations.
              </p>
            </div>

            <span className="workspace-status">
              {uploadedImage ? "Image Loaded" : "Ready"}
            </span>
          </div>

          {uploadedImage ? (
            <div className="result">
              <div className="image-details">
                <strong>Current Image</strong>
                <span>
                  {uploadedImage.width} x {uploadedImage.height} px
                </span>
              </div>

              <AnnotationCanvas
                key={uploadedImage.image_id}
                imageUrl={uploadedImage.url}
                imageId={uploadedImage.image_id}
                projectId={uploadedImage.projectId || null}
                projectLabels={
                  uploadedImage.projectId
                    ? selectedProject?.labels ?? []
                    : null
                }
              />
            </div>
          ) : (
            <div className="workspace-empty">
              <div className="empty-icon">+</div>
              <h3>Your annotation workspace is ready</h3>
              <p>
                Select a project and upload an image to begin annotating.
              </p>
              <span>Manual Annotation · AI Suggestions · COCO Export</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
