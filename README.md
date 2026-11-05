# GeoTrace AI — Photo Intelligence Workspace

A multi-view HTML/CSS/JavaScript application based on the Phoenix Coders **GeoTrace AI** proposal and the supplied terracotta palette. The frontend is deliberately framework-free. Firebase is optional while exploring the demo; live investigations require Google Authentication, Firestore, Storage, an approved organization membership, and the trusted FastAPI analysis service.

> **Important:** the supplied presentation describes a proposed system and an illustrative DEMO-001 workflow. The displayed phrase “SHREE GANGA SWEETS”, `Place A / B / C`, and scores `0.81 / 0.67 / 0.52` are fictional fixture values. They are not detections from an uploaded file. Do not use demo mode with sensitive evidence.

## 1. What is included

### Application screens

- **Overview:** workspace summary, recent case, evidence signals, analysis pipeline, and quick actions.
- **Investigations:** searchable/filterable case register with case detail view.
- **New Analysis:** drag-and-drop photo upload, file size/type checks, SHA-256 fingerprint, case details, authorization confirmation, progress, and result review.
- **Map Explorer:** candidate list and Leaflet/OpenStreetMap map when live analysis returns coordinates. The proposal's fictional demo candidates have no coordinates, so the demo map correctly stays in an empty state.
- **Evidence Vault:** file and hash register with explicit placeholder status for the presentation fixture.
- **Reports:** structured case summary export with evidence, leads, limitations, and review warning.
- **Audit Trail:** event timeline and JSON export. The demo log is local and illustrative; production events are written by the trusted API.
- **AI Workbench:** Agent37 / Hermes chat, prompt shortcuts, app navigation, case search, report preparation, and safe-workflow explanations.
- **Settings:** Firebase and API connection fields, access model, theme, AI setup, and retention guidance.
- **Help & Guide:** feature explanations, FAQ, and a six-step guided tour that highlights the relevant part of the site.

### Interaction and quality features

- Light and dark themes using your screenshot's color palette.
- Responsive desktop, tablet, and mobile layouts.
- Global search / command palette (`Ctrl/Cmd + K`).
- Hermes drawer (`Ctrl/Cmd + J`).
- Keyboard shortcuts (`Ctrl/Cmd + 1`, `2`, `3`).
- Toast messages, empty states, progress states, file preview, and form validation.
- Reduced-motion support and semantic dialog labels.
- Frontend fallback demo mode when Firebase credentials are not supplied.
- Optional Firebase modular Web SDK, loaded only after valid configuration is entered.
- FastAPI backend with Firebase ID-token verification, organization role checks, server-side hash verification, OCR/visual-search adapter, and optional Gemini tool calling.
- Firestore and Cloud Storage rules that deny access by default and prevent users from granting themselves roles.

## 2. Quick start — preview the website

You need a modern browser and Python 3 (or another static web server). From this project directory:

```bash
python -m http.server 5500
```

Open `http://localhost:5500`.

The site starts in **Demo mode**. You can navigate all screens, toggle themes, take the guide tour, upload a non-sensitive test image, calculate its local SHA-256 hash, and see the fictional proposal fixture. The fixture's OCR phrase and sample candidates are not calculated from your image.

Opening `index.html` directly with `file://` is not supported because the frontend uses JavaScript modules. Use a local web server or Firebase Hosting.

## 3. Firebase setup for Google login and live data

### A. Create the project

