"""GeoTrace AI trusted API. Run with: uvicorn main:app --reload"""
from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timezone
from typing import Any
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).with_name(".env"))

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from analysis_engine import EngineNotConfigured, analyze_image

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("geotrace")

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
ALLOWED_ORIGINS = [v.strip() for v in os.getenv("ALLOWED_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500").split(",") if v.strip()]

EXPOSE_API_DOCS = os.getenv("EXPOSE_API_DOCS", "false").lower() == "true"
app = FastAPI(title="GeoTrace AI API", version="1.0.0", docs_url="/docs" if EXPOSE_API_DOCS else None, redoc_url="/redoc" if EXPOSE_API_DOCS else None, openapi_url="/openapi.json" if EXPOSE_API_DOCS else None)
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_credentials=True, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])
bearer = HTTPBearer(auto_error=False)
_firebase_app = None
_db = None


def get_firestore():
    global _firebase_app, _db
    if _db is not None:
        return _db
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        if not firebase_admin._apps:
            if FIREBASE_PROJECT_ID:
                firebase_admin.initialize_app(options={"projectId": FIREBASE_PROJECT_ID})
            else:
                firebase_admin.initialize_app(credentials.ApplicationDefault())
        _firebase_app = firebase_admin.get_app()
        _db = firestore.client()
        return _db
    except Exception as exc:
        logger.exception("Firebase Admin SDK could not initialize")
        raise HTTPException(status_code=503, detail="Firebase Admin is not configured on the API. Set GOOGLE_APPLICATION_CREDENTIALS or configure the backend service identity.") from exc


def verify_member(credentials: HTTPAuthorizationCredentials | None, org_id: str, write: bool = False) -> dict[str, Any]:
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="A Firebase ID token is required.")
    try:
        from firebase_admin import auth as firebase_auth
        identity = firebase_auth.verify_id_token(credentials.credentials, check_revoked=True)
    except Exception as exc:
        raise HTTPException(status_code=401, detail="The Firebase ID token is invalid or expired.") from exc
    db = get_firestore()
    member_ref = db.collection("orgs").document(org_id).collection("members").document(identity["uid"])
    member_snap = member_ref.get()
    member = member_snap.to_dict() if member_snap.exists else None
    if not member or member.get("status") != "approved":
        raise HTTPException(status_code=403, detail="Workspace access is pending administrator approval.")
    role = member.get("role")
    allowed = {"admin", "investigator"} if write else {"admin", "investigator", "reviewer"}
    if role not in allowed:
        raise HTTPException(status_code=403, detail="Your workspace role does not allow this operation.")
    return {"uid": identity["uid"], "email": identity.get("email", ""), "role": role, "org_id": org_id}


def write_audit(db, org_id: str, actor: dict[str, Any], action: str, object_id: str, detail: str) -> None:
    from firebase_admin import firestore
    ref = db.collection("orgs").document(org_id).collection("auditLogs").document()
    ref.set({
        "actorUid": actor["uid"], "actorEmail": actor.get("email", ""), "actorRole": actor["role"],
        "action": action, "objectType": "case", "objectId": object_id, "detail": detail,
        "createdAt": firestore.SERVER_TIMESTAMP,
    })


