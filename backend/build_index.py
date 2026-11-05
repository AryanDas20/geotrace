"""Build an OpenCLIP + FAISS index from a curated reference-photo directory.

Expected layout:
reference_photos/
  location-001/
    metadata.json  # location_name, latitude, longitude, sign_text, source
    01.jpg
    02.jpg
  location-002/
    metadata.json
    reference.png
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import faiss
import numpy as np
import open_clip
import torch
from PIL import Image

ROOT = Path(os.getenv("REFERENCE_PHOTOS_DIR", "reference_photos"))
OUT = Path(os.getenv("REFERENCE_INDEX_DIR", "index"))
MODEL_NAME = os.getenv("OPENCLIP_MODEL", "ViT-B-32")
PRETRAINED = os.getenv("OPENCLIP_PRETRAINED", "laion2b_s34b_b79k")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def main():
    if not ROOT.exists():
        raise SystemExit(f"Reference directory not found: {ROOT.resolve()}")
    model, _, preprocess = open_clip.create_model_and_transforms(MODEL_NAME, pretrained=PRETRAINED)
    model.eval()
    vectors, metadata = [], []
    for folder in sorted(path for path in ROOT.iterdir() if path.is_dir()):
        meta_path = folder / "metadata.json"
        if not meta_path.exists():
            print(f"Skip {folder.name}: missing metadata.json")
            continue
        place = json.loads(meta_path.read_text(encoding="utf-8"))
        required = ["location_name", "latitude", "longitude", "source"]
        missing = [key for key in required if key not in place]
        if missing:
            print(f"Skip {folder.name}: metadata missing {', '.join(missing)}")
            continue
        for image_path in sorted(folder.iterdir()):
            if image_path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            try:
                with Image.open(image_path) as image:
                    tensor = preprocess(image.convert("RGB")).unsqueeze(0)
                with torch.no_grad():
                    embedding = model.encode_image(tensor)
                    embedding = embedding / embedding.norm(dim=-1, keepdim=True)
                vectors.append(embedding.cpu().numpy().astype("float32")[0])
                metadata.append({
                    "location_id": folder.name,
                    "location_name": place["location_name"],
                    "latitude": float(place["latitude"]),
                    "longitude": float(place["longitude"]),
                    "sign_text": place.get("sign_text", ""),
                    "search_text": place.get("search_text", ""),
                    "description": place.get("description", ""),
                    "source": place["source"],
                    "reference_id": f"{folder.name}/{image_path.name}",
                })
                print(f"Indexed {image_path}")
            except Exception as exc:
                print(f"Could not index {image_path}: {exc}")
    if not vectors:
        raise SystemExit("No valid reference images found. Add metadata.json and images first.")
    matrix = np.vstack(vectors).astype("float32")
    index = faiss.IndexFlatIP(matrix.shape[1])
    index.add(matrix)
    OUT.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(OUT / "reference.faiss"))
    (OUT / "reference_metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Done: {len(metadata)} reference images indexed into {OUT.resolve()}")


if __name__ == "__main__":
    main()