1. Open the [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Register a **Web App** inside the project and copy its web configuration.
3. In **Authentication → Sign-in method**, enable **Google**.
4. In **Authentication → Settings → Authorized domains**, add `localhost` for local development and your real deployed domain.
5. Create a **Cloud Firestore** database and enable **Cloud Storage**.
6. Billing may be required for some Firebase Storage configurations and production use. Review the current Firebase plan and regional requirements before deployment.

### B. Add the client configuration

Two choices are supported:

- Use **Settings → Connections** in the app and paste the Firebase Web App values. The values are stored in this browser's local storage only; or
- Edit `src/config.js` and fill in `FIREBASE_CONFIG`.

Set `APP_CONFIG.organizationId` in `src/config.js` to your chosen organization ID. It must match the `--org` value used for the first-admin bootstrap below.

The Firebase Web API key is not a service-account secret. Firebase client configuration is expected to be visible in the browser; security comes from Authentication, restrictive rules, and trusted server verification. Never place a service-account JSON file or Gemini API key in frontend code.

### C. Deploy rules

Install the Firebase CLI and sign in:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
```

The included `firebase.json` points to:

- `firebase/firestore.rules`
- `firebase/storage.rules`

Deploy the rules:

```bash
firebase deploy --only firestore:rules,storage
```

The rules are intentionally restrictive. They do **not** allow public database access. The first admin cannot create their own membership from the client.

### D. Bootstrap the first admin

The intended flow is:

1. The administrator signs in once using Google so the Firebase Authentication user exists.
2. A trusted operator with Firebase Admin credentials runs the bootstrap script.
3. That script grants the specified user `role: admin` and `status: approved` for the configured organization.

Create a Python environment and install the base backend dependencies as described in section 4. Configure Application Default Credentials or `GOOGLE_APPLICATION_CREDENTIALS` in the trusted environment, then run:

```bash
export FIREBASE_PROJECT_ID="your-firebase-project-id"
python scripts/bootstrap_admin.py --email "admin@example.org" --org "geotrace-workspace"
```

Do not expose the service account to the browser or commit it to source control. After the first admin exists, organization admins can provision other members using a trusted admin process or a separate admin-only backend endpoint. This starter does not provide a self-service role editor.

### E. Role model

The rules and API expect an organization membership document at:

```text
orgs/{organizationId}/members/{firebaseUid}
```

Example:

```json
{
  "uid": "FIREBASE_AUTH_UID",
  "email": "investigator@example.org",
  "displayName": "Investigator Name",
  "role": "investigator",
  "status": "approved"
}
```

Supported roles in this starter:

- `admin`: manage workspace membership through trusted admin processes, read cases, and administer cases.
- `investigator`: create cases and submit evidence for analysis; read cases they are permitted to access.
- `reviewer`: read and review investigation records; cannot submit new analyses.

In this starter, all approved members of the same organization can read that organization's cases; investigators can create and update only their own draft cases, and admins can administer cases. Storage evidence is readable by approved organization members but cannot be deleted from the browser. Add case-level assignment restrictions if your agency requires investigators to see only assigned records.

## 4. Start the FastAPI backend

Use Python 3.10 or 3.11 for the optional computer-vision dependencies. From the project directory:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\\Scripts\\activate
pip install -r backend/requirements.txt
```

Copy `backend/.env.example` to `backend/.env` or set the same variables in your hosting environment. Do not commit `.env`.

Required settings:

```text
FIREBASE_PROJECT_ID=your-firebase-project-id
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json   # local only; use a service identity in cloud hosting
ALLOWED_ORIGINS=http://localhost:5500,https://your-real-host.example
```

For live analysis, install the vision dependencies in a compatible environment:

```bash
pip install -r backend/requirements-vision.txt
```

Then add your licensed reference photos and build an index (see section 5). Run the API:

```bash
cd backend
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

In GeoTrace **Settings → Connections**, set the API base URL to `http://127.0.0.1:8000` (for a local browser). For production, use HTTPS and set `ALLOWED_ORIGINS` to the exact deployed web origin.

The API has a `/health` endpoint. Interactive API documentation is disabled by default; set `EXPOSE_API_DOCS=true` only in a protected development environment.

## 5. Build the location reference index

A location-identification system is only as useful as its reference catalogue. The slide deck mentions an illustrative catalogue of around 200 landmarks; it does not include those reference photos, verified labels, rights, or coordinates. You must create that dataset yourself from material your organization is authorized to process.

Expected directory layout:

```text
backend/reference_photos/
  location-001/
    metadata.json
    street-view-01.jpg
    street-view-02.jpg
  location-002/
    metadata.json
    reference.png
```

Example `metadata.json`:

```json
{
  "location_name": "Verified landmark name",
  "latitude": 31.0001,
  "longitude": 75.0001,
  "sign_text": "Known sign or storefront text",
  "search_text": "alternate spellings, nearby street, district",
  "description": "Non-sensitive visual description",
  "source": "Dataset provenance, license, collection date, and reference"
}
```

Use verified coordinates and record the provenance/license for each source. Avoid putting sensitive personal addresses or private residential imagery into the catalogue without legal authority. A location should have multiple reference views when possible.

Build the index:

```bash
cd backend
python build_index.py
```

This creates `backend/index/reference.faiss` and `backend/index/reference_metadata.json`. These generated data files are ignored by Git. Configure `REFERENCE_INDEX_PATH` and `REFERENCE_METADATA_PATH` if you use a different location.

The starter pipeline:

1. Verifies the Firebase ID token and the user's organization membership.
2. Verifies the case belongs to the organization and checks who created it.
3. Checks the uploaded file type and size; computes SHA-256 again on the server and compares it with the client fingerprint.
4. Attempts EXIF metadata extraction and PaddleOCR text extraction.
5. Generates an OpenCLIP embedding and retrieves visual matches from FAISS.
6. Combines visual and text similarity for a ranked shortlist, grouped by location.
7. Writes the result, evidence fingerprint, status, and audit event using Firebase Admin.

Similarity numbers are normalized ranking values, not calibrated probabilities. No radius/uncertainty estimate is invented. The production system needs validation against withheld photos and a documented evaluation protocol before operational use.

## 6. Connect Gemini to Agent37 / Hermes

The UI already includes a deterministic local assistant for navigation, sample-case explanations, evidence help, and report preparation. This does not require a model key.

To enable model-backed reasoning:

1. Obtain a Gemini API key in the Google AI developer console.
2. Set `GEMINI_API_KEY` in the **backend environment only**.
3. Set `GEMINI_MODEL` to a model available to your project.
4. Restart the FastAPI service.
5. Ensure the web app's API URL is configured, and the user is an approved workspace member.

The backend uses Gemini function calling to propose a small allowlist of read-only tools: `search_cases`, `case_summary`, and `prepare_report`. The UI asks for confirmation before sending a proposed action to `/api/agent/execute`. The execute endpoint checks Firebase identity and organization membership again. Add new tools one at a time, with explicit role checks, parameter validation, server-side audit events, and human approval for any state change. Do not expose a general-purpose shell, unrestricted Firestore access, arbitrary file deletion, or an unrestricted "do anything" agent.

## 7. Deploy the frontend to Firebase Hosting

From the project root:

```bash
firebase deploy --only hosting
```

The Firebase Hosting config serves the root `index.html` and ignores backend code, scripts, configuration files, and documentation. Add your final Hosting domain to Firebase Authentication's authorized domains. Update `ALLOWED_ORIGINS` on the API to include that exact HTTPS origin.

For local preview, `python -m http.server 5500` is sufficient. A production deployment should use HTTPS and consider a Content Security Policy, monitoring, rate limiting, backup, and a security review.

## 8. Data model overview

```text
profiles/{uid}
  uid, email, displayName, photoURL, organizationId, accessStatus

orgs/{orgId}/members/{uid}
  uid, email, role, status, grantedBy, timestamps

orgs/{orgId}/cases/{caseId}
  title, status, priority, notes, createdBy, evidenceCount,
  sha256, analysis, updatedAt, createdAt

orgs/{orgId}/cases/{caseId}/evidence/{evidenceId}
  fileName, contentType, sizeBytes, sha256, storagePath,
  uploadedBy, createdAt

orgs/{orgId}/auditLogs/{eventId}
  actorUid, actorEmail, actorRole, action, objectType,
  objectId, detail, createdAt
```

Cloud Storage evidence paths:

```text
orgs/{orgId}/cases/{caseId}/evidence/{uid}/{fileName}
```

## 9. What you still need before a real deployment

- A Firebase project with Google Authentication, Firestore, Storage, billing/region configuration, deployed rules, and an approved first admin.
- A backend host with a private service identity and HTTPS endpoint.
- A curated, legally permitted reference-photo dataset with verified labels, coordinates, licenses/provenance, and quality assurance.
- Compatible PaddleOCR and OpenCLIP runtime packages/model weights, a built FAISS index, and test infrastructure.
- A server-side Gemini API key and reviewed tool allowlist, if model-backed Hermes is required.
- An approved access policy, case assignment model, evidence retention/deletion schedule, privacy assessment, and audit retention policy.
- A validation set of held-out images and documented metrics (e.g. top-1/top-3 retrieval performance, OCR precision/recall, false lead analysis, and performance by image condition).
- Threat modeling, penetration testing, rate limiting, abuse monitoring, backups, incident response, and a legal review for any real investigative use.

## 10. Known implementation boundaries

- The UI's local demo case and audit log are fixtures; local storage is not a forensic record.
- The selected file is retained only in browser memory in demo mode. It is not sent to a server.
- Firebase login works only after the client configuration and Google provider are set up. Signing in alone does not grant case access.
- The live analysis endpoint returns a clear setup error until a valid reference index and vision runtime are installed. It does not manufacture candidate results when the index is missing.
- A hash proves byte identity only; it does not prove authenticity, capture origin, ownership, or custody history.
- The AI tools are intentionally narrow. They are not unrestricted agents and do not autonomously make investigative findings.
- This starter is not a certified digital-forensics product. Conduct a professional security, legal, and forensic validation before real evidence is processed.

## 11. Source alignment

The uploaded GeoTrace AI presentation describes the problem (missing GPS, scattered text/landmark clues, and hard-to-document manual search), the proposal (OCR and look-alike retrieval leading to top-three places on a map), and the technology choices (Leaflet/OpenStreetMap, FastAPI, PaddleOCR, OpenCLIP, FAISS, and SQLite). This version keeps the main workflow, uses Firebase for sign-in and cloud data as requested, and makes the reference dataset and model runtime explicit production prerequisites.