@app.get("/health")
def health():
    index_path = Path(os.getenv("REFERENCE_INDEX_PATH", "index/reference.faiss"))
    metadata_path = Path(os.getenv("REFERENCE_METADATA_PATH", "index/reference_metadata.json"))
    index_ready = index_path.is_file() and metadata_path.is_file()
    return {"ok": True, "service": "geotrace-ai", "analysis_index_configured": index_ready, "gemini_configured": bool(GEMINI_API_KEY)}


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    case_id: str = Form(...),
    org_id: str = Form(...),
    title: str = Form("Photo location review"),
    notes: str = Form(""),
    client_sha256: str = Form(""),
    storage_path: str = Form(""),
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
):
    actor = verify_member(credentials, org_id, write=True)
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/tiff", "application/octet-stream", None}
    extension = (file.filename or "").lower().rsplit(".", 1)[-1]
    allowed_extensions = {"jpg", "jpeg", "png", "webp", "tif", "tiff"}
    if file.content_type not in allowed_types or extension not in allowed_extensions:
        raise HTTPException(status_code=415, detail="Only JPG, PNG, WEBP, and TIFF evidence images are accepted.")
    image_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if not image_bytes or len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image is empty or exceeds the upload limit.")
    server_hash = hashlib.sha256(image_bytes).hexdigest()
    if client_sha256 and client_sha256.lower() != server_hash:
        raise HTTPException(status_code=409, detail="The client and server SHA-256 fingerprints do not match. Preserve the original and retry.")

    db = get_firestore()
    case_ref = db.collection("orgs").document(org_id).collection("cases").document(case_id)
    case_snap = case_ref.get()
    if not case_snap.exists:
        raise HTTPException(status_code=404, detail="The case does not exist in this organization.")
    case_data = case_snap.to_dict() or {}
    if case_data.get("createdBy") != actor["uid"] and actor["role"] != "admin":
        raise HTTPException(status_code=403, detail="You can only submit evidence to a case you created, unless you are an admin.")
    if case_data.get("status") not in {"draft", "submitted"}:
        raise HTTPException(status_code=409, detail="This case is not in a state that accepts new analysis.")

    expected_storage_prefix = f"orgs/{org_id}/cases/{case_id}/evidence/{actor['uid']}/"
    if storage_path and (not storage_path.startswith(expected_storage_prefix) or ".." in storage_path.split("/")):
        raise HTTPException(status_code=400, detail="The evidence storage path does not match this user's case upload path.")

    now = datetime.now(timezone.utc)
    evidence_ref = case_ref.collection("evidence").document()
    evidence_ref.set({
        "fileName": file.filename or "evidence-image", "contentType": file.content_type,
        "sizeBytes": len(image_bytes), "sha256": server_hash, "storagePath": storage_path,
        "uploadedBy": actor["uid"], "createdAt": now,
    })
    case_ref.update({"status": "analyzing", "updatedAt": now, "title": title, "notes": notes, "sha256": server_hash, "evidenceCount": int(case_data.get("evidenceCount", 0)) + 1})
    write_audit(db, org_id, actor, "evidence_uploaded", case_id, f"Evidence fingerprint {server_hash}")
    write_audit(db, org_id, actor, "analysis_started", case_id, f"Evidence fingerprint {server_hash}")
    try:
        analysis = analyze_image(image_bytes)
    except EngineNotConfigured as exc:
        case_ref.update({"status": "draft", "updatedAt": datetime.now(timezone.utc), "lastError": str(exc)})
        write_audit(db, org_id, actor, "analysis_blocked", case_id, str(exc))
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Analysis engine failed")
        case_ref.update({"status": "draft", "updatedAt": datetime.now(timezone.utc), "lastError": "Analysis engine failed"})
        write_audit(db, org_id, actor, "analysis_failed", case_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail="The analysis engine failed. Check backend logs and retry after correcting the engine configuration.") from exc

    now = datetime.now(timezone.utc)
    case_ref.update({
        "status": "review", "updatedAt": now,
        "analysis": analysis,
        "lastError": "",
    })
    write_audit(db, org_id, actor, "analysis_completed", case_id, f"{len(analysis.get('candidates', []))} candidate lead(s); sha256={server_hash}")
    return {
        "caseId": case_id, "sha256": server_hash,
        "metadata": analysis.get("metadata", {}), "ocr": analysis.get("ocr", {}),
        "candidates": analysis.get("candidates", []),
        "case": {"id": case_id, "title": title, "status": "review", "evidenceCount": int(case_data.get("evidenceCount", 0)) + 1},
        "limitations": analysis.get("limitations", []),
    }


class AgentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    org_id: str = Field(min_length=1, max_length=128)
    context: dict[str, Any] = Field(default_factory=dict)


class AgentExecuteRequest(BaseModel):
    org_id: str = Field(min_length=1, max_length=128)
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    confirmed: bool = False


