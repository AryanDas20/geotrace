"""Reference-image retrieval pipeline used by GeoTrace AI.

A real result requires a curated reference index created by build_index.py.
Scores are normalized similarity-ranking values, never probabilities.
"""
from __future__ import annotations

import io
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ExifTags


class EngineNotConfigured(RuntimeError):
    pass


def _dms_to_degrees(value) -> float:
    parts = [float(item[0]) / float(item[1]) for item in value]
    return parts[0] + parts[1] / 60 + parts[2] / 3600


def extract_metadata(image: Image.Image) -> dict[str, Any]:
    result: dict[str, Any] = {"gps": "Not found", "datetime": None, "camera": None, "orientation": None}
    try:
        exif = image.getexif()
        if not exif:
            return result
        tags = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
        result["datetime"] = str(tags.get("DateTimeOriginal") or tags.get("DateTime") or "") or None
        make, model = tags.get("Make"), tags.get("Model")
        result["camera"] = " ".join(str(part).strip() for part in (make, model) if part) or None
        result["orientation"] = tags.get("Orientation")
        gps_ifd = exif.get_ifd(34853)
        if gps_ifd:
            gps = {ExifTags.GPSTAGS.get(key, key): value for key, value in gps_ifd.items()}
            lat, lon = gps.get("GPSLatitude"), gps.get("GPSLongitude")
            lat_ref, lon_ref = gps.get("GPSLatitudeRef"), gps.get("GPSLongitudeRef")
            if lat and lon:
                latitude = _dms_to_degrees(lat) * (-1 if str(lat_ref).upper() == "S" else 1)
                longitude = _dms_to_degrees(lon) * (-1 if str(lon_ref).upper() == "W" else 1)
                result["gps"] = "Detected"
                result["latitude"] = latitude
                result["longitude"] = longitude
    except Exception:
        # Malformed or partial metadata should not block image analysis.
        pass
    return result


@lru_cache(maxsize=1)
def _load_ocr():
    try:
        from paddleocr import PaddleOCR
        # PaddleOCR's v2 API is pinned in requirements-vision.txt.
        return PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    except Exception:
        return None


@lru_cache(maxsize=1)
def _load_visual_model():
    try:
        import open_clip
        import torch
        model_name = os.getenv("OPENCLIP_MODEL", "ViT-B-32")
        pretrained = os.getenv("OPENCLIP_PRETRAINED", "laion2b_s34b_b79k")
        model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained)
        model.eval()
        return model, preprocess, torch
    except Exception as exc:
        raise EngineNotConfigured("OpenCLIP is not installed or its model weights are unavailable. Install backend/requirements-vision.txt and retry.") from exc


@lru_cache(maxsize=1)
def _load_index():
    index_path = Path(os.getenv("REFERENCE_INDEX_PATH", "index/reference.faiss"))
    metadata_path = Path(os.getenv("REFERENCE_METADATA_PATH", "index/reference_metadata.json"))
    if not index_path.exists() or not metadata_path.exists():
        raise EngineNotConfigured("The reference-photo index is not configured. Add licensed, verified reference photos and build the FAISS index with build_index.py before running live analyses.")
    try:
        import faiss
    except Exception as exc:
        raise EngineNotConfigured("FAISS is not installed. Install backend/requirements-vision.txt in a compatible environment.") from exc
    index = faiss.read_index(str(index_path))
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if index.ntotal != len(metadata):
        raise EngineNotConfigured("The reference index and metadata catalogue have different record counts. Rebuild the index.")
    return index, metadata


def _read_ocr(image: Image.Image) -> list[str]:
    engine = _load_ocr()
    if engine is None:
        return []
    import numpy as np
    raw = engine.ocr(np.array(image.convert("RGB")), cls=True)
    texts: list[str] = []
    for page in raw or []:
        for line in page or []:
            try:
                text = str(line[1][0]).strip()
                if text:
                    texts.append(text)
            except (IndexError, TypeError):
                continue
    return texts


def _text_similarity(query: str, reference: str) -> float:
    if not query or not reference:
        return 0.0
    try:
        from rapidfuzz import fuzz
        return float(fuzz.token_set_ratio(query, reference)) / 100.0
    except ImportError:
        from difflib import SequenceMatcher
        return SequenceMatcher(None, query.casefold(), reference.casefold()).ratio()


def analyze_image(image_bytes: bytes) -> dict[str, Any]:
    try:
        with Image.open(io.BytesIO(image_bytes)) as source_image:
            metadata = extract_metadata(source_image)
            image = source_image.convert("RGB")
    except Exception as exc:
        raise ValueError("The uploaded evidence is not a readable image.") from exc

    ocr_texts = _read_ocr(image)
    index, reference_metadata = _load_index()
    model, preprocess, torch = _load_visual_model()

    with torch.no_grad():
        tensor = preprocess(image).unsqueeze(0)
        embedding = model.encode_image(tensor)
        embedding = embedding / embedding.norm(dim=-1, keepdim=True)
        vector = embedding.cpu().numpy().astype("float32")
    distances, indexes = index.search(vector, min(100, index.ntotal))
    combined_text = " ".join(ocr_texts).strip()

    ranked: dict[str, dict[str, Any]] = {}
    for raw_similarity, row_index in zip(distances[0], indexes[0]):
        if row_index < 0:
            continue
        record = reference_metadata[int(row_index)]
        location_id = str(record.get("location_id") or record.get("location_name") or row_index)
        visual_score = max(0.0, min(1.0, (float(raw_similarity) + 1.0) / 2.0))
        text_ref = " ".join(str(record.get(key, "")) for key in ("location_name", "sign_text", "search_text", "description"))
        text_score = _text_similarity(combined_text, text_ref) if combined_text else 0.0
        ranking_score = (0.72 * visual_score + 0.28 * text_score) if combined_text else (0.88 * visual_score)
        existing = ranked.get(location_id)
        if existing is None or ranking_score > existing["score"]:
            reason = "Visual reference + OCR text similarity" if combined_text and text_score > 0 else "Visual reference similarity only"
            ranked[location_id] = {
                "name": record.get("location_name") or "Unlabeled reference location",
                "score": round(ranking_score, 4),
                "visualScore": round(visual_score, 4),
                "textScore": round(text_score, 4) if combined_text else None,
                "reason": reason,
                "referenceId": record.get("reference_id") or str(row_index),
                "latitude": record.get("latitude"), "longitude": record.get("longitude"),
                "source": record.get("source") or "Organization reference index",
            }
    candidates = sorted(ranked.values(), key=lambda item: item["score"], reverse=True)[:3]
    limitations = []
    if not ocr_texts:
        limitations.append("No readable OCR text was extracted; candidate ranking relies on visual similarity only.")
    if metadata.get("gps") == "Not found":
        limitations.append("No embedded GPS coordinates were detected. This does not establish whether metadata was removed or altered.")
    limitations.append("Reference similarity is not a probability and does not prove capture location. Human verification is required.")
    return {
        "metadata": metadata,
        "ocr": {"text": " | ".join(ocr_texts), "items": ocr_texts},
        "candidates": candidates,
        "limitations": limitations,
    }
