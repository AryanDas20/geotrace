import { FIREBASE_CONFIG, APP_CONFIG } from "./config.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const dateLabel = value => {
  if (!value) return "—";
  const normalized = value && typeof value.toDate === "function" ? value.toDate() : (value && typeof value.seconds === "number" ? new Date(value.seconds * 1000) : value);
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, {month:"short", day:"2-digit", year:"numeric"}).format(date);
};
const timeLabel = value => {
  const normalized = value && typeof value.toDate === "function" ? value.toDate() : (value && typeof value.seconds === "number" ? new Date(value.seconds * 1000) : (value || Date.now()));
  const date = normalized instanceof Date ? normalized : new Date(normalized);
  return Number.isNaN(date.getTime()) ? "Just now" : new Intl.DateTimeFormat(undefined, {hour:"2-digit", minute:"2-digit"}).format(date);
};
const prettyBytes = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const DEMO_CANDIDATES = [
  {rank:1,name:"Place A",score:0.81,uncertainty:"± 1.5 km",reason:"Sign text + look match",detail:"Illustrative match only"},
  {rank:2,name:"Place B",score:0.67,uncertainty:"± 4 km",reason:"Look match only",detail:"Illustrative match only"},
  {rank:3,name:"Place C",score:0.52,uncertainty:"± 8 km",reason:"Weak look match",detail:"Illustrative match only"}
];
const DEMO_CASE = {
  id:"DEMO-001", title:"Photo location review", status:"review", priority:"Standard", createdBy:"demo", createdAt:new Date("2026-11-05T10:00:00"), updatedAt:new Date("2026-11-05T10:30:00"),
  evidenceCount:1, isDemo:true, gps:"Not found", clue:"SHREE GANGA SWEETS", candidates:DEMO_CANDIDATES,
  notes:"Illustrative sample case from the GeoTrace AI proposal. The sign text and candidate matches are fictional demo data, not analysis of the uploaded image."
};
const DEMO_AUDIT = [
  {action:"Sample case loaded", detail:"DEMO-001 · Photo location review", actor:"Demo workspace", time:new Date("2026-11-05T10:00:00"), icon:"▤"},
  {action:"Metadata check shown", detail:"The illustrative sample indicates no GPS metadata.", actor:"Demo workflow", time:new Date("2026-11-05T10:04:00"), icon:"⌁"},
  {action:"OCR clue displayed", detail:"SHREE GANGA SWEETS · fictional reference text", actor:"Demo workflow", time:new Date("2026-11-05T10:07:00"), icon:"Aa"},
  {action:"Top-three mock ranking displayed", detail:"Place A, Place B, Place C · fictional scores", actor:"Demo workflow", time:new Date("2026-11-05T10:10:00"), icon:"⌖"}
];

let cases = [DEMO_CASE];
let auditEvents = [...DEMO_AUDIT];
let selectedFile = null;
let selectedFileHash = "";
let currentUser = null;
let userProfile = null;
let memberRecord = null;
let firebase = null;
let firebaseError = "";
let isFirebaseConfigured = false;
let authReady = false;
let latestAnalysis = null;
let reports = [];
let tourIndex = 0;
let tourTarget = null;
let activeMap = null;
let mapLibraries = null;
let themePreference = localStorage.getItem("geotrace_theme") || "light";
let apiBaseUrl = localStorage.getItem("geotrace_api_url") || APP_CONFIG.apiBaseUrl;
let localFirebaseConfig = readStoredFirebaseConfig();