@app.post("/api/agent")
def agent(request: AgentRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    actor = verify_member(credentials, request.org_id, write=False)
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="The server-side Gemini API key is not configured.")
    try:
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=GEMINI_API_KEY)
        declarations = [
            types.FunctionDeclaration(
                name="search_cases", description="Search case IDs and titles in the current organization. This is read-only.",
                parameters_json_schema={"type": "object", "properties": {"query": {"type": "string", "description": "Case ID or words to find"}}, "required": ["query"]},
            ),
            types.FunctionDeclaration(
                name="case_summary", description="Read a single case summary in the current organization. This is read-only.",
                parameters_json_schema={"type": "object", "properties": {"case_id": {"type": "string", "description": "Exact case document ID"}}, "required": ["case_id"]},
            ),
            types.FunctionDeclaration(
                name="prepare_report", description="Prepare a text report from one case. This does not submit, delete, or alter the case.",
                parameters_json_schema={"type": "object", "properties": {"case_id": {"type": "string", "description": "Exact case document ID"}}, "required": ["case_id"]},
            ),
        ]
        system = (
            "You are Agent37 Hermes, the GeoTrace AI workspace assistant. You can explain metadata, OCR, visual similarity,"
            " evidence hashing, candidate ranking, workflow limitations, and report structure. You may propose only these read-only"
            " tools: search_cases, case_summary, prepare_report. Never claim a place is proven. Similarity is not probability."
            " Missing GPS is not proof of tampering. Never request secrets, bypass permissions, or propose unrestricted database access."
            " When a tool is needed, call it and wait for explicit user approval; the application executes tools only after confirmation."
            " State when the reference index or evidence is unavailable."
        )
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=request.message,
            config=types.GenerateContentConfig(
                system_instruction=system,
                tools=[types.Tool(function_declarations=declarations)],
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
        calls = response.function_calls or []
        if calls:
            call = calls[0]
            args = dict(call.args or {})
            if call.name not in {"search_cases", "case_summary", "prepare_report"}:
                raise HTTPException(status_code=400, detail="The model proposed a tool that is not allow-listed.")
            return {"answer": "I have a read-only workspace action ready. Review it before execution.", "proposed_action": {"name": call.name, "args": args, "description": f"{call.name.replace('_', ' ').capitalize()} · {args}"}}
        answer = (response.text or "I could not produce a response.").strip()
        return {"answer": answer, "proposed_action": None}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Gemini agent request failed")
        raise HTTPException(status_code=502, detail="The AI service request failed. Check the configured model, API quota, and backend logs.") from exc


@app.post("/api/agent/execute")
def execute_agent_action(request: AgentExecuteRequest, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if not request.confirmed:
        raise HTTPException(status_code=400, detail="Explicit user confirmation is required.")
    actor = verify_member(credentials, request.org_id, write=False)
    db = get_firestore()
    cases_ref = db.collection("orgs").document(request.org_id).collection("cases")
    tool = request.tool
    if tool == "search_cases":
        query = str(request.args.get("query", "")).strip().lower()[:120]
        if not query:
            raise HTTPException(status_code=400, detail="A search query is required.")
        docs = cases_ref.limit(100).stream()
        matches = []
        for doc in docs:
            value = doc.to_dict() or {}
            if query in f"{doc.id} {value.get('title','')} {value.get('status','')}".lower():
                matches.append({"id": doc.id, "title": value.get("title", ""), "status": value.get("status", "")})
        write_audit(db, request.org_id, actor, "agent_search_cases", "", f"Hermes searched {query!r}; {len(matches)} match(es)")
        return {"message": f"Found {len(matches)} matching case(s).", "result": matches}
    if tool in {"case_summary", "prepare_report"}:
        case_id = str(request.args.get("case_id", "")).strip()
        if not case_id or len(case_id) > 128:
            raise HTTPException(status_code=400, detail="A valid case ID is required.")
        snap = cases_ref.document(case_id).get()
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Case not found in this organization.")
        value = snap.to_dict() or {}
        analysis = value.get("analysis", {}) or {}
        candidates = analysis.get("candidates", [])
        lines = [f"Case {case_id}: {value.get('title','Untitled')}", f"Status: {value.get('status','unknown')}", f"Evidence count: {value.get('evidenceCount',0)}", f"SHA-256: {value.get('sha256','Not recorded')}"]
        for index, candidate in enumerate(candidates[:3], start=1):
            lines.append(f"{index}. {candidate.get('name','Candidate')} — similarity {candidate.get('score','not scored')} — {candidate.get('reason','No reason supplied')}")
        lines.append("Limit: model-generated similarity is a lead, not proof of location. Independent human verification is required.")
        write_audit(db, request.org_id, actor, "agent_case_read", case_id, f"Hermes executed {tool}")
        return {"message": "\n".join(lines), "result": {"case_id": case_id, "title": value.get("title", ""), "candidates": candidates[:3]}}
    raise HTTPException(status_code=400, detail="This agent tool is not allow-listed. No action was performed.")
