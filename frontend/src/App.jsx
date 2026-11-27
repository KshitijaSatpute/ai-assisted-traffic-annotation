
import AnnotationCanvas from "./AnnotationCanvas";
import { useState } from "react";
import "./App.css";

const API_URL = "http://127.0.0.1:8000";

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  
const [uploadedImage, setUploadedImage] = useState(() => {
  try {
    const saved = localStorage.getItem("traffic_last_image");
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
});

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleUpload() {
    if (!selectedFile) {
      setError("Please select an image first.");
      return;
    }

    setLoading(true);
    setError("");
    setUploadedImage(null);

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch(`${API_URL}/images/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Image upload failed.");
      }

      
const imageData = {
  ...data,
  url: `${API_URL}${data.image_url}`,
};

setUploadedImage(imageData);

localStorage.setItem(
  "traffic_last_image",
  JSON.stringify(imageData)
);

    } catch (err) {
      setError(err.message || "Cannot connect to backend.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="app">
      <header>
        <h1>AI-Assisted Image Annotation Platform</h1>
        <p>Upload any image, define custom labels, and annotate with AI assistance.</p>
      </header>

      <section className="upload-card">
        <h2>Upload Image</h2>

        <input
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

        {error && <p className="error" role="alert">{error}</p>}

        {uploadedImage && (
          <div className="result">
            <h3>Upload Successful</h3>
            <p>Image ID: {uploadedImage.image_id}</p>
            <p>
              Dimensions: {uploadedImage.width} × {uploadedImage.height}
            </p>
            <img
              src={uploadedImage.url}
              alt="Uploaded traffic scene"
            />

          <AnnotationCanvas
  imageUrl={uploadedImage.url}
  imageId={uploadedImage.image_id}
/>


          </div>
        )}
      </section>
    </main>
  );
}

export default App;