function readStoredFirebaseConfig() {
  try { return JSON.parse(localStorage.getItem("geotrace_firebase_config") || "null") || {...FIREBASE_CONFIG}; }
  catch { return {...FIREBASE_CONFIG}; }
}
function hasFirebaseConfig(config = localFirebaseConfig) {
  return !!(config?.apiKey && config?.authDomain && config?.projectId && config?.storageBucket && config?.appId);
}
function liveMode() { return isFirebaseConfigured && !!firebase; }
function accessApproved() { return !!(currentUser && memberRecord && memberRecord.status === "approved" && ["admin","investigator","reviewer"].includes(memberRecord.role)); }
function canInvestigate() { return accessApproved() && ["admin","investigator"].includes(memberRecord?.role); }
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<span>${type === "error" ? "!" : type === "success" ? "✓" : "✳"}</span><div>${esc(message)}</div>`;
  $("#toast-region").append(toast);
  setTimeout(() => toast.remove(), 3900);
}
function setTheme(value) {
  themePreference = value;
  localStorage.setItem("geotrace_theme", value);
  const resolved = value === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
  document.documentElement.dataset.theme = resolved;
  $("#theme-icon").textContent = resolved === "dark" ? "☼" : "☾";
  $$('[data-theme-choice]').forEach(button => button.classList.toggle("active", button.dataset.themeChoice === value));
}
function currentView() { return $(".view.active-view")?.dataset.viewPanel || "dashboard"; }
const viewTitles = {dashboard:"Overview",investigations:"Investigations",workbench:"New analysis",map:"Map explorer",evidence:"Evidence vault",reports:"Reports",audit:"Audit trail","ai-work":"AI workbench",settings:"Settings",help:"Help & guide"};
function setView(view, options = {}) {
  if (!viewTitles[view]) return;
  if (view === "workbench" && liveMode() && currentUser && !canInvestigate()) {
    showToast("Your account needs investigator or admin approval to start analyses.", "error");
    return;
  }
  $$(".view").forEach(section => section.classList.toggle("active-view", section.dataset.viewPanel === view));
  $$(".nav-link[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $("#breadcrumb-current").textContent = viewTitles[view];
  $("#sidebar").classList.remove("mobile-open");
  if (view === "investigations") renderCases();
  if (view === "evidence") renderEvidence();
  if (view === "audit") renderAudit();
  if (view === "reports") renderReports();
  if (view === "map") renderMap(latestAnalysis);
  if (!options.keepScroll) window.scrollTo({top:0,behavior:"smooth"});
}
function showModal(id) { const node = $(id); if (node) { node.hidden = false; document.body.style.overflow = "hidden"; } }
function hideModal(node) { if (!node) return; node.hidden = true; if (!$$(".modal-backdrop:not([hidden])").length) document.body.style.overflow = ""; }
function addAudit(action, detail, icon = "◷") {
  auditEvents.unshift({action,detail,actor:currentUser?.displayName || "Demo Investigator",time:new Date(),icon});
  if (auditEvents.length > 100) auditEvents.length = 100;
  renderAudit();
}
function createCaseId() { return `GT-${new Date().getFullYear()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`; }
function normalizedCase(item) {
  const analysis = item.analysis || {};
  return {...item, id:item.id || item.caseId || createCaseId(), title:item.title || "Untitled investigation", status:item.status || "draft", evidenceCount:item.evidenceCount ?? (item.evidence ? 1 : 0), isDemo:!!item.isDemo, candidates:item.candidates || analysis.candidates || [], gps:item.gps || analysis.metadata?.gps || "Not detected", clue:item.clue || analysis.ocr?.text || "Not extracted"};
}
function getCaseById(id) { return cases.find(item => item.id === id); }
function statusMarkup(status) {
  const map = {draft:["Draft","status-draft"],submitted:["Submitted","status-submitted"],analyzing:["Analyzing","status-analyzing"],review:["Ready for review","status-review"],approved:["Approved","status-review"],failed:["Needs attention","status-draft"]};
  const [label,klass] = map[status] || [status || "Unknown","status-draft"];
  return `<span class="status-pill ${klass}">${esc(label)}</span>`;
}
function renderCases() {
  const filter = ($("#case-filter")?.value || "").trim().toLowerCase();
  const status = $("#status-filter")?.value || "all";
  const filtered = cases.filter(item => {
    const matches = `${item.id} ${item.title} ${item.clue || ""} ${item.notes || ""}`.toLowerCase().includes(filter);
    return matches && (status === "all" || item.status === status);
  });
  $("#cases-table-body").innerHTML = filtered.map(item => `<tr>
    <td><span class="table-id">${esc(item.id)}</span>${item.isDemo ? '<span class="table-case-sub">DEMO FIXTURE</span>' : ""}</td>
    <td><span class="table-case-title">${esc(item.title)}</span><span class="table-case-sub">${esc(item.clue || item.notes || "No case note")}</span></td>
    <td>${item.isDemo ? statusMarkup("review") : statusMarkup(item.status)}</td>
    <td>${Number(item.evidenceCount || 0).toString().padStart(2,"0")} file${item.evidenceCount === 1 ? "" : "s"}</td>
    <td>${dateLabel(item.updatedAt || item.createdAt)}</td>
    <td><button class="table-row-action" data-open-case="${esc(item.id)}">Open ↗</button></td>
  </tr>`).join("");
  $("#cases-empty").hidden = filtered.length > 0;
  $("#case-table-count").textContent = `${filtered.length} investigation${filtered.length === 1 ? "" : "s"}`;
  $("#record-range").textContent = filtered.length;
  $("#case-count").textContent = String(cases.length).padStart(2,"0");
  $("#metric-open").textContent = String(cases.length).padStart(2,"0");
}
function renderEvidence() {
  const q = ($("#evidence-filter")?.value || "").toLowerCase();
  const rows = cases.filter(c => c.evidenceCount > 0 && `${c.id} ${c.title} ${c.fileName || ""}`.toLowerCase().includes(q));
  const demo = rows.some(c => c.isDemo);
  $("#evidence-table-body").innerHTML = rows.map(c => `<tr><td><span class="table-case-title">${esc(c.fileName || (c.isDemo ? "DEMO-001 / reference image" : "Evidence image"))}</span><span class="table-case-sub">${esc(c.isDemo ? "Illustrative placeholder · no actual file bytes" : c.fileSize || "Uploaded evidence")}</span></td><td><span class="table-id">${esc(c.id)}</span></td><td>Image</td><td><span class="table-id">${esc(c.sha256 ? c.sha256.slice(0,18)+"…" : "Not captured")}</span></td><td>${c.isDemo ? '<span class="status-pill status-review">Demo fixture</span>' : '<span class="status-pill status-submitted">Firebase Storage</span>'}</td><td><button class="table-row-action" data-open-case="${esc(c.id)}">Open ↗</button></td></tr>`).join("");
  $("#evidence-empty").hidden = rows.length > 0;
  $("#evidence-count").textContent = String(rows.length).padStart(2,"0");
  $("#storage-state").textContent = liveMode() ? "Firebase" : "Local demo";
}
function renderAudit() {
  const q = ($("#audit-filter")?.value || "").toLowerCase();
  const rows = auditEvents.filter(event => `${event.action} ${event.detail} ${event.actor}`.toLowerCase().includes(q));
  $("#audit-list").innerHTML = rows.map(event => `<div class="audit-event"><span class="audit-event-icon">${esc(event.icon || "◷")}</span><div class="audit-event-copy"><strong>${esc(event.action)}</strong><p>${esc(event.detail)}</p><small>${esc(event.actor)} · ${dateLabel(event.time)} at ${timeLabel(event.time)}</small></div><time>${timeLabel(event.time)}</time></div>`).join("") || '<div class="audit-empty">No events match this filter.</div>';
  $("#audit-count").textContent = String(auditEvents.length).padStart(2,"0");
  $("#audit-latest").textContent = auditEvents.length ? timeLabel(auditEvents[0].time) : "—";
  $("#audit-mode").textContent = liveMode() ? "Server / client" : "Local demo";
}
function renderReports() {
  const history = $("#report-history");
  if (!reports.length) {
    history.innerHTML = '<div class="panel report-empty"><span>▤</span><strong>No reports generated yet</strong><small>Choose a case and prepare a review summary.</small></div>';
    return;
  }
  history.innerHTML = reports.map(report => `<article class="panel report-card"><span class="report-card-icon">▤</span><strong>${esc(report.title)}</strong><small>${esc(report.caseId)} · ${dateLabel(report.createdAt)}</small><button class="inline-link" data-download-report="${esc(report.id)}">Download report ↓</button></article>`).join("");
}
function renderCandidateList(candidates) {
  if (!candidates?.length) return '<div class="candidate-empty">No candidate coordinates yet.<br/><small>Run an analysis with a configured reference index.</small></div>';
  return candidates.map((candidate,index) => `<div class="result-candidate"><span class="result-rank">${index+1}</span><div><strong>${esc(candidate.name || candidate.label || `Candidate ${index+1}`)}</strong><small>${esc(candidate.reason || candidate.matchReason || "Visual reference similarity")}</small></div><span class="result-score">${typeof candidate.score === "number" ? candidate.score.toFixed(2) : esc(candidate.score || "—")}</span></div>`).join("");
}
function openCase(id) {
  const item = getCaseById(id);
  if (!item) return showToast("That investigation is not available in this view.", "error");
  $("#modal-case-id").textContent = item.id;
  $("#case-modal-title").textContent = item.title;
  $("#modal-case-status").textContent = item.isDemo ? "Illustrative" : (item.status || "Draft");
  $("#modal-evidence").textContent = `${item.evidenceCount || 0} image${item.evidenceCount === 1 ? "" : "s"}`;
  $("#modal-gps").textContent = item.gps || "Not available";
  $("#modal-clue").textContent = item.clue || "Not extracted";
  $("#modal-hash").textContent = item.sha256 ? `${item.sha256.slice(0,22)}…` : "Not captured";
  $("#modal-notes").textContent = item.notes || "No investigator note has been added.";
  $("#modal-candidates").innerHTML = (item.candidates || []).map((candidate,index) => `<div class="modal-candidate"><span>${index+1}</span><div><strong>${esc(candidate.name || candidate.label || "Candidate")}</strong><small>${esc(candidate.reason || candidate.matchReason || "Similarity result")}</small></div><b>${typeof candidate.score === "number" ? candidate.score.toFixed(2) : esc(candidate.score || "—")}</b></div>`).join("") || '<p class="text-empty">No ranked results recorded.</p>';
  $("#modal-report").onclick = () => { hideModal($("#case-modal")); generateReport(id); };
  showModal("#case-modal");
}
function downloadBlob(filename, content, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function buildReport(item) {
  const candidates = item.candidates || [];
  return `GEOTRACE AI — INVESTIGATION SUMMARY\n\nCase ID: ${item.id}\nTitle: ${item.title}\nStatus: ${item.status}\nGenerated: ${new Date().toISOString()}\n\nEVIDENCE\nFiles: ${item.evidenceCount || 0}\nGPS metadata: ${item.gps || "Not recorded"}\nText clue: ${item.clue || "Not recorded"}\nSHA-256: ${item.sha256 || "Not available"}\n\nCANDIDATE LEADS\n${candidates.length ? candidates.map((c,i)=>`${i+1}. ${c.name || c.label}\n   Similarity: ${typeof c.score === "number" ? c.score.toFixed(2) : c.score || "Not scored"}\n   Reason: ${c.reason || c.matchReason || "Not supplied"}`).join("\n") : "No candidate leads recorded."}\n\nINVESTIGATOR NOTES\n${item.notes || "None recorded."}\n\nLIMITATIONS & REVIEW NOTICE\n${item.isDemo ? "This is an illustrative DEMO fixture. Values are fictional and were not derived from an uploaded image." : "Machine-generated matches are investigative leads, not proof of location. Similarity scores are not probabilities. Verify candidates independently."}\nMissing or altered metadata, blurry or edited imagery, misleading signage, and incomplete reference coverage may affect results.\n\nGeoTrace AI | Phoenix Coders\n`;
}
function generateReport(id = null) {
  const item = getCaseById(id || "DEMO-001") || cases[0];
  if (!item) return showToast("No investigation is available to report.", "error");
  const report = {id:`RPT-${Date.now()}`,caseId:item.id,title:`${item.title} — review summary`,createdAt:new Date(),content:buildReport(item)};
  reports.unshift(report);
  renderReports();
  downloadBlob(`${item.id}-geotrace-report.txt`, report.content);
  addAudit("Report prepared", `${item.id} · Review summary exported`, "▤");
  showToast("Report prepared and downloaded.", "success");
  return report;
}
async function sha256(file) {
  if (!crypto?.subtle) throw new Error("SHA-256 requires HTTPS or localhost in this browser.");
  const data = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}
function updateSelectedFile(file) {
  if (!file) return;
  const allowed = ["image/jpeg","image/png","image/webp","image/tiff"];
  if (!allowed.includes(file.type) && !/\.(jpe?g|png|webp|tiff?)$/i.test(file.name)) return showToast("Choose a JPG, PNG, WEBP, or TIFF image.", "error");
  if (file.size > APP_CONFIG.maxUploadBytes) return showToast("This image is larger than the 25 MB limit.", "error");
  selectedFile = file;
  selectedFileHash = "";
  $("#file-preview").src = URL.createObjectURL(file);
  $("#file-name").textContent = file.name;
  $("#file-size").textContent = `${prettyBytes(file.size)} · Calculating SHA-256…`;
  $("#file-hash").textContent = "Fingerprint in progress";
  $("#selected-file").hidden = false;
  $("#drop-zone").hidden = true;
  $("#run-analysis").disabled = true;
  sha256(file).then(hash => {
    selectedFileHash = hash;
    $("#file-size").textContent = `${prettyBytes(file.size)} · SHA-256 calculated`;
    $("#file-hash").textContent = hash;
    $("#run-analysis").disabled = !$("#consent-check").checked;
  }).catch(error => {
    $("#file-size").textContent = `${prettyBytes(file.size)} · Hash unavailable`;
    $("#file-hash").textContent = error.message;
    $("#run-analysis").disabled = !$("#consent-check").checked;
  });
}
function clearSelectedFile() {
  selectedFile = null; selectedFileHash = "";
  $("#photo-input").value = "";
  const previewUrl = $("#file-preview").getAttribute("src");
  if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
  $("#selected-file").hidden = true; $("#drop-zone").hidden = false; $("#run-analysis").disabled = true;
}
function setAnalysisProgress(percent, message) {
  $("#analysis-progress").hidden = false;
  $("#progress-title").textContent = message;
  $("#progress-percent").textContent = `${percent}%`;
  $("#progress-fill").style.width = `${percent}%`;
  const active = percent < 25 ? 0 : percent < 50 ? 1 : percent < 85 ? 2 : 3;
  $$("#progress-stages .stage").forEach((stage,index) => stage.classList.toggle("active", index <= active));
}
function renderAnalysisResults(result, isDemo = false) {
  latestAnalysis = result;
  const results = result.candidates || result.results || [];
  const gps = result.metadata?.gps || result.gps || "Not detected";
  const clue = result.ocr?.text || result.textClues?.[0]?.text || result.clue || "No readable text returned";
  $("#analysis-results").hidden = false;
  $("#analysis-results").innerHTML = `<div class="results-header"><div><span class="eyebrow">${isDemo ? "ILLUSTRATIVE FIXTURE" : "ANALYSIS COMPLETE"}</span><h2>Review your location leads<span class="title-period">.</span></h2><p>${isDemo ? "These sample candidates are from the proposal and were not derived from your uploaded image." : "Review each candidate against its source evidence before drawing a conclusion."}</p></div><span class="sample-chip">${isDemo ? "DEMO ONLY" : "HUMAN REVIEW REQUIRED"}</span></div><div class="results-grid"><div class="result-block"><h4>Evidence inspection</h4><div class="signal-row"><div class="signal-icon">⌁</div><div class="signal-copy"><strong>GPS metadata</strong><small>${esc(gps)}</small></div></div><div class="signal-row"><div class="signal-icon signal-orange">Aa</div><div class="signal-copy"><strong>OCR / text clues</strong><small>${esc(clue)}</small></div></div><div class="signal-row"><div class="signal-icon">#</div><div class="signal-copy"><strong>SHA-256</strong><small>${esc(result.sha256 || selectedFileHash || "Not returned")}</small></div></div></div><div class="result-block"><h4>Top candidate locations</h4>${renderCandidateList(results)}</div></div><div class="results-warning">ⓘ ${isDemo ? "Fictional demo output: Place A / B / C and their scores are illustrative only. They are not findings about the image you selected." : "Similarity scores are ranking signals, not probabilities. Confirm each lead with independent evidence and document your interpretation."}</div><div class="modal-actions"><button class="button button-soft" id="results-open-map">Open map explorer</button><button class="button button-primary" id="results-report">Prepare report ↓</button></div>`;
  $("#results-open-map").addEventListener("click", () => { setView("map"); renderMap(result); });
  $("#results-report").addEventListener("click", () => generateReport(result.caseId));
  renderMap(result);
  addAudit(isDemo ? "Demo analysis fixture displayed" : "Analysis result received", `${result.caseId || "New case"} · ${results.length} candidate record(s)`, "⌖");
}
async function runDemoAnalysis(file, caseData) {
  const steps = [[12,"Calculating file fingerprint…"],[31,"Inspecting image metadata…"],[56,"Checking text and visual clue stages…"],[83,"Preparing illustrative candidate list…"],[100,"Demo workflow complete"]];
  for (const [percent,message] of steps) { setAnalysisProgress(percent,message); await new Promise(resolve => setTimeout(resolve,520)); }
  const result = {caseId:caseData.id,sha256:selectedFileHash || "Hash unavailable",metadata:{gps:"Not found in proposal sample"},ocr:{text:"SHREE GANGA SWEETS"},candidates:DEMO_CANDIDATES.map(item=>({...item})),isDemo:true};
  // The presentation's sample phrase and candidate scores are fixtures. They are deliberately not run against the uploaded file.
  const record = {...caseData,evidenceCount:1,fileName:file.name,fileSize:prettyBytes(file.size),sha256:selectedFileHash,status:"review",gps:"Not found in proposal sample",clue:"SHREE GANGA SWEETS",candidates:result.candidates,isDemo:true,updatedAt:new Date(),notes:caseData.notes || "Uploaded file retained only in the current browser session. Candidate output is a fictional proposal fixture and is not derived from this upload."};
  cases = [record,...cases.filter(item => item.id !== record.id)];
  renderCases(); renderEvidence();
  renderAnalysisResults(result,true);
  showToast("Demo workflow finished. Sample results are fictional.", "success");
}
async function runLiveAnalysis(file, caseData) {
  if (!currentUser || !accessApproved() || !canInvestigate()) throw new Error("Your account is not approved for investigator access.");
  if (!apiBaseUrl) throw new Error("GeoTrace API URL is missing. Add it in Settings → Connections. No live analysis was created.");
  if (!firebase?.storage || !firebase?.firestore) throw new Error("Firebase Storage or Firestore is not ready.");
  const {ref,uploadBytes,getDownloadURL} = firebase.storageFns;
  setAnalysisProgress(10,"Creating secured evidence record…");
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,100);
  const storagePath = `orgs/${APP_CONFIG.organizationId}/cases/${caseData.id}/evidence/${currentUser.uid}/${Date.now()}_${safeName}`;
  const storageRef = ref(firebase.storage,storagePath);
  const extension = file.name.toLowerCase().split(".").pop();
  const inferredTypes = {jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",tif:"image/tiff",tiff:"image/tiff"};
  const contentType = ["image/jpeg","image/png","image/webp","image/tiff"].includes(file.type) ? file.type : (inferredTypes[extension] || "application/octet-stream");
  await uploadBytes(storageRef,file,{contentType,customMetadata:{caseId:caseData.id,sha256:selectedFileHash || ""}});
  setAnalysisProgress(38,"Sending evidence to the analysis service…");
  const token = await currentUser.getIdToken();
  const apiFile = file.type === contentType ? file : new File([file],file.name,{type:contentType,lastModified:file.lastModified});
  const form = new FormData(); form.append("file",apiFile,file.name); form.append("case_id",caseData.id); form.append("org_id",APP_CONFIG.organizationId); form.append("title",caseData.title); form.append("notes",caseData.notes || ""); form.append("client_sha256",selectedFileHash || ""); form.append("storage_path",storagePath);
  const response = await fetch(`${apiBaseUrl.replace(/\/$/,"")}/api/analyze`,{method:"POST",headers:{Authorization:`Bearer ${token}`},body:form});
  const payload = await response.json().catch(()=>({detail:"Analysis service returned an invalid response."}));
  if (!response.ok) throw new Error(payload.detail || payload.message || `Analysis API error (${response.status})`);
  setAnalysisProgress(100,"Analysis response received");
  const record = {...caseData,...payload.case,evidenceCount:1,fileName:file.name,fileSize:prettyBytes(file.size),sha256:payload.sha256 || selectedFileHash,status:"review",updatedAt:new Date(),isDemo:false,candidates:payload.candidates || payload.results || [],gps:payload.metadata?.gps || "Not detected",clue:payload.ocr?.text || "No text returned"};
  cases = [record,...cases.filter(item=>item.id!==record.id)];
  renderCases(); renderEvidence();
  renderAnalysisResults({...payload,caseId:caseData.id,sha256:payload.sha256 || selectedFileHash},false);
}
async function startAnalysis() {
  if (!selectedFile) return showToast("Choose an image before starting analysis.","error");
  if (!$("#consent-check").checked) return showToast("Please confirm that you are authorized to review this image.","error");
  const title = $("#case-title").value.trim();
  if (!title) return showToast("Add an investigation title.","error");
  const caseData = {id:liveMode() ? createCaseId() : createCaseId(),title,status:"draft",priority:$("#case-priority").value,notes:$("#case-notes").value.trim(),createdAt:new Date(),updatedAt:new Date(),createdBy:currentUser?.uid || "demo",evidenceCount:0,isDemo:!liveMode()};
  $("#run-analysis").disabled = true;
  $("#analysis-results").hidden = true;
  try {
    if (liveMode()) {
      if (!currentUser) { showModal("#auth-modal"); throw new Error("Sign in with an approved organization account first."); }
      if (!canInvestigate()) throw new Error("Your account is pending approval or does not have an investigator role.");
      if (!apiBaseUrl) throw new Error("GeoTrace API URL is missing. Configure it in Settings → Connections before creating a live case.");
      const {collection,addDoc,serverTimestamp} = firebase.firestoreFns;
      const docRef = await addDoc(collection(firebase.db,"orgs",APP_CONFIG.organizationId,"cases"),{orgId:APP_CONFIG.organizationId,createdBy:currentUser.uid,title,priority:caseData.priority,notes:caseData.notes,status:"draft",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
      caseData.id = docRef.id;
      await runLiveAnalysis(selectedFile,caseData);
    } else {
      await runDemoAnalysis(selectedFile,caseData);
    }
    addAudit("Evidence analyzed", `${caseData.id} · ${selectedFile.name}`, "◈");
  } catch (error) {
    console.error(error);
    $("#analysis-progress").hidden = true;
    showToast(error.message || "Analysis could not be completed.","error");
  } finally {
    $("#run-analysis").disabled = !selectedFile || !$("#consent-check").checked;
  }
}
async function loadMapLibrary() {
  if (mapLibraries) return mapLibraries;
  const css = document.createElement("link"); css.rel="stylesheet"; css.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"; document.head.append(css);
  const lib = await import("https://unpkg.com/leaflet@1.9.4/dist/leaflet-src.esm.js");
  mapLibraries = lib; return lib;
}
async function renderMap(result = latestAnalysis) {
  const stage = $("#map-stage");
  if (!stage) return;
  const candidates = result?.candidates || result?.results || [];
  const mapped = candidates.filter(c => Number.isFinite(Number(c.latitude ?? c.lat)) && Number.isFinite(Number(c.longitude ?? c.lng ?? c.lon)));
  $("#candidate-list").innerHTML = renderCandidateList(candidates);
  $("#map-case-label").textContent = result?.caseId ? `Case ${result.caseId}` : "No live case selected";
  if (activeMap) { activeMap.remove(); activeMap = null; }
  stage.querySelector(".leaflet-map")?.remove();
  stage.querySelector(".map-empty-state")?.remove();
  stage.querySelector(".map-grid-bg")?.remove();
  if (!mapped.length) {
    stage.insertAdjacentHTML("afterbegin",'<div class="map-grid-bg"></div><div class="map-empty-state"><div class="map-radar"><span></span><i></i><b></b></div><strong>Waiting for geospatial evidence</strong><p>When the analysis API returns coordinates, candidate places will appear here with their supporting clues and match scores.</p><button class="button button-primary button-small" data-view="workbench">Start an analysis</button><small>Illustrative results do not contain real coordinates.</small></div>');
    const action = stage.querySelector('[data-view="workbench"]'); if (action) action.addEventListener("click",()=>setView("workbench"));
    return;
  }
  const mount = document.createElement("div"); mount.className="leaflet-map"; mount.id="live-leaflet-map"; stage.prepend(mount);
  try {
    const L = await loadMapLibrary();
    activeMap = L.map(mount,{scrollWheelZoom:false}).setView([Number(mapped[0].latitude ?? mapped[0].lat),Number(mapped[0].longitude ?? mapped[0].lng ?? mapped[0].lon)],11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(activeMap);
    const bounds=[];
    mapped.forEach((candidate,index)=>{
      const point=[Number(candidate.latitude ?? candidate.lat),Number(candidate.longitude ?? candidate.lng ?? candidate.lon)]; bounds.push(point);
      L.circleMarker(point,{radius:index===0?10:7,color:"#b4451f",fillColor:index===0?"#b4451f":"#d79a7f",fillOpacity:.85,weight:2}).addTo(activeMap).bindPopup(`<strong>${esc(candidate.name || `Candidate ${index+1}`)}</strong><br/>Similarity: ${typeof candidate.score === "number" ? candidate.score.toFixed(2) : esc(candidate.score || "—")}`);
    });
    if (bounds.length>1) activeMap.fitBounds(bounds,{padding:[35,35]});
    $("#map-fit").onclick=()=>activeMap?.fitBounds(bounds,{padding:[35,35]});
  } catch (error) {
    console.error("Map library could not load",error);
    mount.innerHTML='<div class="map-empty-state"><strong>Map library unavailable</strong><p>Check network access to load Leaflet and OpenStreetMap tiles.</p></div>';
  }
}

// Firebase is loaded only after a valid web-app configuration is supplied.
async function initializeFirebase(config = localFirebaseConfig) {
  if (!hasFirebaseConfig(config)) {
    isFirebaseConfigured = false; firebase = null; updateConnectionUI(); return false;
  }
  try {
    const v = APP_CONFIG.firebaseSdkVersion;
    const [appSdk,authSdk,dbSdk,storageSdk] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-storage.js`)
    ]);
    const appName = `geotrace-${config.projectId}`;
    const existingApp = appSdk.getApps().find(item => item.name === appName);
    const app = existingApp || appSdk.initializeApp(config,appName);
    const auth = authSdk.getAuth(app);
    const db = dbSdk.getFirestore(app);
    const storage = storageSdk.getStorage(app);
    firebase = {app,auth,db,storage,authSdk,firestoreFns:dbSdk,storageFns:storageSdk};
    isFirebaseConfigured = true; firebaseError = "";
    authSdk.onAuthStateChanged(auth, async user => {
      currentUser = user;
      try {
        if (user) await loadUserAccess(user);
        else { userProfile = null; memberRecord = null; }
        authReady = true;
        updateIdentityUI(); updateConnectionUI();
        if (user && accessApproved()) await syncCases();
      } catch (error) {
        console.error("Could not load account membership", error);
        memberRecord = null; userProfile = null; authReady = true;
        updateIdentityUI(); updateConnectionUI();
        showToast("Sign-in completed, but the profile or membership could not be read. Check Firestore rules and the configured organization ID.", "error");
      }
    });
    updateConnectionUI();
    return true;
  } catch (error) {
    console.error("Firebase initialization failed",error);
    firebaseError = error.message;
    isFirebaseConfigured = false; firebase = null; updateConnectionUI();
    showToast("Firebase could not initialize. Check config and network access.","error");
    return false;
  }
}
async function loadUserAccess(user) {
  const {doc,getDoc,setDoc,serverTimestamp} = firebase.firestoreFns;
  const profileRef = doc(firebase.db,"profiles",user.uid);
  const profileSnap = await getDoc(profileRef);
  if (!profileSnap.exists()) {
    await setDoc(profileRef,{uid:user.uid,email:user.email || "",displayName:user.displayName || "",photoURL:user.photoURL || "",organizationId:APP_CONFIG.organizationId,accessStatus:"pending",createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    userProfile = {accessStatus:"pending",organizationId:APP_CONFIG.organizationId};
  } else userProfile = profileSnap.data();
  const memberRef = doc(firebase.db,"orgs",APP_CONFIG.organizationId,"members",user.uid);
  const memberSnap = await getDoc(memberRef);
  memberRecord = memberSnap.exists() ? memberSnap.data() : null;
  if (!memberRecord || memberRecord.status !== "approved") {
    showToast("Google sign-in succeeded. Workspace access is pending administrator approval.","info");
  }
}
async function signInGoogle() {
  $("#auth-error").hidden = true;
  if (!liveMode()) {
    if (!hasFirebaseConfig()) {
      $("#auth-error").hidden = false;
      $("#auth-error").textContent = "Firebase is not configured yet. Continue in demo mode, or add Firebase settings first.";
      return;
    }
    const ok = await initializeFirebase(); if (!ok) return;
  }
  const provider = new firebase.authSdk.GoogleAuthProvider();
  provider.setCustomParameters({prompt:"select_account"});
  try {
    if (window.matchMedia("(max-width: 700px)").matches) await firebase.authSdk.signInWithRedirect(firebase.auth,provider);
    else await firebase.authSdk.signInWithPopup(firebase.auth,provider);
    hideModal($("#auth-modal")); addAudit("Google sign-in completed","Authentication through Firebase", "◉");
  } catch (error) {
    console.error(error);
    const message = error.code === "auth/popup-closed-by-user" ? "Sign-in window was closed." : error.message || "Google sign-in failed.";
    $("#auth-error").hidden = false; $("#auth-error").textContent = message;
  }
}
async function syncCases() {
  if (!liveMode() || !accessApproved()) return;
  try {
    const {collection,getDocs,query,orderBy,limit} = firebase.firestoreFns;
    const ref = collection(firebase.db,"orgs",APP_CONFIG.organizationId,"cases");
    const snapshot = await getDocs(query(ref,orderBy("createdAt","desc"),limit(100)));
    const remote = snapshot.docs.map(docSnap => normalizedCase({id:docSnap.id,...docSnap.data()}));
    cases = [...remote.filter(c=>c.id!=="DEMO-001"),DEMO_CASE];
    renderCases(); renderEvidence();
  } catch (error) {
    console.error("Could not sync cases",error);
    showToast("Could not load cases. Check Firestore rules and organization membership.","error");
  }
}
async function signOutUser() {
  if (!firebase) return showToast("You are using a local demo session.");
  await firebase.authSdk.signOut(firebase.auth);
  currentUser=null;memberRecord=null;userProfile=null;updateIdentityUI();updateConnectionUI();
  showToast("Signed out successfully.","success");
}
function updateIdentityUI() {
  const name = currentUser?.displayName || "Demo Investigator";
  $("#profile-name").textContent = name;
  $("#profile-role").textContent = currentUser ? (accessApproved() ? `${memberRecord.role} · Approved` : "Pending approval") : "Local demo session";
  $("#profile-avatar").textContent = name.split(/\s+/).map(v=>v[0]).join("").slice(0,2).toUpperCase();
  $("#sign-in-button").textContent = currentUser ? "Account ✓" : "Sign in ↗";
  $("#security-mode").textContent = liveMode() ? (accessApproved() ? "Live · Approved" : "Live · Approval pending") : "Demo workspace";
  $("#sign-in-button").title = currentUser ? (currentUser.email || "Signed in") : "Sign in with Google";
}
function updateConnectionUI() {
  const configured = hasFirebaseConfig();
  $("#firebase-connection-pill").textContent = liveMode() ? "Connected" : configured ? "Initializing" : "Not configured";
  $("#api-connection-pill").textContent = apiBaseUrl ? "URL saved" : "Demo only";
  $("#setup-state").textContent = liveMode() && apiBaseUrl ? "CONFIGURED" : "SETUP REQUIRED";
  $("#auth-setting-status").textContent = currentUser ? (accessApproved() ? "Approved" : "Pending approval") : "Not signed in";
  $("#ai-setting-status").textContent = apiBaseUrl ? "Backend URL saved" : "Local assistant";
  $("#agent-mode-label").textContent = apiBaseUrl ? "Backend configured · sign-in required" : "Local assistant";
  $("#ai-connection-note").textContent = apiBaseUrl ? "Backend URL saved; reachability and Gemini configuration are verified only when an approved user sends a request." : "Connect a server-side Gemini API key in the backend to enable model-backed reasoning. Never put model secrets in browser JavaScript.";
  $("#storage-state").textContent = liveMode() ? "Firebase" : "Local demo";
}
function loadSettingsFields() {
  $("#setting-api-key").value = localFirebaseConfig.apiKey || "";
  $("#setting-project-id").value = localFirebaseConfig.projectId || "";
  $("#setting-auth-domain").value = localFirebaseConfig.authDomain || "";
  $("#setting-storage-bucket").value = localFirebaseConfig.storageBucket || "";
  $("#setting-sender-id").value = localFirebaseConfig.messagingSenderId || "";
  $("#setting-app-id").value = localFirebaseConfig.appId || "";
  $("#setting-api-url").value = apiBaseUrl || "";
}
async function saveFirebaseSettings() {
  const config = {
    apiKey:$("#setting-api-key").value.trim(),projectId:$("#setting-project-id").value.trim(),authDomain:$("#setting-auth-domain").value.trim(),storageBucket:$("#setting-storage-bucket").value.trim(),messagingSenderId:$("#setting-sender-id").value.trim(),appId:$("#setting-app-id").value.trim()
  };
  if (!hasFirebaseConfig(config)) return showToast("Fill in API key, project ID, auth domain, storage bucket, and app ID.","error");
  localFirebaseConfig=config;localStorage.setItem("geotrace_firebase_config",JSON.stringify(config));
  const ok=await initializeFirebase(config);
  if (ok) showToast("Firebase configuration saved. Enable Google sign-in and deploy the rules next.","success");
}
function saveApiSettings() {
  apiBaseUrl=$("#setting-api-url").value.trim().replace(/\/$/,"");
  localStorage.setItem("geotrace_api_url",apiBaseUrl);
  updateConnectionUI(); showToast("Backend URL saved in this browser.","success");
}

// Hermes: local task tools are explicit and deterministic; optional model calls go through the trusted API.
function localHermesAnswer(message) {
  const q=message.toLowerCase();
  const nav=[
    ["dashboard|overview|home","dashboard","I'll open the Overview so you can see workspace activity."],
    ["investigation|case register|all cases","investigations","Opening the investigation register."],
    ["new analysis|upload|analyze photo|analyse photo|start analysis","workbench","Opening New Analysis. Add an authorized image to continue."],
    ["map|candidate location|locations","map","Opening Map Explorer. The sample fixture has no real coordinates."],
    ["evidence vault|evidence files|fingerprint","evidence","Opening the Evidence Vault."],
    ["report|export report","reports","Opening Reports. I can prepare a structured case summary."],
    ["audit|activity log|event log","audit","Opening the Audit Trail."],
    ["setting|configure firebase|connect firebase","settings","Opening Settings. Check Connections to configure Firebase and the API."],
    ["help|guide|tour","help","Opening Help & Guide."],
    ["ai workbench|ai workspace","ai-work","You're already in the AI Workbench."],
  ];
  for (const [pattern,view,reply] of nav) if (new RegExp(pattern).test(q)) return {reply,action:()=>setView(view)};
  if (/summari[sz]e|what is in|details of|tell me about/.test(q) && /demo-001|sample case|case/.test(q)) {
    return {reply:"DEMO-001 is a fictional sample from the project proposal. Its illustrative checks show no GPS metadata, the phrase ‘SHREE GANGA SWEETS’, and three mock candidates: Place A (0.81), Place B (0.67), and Place C (0.52). These values are not derived from your uploaded image.",action:null};
  }
  if (/prepare|create|generate/.test(q) && /report|summary/.test(q)) return {reply:"I can prepare a review summary and download it. I'll use the sample case unless you open another case first.",action:()=>generateReport("DEMO-001")};
  if (/create|new|start/.test(q) && /case|investigation/.test(q)) return {reply:"Opening the new analysis form. Add an authorized image and a case title before submitting.",action:()=>setView("workbench")};
  if (/find|search|look for/.test(q)) {
    const term=message.replace(/find|search|look for|cases?|investigations?/ig,"").trim();
    const matches=cases.filter(c=>`${c.id} ${c.title} ${c.clue||""}`.toLowerCase().includes(term.toLowerCase()) || !term);
    return {reply:matches.length?`I found ${matches.length} matching investigation(s): ${matches.map(c=>`${c.id} — ${c.title}`).join("; ")}. I'll open the register so you can review them.`:"I couldn't find a matching case in the currently loaded workspace.",action:()=>setView("investigations")};
  }
  if (/similarity|score|rank|confidence/.test(q)) return {reply:"GeoTrace combines two signal families: visual similarity from an image embedding (the proposal uses OpenCLIP) and text clues extracted from the photo (the proposal uses PaddleOCR). Candidate scores rank matches in the reference set; they are not probabilities. If text clues are absent, ranking relies more heavily on visual similarity and should be treated with additional caution.",action:null};
  if (/ocr|sign text|metadata|gps|exif/.test(q)) return {reply:"Metadata inspection checks the file for available EXIF fields such as timestamp, device details, and GPS coordinates. OCR then attempts to read visible text such as shop signs or road labels. Missing GPS is common and does not by itself prove alteration. The live backend must process the actual uploaded bytes before it can claim a clue was detected.",action:null};
  if (/hash|sha|fingerprint/.test(q)) return {reply:"The browser can calculate a SHA-256 fingerprint from the selected file bytes. A hash can help detect whether two files are byte-for-byte identical; it does not prove who captured the image, where it was captured, or when. Live mode should verify the hash again on the server and log that event.",action:null};
  if (/secure|privacy|permission|role|access/.test(q)) return {reply:"Live access is based on Firebase Authentication plus an administrator-managed organization membership record. New sign-ins remain pending until approved. Firestore and Storage rules restrict access, while audit writes and AI tool execution belong on the trusted backend. Never make the database public to fix a permission error.",action:null};
  if (/can you|what can you|capabilit|do for me/.test(q)) return {reply:"I can navigate the workspace, search loaded cases, explain metadata/OCR/visual matching, and prepare a case report. With the server-side Gemini integration enabled, I can propose additional allow-listed actions. Every state-changing operation must be explicitly approved and checked against your role; I cannot make unrestricted changes or conclusions.",action:null};
  return {reply:"I can help with GeoTrace workflows, case lookup, evidence fields, candidate scoring, reports, and navigation. For broader reasoning, connect the server-side Gemini integration in Settings → AI assistant. Try asking me to ‘summarize DEMO-001’, ‘explain visual similarity’, or ‘prepare a report’. ",action:null};
}
async function askHermes(message, target="drawer") {
  const trimmed=message.trim(); if (!trimmed) return;
  const isDrawer=target==="drawer";
  const input=$(isDrawer?"#drawer-input":"#ai-work-input");
  if (input) input.value="";
  appendChatMessage(trimmed,"user",target);
  if (apiBaseUrl && currentUser && accessApproved()) {
    try {
      const token=await currentUser.getIdToken();
      const response=await fetch(`${apiBaseUrl}/api/agent`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({message:trimmed,org_id:APP_CONFIG.organizationId,context:{view:currentView(),case_ids:cases.slice(0,20).map(c=>c.id)}})});
      const data=await response.json();
      if (!response.ok) throw new Error(data.detail || "Agent request failed.");
      appendChatMessage(data.answer || "I could not produce a response.","assistant",target);
      if (data.proposed_action) appendActionCard(data.proposed_action,target);
      return;
    } catch(error) { console.warn("Hermes API unavailable; using local tools",error); appendChatMessage(`The model service could not be reached (${error.message}). I'll use the local supported tools instead.`,"assistant",target); }
  }
  const result=localHermesAnswer(trimmed);
  appendChatMessage(result.reply,"assistant",target);
  if (result.action) {
    const button=document.createElement("button");button.className="inline-link";button.style.margin="3px 0 7px 31px";button.textContent="Run suggested action →";button.addEventListener("click",()=>{result.action();button.remove();});
    (isDrawer?$("#drawer-chat"):$("#ai-work-chat")).append(button);
  }
}
function appendChatMessage(text,role,target) {
  const container=$(target==="drawer"?"#drawer-chat":"#ai-work-chat");
  const node=document.createElement("div");node.className=target==="drawer"?`drawer-message ${role}`:`chat-message ${role==="user"?"user-message":"assistant-message"}`;
  if (target==="drawer") node.innerHTML=`${role==="assistant"?'<span class="mini-agent">✳</span>':""}<div class="mini-bubble">${esc(text).replace(/\n/g,"<br>")}</div>`;
  else node.innerHTML=`${role==="assistant"?'<span class="chat-avatar">✳</span>':""}<div class="message-bubble"><strong>${role==="assistant"?"Hermes":"You"}</strong><p>${esc(text).replace(/\n/g,"<br>")}</p><small>${role==="assistant"?"GeoTrace assistant":"Just now"}</small></div>`;
  container.append(node);container.scrollTop=container.scrollHeight;
}
function appendActionCard(action,target) {
  const container=$(target==="drawer"?"#drawer-chat":"#ai-work-chat");
  const card=document.createElement("div");card.className="message-bubble";card.style.margin="0 0 12px 34px";
  card.innerHTML=`<strong>Suggested action</strong><p>${esc(action.description || `Run ${action.name || "workspace action"}`)}</p><button class="button button-primary button-small">Review & approve</button>`;
  card.querySelector("button").addEventListener("click",async()=>{
    if (!currentUser || !accessApproved()) return showToast("Sign in with an approved account before using live agent tools.","error");
    if (!confirm("Approve this proposed Hermes action?")) return;
    try {
      const token=await currentUser.getIdToken();const res=await fetch(`${apiBaseUrl}/api/agent/execute`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({org_id:APP_CONFIG.organizationId,tool:action.name,args:action.args||{},confirmed:true})});
      const data=await res.json();if(!res.ok)throw new Error(data.detail||"Action could not be executed.");
      appendChatMessage(data.message || JSON.stringify(data.result || data),"assistant",target);card.remove();
    }catch(error){showToast(error.message,"error");}
  });container.append(card);container.scrollTop=container.scrollHeight;
}

const tourSteps=[
  {view:"dashboard",selector:"#overview-metrics",title:"Your operational overview",copy:"Start here for a concise snapshot of cases, evidence, and the investigation workflow. Demo counts are clearly labeled."},
  {view:"dashboard",selector:"[data-tour='recent-cases']",title:"Recent investigations",copy:"Open a case to review its evidence notes, metadata status, and candidate leads."},
  {view:"dashboard",selector:"[data-tour='pipeline']",title:"The analysis pipeline",copy:"GeoTrace combines metadata inspection, OCR text clues, and visual similarity before ranking candidate places."},
  {view:"workbench",selector:"[data-tour='upload-zone']",title:"Add photographic evidence",copy:"Select an authorized image, review its SHA-256 fingerprint, add case context, and submit it to the configured analysis service."},
  {view:"ai-work",selector:".ai-chat-panel",title:"Meet Agent37 · Hermes",copy:"Ask questions, search cases, navigate the app, and prepare reports. Live model tools require a secure backend and human approval."},
  {view:"settings",selector:"[data-settings-pane='connections']",title:"Connect your services",copy:"Add your Firebase web config and backend URL. Deploy restrictive rules and bootstrap an administrator before live use."}
];
function startTour(index=0) {
  tourIndex=index;$("#tour-backdrop").hidden=false;$("#tour-tooltip").hidden=false;
  renderTourStep();
}
function renderTourStep() {
  $$(".tour-highlight").forEach(node=>node.classList.remove("tour-highlight"));
  const step=tourSteps[tourIndex];if(!step)return finishTour();
  setView(step.view,{keepScroll:true});
  setTimeout(()=>{
    const target=$(step.selector);tourTarget=target;
    if (target) { target.classList.add("tour-highlight"); target.scrollIntoView({behavior:"smooth",block:"center"}); }
    $("#tour-index").textContent=`${String(tourIndex+1).padStart(2,"0")} / ${String(tourSteps.length).padStart(2,"0")}`;
    $("#tour-title").textContent=step.title;$("#tour-copy").textContent=step.copy;
    $("#tour-progress").innerHTML=tourSteps.map((_,i)=>`<i class="${i<=tourIndex?"active":""}"></i>`).join("");
    $("#tour-next").textContent=tourIndex===tourSteps.length-1?"Finish ✓":"Next →";
    positionTourTooltip(target);
  },80);
}
function positionTourTooltip(target) {
  const tooltip=$("#tour-tooltip");
  if (window.innerWidth<=680) { tooltip.style.left="15px";tooltip.style.right="15px";tooltip.style.top="auto";tooltip.style.bottom="16px";return; }
  const rect=target?.getBoundingClientRect();
  if (!rect) {tooltip.style.left="50%";tooltip.style.top="50%";tooltip.style.transform="translate(-50%,-50%)";return;}
  tooltip.style.transform="none";
  const left=Math.max(15,Math.min(window.innerWidth-355,rect.left+Math.min(rect.width-20,45)));
  const top=rect.bottom+14+250<window.innerHeight?rect.bottom+14:Math.max(15,rect.top-220);
  tooltip.style.left=`${left}px`;tooltip.style.top=`${top}px`;tooltip.style.bottom="auto";
}
function finishTour() {
  $$(".tour-highlight").forEach(node=>node.classList.remove("tour-highlight"));
  $("#tour-backdrop").hidden=true;$("#tour-tooltip").hidden=true;tourTarget=null;
}
function openAgent() { $("#agent-overlay").classList.add("open");$("#agent-drawer").classList.add("open");setTimeout(()=>$("#drawer-input").focus(),250); }
function closeAgent() { $("#agent-overlay").classList.remove("open");$("#agent-drawer").classList.remove("open"); }
function renderGlobalSearch(q="") {
  const needle=q.trim().toLowerCase();
  const pages=Object.entries(viewTitles).filter(([key,title])=>!needle||`${title} ${key}`.toLowerCase().includes(needle));
  const foundCases=cases.filter(c=>!needle||`${c.id} ${c.title} ${c.clue||""}`.toLowerCase().includes(needle));
  const results=$("#global-search-results");
  results.innerHTML=`<span class="command-label">PAGES</span>${pages.slice(0,7).map(([key,title])=>`<button data-view="${key}"><span>${key==="ai-work"?"✳":"▦"}</span>${esc(title)}<kbd>↵</kbd></button>`).join("")}${foundCases.length?'<span class="command-label">INVESTIGATIONS</span>':""}${foundCases.slice(0,5).map(c=>`<button data-open-case="${esc(c.id)}"><span>▤</span>${esc(c.id)} — ${esc(c.title)}<kbd>↵</kbd></button>`).join("")}`;
  if (!pages.length&&!foundCases.length) results.innerHTML='<div class="audit-empty">No matching pages or investigations.</div>';
}
function copySetupChecklist() {
  const content="GeoTrace AI setup checklist\n1. Create Firebase project and register a Web app.\n2. Enable Google provider in Firebase Authentication.\n3. Add localhost and deployed domain to Authorized domains.\n4. Paste Firebase web config into GeoTrace Settings.\n5. Deploy firebase/firestore.rules and firebase/storage.rules.\n6. Run scripts/bootstrap_admin.py with trusted admin credentials.\n7. Start the FastAPI backend and set GEMINI_API_KEY server-side.\n8. Build a licensed, verified reference photo dataset and FAISS index.\n9. Configure retention, audit access, and legal approvals before live evidence use.";
  navigator.clipboard?.writeText(content).then(()=>showToast("Setup checklist copied.","success")).catch(()=>showToast("Clipboard access was blocked by the browser."));
}

// Event wiring
$$('[data-view]').forEach(button=>button.addEventListener("click",()=>setView(button.dataset.view)));
$$('[data-view-link]').forEach(link=>link.addEventListener("click",event=>{event.preventDefault();setView(link.dataset.viewLink);}));
$("#mobile-menu").addEventListener("click",()=>$("#sidebar").classList.toggle("mobile-open"));
$("#theme-toggle").addEventListener("click",()=>setTheme(document.documentElement.dataset.theme==="dark"?"light":"dark"));
$("#start-tour").addEventListener("click",()=>startTour());$("#help-tour").addEventListener("click",()=>startTour());$("#footer-guide").addEventListener("click",()=>startTour());
$("#open-agent").addEventListener("click",openAgent);$("#close-agent").addEventListener("click",closeAgent);$("#agent-overlay").addEventListener("click",closeAgent);
$("#sign-in-button").addEventListener("click",()=> currentUser ? showToast(`${currentUser.email || currentUser.displayName} · ${accessApproved()?memberRecord.role:"pending approval"}`) : showModal("#auth-modal"));
$("#profile-button").addEventListener("click",()=> currentUser ? (confirm("Sign out of GeoTrace AI?")&&signOutUser()) : showModal("#auth-modal"));
$("#google-sign-in").addEventListener("click",signInGoogle);
$("#continue-demo").addEventListener("click",()=>{hideModal($("#auth-modal"));showToast("Demo mode active. Use fictional sample data only.");});
$("#open-search").addEventListener("click",()=>{showModal("#search-modal");$("#global-search-input").focus();renderGlobalSearch("");});
$("#global-search-input").addEventListener("input",event=>renderGlobalSearch(event.target.value));
$("#global-search-results").addEventListener("click",event=>{
  const viewButton=event.target.closest("[data-view]");
  const caseButton=event.target.closest("[data-open-case]");
  if(viewButton){setView(viewButton.dataset.view);hideModal($("#search-modal"));}
  else if(caseButton){openCase(caseButton.dataset.openCase);hideModal($("#search-modal"));}
});
$("#search-modal").addEventListener("click",event=>{if(event.target===$("#search-modal"))hideModal($("#search-modal"));});
$("#case-filter").addEventListener("input",renderCases);$("#status-filter").addEventListener("change",renderCases);$("#refresh-cases").addEventListener("click",()=>liveMode()?syncCases():showToast("Demo case list is already up to date."));
$("#evidence-filter").addEventListener("input",renderEvidence);$("#audit-filter").addEventListener("input",renderAudit);
$("#cases-table-body").addEventListener("click",event=>{const button=event.target.closest("[data-open-case]");if(button)openCase(button.dataset.openCase);});
$("#evidence-table-body").addEventListener("click",event=>{const button=event.target.closest("[data-open-case]");if(button)openCase(button.dataset.openCase);});
$("#open-demo-case").addEventListener("click",()=>openCase("DEMO-001"));$("#view-demo-case").addEventListener("click",()=>openCase("DEMO-001"));
$("#photo-input").addEventListener("change",event=>updateSelectedFile(event.target.files?.[0]));
$("#drop-zone").addEventListener("dragover",event=>{event.preventDefault();$("#drop-zone").classList.add("dragover");});
$("#drop-zone").addEventListener("dragleave",()=>$("#drop-zone").classList.remove("dragover"));
$("#drop-zone").addEventListener("drop",event=>{event.preventDefault();$("#drop-zone").classList.remove("dragover");updateSelectedFile(event.dataTransfer.files?.[0]);});
$("#remove-file").addEventListener("click",clearSelectedFile);$("#consent-check").addEventListener("change",event=>$("#run-analysis").disabled=!selectedFile||!event.target.checked);$("#run-analysis").addEventListener("click",startAnalysis);
$("#generate-report").addEventListener("click",()=>generateReport());$("#report-from-demo").addEventListener("click",()=>generateReport("DEMO-001"));
$("#report-history").addEventListener("click",event=>{const button=event.target.closest("[data-download-report]");if(button){const report=reports.find(item=>item.id===button.dataset.downloadReport);if(report)downloadBlob(`${report.caseId}-geotrace-report.txt`,report.content);}});
$("#export-audit").addEventListener("click",()=>downloadBlob("geotrace-audit-preview.json",JSON.stringify(auditEvents.map(e=>({...e,time:new Date(e.time).toISOString()})),null,2),"application/json"));
$("#map-fit").addEventListener("click",()=>{if(activeMap)activeMap.invalidateSize();else showToast("No mapped candidate coordinates to fit.");});
$("#dismiss-banner").addEventListener("click",()=>$("#mode-banner").remove());
$("#save-firebase-config").addEventListener("click",saveFirebaseSettings);$("#save-api-config").addEventListener("click",saveApiSettings);$("#copy-setup-checklist").addEventListener("click",copySetupChecklist);
$$('[data-settings-tab]').forEach(button=>button.addEventListener("click",()=>{$$('[data-settings-tab]').forEach(b=>b.classList.toggle("active",b===button));$$('[data-settings-pane]').forEach(p=>p.classList.toggle("active",p.dataset.settingsPane===button.dataset.settingsTab));}));
$$('[data-theme-choice]').forEach(button=>button.addEventListener("click",()=>setTheme(button.dataset.themeChoice)));
$("#reset-theme").addEventListener("click",()=>{localStorage.removeItem("geotrace_theme");setTheme("light");});
$("#ai-work-form").addEventListener("submit",event=>{event.preventDefault();askHermes($("#ai-work-input").value,"work");});
$("#drawer-form").addEventListener("submit",event=>{event.preventDefault();askHermes($("#drawer-input").value,"drawer");});
$$("[data-prompt]").forEach(button=>button.addEventListener("click",()=>askHermes(button.dataset.prompt,button.closest("#drawer-chat")?"drawer":"work")));
$("#drawer-input").addEventListener("keydown",event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("#drawer-form").requestSubmit();}});
$("#tour-next").addEventListener("click",()=>{tourIndex++;if(tourIndex>=tourSteps.length)finishTour();else renderTourStep();});$("#tour-skip").addEventListener("click",finishTour);$("#tour-close").addEventListener("click",finishTour);$("#tour-backdrop").addEventListener("click",finishTour);
$("#modal-close-action").addEventListener("click",()=>hideModal($("#case-modal")));
$$("[data-close-modal]").forEach(button=>button.addEventListener("click",()=>hideModal(button.closest(".modal-backdrop"))));
$("#auth-modal").addEventListener("click",event=>{if(event.target===$("#auth-modal"))hideModal($("#auth-modal"));});

// Global keyboard shortcuts and command palette behavior.
document.addEventListener("keydown",event=>{
  const mod=event.metaKey||event.ctrlKey;
  if(mod&&event.key.toLowerCase()==="k"){event.preventDefault();showModal("#search-modal");$("#global-search-input").focus();renderGlobalSearch("");}
  if(mod&&event.key.toLowerCase()==="j"){event.preventDefault();openAgent();}
  if(mod&&/^\d$/.test(event.key)){const map={1:"dashboard",2:"investigations",3:"workbench"};if(map[event.key]){event.preventDefault();setView(map[event.key]);}}
  if(event.key==="Escape"){
    hideModal($("#search-modal"));finishTour();closeAgent();
    $$(".modal-backdrop:not([hidden])").forEach(node=>hideModal(node));
  }
});
window.addEventListener("resize",()=>{if(!$("#tour-tooltip").hidden)positionTourTooltip(tourTarget);if(activeMap)activeMap.invalidateSize();});

// Boot
setTheme(themePreference);
loadSettingsFields();
renderCases();renderEvidence();renderAudit();renderReports();updateConnectionUI();updateIdentityUI();
if (hasFirebaseConfig()) initializeFirebase(localFirebaseConfig);
