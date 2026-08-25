import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users,
  Search,
  FolderOpen,
  CheckCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  UserPlus,
  Trash2,
  X,
  ExternalLink,
  FileText,
  User,
  UsersIcon,
  ChevronDown,
  Shield,
  TrendingUp,
  Building2,
  Settings,
  KeyRound,
  UserCheck,
  Plus,
  Eye,
  EyeOff,
  BarChart3,
  CreditCard,
  GraduationCap,
  Banknote,
  Home,
  Briefcase,
  Star,
  AlertTriangle,
  XCircle,
  Send,
  Upload,
  ScanText,
  ShieldCheck,
  Pencil,
} from "lucide-react";
import { useStudent } from "../../context/StudentContext";
import { getAllStudentsFromDrive, deleteStudent, updateLoanStatus, uploadSanctionLetter, recoverMetaFromPdf, restoreMeta, buildFolderKey } from "../../utils/driveApi";
import { DOCUMENT_SCHEMA, CO_APPLICANT_SCHEMA, getTotalRequiredFields } from "../../context/schemas";
import { BANK_OPTIONS, getBankLogo } from "../../utils/bankOptions";
import "./Admin.css";

/* ─── Helpers ─────────────────────────────────────────────────── */

function getTotalUploads(s) {
  if (!s.uploads) return 0;
  return Object.values(s.uploads).reduce((acc, section) => {
    if (!section || typeof section !== "object") return acc;
    return acc + Object.values(section).filter(Boolean).length;
  }, 0);
}

function getOverallProgress(s) {
  const total = getTotalUploads(s);
  const required = getTotalRequiredFields(s.coApplicants || 1, s.personalInfo || {});
  return Math.min(100, Math.round((total / required) * 100));
}

function getAvatarVariant(name) {
  const variants = ["a", "b", "c", "d", "e"];
  const code = (name || "?").charCodeAt(0);
  return variants[code % variants.length];
}

function getAllUploadedFiles(uploads) {
  const files = [];
  if (!uploads) return files;
  Object.entries(uploads).forEach(([section, sectionFiles]) => {
    if (!sectionFiles || typeof sectionFiles !== "object") return;
    Object.entries(sectionFiles).forEach(([fieldId, fileInfo]) => {
      if (!fileInfo) return; // null = removed file slot
      files.push({
        section,
        fieldId,
        name: fileInfo.name || fileInfo.fileName || fieldId,
        webViewLink: fileInfo.webViewLink,
        customName: fileInfo.customName,
      });
    });
  });
  return files;
}

function getMissingDocs(s) {
  const uploads = s.uploads || {};
  const missing = [];

  const applicantUploads = uploads.applicant || {};
  DOCUMENT_SCHEMA.applicant.fields
    .filter((f) => !f.optional)
    .forEach((f) => {
      if (!applicantUploads[f.id]) {
        missing.push({ section: "GOVT ID", label: f.label });
      }
    });

  const academicUploads = uploads.academics || {};
  DOCUMENT_SCHEMA.academics.fields
    .filter((f) => !f.optional)
    .forEach((f) => {
      if (!academicUploads[f.id]) {
        missing.push({ section: "Academics", label: f.label });
      }
    });

  const coCount = s.coApplicants || 0;
  for (let i = 0; i < coCount; i++) {
    const coUploads = uploads[`co_${i}`] || {};
    const empType = s.personalInfo?.[`co_info_${i}`]?.empType || "salaried";
    const coFields = CO_APPLICANT_SCHEMA[empType] || CO_APPLICANT_SCHEMA.other;
    const coInfoForName = s.personalInfo?.[`co_info_${i}`] || {};
    const coName =
      [coInfoForName.firstName, coInfoForName.lastName].filter(Boolean).join(" ") ||
      coInfoForName.name ||
      `Co-Applicant ${i + 1}`;

    coFields.forEach((f) => {
      if (!coUploads[f.id]) {
        missing.push({ section: coName, label: f.label });
      }
    });
  }

  return missing;
}

function getProgressClass(p) {
  if (p === 0) return "prog-0";
  if (p === 100) return "prog-done";
  return "prog-mid";
}

/* ─── Score Classification Helpers ────────────────────────────── */

// Generic: returns "cibil-excellent" | "cibil-good" | "cibil-fair" | "cibil-poor" | "cibil-unknown"
function getScoreClass(value, { excellent, good, fair, min = 0 }) {
  const n = parseFloat(value);
  if (!n || isNaN(n) || n < min) return "cibil-unknown";
  if (n >= excellent) return "cibil-excellent";
  if (n >= good)      return "cibil-good";
  if (n >= fair)      return "cibil-fair";
  return "cibil-poor";
}

function getScoreLabel(value, { excellent, good, fair, min = 0 }, labels = ["Low","Average","Good","Excellent"]) {
  const n = parseFloat(value);
  if (!n || isNaN(n) || n < min) return "N/A";
  if (n >= excellent) return labels[3];
  if (n >= good)      return labels[2];
  if (n >= fair)      return labels[1];
  return labels[0];
}

// Threshold presets
const CIBIL_T    = { excellent: 750, good: 700, fair: 650, min: 300 };
const PCT_T      = { excellent: 85,  good: 75,  fair: 60,  min: 0   };
const CGPA_T     = { excellent: 8.5, good: 7.5, fair: 6.0, min: 0   };
const GRE_T      = { excellent: 325, good: 310, fair: 290, min: 260  };
const IELTS_T    = { excellent: 8.0, good: 7.0, fair: 6.0, min: 0   };
const TOEFL_T    = { excellent: 110, good: 100, fair: 80,  min: 0   };
const DUOLINGO_T = { excellent: 131, good: 110, fair: 90,  min: 10  };
const GMAT_T     = { excellent: 700, good: 600, fair: 500, min: 200 };
const PTE_T      = { excellent: 79,  good: 65,  fair: 50,  min: 10  };

const ACAD_LABELS = ["Low", "Average", "Good", "Excellent"];
const CIBIL_LABELS = ["Poor", "Fair", "Good", "Excellent"];

/* ─── Loan Eligibility Engine ──────────────────────────────────── */

function scoreAcademics(p) {
  // Returns 0–3 representing overall academic strength
  let points = 0, count = 0;
  const rate = (val, thresholds) => {
    const cls = getScoreClass(val, thresholds);
    if (cls === "cibil-excellent") return 3;
    if (cls === "cibil-good")      return 2;
    if (cls === "cibil-fair")      return 1;
    if (cls === "cibil-poor")      return 0;
    return null;
  };
  // "marks" totals vary by board (out of 500/600/etc) and aren't comparable on a
  // fixed scale, so they're excluded from the strength score. "points" (0-10) maps
  // onto the same scale as CGPA.
  [
    p.pct10Type === "marks" ? null : rate(p.pct10Score, p.pct10Type === "points" ? CGPA_T : PCT_T),
    p.pct12Type === "marks" ? null : rate(p.pct12Score, p.pct12Type === "points" ? CGPA_T : PCT_T),
    rate(p.pctGradScore, p.pctGradType === "cgpa" ? CGPA_T : PCT_T),
  ].forEach((v) => { if (v !== null) { points += v; count++; } });
  return count > 0 ? points / count : null; // null = no data
}

function assessLoanEligibility(student) {
  const p = student.personalInfo || {};
  const progress = getOverallProgress(student);

  // Collect CIBIL scores
  const scores = [];
  if (p.studentCibil)  scores.push({ label: "Student",   score: parseInt(p.studentCibil),  role: "student"    });
  if (p.fatherCibil)   scores.push({ label: "Father",    score: parseInt(p.fatherCibil),   role: "co"         });
  if (p.motherCibil)   scores.push({ label: "Mother",    score: parseInt(p.motherCibil),   role: "co"         });
  if (p.guarantorCibil)scores.push({ label: "Guarantor", score: parseInt(p.guarantorCibil),role: "guarantor"  });

  const coCount = student.coApplicants || 0;
  for (let i = 0; i < coCount; i++) {
    const co = p[`co_info_${i}`] || {};
    const coLabel = [co.firstName, co.lastName].filter(Boolean).join(" ") || co.name || `Co-App ${i + 1}`;
    if (co.cibil) scores.push({ label: coLabel, score: parseInt(co.cibil), role: "co" });
  }

  const validScores = scores.filter((s) => s.score >= 300 && s.score <= 900);
  const bestFinancial = validScores
    .filter((s) => s.role !== "student")
    .reduce((best, s) => (s.score > (best?.score || 0) ? s : best), null);

  const bestScore = bestFinancial?.score || (validScores[0]?.score) || 0;
  const acadScore = scoreAcademics(p); // 0–3 or null

  // Verdicts
  const docGood   = progress >= 70;
  const scoreGood = bestScore >= 700;
  const scoreFair = bestScore >= 650 && bestScore < 700;
  const acadGood  = acadScore !== null && acadScore >= 2;    // Good or Excellent average
  const acadFair  = acadScore !== null && acadScore >= 1;    // at least Average

  let verdict, verdictClass, verdictReasons;

  if (scoreGood && docGood && (acadScore === null || acadGood)) {
    verdict = "Likely Eligible";
    verdictClass = "verdict-eligible";
    verdictReasons = [
      "Strong CIBIL score",
      docGood  ? "Documents ready"         : null,
      acadGood ? "Good academic profile"   : null,
    ].filter(Boolean);
  } else if (
    scoreFair ||
    (scoreGood && !docGood) ||
    (scoreGood && acadScore !== null && !acadGood) ||
    (!scoreGood && docGood && bestScore >= 650)
  ) {
    verdict = "Needs Review";
    verdictClass = "verdict-review";
    verdictReasons = [
      !scoreGood ? "CIBIL score below 700"        : "CIBIL acceptable",
      !docGood   ? `Docs ${progress}% complete`   : "Documents ready",
      acadScore !== null && !acadFair ? "Weak academic profile" :
      acadScore !== null && !acadGood ? "Average academic profile" : null,
    ].filter(Boolean);
  } else if (bestScore > 0 && bestScore < 650) {
    verdict = "High Risk";
    verdictClass = "verdict-risky";
    verdictReasons = [
      `CIBIL ${bestScore} below minimum (650)`,
      !docGood ? `Docs ${progress}% complete` : null,
      acadScore !== null && !acadFair ? "Weak academic profile" : null,
    ].filter(Boolean);
  } else {
    verdict = "Incomplete Data";
    verdictClass = "verdict-incomplete";
    verdictReasons = [
      "CIBIL scores not entered",
      !docGood ? `Documents ${progress}% complete` : null,
    ].filter(Boolean);
  }

  return { scores: validScores, bestFinancial, acadScore, progress, verdict, verdictClass, verdictReasons };
}

/* ─── Sub-components ───────────────────────────────────────────── */

function StatsPanel({ stats, loanStats, filter, setFilter, loanStatusFilter, setLoanStatusFilter }) {
  const docCards = [
    { key: "all",        label: "Total Students", value: stats.total,      color: "blue",  icon: <Building2 size={15} /> },
    { key: "complete",   label: "Completed",       value: stats.complete,   color: "green", icon: <CheckCircle size={15} /> },
    { key: "progress",   label: "In Progress",     value: stats.inProgress, color: "amber", icon: <TrendingUp size={15} /> },
    { key: "notStarted", label: "Not Started",     value: stats.notStarted, color: "red",   icon: <Clock size={15} /> },
  ];
  const loanCards = [
    { key: "pending",    label: "Pending",    value: loanStats.pending,    color: "slate" },
    { key: "inprocess",  label: "In Process", value: loanStats.inprocess,  color: "orange" },
    { key: "sanctioned", label: "Sanctioned", value: loanStats.sanctioned, color: "teal" },
    { key: "rejected",   label: "Rejected",   value: loanStats.rejected,   color: "rose" },
    { key: "dropped",    label: "Dropped",    value: loanStats.dropped,    color: "violet" },
  ];
  return (
    <div className="kpi-section animate-fade-in">
      <p className="kpi-section-title"><BarChart3 size={11} /> Document Progress</p>
      <div className="kpi-grid">
        {docCards.map(({ key, label, value, color, icon }) => (
          <button key={key} type="button"
            className={`kpi-card kpi-${color}${filter === key ? " kpi-active" : ""}`}
            onClick={() => setFilter(filter === key && key !== "all" ? "all" : key)}>
            <div className="kpi-top">
              <span className="kpi-label">{label}</span>
              <span className="kpi-icon">{icon}</span>
            </div>
            <span className="kpi-value">{value}</span>
          </button>
        ))}
      </div>

      <p className="kpi-section-title kpi-section-title-loan"><Banknote size={11} /> Loan Application Status</p>
      <div className="kpi-grid kpi-grid-5">
        {loanCards.map(({ key, label, value, color }) => (
          <button key={key} type="button"
            className={`kpi-card kpi-${color}${loanStatusFilter === key ? " kpi-active" : ""}`}
            onClick={() => setLoanStatusFilter(loanStatusFilter === key ? "all" : key)}>
            <div className="kpi-top">
              <span className="kpi-label">{label}</span>
              <span className="kpi-dot" />
            </div>
            <span className="kpi-value">{value}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Badge({ progress }) {
  if (progress === 100)
    return (
      <span className="badge badge-success">
        <span className="badge-dot" />
        Complete
      </span>
    );
  if (progress > 0)
    return (
      <span className="badge badge-warning">
        <span className="badge-dot" />
        In Progress
      </span>
    );
  return (
    <span className="badge badge-error">
      <span className="badge-dot" />
      Not Started
    </span>
  );
}

/* ─── Loan Status ──────────────────────────────────────────────── */

const LOAN_STATUS_CONFIG = {
  pending:    { label: "Pending",     cls: "loan-pending" },
  inprocess:  { label: "In Process",  cls: "loan-inprocess" },
  sanctioned: { label: "Sanctioned",  cls: "loan-sanctioned" },
  rejected:   { label: "Rejected",    cls: "loan-rejected" },
  dropped:    { label: "Dropped",     cls: "loan-dropped" },
};

// Statuses that must carry an explanatory remark (mirrors backend validation)
const REMARK_STATUSES = ["rejected", "dropped"];
const REMARK_LABELS = {
  rejected: { label: "Rejection Remark", placeholder: "Describe the reason for rejection…" },
  dropped:  { label: "Drop Remark",      placeholder: "Describe why the application was dropped…" },
};

function LoanStatusBadge({ status }) {
  const cfg = LOAN_STATUS_CONFIG[status || "pending"] || LOAN_STATUS_CONFIG.pending;
  return <span className={`loan-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function LoanStatusModal({ student, onClose, onUpdated }) {
  const [status, setStatus] = useState(student.loanStatus || "pending");
  const [remark, setRemark] = useState(student.loanRemark || "");
  const [sanctionFile, setSanctionFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [err, setErr] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (REMARK_STATUSES.includes(status) && !remark.trim()) {
      setErr(`A remark is required when the loan is ${status === "rejected" ? "rejected" : "dropped"}.`);
      return;
    }
    setLoading(true);
    setErr("");
    try {
      setLoadingMsg("Updating status…");
      await updateLoanStatus(student.name, student.email || student.phone || "", status, remark);
      if (status === "sanctioned" && sanctionFile) {
        setLoadingMsg("Uploading sanction letter…");
        await uploadSanctionLetter(student.name, student.email || student.phone || "", sanctionFile);
      }
      onUpdated(student.name, status, remark);
      onClose();
    } catch (e2) {
      setErr(e2.message || "Failed to update loan status.");
    } finally {
      setLoading(false);
      setLoadingMsg("");
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !loading && onClose()}>
      <div className="loan-status-modal animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="lsm-header">
          <div className="lsm-icon"><Banknote size={22} /></div>
          <div className="lsm-title-block">
            <h3 className="lsm-title">Update Loan Status</h3>
            <p className="lsm-sub">{student.name}</p>
          </div>
          <button className="lsm-close" onClick={onClose} disabled={loading}>
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="lsm-body">
          <div className="lsm-status-grid">
            {Object.entries(LOAN_STATUS_CONFIG).map(([key, cfg]) => (
              <button
                key={key} type="button"
                className={`lsm-option ${cfg.cls}${status === key ? " selected" : ""}`}
                onClick={() => { setStatus(key); if (!REMARK_STATUSES.includes(key)) setRemark(""); if (key !== "sanctioned") setSanctionFile(null); }}
              >
                <span className="lsm-option-dot" />
                <span>{cfg.label}</span>
                {status === key && <CheckCircle size={14} className="lsm-check" />}
              </button>
            ))}
          </div>

          {REMARK_STATUSES.includes(status) && (
            <div className="lsm-remark-wrap">
              <label className="lsm-remark-label">
                {REMARK_LABELS[status].label} <span className="required-star">*</span>
              </label>
              <textarea
                className="lsm-remark-input"
                rows={3}
                placeholder={REMARK_LABELS[status].placeholder}
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
              />
            </div>
          )}

          {status === "sanctioned" && (
            <div className="lsm-upload-wrap">
              <label className="lsm-remark-label">
                Sanction Letter <span className="lsm-optional">— optional</span>
              </label>
              <label className={`lsm-file-drop${sanctionFile ? " has-file" : ""}`}>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  style={{ display: "none" }}
                  onChange={(e) => setSanctionFile(e.target.files[0] || null)}
                />
                {sanctionFile ? (
                  <div className="lsm-file-selected">
                    <FileText size={15} />
                    <span className="lsm-file-name">{sanctionFile.name}</span>
                    <button
                      type="button"
                      className="lsm-file-remove"
                      onClick={(e) => { e.preventDefault(); setSanctionFile(null); }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <div className="lsm-file-placeholder">
                    <Upload size={16} />
                    <span>Click to upload PDF or image</span>
                  </div>
                )}
              </label>
            </div>
          )}

          {student.loanRemark && REMARK_STATUSES.includes(student.loanStatus) && !REMARK_STATUSES.includes(status) && (
            <p className="lsm-prev-remark">Previous remark: <em>{student.loanRemark}</em></p>
          )}

          {err && <p className="lsm-error">{err}</p>}

          <div className="lsm-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><RefreshCw size={13} className="spin" /> {loadingMsg}</> : "Update Status"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Report Modal ─────────────────────────────────────────────── */

// Generic scored bar — reuses cibil-* color classes for consistency
function ScoreBar({ label, rawValue, displayValue, thresholds, rangeMin, rangeMax, labels = ACAD_LABELS }) {
  const n = parseFloat(rawValue);
  if (!rawValue && rawValue !== 0) return null;
  const cls = getScoreClass(n, thresholds);
  const lbl = getScoreLabel(n, thresholds, labels);
  const pct = (rangeMax > rangeMin)
    ? Math.min(100, Math.max(0, Math.round(((n - rangeMin) / (rangeMax - rangeMin)) * 100)))
    : 0;

  return (
    <div className="cibil-row">
      <div className="cibil-row-label">{label}</div>
      <div className="cibil-row-right">
        <div className="cibil-track">
          <div className={`cibil-fill ${cls}`} style={{ width: `${pct}%` }} />
        </div>
        <div className={`cibil-score-chip ${cls}`}>
          {displayValue ?? n}
          <span className="cibil-lbl-text">{lbl}</span>
        </div>
      </div>
    </div>
  );
}

function InfoPair({ label, value, mono }) {
  return (
    <div className="rpt-pair">
      <div className="rpt-pair-label">{label}</div>
      <div className={`rpt-pair-value${!value ? " rpt-empty" : ""}${mono ? " mono" : ""}`}>
        {value || "—"}
      </div>
    </div>
  );
}

/* ─── Recover Meta Modal ─────────────────────────────────────── */

function RecoverMetaModal({ student, onClose, onRestored }) {
  const [phase, setPhase] = useState("idle"); // idle | scanning | preview | writing | done | error
  const [recovered, setRecovered] = useState(null);
  const [warning, setWarning] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");

  const handleScan = async () => {
    setPhase("scanning");
    setErrorMsg("");
    try {
      const r = await recoverMetaFromPdf(student.name, student.email || student.phone || "");
      if (!r.success) { setErrorMsg(r.error || "Recovery failed"); setPhase("error"); return; }
      setRecovered(r.recovered);
      setWarning(r.warning || null);
      setPhase("preview");
    } catch (e) {
      setErrorMsg(e.message || "Unexpected error");
      setPhase("error");
    }
  };

  const handleRestore = async () => {
    setPhase("writing");
    try {
      await restoreMeta(student.name, student.email || student.phone || "", recovered);
      setPhase("done");
      setTimeout(() => onRestored(recovered), 800);
    } catch (e) {
      setErrorMsg(e.message || "Write failed");
      setPhase("error");
    }
  };

  const p = recovered?.personalInfo || {};
  const previewFields = [
    ["Name", recovered?.name],
    ["Email", recovered?.email],
    ["Phone", recovered?.phone],
    ["Advisor", recovered?.advisor],
    ["Loan Amount", p.loanAmount ? `₹${Number(p.loanAmount).toLocaleString("en-IN")}` : null],
    ["Target University", p.targetUniversity],
    ["Course", p.courseNameUniversity],
    ["10th Score", p.pct10Score ? `${p.pct10Score} (${p.pct10Type || "%"})` : null],
    ["12th Score", p.pct12Score ? `${p.pct12Score} (${p.pct12Type || "%"})` : null],
    ["Graduation", p.pctGradScore ? `${p.pctGradScore} ${p.pctGradType === "cgpa" ? "CGPA" : "%"}` : null],
    ["Co-Applicants", recovered?.coApplicants],
  ].filter(([, v]) => v != null && v !== "");

  return (
    <div className="modal-backdrop" onClick={() => phase !== "scanning" && phase !== "writing" && onClose()}>
      <div className="modal-box recover-modal animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon"><ScanText size={26} /></div>
        <h3 className="bank-modal-title">Recover Meta from PDF</h3>
        <p className="bank-modal-desc">
          Scans <strong>Student_Summary.pdf</strong> from Drive, uses AI to reconstruct the
          student's form data, then writes it back as <code>student_meta.json</code>.
        </p>

        {phase === "idle" && (
          <>
            <div className="recover-info-box">
              <AlertTriangle size={13} />
              <span>Only run this if the student's data was lost. It will <strong>replace</strong> the current meta.</span>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleScan}>
                <ScanText size={13} /> Scan &amp; Recover
              </button>
            </div>
          </>
        )}

        {phase === "scanning" && (
          <div className="recover-loading">
            <div className="loading-dots"><span /><span /><span /></div>
            <p>OCR-ing PDF then asking Claude to reconstruct the data…</p>
          </div>
        )}

        {phase === "preview" && recovered && (
          <>
            {warning && (
              <div className="recover-warn-box">
                <AlertTriangle size={13} /> {warning}
              </div>
            )}
            <div className="recover-preview">
              <p className="recover-preview-title">Recovered fields preview:</p>
              <div className="recover-field-grid">
                {previewFields.map(([label, value]) => (
                  <div key={label} className="recover-field-row">
                    <span className="recover-field-lbl">{label}</span>
                    <span className="recover-field-val">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRestore}>
                <ShieldCheck size={13} /> Confirm &amp; Write
              </button>
            </div>
          </>
        )}

        {phase === "writing" && (
          <div className="recover-loading">
            <div className="loading-dots"><span /><span /><span /></div>
            <p>Writing recovered data to Drive…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="recover-success">
            <ShieldCheck size={22} />
            <p>Meta restored successfully.</p>
          </div>
        )}

        {phase === "error" && (
          <>
            <div className="settings-msg err">{errorMsg}</div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={handleScan}>Retry</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReportModal({ student, onClose }) {
  const p = student.personalInfo || {};
  const { progress, verdict, verdictClass, verdictReasons } =
    assessLoanEligibility(student);

  const cibilEntries = [
    { label: "Student", key: "studentCibil" },
    { label: "Father", key: "fatherCibil" },
    { label: "Mother", key: "motherCibil" },
    { label: "Guarantor", key: "guarantorCibil" },
  ].filter((e) => p[e.key]);

  const coCount = student.coApplicants || 0;
  const coApplicants = Array.from({ length: coCount }, (_, i) => ({
    idx: i,
    info: p[`co_info_${i}`] || {},
    uploads: student.uploads?.[`co_${i}`] || {},
  }));

  const progressClass = getProgressClass(progress);

  const verdictIconMap = {
    "verdict-eligible": <CheckCircle size={20} />,
    "verdict-review": <AlertTriangle size={20} />,
    "verdict-risky": <XCircle size={20} />,
    "verdict-incomplete": <AlertCircle size={20} />,
  };

  return (
    <div className="modal-backdrop rpt-backdrop" onClick={onClose}>
      <div className="rpt-modal animate-fade-in" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="rpt-header">
          <div className="rpt-header-left">
            <div className={`rpt-avatar avatar-${getAvatarVariant(student.name)}`}>
              {(student.name || "?")[0].toUpperCase()}
            </div>
            <div>
              <h2 className="rpt-name">{student.name}</h2>
              <p className="rpt-contact">{student.email || student.phone || "No contact"}</p>
              {student.advisor && <p className="rpt-advisor">Advisor: {student.advisor}</p>}
            </div>
          </div>
          <button className="icon-btn rpt-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Verdict Banner */}
        <div className={`rpt-verdict ${verdictClass}`}>
          <div className="rpt-verdict-icon">{verdictIconMap[verdictClass]}</div>
          <div className="rpt-verdict-body">
            <div className="rpt-verdict-title">{verdict}</div>
            <div className="rpt-verdict-reasons">
              {verdictReasons.map((r, i) => (
                <span key={i} className="rpt-reason-chip">{r}</span>
              ))}
            </div>
          </div>
          <div className="rpt-verdict-progress">
            <div className={`rpt-prog-ring ${progressClass}`}>
              <svg viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="2.5" className="ring-track" />
                <circle
                  cx="18" cy="18" r="15.9" fill="none" strokeWidth="2.5"
                  strokeDasharray={`${progress} ${100 - progress}`}
                  strokeDashoffset="25"
                  className="ring-fill"
                />
              </svg>
              <span>{progress}%</span>
            </div>
            <div className="rpt-prog-label">Docs</div>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="rpt-body">
          {/* Summary Row */}
          <div className="rpt-summary-grid">
            <div className="rpt-summary-card">
              <Banknote size={15} />
              <div>
                <div className="rpt-sc-label">Loan Amount</div>
                <div className="rpt-sc-val">
                  {p.loanAmount ? `₹${Number(p.loanAmount).toLocaleString("en-IN")}` : "—"}
                </div>
              </div>
            </div>
            <div className="rpt-summary-card">
              <GraduationCap size={15} />
              <div>
                <div className="rpt-sc-label">Applied For</div>
                <div className="rpt-sc-val">{p.loanTrack || "—"}</div>
              </div>
            </div>
            <div className="rpt-summary-card">
              <Home size={15} />
              <div>
                <div className="rpt-sc-label">Own House</div>
                <div className="rpt-sc-val">{p.ownHouseStatus || "—"}</div>
              </div>
            </div>
            <div className="rpt-summary-card">
              <Briefcase size={15} />
              <div>
                <div className="rpt-sc-label">Prior Bank</div>
                <div className="rpt-sc-val">
                  {p.priorBankApplied === "Yes"
                    ? p.priorBankName === "Others" ? p.priorBankNameCustom : p.priorBankName || "Yes"
                    : p.priorBankApplied || "—"}
                </div>
              </div>
            </div>
          </div>

          {/* CIBIL Scores */}
          {cibilEntries.length > 0 && (
            <div className="rpt-section">
              <div className="rpt-section-title">
                <CreditCard size={13} /> CIBIL Score Analysis
              </div>
              <div className="cibil-scale-labels">
                <span>300</span><span>500</span><span>650</span><span>700</span><span>750</span><span>900</span>
              </div>
              <div className="cibil-list">
                {cibilEntries.map((e) => (
                  <ScoreBar
                    key={e.key}
                    label={e.label}
                    rawValue={p[e.key]}
                    thresholds={CIBIL_T}
                    rangeMin={300}
                    rangeMax={900}
                    labels={CIBIL_LABELS}
                  />
                ))}
              </div>
              <div className="cibil-legend">
                <span className="cl-item cibil-poor">Poor &lt;650</span>
                <span className="cl-item cibil-fair">Fair 650–699</span>
                <span className="cl-item cibil-good">Good 700–749</span>
                <span className="cl-item cibil-excellent">Excellent 750+</span>
              </div>
            </div>
          )}

          {/* Academic Profile */}
          <div className="rpt-section">
            <div className="rpt-section-title">
              <GraduationCap size={13} /> Academic Performance
            </div>

            {/* Qualification meta */}
            {(p.qualName || p.marital || p.hasBacklogs || p.qualInstitution) && (
              <div className="rpt-grid-2" style={{ marginBottom: 4 }}>
                {p.qualName && <InfoPair label="Qualification" value={`${p.qualName}${p.qualYear ? ` (${p.qualYear})` : ""}`} />}
                {p.qualInstitution && <InfoPair label="Institution" value={p.qualInstitution} />}
                {p.marital   && <InfoPair label="Marital Status" value={p.marital === "Yes" ? "Married" : p.marital === "No" ? "Unmarried" : p.marital} />}
                {p.hasBacklogs === "Yes" && (
                  <InfoPair label="Backlogs" value={`Yes — ${p.backlogCount || "?"} backlog(s)`} />
                )}
              </div>
            )}

            {/* Score bars */}
            {(p.pct10Score || p.pct12Score || p.pctGradScore) && (
              <>
                <div className="cibil-scale-labels">
                  <span>0%</span><span>60%</span><span>75%</span><span>85%</span><span>100%</span>
                </div>
                <div className="cibil-list">
                  {p.pct10Score && (
                    p.pct10Type === "marks" ? (
                      <InfoPair label={`10th${p.pct10Year ? ` (${p.pct10Year})` : ""}`} value={`${p.pct10Score} Marks`} />
                    ) : (
                      <ScoreBar
                        label={`10th${p.pct10Year ? ` (${p.pct10Year})` : ""}`}
                        rawValue={p.pct10Score}
                        displayValue={p.pct10Type === "points" ? `${p.pct10Score} Points` : `${p.pct10Score}%`}
                        thresholds={p.pct10Type === "points" ? CGPA_T : PCT_T}
                        rangeMin={0} rangeMax={p.pct10Type === "points" ? 10 : 100}
                      />
                    )
                  )}
                  {p.pct12Score && (
                    p.pct12Type === "marks" ? (
                      <InfoPair label={`12th${p.pct12Year ? ` (${p.pct12Year})` : ""}`} value={`${p.pct12Score} Marks`} />
                    ) : (
                      <ScoreBar
                        label={`12th${p.pct12Year ? ` (${p.pct12Year})` : ""}`}
                        rawValue={p.pct12Score}
                        displayValue={p.pct12Type === "points" ? `${p.pct12Score} Points` : `${p.pct12Score}%`}
                        thresholds={p.pct12Type === "points" ? CGPA_T : PCT_T}
                        rangeMin={0} rangeMax={p.pct12Type === "points" ? 10 : 100}
                      />
                    )
                  )}
                  {p.pctGradScore && (
                    <ScoreBar
                      label={`Grad${p.pctGradYear ? ` (${p.pctGradYear})` : ""}`}
                      rawValue={p.pctGradScore}
                      displayValue={p.pctGradType === "cgpa" ? `${p.pctGradScore} CGPA` : `${p.pctGradScore}%`}
                      thresholds={p.pctGradType === "cgpa" ? CGPA_T : PCT_T}
                      rangeMin={0}
                      rangeMax={p.pctGradType === "cgpa" ? 10 : 100}
                    />
                  )}
                </div>
                <div className="cibil-legend">
                  <span className="cl-item cibil-poor">Low &lt;60%</span>
                  <span className="cl-item cibil-fair">Average 60–74%</span>
                  <span className="cl-item cibil-good">Good 75–84%</span>
                  <span className="cl-item cibil-excellent">Excellent 85%+</span>
                </div>
              </>
            )}

            {/* Test scores */}
            {(p.greScore || p.ieltsScore || p.toeflScore || p.duolingoScore || p.gmatScore || p.pteScore) && (
              <>
                <div className="rpt-section-title" style={{ marginTop: 6, fontSize: 10 }}>
                  <Star size={11} /> Standardized Test Scores
                </div>
                <div className="cibil-list">
                  {p.greScore && (
                    <ScoreBar label="GRE" rawValue={p.greScore} displayValue={p.greScore}
                      thresholds={GRE_T} rangeMin={260} rangeMax={340} />
                  )}
                  {p.ieltsScore && (
                    <ScoreBar label="IELTS" rawValue={p.ieltsScore} displayValue={p.ieltsScore}
                      thresholds={IELTS_T} rangeMin={0} rangeMax={9} />
                  )}
                  {p.toeflScore && (
                    <ScoreBar label="TOEFL" rawValue={p.toeflScore} displayValue={p.toeflScore}
                      thresholds={TOEFL_T} rangeMin={0} rangeMax={120} />
                  )}
                  {p.gmatScore && (
                    <ScoreBar label="GMAT" rawValue={p.gmatScore} displayValue={p.gmatScore}
                      thresholds={GMAT_T} rangeMin={200} rangeMax={800} />
                  )}
                  {p.pteScore && (
                    <ScoreBar label="PTE" rawValue={p.pteScore} displayValue={p.pteScore}
                      thresholds={PTE_T} rangeMin={10} rangeMax={90} />
                  )}
                  {p.duolingoScore && (
                    <ScoreBar label="Duolingo" rawValue={p.duolingoScore} displayValue={p.duolingoScore}
                      thresholds={DUOLINGO_T} rangeMin={10} rangeMax={160} />
                  )}
                </div>
                <div className="cibil-legend">
                  <span className="cl-item cibil-poor">Low</span>
                  <span className="cl-item cibil-fair">Average</span>
                  <span className="cl-item cibil-good">Good</span>
                  <span className="cl-item cibil-excellent">Excellent</span>
                </div>
              </>
            )}
          </div>

          {/* University & Visa */}
          <div className="rpt-section">
            <div className="rpt-section-title">
              <Building2 size={13} /> University & Visa
            </div>
            <div className="rpt-grid-2">
              <InfoPair label="Destination Country" value={p.destinationCountry} />
              <InfoPair label="Target University" value={p.targetUniversity} />
              <InfoPair label="Course" value={p.courseNameUniversity} />
              <InfoPair label="I20 Received" value={p.i20Received} />
              <InfoPair label="Visa Booked" value={p.visaBooked === "Yes" ? `Yes${p.visaSlotDate ? ` — ${p.visaSlotDate}` : ""}` : p.visaBooked} />
            </div>
          </div>

          {/* Family & Guarantor */}
          <div className="rpt-section">
            <div className="rpt-section-title">
              <UsersIcon size={13} /> Family & Guarantor
            </div>
            <div className="rpt-grid-2">
              <InfoPair label="Father" value={p.fatherName ? `${p.fatherName}${p.fatherContact ? ` · ${p.fatherContact}` : ""}` : null} />
              <InfoPair label="Mother" value={p.motherName ? `${p.motherName}${p.motherContact ? ` · ${p.motherContact}` : ""}` : null} />
              <InfoPair label="Guarantor" value={p.guarantorName ? `${p.guarantorName} (${p.guarantorRelation || "N/A"})` : null} />
              <InfoPair label="Guarantor Sector" value={p.guarantorSector} />
              <InfoPair label="Income Docs" value={p.guarantorDocsAvailable} />
              <InfoPair label="Job Details" value={p.hasJobDetails === "Yes" ? p.jobSpecs || "Yes" : p.hasJobDetails} />
            </div>
          </div>

          {/* Co-Applicants */}
          {coApplicants.length > 0 && (
            <div className="rpt-section">
              <div className="rpt-section-title">
                <UsersIcon size={13} /> Co-Applicants ({coCount})
              </div>
              <div className="rpt-co-list">
                {coApplicants.map(({ idx, info, uploads: coUploads }) => {
                  const coDisplayName = [info.firstName, info.lastName].filter(Boolean).join(" ") || info.name || "";
                  if (!coDisplayName) return null;
                  const uploadCount = Object.keys(coUploads).length;
                  const empType = info.empType || "salaried";
                  const fields = info.financialStatus === "non-financial"
                    ? 3
                    : (CO_APPLICANT_SCHEMA[empType] || CO_APPLICANT_SCHEMA.other).length;
                  const coPct = fields ? Math.round((uploadCount / fields) * 100) : 0;
                  return (
                    <div key={idx} className="rpt-co-card">
                      <div className="rpt-co-header">
                        <div className="co-avatar"><UsersIcon size={13} /></div>
                        <div className="rpt-co-info">
                          <span className="rpt-co-name">{coDisplayName}</span>
                          <span className="rpt-co-meta">
                            {info.relation || "N/A"} ·{" "}
                            {info.financialStatus === "non-financial" ? "Non-Financial" : info.empType || "Salaried"}
                          </span>
                        </div>
                        <div className={`rpt-co-pct ${getProgressClass(coPct)}`}>{coPct}%</div>
                      </div>
                      <div className="rpt-co-bar">
                        <div className={`rpt-co-fill ${getProgressClass(coPct)}`} style={{ width: `${coPct}%` }} />
                      </div>
                      <div className="rpt-co-details">
                        {info.mobile && <span>{info.mobile}</span>}
                        {info.occupation && <span>{info.occupation}</span>}
                        {info.annualIncome && <span>₹{Number(info.annualIncome).toLocaleString("en-IN")}/yr</span>}
                        {info.qualifications && <span>{info.qualifications}</span>}
                        {info.dependants && <span>{info.dependants} dependants</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Document Completion */}
          <div className="rpt-section">
            <div className="rpt-section-title">
              <FileText size={13} /> Document Completion
            </div>
            <div className="rpt-doc-sections">
              {[
                { key: "applicant", label: "GOVT ID / KYC", required: DOCUMENT_SCHEMA.applicant.fields.filter(f => !f.optional).length },
                { key: "academics", label: "Academics", required: DOCUMENT_SCHEMA.academics.fields.filter(f => !f.optional).length },
              ].map(({ key, label, required }) => {
                const count = Object.keys(student.uploads?.[key] || {}).length;
                const pct = required ? Math.min(100, Math.round((count / required) * 100)) : 0;
                return (
                  <div key={key} className="rpt-doc-row">
                    <span className="rpt-doc-label">{label}</span>
                    <div className="rpt-doc-track">
                      <div className={`rpt-doc-fill ${getProgressClass(pct)}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="rpt-doc-count">{count}/{required}</span>
                  </div>
                );
              })}
              {coApplicants.map(({ idx, info, uploads: coUploads }) => {
                const coDisplayName = [info.firstName, info.lastName].filter(Boolean).join(" ") || info.name || "";
                const empType = info.financialStatus === "non-financial" ? "non-financial" : (info.empType || "salaried");
                const fields = empType === "non-financial" ? 3 : (CO_APPLICANT_SCHEMA[empType] || CO_APPLICANT_SCHEMA.other).length;
                const count = Object.keys(coUploads).length;
                const pct = fields ? Math.min(100, Math.round((count / fields) * 100)) : 0;
                return (
                  <div key={idx} className="rpt-doc-row">
                    <span className="rpt-doc-label">{coDisplayName || `Co-App ${idx + 1}`}</span>
                    <div className="rpt-doc-track">
                      <div className={`rpt-doc-fill ${getProgressClass(pct)}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="rpt-doc-count">{count}/{fields}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Detail tabs content ─────────────────────────────────────── */

function PersonalTab({ student }) {
  const p = student.personalInfo || {};
  const fullName = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.fullName || student.name;
  const fields = [
    { label: "Full Name", value: fullName },
    { label: "Email", value: student.email || p.email },
    { label: "Phone", value: student.phone || p.phone },
    { label: "Marital Status", value: p.marital === "Yes" ? "Married" : p.marital === "No" ? "Unmarried" : p.marital },
    { label: "Loan Amount", value: p.loanAmount ? `₹${Number(p.loanAmount).toLocaleString("en-IN")}` : null },
    { label: "10th Score", value: p.pct10Score ? `${p.pct10Score}${p.pct10Type === "marks" ? " Marks" : p.pct10Type === "points" ? " Points" : "%"}${p.pct10Year ? ` (${p.pct10Year})` : ""}` : p.pct10 },
    { label: "12th Score", value: p.pct12Score ? `${p.pct12Score}${p.pct12Type === "marks" ? " Marks" : p.pct12Type === "points" ? " Points" : "%"}${p.pct12Year ? ` (${p.pct12Year})` : ""}` : p.pct12 },
    { label: "Grad % / CGPA", value: p.pctGradScore ? `${p.pctGradScore}${p.pctGradType === "cgpa" ? " CGPA" : "%"}` : p.pctGrad },
    { label: "Graduation Institution", value: p.qualInstitution },
    { label: "Student CIBIL", value: p.studentCibil },
    { label: "Destination Country", value: p.destinationCountry },
    { label: "Target University", value: p.targetUniversity },
    { label: "Current Address", value: p.currentAddress },
    { label: "Permanent Address", value: p.permanentAddress },
    { label: "Maternal Grandmother", value: p.maternalGrandma },
    { label: "Paternal Grandmother", value: p.paternalGrandma },
  ];

  return (
    <div className="detail-body">
      <p className="section-heading">
        <User size={13} /> Personal Information
      </p>
      <div className="info-grid">
        {fields.map(({ label, value }) => (
          <div key={label} className="info-cell">
            <div className="info-label">{label}</div>
            <div className={`info-value${!value ? " empty" : ""}`}>{value || "—"}</div>
          </div>
        ))}
      </div>

      {student.coApplicants > 0 && (
        <>
          <p className="section-heading" style={{ marginTop: 24 }}>
            <UsersIcon size={13} /> Co‑Applicants ({student.coApplicants})
          </p>
          <div className="co-list">
            {Array.from({ length: student.coApplicants }).map((_, idx) => {
              const info = (student.personalInfo || {})[`co_info_${idx}`] || {};
              const coDisplayName = [info.firstName, info.lastName].filter(Boolean).join(" ") || info.name || "";
              if (!coDisplayName) return null;
              return (
                <div key={idx} className="co-item">
                  <div className="co-avatar"><UsersIcon size={15} /></div>
                  <div className="co-info">
                    <div className="co-name">{coDisplayName}</div>
                    <div className="co-details">{info.relation || "Relation N/A"}</div>
                  </div>
                  {info.empType && <span className="co-type">{info.empType}</span>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function DocumentsTab({ student }) {
  const sections = [
    { key: "applicant", label: "Applicant Docs", required: 6 },
    { key: "academics", label: "Academics", required: 10 },
    { key: "otherDocs", label: "Other Documents", required: null },
  ];
  const caSections = student.coApplicants
    ? [{ key: "co_uploads", label: `Co‑Applicant Docs`, required: student.coApplicants * 3 }]
    : [];

  return (
    <div className="detail-body">
      <p className="section-heading">
        <FolderOpen size={13} /> Document Status by Section
      </p>
      <div className="upload-section-grid">
        {[...sections, ...caSections].map(({ key, label, required }) => {
          const uploads = student.uploads || {};
          const count =
            key === "co_uploads"
              ? Object.keys(uploads).filter((k) => k.startsWith("co_")).length
              : Object.keys(uploads[key] || {}).length;
          const pct = required ? Math.min(100, Math.round((count / required) * 100)) : 0;
          return (
            <div key={key} className="upload-section-card">
              <div className="usc-header">
                <span className="usc-label">{label}</span>
                <span className="usc-count">{count}{required ? ` / ${required}` : "+"}</span>
              </div>
              {required && (
                <div className="usc-bar">
                  <div className="usc-fill" style={{ width: `${pct}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(() => {
        const missing = getMissingDocs(student);
        if (!missing.length)
          return (
            <div className="missing-section missing-all-clear">
              <div className="missing-title missing-ok">
                <CheckCircle size={14} /> All required documents uploaded
              </div>
            </div>
          );

        const grouped = missing.reduce((acc, { section, label }) => {
          if (!acc[section]) acc[section] = [];
          acc[section].push(label);
          return acc;
        }, {});

        return (
          <div className="missing-section" style={{ marginBottom: 16 }}>
            <div className="missing-title">
              <AlertCircle size={14} />
              {missing.length} Missing Required Document{missing.length !== 1 ? "s" : ""}
            </div>
            {Object.entries(grouped).map(([section, labels]) => (
              <div key={section} className="missing-group">
                <div className="missing-group-label">{section}</div>
                <ul className="missing-list">
                  {labels.map((label, i) => <li key={i}>{label}</li>)}
                </ul>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function FilesTab({ student }) {
  const files = getAllUploadedFiles(student.uploads);
  if (!files.length) {
    return (
      <div className="detail-body">
        <div className="admin-empty" style={{ padding: "40px 20px" }}>
          <div className="admin-empty-icon"><FileText size={24} /></div>
          <h3>No files uploaded yet</h3>
          <p>Documents will appear here once the student uploads them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="detail-body">
      <p className="section-heading">
        <FileText size={13} /> {files.length} Uploaded File{files.length !== 1 ? "s" : ""}
      </p>
      <div className="files-list">
        {files.map((file, idx) => (
          <div key={idx} className="file-item">
            <div className="file-icon"><FileText size={14} /></div>
            <div className="file-meta">
              <div className="file-name">{file.name}</div>
              <div className="file-section-tag">{file.section}</div>
            </div>
            {file.webViewLink && (
              <a
                href={file.webViewLink}
                target="_blank"
                rel="noopener noreferrer"
                className="file-link"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} /> View
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Student Row ──────────────────────────────────────────────── */

/* ─── Consultancy inline editor (advisor + superadmin) ─────────── */

const NEW_CONSULTANCY_OPTION = "__new__";

function ConsultancyEditor({ value, onSave, suggestions = [] }) {
  const [editing, setEditing] = useState(false);
  // "select" shows a dropdown of existing consultancy names; "new" shows a
  // free-text input — there's no fixed master list (students type their own
  // consultancy), so there must be a way to add one not yet in the dropdown.
  const [mode, setMode] = useState("select");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const begin = () => {
    setErr("");
    if (value && suggestions.includes(value)) {
      // Already-set value matches an existing option — open on the dropdown, preselected.
      setMode("select");
      setDraft(value);
    } else if (value) {
      // Custom value not in the list — edit it as text directly.
      setMode("new");
      setDraft(value);
    } else if (suggestions.length > 0) {
      // Nothing set yet, but other consultancies exist — offer the dropdown first.
      setMode("select");
      setDraft("");
    } else {
      // No consultancies recorded anywhere yet — nothing to pick from.
      setMode("new");
      setDraft("");
    }
    setEditing(true);
  };
  const cancel = () => { setEditing(false); setErr(""); };
  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (e) {
      setErr(e.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="consultancy-strip">
      <div className="consultancy-strip-label">
        <Building2 size={13} />
        <span>Consultancy</span>
      </div>

      {!editing ? (
        <div className="consultancy-strip-view">
          <span className={`consultancy-strip-value${value ? "" : " empty"}`}>
            {value || "Not set"}
          </span>
          <button className="btn btn-secondary btn-sm consultancy-edit-btn" onClick={begin}>
            <Pencil size={12} /> {value ? "Edit" : "Set consultancy"}
          </button>
        </div>
      ) : mode === "select" ? (
        <div className="consultancy-strip-edit">
          <select
            className="consultancy-strip-select"
            value={draft}
            autoFocus
            disabled={saving}
            onChange={(e) => {
              if (e.target.value === NEW_CONSULTANCY_OPTION) {
                setMode("new");
                setDraft("");
              } else {
                setDraft(e.target.value);
              }
            }}
            onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}
          >
            <option value="">Choose existing consultancy…</option>
            {suggestions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value={NEW_CONSULTANCY_OPTION}>+ Add new consultancy…</option>
          </select>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !draft}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={cancel} disabled={saving}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="consultancy-strip-edit">
          <input
            className="consultancy-strip-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. ABC Overseas, Hyderabad"
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
          />
          {suggestions.length > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={saving}
              onClick={() => { setMode("select"); setDraft(""); }}
              title="Pick from existing consultancies instead"
            >
              Choose existing
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={cancel} disabled={saving}>
            Cancel
          </button>
        </div>
      )}

      {err && <span className="consultancy-strip-err">{err}</span>}
    </div>
  );
}

function StudentRow({ student, isOpen, onToggle, onDelete, onOpenDrive, onViewReport, onSendToBank, onLoanStatusUpdate, onRecoverMeta, canEditConsultancy, onConsultancySave, consultancySuggestions, isDuplicate }) {
  const [activeTab, setActiveTab] = useState("personal");

  const totalUploads = getTotalUploads(student);
  const progress = getOverallProgress(student);
  const progClass = getProgressClass(progress);
  const avatarVariant = getAvatarVariant(student.name);
  const files = getAllUploadedFiles(student.uploads);

  const tabs = [
    { id: "personal", label: "Personal", icon: <User size={12} />, count: null },
    { id: "documents", label: "Documents", icon: <FolderOpen size={12} />, count: null },
    { id: "files", label: "Files", icon: <FileText size={12} />, count: files.length },
  ];

  return (
    <div className={`student-block${isOpen ? " open" : ""}`}>
      <div className="student-row" onClick={onToggle}>
        <div className={`student-avatar avatar-${avatarVariant}`}>
          {(student.name || "?")[0].toUpperCase()}
        </div>

        <div className="student-info">
          <span className="student-name">{student.name || "Unknown Student"}</span>
          <span className="student-contact">{student.email || student.phone || "No contact info"}</span>
          {student._parseError && (
            <span
              className="student-meta-error-badge"
              title={`This student's data file is unreadable and could not be loaded: ${student._parseError}. Filters, progress, and details may be inaccurate until it's fixed (try Recover Meta).`}
            >
              <AlertTriangle size={11} /> Data unreadable
            </span>
          )}
          {isDuplicate && (
            <span
              className="student-meta-error-badge student-duplicate-badge"
              title="Another student record shares this same email or phone number — likely a duplicate Drive folder from a double submission. Check both records before deleting either one."
            >
              <AlertTriangle size={11} /> Possible duplicate
            </span>
          )}
        </div>

        <div className="student-meta">
          {student.advisor && <span className="meta-pill">{student.advisor}</span>}
          {student.personalInfo?.loanAmount && (
            <span className="meta-pill">₹{Number(student.personalInfo.loanAmount).toLocaleString("en-IN")}</span>
          )}
          <span className="meta-pill">{totalUploads} files</span>
        </div>

        <div className={`student-progress-col ${progClass}`}>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="progress-pct">{progress}%</span>
        </div>

        <div className="student-status-col">
          <Badge progress={progress} />
          <LoanStatusBadge status={student.loanStatus} />
        </div>

        <div className="student-actions-col" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn loan-btn" title="Update Loan Status" onClick={onLoanStatusUpdate}>
            <Banknote size={14} />
          </button>
          <button className="icon-btn report-btn" title="View Eligibility Report" onClick={onViewReport}>
            <BarChart3 size={14} />
          </button>
          <button className="icon-btn bank-btn" title="Grant Bank Access" onClick={onSendToBank}>
            <Send size={14} />
          </button>
          <button className="icon-btn del-btn" title="Delete student" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </div>

        <button className={`chevron-btn${isOpen ? " open" : ""}`}>
          <ChevronDown size={16} />
        </button>
      </div>

      {isOpen && (
        <div className="student-detail">
          <div className="detail-inner">
            <div className="detail-tabs">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  className={`detail-tab${activeTab === tab.id ? " active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.icon}
                  {tab.label}
                  {tab.count !== null && tab.count > 0 && (
                    <span className="tab-count">{tab.count}</span>
                  )}
                </button>
              ))}
            </div>

            {activeTab === "personal" && <PersonalTab student={student} />}
            {activeTab === "documents" && <DocumentsTab student={student} />}
            {activeTab === "files" && <FilesTab student={student} />}

            {canEditConsultancy && (
              <ConsultancyEditor
                value={student.personalInfo?.consultantNameLoc || ""}
                onSave={onConsultancySave}
                suggestions={consultancySuggestions}
              />
            )}

            <div className="detail-action-bar">
              <div className="dab-primary">
                <button className="btn btn-loan btn-sm" onClick={onLoanStatusUpdate}>
                  <Banknote size={13} /> Loan Status
                </button>
                <button className="btn btn-primary btn-sm" onClick={onViewReport}>
                  <BarChart3 size={13} /> Eligibility Report
                </button>
                <button className="btn btn-secondary btn-sm" onClick={onOpenDrive}>
                  <ExternalLink size={13} /> Open Drive
                </button>
                <button className="btn btn-secondary btn-sm" onClick={onSendToBank}>
                  <Send size={13} /> Bank Access
                </button>
                <button className="btn btn-recover btn-sm" onClick={onRecoverMeta} title="Recover meta JSON from Summary PDF">
                  <ScanText size={13} /> Recover Meta
                </button>
              </div>
              <button className="btn btn-danger btn-sm dab-delete" onClick={onDelete}>
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Delete Confirm Modal ─────────────────────────────────────── */

function DeleteModal({ name, deleting, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={() => !deleting && onCancel()}>
      <div className="modal-box animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon danger"><Trash2 size={28} /></div>
        <h3>Delete Student?</h3>
        <p>
          This will permanently remove <strong>{name}</strong> and all their
          associated documents from Google Drive. This action cannot be undone.
        </p>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? (
              <><RefreshCw size={13} className="spin" /> Deleting…</>
            ) : (
              <><Trash2 size={13} /> Delete Permanently</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Grant Bank Access Modal ─────────────────────────────────── */

function GrantBankAccessModal({ student, onClose, onAccessChanged }) {
  const [bankers, setBankers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [shared, setShared] = useState(new Set(student.sharedBankers || []));
  const [togglingName, setTogglingName] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await callAPI("GET", "/api/admins/bankers");
        if (!cancelled && r.success) setBankers(r.bankers || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const p = student.personalInfo || {};
  const excludedBank = p.priorBankApplied === "Yes"
    ? (p.priorBankName === "Others" ? p.priorBankNameCustom : p.priorBankName)
    : "";

  const toggleAccess = async (bankerName) => {
    const grant = !shared.has(bankerName);
    setTogglingName(bankerName);
    setError("");
    try {
      const identifier = student.email || student.phone || "";
      const r = await callAPI("PUT", "/api/students/banker-access", {
        studentName: student.name, studentIdentifier: identifier, bankerName, grant,
      });
      if (r.success) {
        setShared(new Set(r.sharedBankers));
        onAccessChanged?.(student.name, r.sharedBankers);
      } else {
        setError(r.error || "Failed to update access.");
      }
    } catch (e) {
      setError(e.message || "Network error. Try again.");
    } finally {
      setTogglingName(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box bank-modal-box animate-fade-in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon"><Send size={28} /></div>
        <h3 className="bank-modal-title">Grant Bank Access</h3>
        <p className="bank-modal-desc">
          Choose which banker accounts can log in and view <strong>{student.name}</strong>'s
          documents. Access can be revoked at any time.
        </p>

        {excludedBank && (
          <p className="settings-msg warn">
            <strong>{excludedBank}</strong> may already have this application — double check before granting.
          </p>
        )}

        {loading ? (
          <div className="admin-loading bank-modal-loading">
            <div className="loading-dots"><span /><span /><span /></div>
          </div>
        ) : bankers.length === 0 ? (
          <p className="bank-modal-empty">
            No banker accounts yet. Use the "Banker Access" button to add one.
          </p>
        ) : (
          <div className="team-list bank-checklist">
            {bankers.map((b) => (
              <label key={b.name} className="team-row bank-check-row">
                <input
                  type="checkbox"
                  className="bank-checkbox"
                  checked={shared.has(b.name)}
                  disabled={togglingName === b.name}
                  onChange={() => toggleAccess(b.name)}
                />
                <div className="bank-logo-mini-wrap">
                  <img src={getBankLogo(b.bank)} alt={b.bank || b.name} className="bank-logo-mini" onError={(e) => { e.target.style.display = "none"; }} />
                </div>
                <div className="team-info">
                  <span className="team-name">{b.name}</span>
                  <span className="team-role-badge banker">
                    {togglingName === b.name ? "Updating…" : shared.has(b.name) ? "Access granted" : "No access"}
                  </span>
                </div>
              </label>
            ))}
          </div>
        )}

        {error && <div className="settings-msg err">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Banker Access + Management (unified) ─────────────────────── */

function BankerAccessManagerModal({ students, onClose, onAccessChanged, onBankersChanged }) {
  // Bankers — fetched internally so add/edit/delete stays live
  const [allBankers, setAllBankers] = useState([]);
  const [bankersLoading, setBankersLoading] = useState(true);

  // Filter + selection
  const [bankFilter, setBankFilter] = useState("all");
  const [selectedName, setSelectedName] = useState(null);

  // Panel: "access" | "add" | "edit"
  const [panel, setPanel] = useState("access");

  // Add form
  const [addBank, setAddBank] = useState("");
  const [addName, setAddName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addPass, setAddPass] = useState("");
  const [addShowPass, setAddShowPass] = useState(false);
  const [addMsg, setAddMsg] = useState(null);
  const [addLoading, setAddLoading] = useState(false);

  // Edit form
  const [editBanker, setEditBanker] = useState(null);
  const [editBank, setEditBank] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPass, setEditPass] = useState("");
  const [editShowPass, setEditShowPass] = useState(false);
  const [editMsg, setEditMsg] = useState(null);
  const [editLoading, setEditLoading] = useState(false);

  // Delete
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Access management
  const [accessSearch, setAccessSearch] = useState("");
  const [togglingName, setTogglingName] = useState(null);
  const [accessError, setAccessError] = useState("");

  const fetchBankers = useCallback(async () => {
    try {
      const r = await callAPI("GET", "/api/admins/bankers");
      if (r.success) {
        const list = r.bankers || [];
        setAllBankers(list);
        setSelectedName((prev) => {
          if (prev && list.find((b) => b.name === prev)) return prev;
          return list[0]?.name || null;
        });
      }
    } catch { /* silent */ }
    finally { setBankersLoading(false); }
  }, []);

  useEffect(() => { fetchBankers(); }, [fetchBankers]);

  // Derived: unique banks that have registered officers
  const uniqueBanks = Array.from(new Set(allBankers.map((b) => b.bank).filter(Boolean))).sort();

  // Bankers visible in sidebar after bank filter
  const visibleBankers = bankFilter === "all"
    ? allBankers
    : allBankers.filter((b) => b.bank === bankFilter);

  const selectedBanker = allBankers.find((b) => b.name === selectedName) || null;

  // Keep selected banker valid when filter changes
  useEffect(() => {
    if (selectedName && !visibleBankers.find((b) => b.name === selectedName)) {
      setSelectedName(visibleBankers[0]?.name || null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bankFilter, allBankers]);

  // Access management data
  const grantedStudents = students.filter((s) => (s.sharedBankers || []).includes(selectedName));
  const grantedNames = new Set(grantedStudents.map((s) => s.name));
  const q = accessSearch.trim().toLowerCase();
  const availableStudents = students.filter((s) => {
    if (grantedNames.has(s.name)) return false;
    if (!q) return true;
    return (s.name || "").toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q) ||
      (s.phone || "").includes(q);
  });
  const visibleAvailable = availableStudents.slice(0, 40);

  // Handlers
  const toggleAccess = async (student, grant) => {
    setTogglingName(student.name);
    setAccessError("");
    try {
      const identifier = student.email || student.phone || "";
      const r = await callAPI("PUT", "/api/students/banker-access", {
        studentName: student.name, studentIdentifier: identifier, bankerName: selectedName, grant,
      });
      if (r.success) {
        onAccessChanged?.(student.name, r.sharedBankers);
      } else {
        setAccessError(r.error || "Failed to update access.");
      }
    } catch (e) {
      setAccessError(e.message || "Network error.");
    } finally {
      setTogglingName(null);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!addBank) { setAddMsg({ type: "err", text: "Please select a bank." }); return; }
    if (!addName.trim()) { setAddMsg({ type: "err", text: "Name is required." }); return; }
    if (addPass.length < 6) { setAddMsg({ type: "err", text: "Password must be at least 6 characters." }); return; }
    setAddLoading(true); setAddMsg(null);
    try {
      const r = await callAPI("POST", "/api/admins", {
        name: addName.trim(), role: "banker", password: addPass,
        bank: addBank,
      });
      if (r.success) {
        setAddMsg({ type: "ok", text: `${addName.trim()} added successfully.` });
        setAddBank(""); setAddName(""); setAddPass("");
        await fetchBankers(); onBankersChanged?.();
        setTimeout(() => { setPanel("access"); setAddMsg(null); }, 1400);
      } else {
        setAddMsg({ type: "err", text: r.error || "Failed to create." });
      }
    } catch { setAddMsg({ type: "err", text: "Network error." }); }
    finally { setAddLoading(false); }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setEditLoading(true); setEditMsg(null);
    try {
      const r = await callAPI("PUT", `/api/admins/${encodeURIComponent(editBanker.name)}`, { bank: editBank, email: editEmail });
      if (!r.success) { setEditMsg({ type: "err", text: r.error || "Failed to update." }); setEditLoading(false); return; }
      if (editPass.length >= 6) {
        const rp = await callAPI("PUT", `/api/admins/${encodeURIComponent(editBanker.name)}/reset-password`, { newPassword: editPass });
        if (!rp.success) { setEditMsg({ type: "err", text: rp.error || "Failed to reset password." }); setEditLoading(false); return; }
      }
      setEditMsg({ type: "ok", text: "Saved successfully." });
      await fetchBankers(); onBankersChanged?.();
      setTimeout(() => { setPanel("access"); setEditBanker(null); setEditMsg(null); }, 1400);
    } catch { setEditMsg({ type: "err", text: "Network error." }); }
    finally { setEditLoading(false); }
  };

  const handleDelete = async (name) => {
    setDeleteLoading(true);
    try {
      const r = await callAPI("DELETE", `/api/admins/${encodeURIComponent(name)}`);
      if (r.success) {
        setDeleteTarget(null);
        if (editBanker?.name === name) { setPanel("access"); setEditBanker(null); }
        await fetchBankers(); onBankersChanged?.();
      } else { alert(r.error || "Failed to delete."); }
    } catch { alert("Network error."); }
    finally { setDeleteLoading(false); }
  };

  const openEdit = (b) => {
    setEditBanker(b); setEditBank(b.bank || ""); setEditEmail(b.email || "");
    setEditPass(""); setEditMsg(null); setPanel("edit");
    setSelectedName(b.name);
  };

  const openAdd = () => {
    setPanel("add"); setAddMsg(null);
    setAddBank(""); setAddName(""); setAddEmail(""); setAddPass("");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="bam-modal animate-fade-in" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="bam-header">
          <div className="bam-header-left">
            <div className="bam-header-icon"><Send size={18} /></div>
            <div>
              <h2 className="bam-title">Banker Access</h2>
              <p className="bam-subtitle">
                {allBankers.length} loan officer{allBankers.length !== 1 ? "s" : ""}
                {uniqueBanks.length > 0 && ` · ${uniqueBanks.length} bank${uniqueBanks.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
          <div className="bam-header-actions">
            {panel !== "add" && (
              <button className="btn btn-primary btn-sm bam-add-btn" onClick={openAdd}>
                <Plus size={13} /> Add Loan Officer
              </button>
            )}
            <button className="icon-btn" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        {/* ── Bank filter chips ───────────────────────────────────── */}
        {uniqueBanks.length > 0 && (
          <div className="bam-bank-filters">
            <button
              className={`bam-bank-chip${bankFilter === "all" ? " active" : ""}`}
              onClick={() => setBankFilter("all")}
            >
              <span className="bam-chip-all-icon"><Building2 size={13} /></span>
              <span className="bam-chip-label">All</span>
              <span className="bam-chip-count">{allBankers.length}</span>
            </button>
            {uniqueBanks.map((bank) => {
              const cnt = allBankers.filter((b) => b.bank === bank).length;
              return (
                <button
                  key={bank}
                  className={`bam-bank-chip${bankFilter === bank ? " active" : ""}`}
                  onClick={() => setBankFilter(bank)}
                >
                  <img src={getBankLogo(bank)} alt={bank} className="bam-chip-logo"
                    onError={(e) => { e.target.style.display = "none"; }} />
                  <span className="bam-chip-label">{bank}</span>
                  <span className="bam-chip-count">{cnt}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="bam-body">

          {/* Sidebar — banker list */}
          <div className="bam-sidebar">
            {bankersLoading ? (
              <div className="bam-sidebar-loading">
                <div className="loading-dots"><span /><span /><span /></div>
              </div>
            ) : visibleBankers.length === 0 ? (
              <div className="bam-sidebar-empty">
                <div className="bam-sidebar-empty-icon"><Building2 size={28} /></div>
                <p>No loan officers yet</p>
                <button className="btn btn-primary btn-sm" onClick={openAdd}><Plus size={12} /> Add first</button>
              </div>
            ) : (
              visibleBankers.map((b) => {
                const count = students.filter((s) => (s.sharedBankers || []).includes(b.name)).length;
                const isSelected = selectedName === b.name;
                return (
                  <div
                    key={b.name}
                    className={`bam-banker-card${isSelected ? " selected" : ""}`}
                    onClick={() => { setSelectedName(b.name); if (panel === "edit" || panel === "add") setPanel("access"); }}
                  >
                    <div className="bam-card-logo-wrap">
                      <img src={getBankLogo(b.bank)} alt={b.bank || "Bank"} className="bam-card-logo"
                        onError={(e) => { e.target.style.display = "none"; }} />
                    </div>
                    <div className="bam-card-info">
                      <span className="bam-card-name">{b.name}</span>
                      <span className="bam-card-bank">{b.bank || <em className="bam-card-nobank">No bank set</em>}</span>
                      {b.email && <span className="bam-card-email">{b.email}</span>}
                    </div>
                    <div className="bam-card-right">
                      <span className="bam-card-count" title={`${count} student${count !== 1 ? "s" : ""} with access`}>
                        {count}
                      </span>
                      <div className="bam-card-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="bam-action-btn edit" title="Edit" onClick={() => openEdit(b)}>
                          <Pencil size={11} />
                        </button>
                        {deleteTarget === b.name ? (
                          <div className="bam-del-confirm">
                            <button className="bam-del-yes" disabled={deleteLoading} onClick={() => handleDelete(b.name)}>
                              {deleteLoading ? <RefreshCw size={10} className="spin" /> : "Yes"}
                            </button>
                            <button className="bam-del-no" onClick={() => setDeleteTarget(null)} disabled={deleteLoading}>No</button>
                          </div>
                        ) : (
                          <button className="bam-action-btn delete" title="Remove" onClick={() => setDeleteTarget(b.name)}>
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Main panel */}
          <div className="bam-main">

            {/* ── Access panel ── */}
            {panel === "access" && (
              selectedBanker ? (
                <div className="bam-access-panel">
                  {/* Banker identity bar */}
                  <div className="bam-identity-bar">
                    <div className="bam-identity-logo-wrap">
                      <img src={getBankLogo(selectedBanker.bank)} alt={selectedBanker.bank || ""} className="bam-identity-logo"
                        onError={(e) => { e.target.style.display = "none"; }} />
                    </div>
                    <div className="bam-identity-info">
                      <span className="bam-identity-name">{selectedBanker.name}</span>
                      <span className="bam-identity-bank">{selectedBanker.bank || "No bank set"}</span>
                    </div>
                    <button className="bam-identity-edit-btn" onClick={() => openEdit(selectedBanker)} title="Edit this loan officer">
                      <Pencil size={13} /> Edit
                    </button>
                  </div>

                  {/* Granted students */}
                  <div className="bam-section">
                    <div className="bam-section-header">
                      <span className="bam-section-title">Can access</span>
                      <span className="bam-section-badge">{grantedStudents.length}</span>
                    </div>
                    {grantedStudents.length === 0 ? (
                      <p className="bam-no-students">No students assigned yet. Grant access below.</p>
                    ) : (
                      <div className="bam-student-list">
                        {grantedStudents.map((s) => (
                          <div key={s.name} className="bam-student-row">
                            <div className="bam-student-avatar">{(s.name || "?")[0].toUpperCase()}</div>
                            <div className="bam-student-info">
                              <span className="bam-student-name">{s.name}</span>
                              <span className="bam-student-contact">{s.email || s.phone || "—"}</span>
                            </div>
                            <button className="bam-revoke-btn" disabled={togglingName === s.name} onClick={() => toggleAccess(s, false)}>
                              {togglingName === s.name ? <RefreshCw size={11} className="spin" /> : "Revoke"}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Grant more */}
                  <div className="bam-section">
                    <div className="bam-section-header">
                      <span className="bam-section-title">Grant access</span>
                    </div>
                    <div className="bam-search-wrap">
                      <Search size={13} className="bam-search-icon" />
                      <input
                        className="bam-search-input"
                        placeholder="Search students by name, email, or phone…"
                        value={accessSearch}
                        onChange={(e) => setAccessSearch(e.target.value)}
                      />
                      {accessSearch && (
                        <button className="bam-search-clear" onClick={() => setAccessSearch("")}><X size={12} /></button>
                      )}
                    </div>
                    <div className="bam-student-list bam-grant-list">
                      {visibleAvailable.length === 0 ? (
                        <p className="bam-no-students">
                          {accessSearch ? "No matching students." : "All students already have access."}
                        </p>
                      ) : (
                        visibleAvailable.map((s) => (
                          <div key={s.name} className="bam-student-row">
                            <div className="bam-student-avatar">{(s.name || "?")[0].toUpperCase()}</div>
                            <div className="bam-student-info">
                              <span className="bam-student-name">{s.name}</span>
                              <span className="bam-student-contact">{s.email || s.phone || "—"}</span>
                            </div>
                            <button className="bam-grant-btn" disabled={togglingName === s.name} onClick={() => toggleAccess(s, true)}>
                              {togglingName === s.name ? <RefreshCw size={11} className="spin" /> : "Grant"}
                            </button>
                          </div>
                        ))
                      )}
                      {availableStudents.length > visibleAvailable.length && (
                        <p className="bam-more-hint">+{availableStudents.length - visibleAvailable.length} more — type to search</p>
                      )}
                    </div>
                    {accessError && <p className="bam-error-inline">{accessError}</p>}
                  </div>
                </div>
              ) : (
                <div className="bam-empty-main">
                  <div className="bam-empty-icon-wrap"><Building2 size={36} /></div>
                  <h3>No loan officers yet</h3>
                  <p>Add your first loan officer using the button above.</p>
                  <button className="btn btn-primary" onClick={openAdd}><Plus size={13} /> Add Loan Officer</button>
                </div>
              )
            )}

            {/* ── Add form ── */}
            {panel === "add" && (
              <div className="bam-form-panel animate-fade-in">
                <div className="bam-form-titlebar">
                  <div className="bam-form-titlebar-icon add"><Plus size={16} /></div>
                  <div>
                    <h3 className="bam-form-h">Add Loan Officer</h3>
                    <p className="bam-form-sub">Register a new banker who can log in and view student documents.</p>
                  </div>
                  <button className="icon-btn" onClick={() => setPanel("access")}><X size={16} /></button>
                </div>
                <form onSubmit={handleAdd} className="bam-form">
                  <div className="bam-field">
                    <label>Bank <span className="req">*</span></label>
                    <div className="bam-select-wrap">
                      {addBank && <img src={getBankLogo(addBank)} alt={addBank} className="bam-select-logo" />}
                      <select className={`bam-select${addBank ? " has-logo" : ""}`} value={addBank} onChange={(e) => setAddBank(e.target.value)}>
                        <option value="">— Select bank —</option>
                        {BANK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="bam-field">
                    <label>Full Name <span className="req">*</span> <span className="bam-hint">(login username)</span></label>
                    <input className="bam-input" type="text" placeholder="e.g. Rajesh Kumar" value={addName} onChange={(e) => setAddName(e.target.value)} />
                  </div>
                  <div className="bam-field">
                    <label>Password <span className="req">*</span></label>
                    <div className="bam-pw-wrap">
                      <input className="bam-input" type={addShowPass ? "text" : "password"} placeholder="Min. 6 characters" value={addPass} onChange={(e) => setAddPass(e.target.value)} />
                      <button type="button" className="bam-pw-toggle" onClick={() => setAddShowPass(!addShowPass)}>
                        {addShowPass ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                  {addMsg && <div className={`bam-msg ${addMsg.type}`}>{addMsg.text}</div>}
                  <div className="bam-form-actions">
                    <button type="submit" className="bam-submit-btn" disabled={addLoading}>
                      {addLoading ? <><RefreshCw size={13} className="spin" /> Creating…</> : <><Plus size={13} /> Create Officer</>}
                    </button>
                    <button type="button" className="bam-cancel-btn" onClick={() => setPanel("access")}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

            {/* ── Edit form ── */}
            {panel === "edit" && editBanker && (
              <div className="bam-form-panel animate-fade-in">
                <div className="bam-form-titlebar">
                  <div className="bam-edit-logo-wrap">
                    <img src={getBankLogo(editBanker.bank)} alt={editBanker.bank || "Bank"} className="bam-edit-thumb"
                      onError={(e) => { e.target.style.display = "none"; }} />
                  </div>
                  <div>
                    <h3 className="bam-form-h">{editBanker.name}</h3>
                    <p className="bam-form-sub">Since {new Date(editBanker.createdAt).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}</p>
                  </div>
                  <button className="icon-btn" onClick={() => { setPanel("access"); setEditBanker(null); }}><X size={16} /></button>
                </div>
                <form onSubmit={handleEdit} className="bam-form">
                  <div className="bam-field">
                    <label>Bank</label>
                    <div className="bam-select-wrap">
                      {editBank && <img src={getBankLogo(editBank)} alt={editBank} className="bam-select-logo" />}
                      <select className={`bam-select${editBank ? " has-logo" : ""}`} value={editBank} onChange={(e) => setEditBank(e.target.value)}>
                        <option value="">— Select bank —</option>
                        {BANK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="bam-field">
                    <label>New Password <span className="bam-hint">(leave blank to keep current)</span></label>
                    <div className="bam-pw-wrap">
                      <input className="bam-input" type={editShowPass ? "text" : "password"} placeholder="Min. 6 characters" value={editPass} onChange={(e) => setEditPass(e.target.value)} />
                      <button type="button" className="bam-pw-toggle" onClick={() => setEditShowPass(!editShowPass)}>
                        {editShowPass ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                  {editMsg && <div className={`bam-msg ${editMsg.type}`}>{editMsg.text}</div>}
                  <div className="bam-form-actions">
                    <button type="submit" className="bam-submit-btn" disabled={editLoading}>
                      {editLoading ? <><RefreshCw size={13} className="spin" /> Saving…</> : <><CheckCircle size={13} /> Save Changes</>}
                    </button>
                    <button type="button" className="bam-cancel-btn" onClick={() => { setPanel("access"); setEditBanker(null); }}>Cancel</button>
                  </div>
                </form>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Settings Panel ───────────────────────────────────────────── */

const API_URL = import.meta.env.VITE_API_URL ?? '';

function getToken() {
  try { return JSON.parse(localStorage.getItem("abroad_admin_session") || "{}").token || ""; }
  catch { return ""; }
}

async function callAPI(method, path, body) {
  const token = getToken();
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body && method !== "GET") opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  return res.json();
}

function SettingsPanel({ onClose, adminName, adminRole }) {
  const [tab, setTab] = useState("password");

  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [passMsg, setPassMsg] = useState(null);
  const [passLoading, setPassLoading] = useState(false);

  const [teamPass, setTeamPass] = useState("");
  const [teamVerified, setTeamVerified] = useState(false);
  const [teamVerifying, setTeamVerifying] = useState(false);
  const [teamErr, setTeamErr] = useState("");
  const [admins, setAdmins] = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("advisor");
  const [newAdminPass, setNewAdminPass] = useState("");
  const [createMsg, setCreateMsg] = useState(null);
  const [createLoading, setCreateLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [resetPwTarget, setResetPwTarget] = useState(null);
  const [resetPwValue, setResetPwValue] = useState("");
  const [resetPwLoading, setResetPwLoading] = useState(false);
  const [resetPwMsg, setResetPwMsg] = useState(null);

  const loadAdmins = async () => {
    setAdminsLoading(true);
    try {
      const d = await callAPI("GET", "/api/admins");
      if (d.success) setAdmins(d.admins || []);
    } catch { /* silent */ }
    finally { setAdminsLoading(false); }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (resetPwValue.length < 6) { setResetPwMsg({ type: "err", text: "Password must be at least 6 characters." }); return; }
    setResetPwLoading(true); setResetPwMsg(null);
    try {
      const r = await callAPI("PUT", `/api/admins/${encodeURIComponent(resetPwTarget)}/reset-password`, { newPassword: resetPwValue });
      if (r.success) {
        setResetPwMsg({ type: "ok", text: `Password reset for ${resetPwTarget}.` });
        setResetPwValue("");
        setTimeout(() => { setResetPwTarget(null); setResetPwMsg(null); }, 1500);
      } else {
        setResetPwMsg({ type: "err", text: r.error || "Failed to reset password." });
      }
    } catch { setResetPwMsg({ type: "err", text: "Network error. Try again." }); }
    finally { setResetPwLoading(false); }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPass.length < 6) { setPassMsg({ type: "err", text: "New password must be at least 6 characters." }); return; }
    if (newPass !== confirmPass) { setPassMsg({ type: "err", text: "Passwords do not match." }); return; }
    setPassLoading(true); setPassMsg(null);
    try {
      const r = await callAPI("PUT", "/api/admins/password", { currentPassword: curPass, newPassword: newPass });
      if (r.success) {
        setPassMsg({ type: "ok", text: "Password updated successfully." });
        setCurPass(""); setNewPass(""); setConfirmPass("");
      } else {
        setPassMsg({ type: "err", text: r.error || "Failed to update password." });
      }
    } catch { setPassMsg({ type: "err", text: "Network error. Try again." }); }
    finally { setPassLoading(false); }
  };

  const handleVerifyTeamPass = async (e) => {
    e.preventDefault(); setTeamVerifying(true); setTeamErr("");
    try {
      const r = await callAPI("POST", "/api/auth/login", { name: adminName, password: teamPass });
      if (r.success && (r.role === "superadmin" || r.role === "advisor")) {
        setTeamVerified(true);
        if (r.role === "superadmin") loadAdmins();
      } else {
        setTeamErr("Incorrect password.");
      }
    } catch { setTeamErr("Network error. Try again."); }
    finally { setTeamVerifying(false); }
  };

  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    if (!newName.trim()) { setCreateMsg({ type: "err", text: "Name is required." }); return; }
    if (newAdminPass.length < 6) { setCreateMsg({ type: "err", text: "Password must be at least 6 characters." }); return; }
    setCreateLoading(true); setCreateMsg(null);
    try {
      const r = await callAPI("POST", "/api/admins", { name: newName.trim(), role: newRole, password: newAdminPass });
      if (r.success) {
        setCreateMsg({ type: "ok", text: `${newName.trim()} created successfully.` });
        setNewName(""); setNewAdminPass(""); setNewRole("advisor");
        loadAdmins();
      } else {
        setCreateMsg({ type: "err", text: r.error || "Failed to create admin." });
      }
    } catch { setCreateMsg({ type: "err", text: "Network error. Try again." }); }
    finally { setCreateLoading(false); }
  };

  const handleDeleteAdmin = async (name) => {
    setDeleteLoading(true);
    try {
      const r = await callAPI("DELETE", `/api/admins/${encodeURIComponent(name)}`);
      if (r.success) { setDeleteTarget(null); loadAdmins(); }
      else { alert(r.error || "Failed to delete."); }
    } catch { alert("Network error. Try again."); }
    finally { setDeleteLoading(false); }
  };

  return (
    <>
      <div className="settings-overlay" onClick={onClose} />
      <div className="settings-panel animate-fade-in">
        <div className="settings-header">
          <div className="settings-title"><Settings size={16} /> Settings</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab${tab === "password" ? " active" : ""}`} onClick={() => setTab("password")}>
            <KeyRound size={16} />
            <span>Password</span>
          </button>
          {adminRole === "superadmin" && (
            <button
              className={`settings-tab${tab === "team" ? " active" : ""}`}
              onClick={() => { setTab("team"); if (teamVerified) loadAdmins(); }}
            >
              <UserCheck size={16} />
              <span>Team</span>
            </button>
          )}
        </div>

        <div className="settings-body">
          {tab === "password" && (
            <form onSubmit={handleChangePassword} className="settings-form">
              <p className="settings-section-label">Update your login password</p>
              <div className="input-group">
                <label>Current Password</label>
                <div className="password-wrap">
                  <input className="input-field" type={showPass ? "text" : "password"} placeholder="Your current password"
                    value={curPass} onChange={(e) => setCurPass(e.target.value)} />
                  <button type="button" className="show-pass" onClick={() => setShowPass(!showPass)}>
                    {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="input-group">
                <label>New Password</label>
                <input className="input-field" type={showPass ? "text" : "password"} placeholder="Min. 6 characters"
                  value={newPass} onChange={(e) => setNewPass(e.target.value)} />
              </div>
              <div className="input-group">
                <label>Confirm New Password</label>
                <input className="input-field" type={showPass ? "text" : "password"} placeholder="Repeat new password"
                  value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} />
              </div>
              {passMsg && <p className={`settings-msg ${passMsg.type}`}>{passMsg.text}</p>}
              <button type="submit" className="btn btn-primary btn-sm" disabled={passLoading}>
                {passLoading ? <><RefreshCw size={13} className="spin" /> Saving…</> : <><KeyRound size={13} /> Update Password</>}
              </button>
            </form>
          )}

          {tab === "team" && (
            <div>
              {!teamVerified ? (
                <form onSubmit={handleVerifyTeamPass} className="settings-form">
                  <p className="settings-section-label">Enter your password to manage the team</p>
                  <div className="input-group">
                    <label>Your Password</label>
                    <div className="password-wrap">
                      <input className="input-field" type={showPass ? "text" : "password"} placeholder="Confirm your identity"
                        value={teamPass} onChange={(e) => setTeamPass(e.target.value)} autoFocus />
                      <button type="button" className="show-pass" onClick={() => setShowPass(!showPass)}>
                        {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>
                  {teamErr && <p className="settings-msg err">{teamErr}</p>}
                  <button type="submit" className="btn btn-primary btn-sm" disabled={teamVerifying}>
                    {teamVerifying ? <><RefreshCw size={13} className="spin" /> Verifying…</> : <><Shield size={13} /> Verify & Continue</>}
                  </button>
                </form>
              ) : (
                <div>
                  <p className="settings-section-label">Current Team</p>
                  {adminsLoading ? (
                    <div className="admin-loading" style={{ padding: "24px 0" }}>
                      <div className="loading-dots"><span /><span /><span /></div>
                    </div>
                  ) : (
                    <div className="team-list">
                      {admins.map((a) => (
                        <div key={a.name} className="team-row">
                          <div className="team-avatar">{a.name[0].toUpperCase()}</div>
                          <div className="team-info">
                            <span className="team-name">{a.name}</span>
                            <span className={`team-role-badge ${a.role}`}>
                              {a.role === "superadmin" ? "Super Admin" : a.role === "banker" ? "Banker" : "Advisor"}
                            </span>
                          </div>
                          {a.name !== adminName && (
                            deleteTarget === a.name ? (
                              <div className="team-delete-confirm">
                                <span>Delete?</span>
                                <button className="btn btn-danger btn-sm" onClick={() => handleDeleteAdmin(a.name)} disabled={deleteLoading}>
                                  {deleteLoading ? <RefreshCw size={12} className="spin" /> : "Yes"}
                                </button>
                                <button className="btn btn-secondary btn-sm" onClick={() => setDeleteTarget(null)} disabled={deleteLoading}>No</button>
                              </div>
                            ) : (
                              <>
                                <button className="icon-btn" title={`Reset ${a.name}'s password`} onClick={() => { setResetPwTarget(a.name); setResetPwValue(""); setResetPwMsg(null); }}>
                                  <KeyRound size={13} />
                                </button>
                                <button className="icon-btn del-btn" title={`Remove ${a.name}`} onClick={() => setDeleteTarget(a.name)}>
                                  <Trash2 size={13} />
                                </button>
                              </>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="settings-section-label" style={{ marginTop: 20 }}>Add New Member</p>
                  <form onSubmit={handleCreateAdmin} className="settings-form">
                    <div className="input-group">
                      <label>Name</label>
                      <input className="input-field" type="text" placeholder="e.g. Ravi" value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </div>
                    <div className="input-group">
                      <label>Role</label>
                      <select className="input-field" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                        <option value="advisor">Advisor</option>
                        <option value="banker">Banker</option>
                        <option value="superadmin">Super Admin</option>
                      </select>
                    </div>
                    <div className="input-group">
                      <label>Password</label>
                      <input className="input-field" type="password" placeholder="Min. 6 characters" value={newAdminPass} onChange={(e) => setNewAdminPass(e.target.value)} />
                    </div>
                    {createMsg && <p className={`settings-msg ${createMsg.type}`}>{createMsg.text}</p>}
                    <button type="submit" className="btn btn-primary btn-sm" disabled={createLoading}>
                      {createLoading ? <><RefreshCw size={13} className="spin" /> Creating…</> : <><Plus size={13} /> Create Member</>}
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {resetPwTarget && (
        <div className="modal-backdrop" onClick={() => !resetPwLoading && setResetPwTarget(null)}>
          <div className="modal-box animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon"><KeyRound size={28} /></div>
            <h3>Reset Password</h3>
            <p>
              Set a new password for <strong>{resetPwTarget}</strong>. They'll need to use it next time they log in.
            </p>
            <form onSubmit={handleResetPassword} className="settings-form" style={{ textAlign: "left" }}>
              <div className="input-group">
                <label>New Password</label>
                <input className="input-field" type="password" placeholder="Min. 6 characters" value={resetPwValue} onChange={(e) => setResetPwValue(e.target.value)} autoFocus />
              </div>
              {resetPwMsg && <p className={`settings-msg ${resetPwMsg.type}`}>{resetPwMsg.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setResetPwTarget(null)} disabled={resetPwLoading}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={resetPwLoading}>
                  {resetPwLoading ? <><RefreshCw size={13} className="spin" /> Resetting…</> : "Reset Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

/* ─── Main Component ───────────────────────────────────────────── */

// A stable per-student identity for React keys and state tracking.
// driveUrl is always unique (one Drive folder per student); name is NOT —
// two students can share a display name, and a student whose meta.json
// failed to parse falls back to showing its raw folder-key name, which can
// collide with another record. Using name/array-index as a key or state
// pointer lets the wrong row appear expanded/selected after a filter or
// list refresh reorders things.
function studentKey(s) {
  return s.driveUrl || s.email || s.phone || s.name;
}

export default function Admin() {
  const { isAdmin, adminRole, adminAdvisorName, adminName } = useStudent();
  const navigate = useNavigate();

  const [students, setStudents] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [advisorFilter, setAdvisorFilter] = useState("all");
  const [bankerFilter, setBankerFilter] = useState("all");
  const [loanStatusFilter, setLoanStatusFilter] = useState("all");
  const [consultancyFilter, setConsultancyFilter] = useState("");
  const [bankers, setBankers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Tracks the expanded row by a stable per-student key (driveUrl, falling
  // back to email/phone/name), NOT by array index or by name alone. Both of
  // those break as soon as the list is filtered/reordered or two students
  // share a display name (e.g. a corrupted meta record falling back to its
  // raw folder-key name) — the wrong row would appear expanded, showing one
  // student's data on another student's row.
  const [expandedKey, setExpandedKey] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reportStudent, setReportStudent] = useState(null);
  const [bankStudent, setBankStudent] = useState(null);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [loanStatusStudent, setLoanStatusStudent] = useState(null);
  const [recoverStudent, setRecoverStudent] = useState(null);

  useEffect(() => {
    if (!isAdmin) navigate("/admin-login");
  }, [isAdmin, navigate]);

  const loadStudents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const fetched = await getAllStudentsFromDrive();
      setStudents(fetched || []);
    } catch (e) {
      setError("Could not load students: " + e.message);
      setStudents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadBankers = useCallback(async () => {
    try {
      const r = await callAPI("GET", "/api/admins/bankers");
      if (r.success) setBankers(r.bankers || []);
    } catch { /* silent — banker filter just won't show options */ }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStudents();
    void loadBankers();
  }, [isAdmin, loadStudents, loadBankers]);

  // Deletes by the actual student object (not by name — display names are
  // not unique, e.g. two students can share a name, or a corrupted meta
  // record falls back to showing its raw folder-key name). Matching by name
  // could delete/hide the wrong row when two students collide on it.
  const handleDelete = async (student) => {
    setDeleting(true);
    try {
      const identifier = student.email || student.phone || "";
      await deleteStudent(student.name, identifier, student.driveUrl || "");
      const key = studentKey(student);
      setStudents((prev) => prev.filter((s) => studentKey(s) !== key));
      setConfirmDelete(null);
      setExpandedKey((cur) => (cur === key ? null : cur));
      // Re-sync from the backend — the cache was just cleared server-side,
      // so this confirms the delete actually stuck instead of trusting the
      // optimistic local removal alone.
      void loadStudents();
    } catch (e) {
      setError("Delete failed: " + e.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleAccessChanged = (name, sharedBankers) => {
    setStudents((prev) => prev.map((s) => s.name === name ? { ...s, sharedBankers } : s));
  };

  const handleLoanStatusChange = (name, loanStatus, loanRemark) => {
    setStudents((prev) => prev.map((s) => s.name === name ? { ...s, loanStatus, loanRemark } : s));
  };

  // Advisor sets/corrects a student's consultancy from the admin panel.
  // Writes the same meta field the student portal fills (personalInfo.consultantNameLoc)
  // via the staff-only /api/meta route, so portal, summary PDF, and the
  // consultancy filter all stay in sync.
  const handleConsultancySave = async (student, value) => {
    // Strip backend-added listing fields so only real meta goes back to Drive
    const meta = { ...student };
    delete meta.driveUrl;
    delete meta._parseError;
    const updatedMeta = {
      ...meta,
      personalInfo: { ...(meta.personalInfo || {}), consultantNameLoc: value },
    };
    const identifier = student.email || student.phone || "";
    const folderKey = buildFolderKey(student.name, identifier);
    const r = await callAPI("POST", "/api/meta", {
      studentName: folderKey,
      metaJson: JSON.stringify(updatedMeta),
    });
    if (!r.success) throw new Error(r.error || "Could not save consultancy");
    setStudents((prev) =>
      prev.map((s) => (s.name === student.name ? { ...s, personalInfo: updatedMeta.personalInfo } : s)),
    );
  };

  const openDriveFolder = (s) => {
    const url =
      s.driveUrl ||
      s.driveFolderUrl ||
      (import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID
        ? `https://drive.google.com/drive/folders/${import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID}`
        : null);
    if (url) window.open(url, "_blank");
  };

  // Flags students sharing a non-empty email or phone with another student —
  // a sign of a duplicate Drive folder (most commonly from a double-submit
  // race during registration/upload, before getOrCreate serialized those
  // calls server-side). Computed across the FULL unscoped list so a
  // superadmin sees cross-advisor duplicates too.
  const duplicateIdentifiers = (() => {
    const counts = new Map();
    for (const s of students) {
      for (const raw of [s.email, s.phone]) {
        const v = (raw || "").trim().toLowerCase();
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    const dupes = new Set();
    for (const [v, c] of counts) if (c > 1) dupes.add(v);
    return dupes;
  })();
  const isDuplicateStudent = (s) => {
    const e = (s.email || "").trim().toLowerCase();
    const p = (s.phone || "").trim().toLowerCase();
    return (e && duplicateIdentifiers.has(e)) || (p && duplicateIdentifiers.has(p));
  };

  // Advisor scope applies everywhere on the dashboard — stats, list, everything.
  // Advisors are locked to their own students; superadmins can narrow via advisorFilter.
  // bankerFilter narrows further, on top of whichever scope above already applies.
  const scopedStudents = students.filter((s) => {
    if (adminRole === "advisor" && s.advisor !== adminAdvisorName) return false;
    if (adminRole !== "advisor" && advisorFilter !== "all" && s.advisor !== advisorFilter) return false;
    if (bankerFilter !== "all" && !(s.sharedBankers || []).includes(bankerFilter)) return false;
    return true;
  });

  const stats = {
    total: scopedStudents.length,
    complete: scopedStudents.filter((s) => getOverallProgress(s) === 100).length,
    inProgress: scopedStudents.filter((s) => { const p = getOverallProgress(s); return p > 0 && p < 100; }).length,
    notStarted: scopedStudents.filter((s) => getOverallProgress(s) === 0).length,
  };

  const loanStats = {
    pending:    scopedStudents.filter((s) => !s.loanStatus || s.loanStatus === "pending").length,
    inprocess:  scopedStudents.filter((s) => s.loanStatus === "inprocess").length,
    sanctioned: scopedStudents.filter((s) => s.loanStatus === "sanctioned").length,
    rejected:   scopedStudents.filter((s) => s.loanStatus === "rejected").length,
    dropped:    scopedStudents.filter((s) => s.loanStatus === "dropped").length,
  };

  // Advisor dropdown options always list every advisor, regardless of current scope.
  const advisorList = Array.from(
    new Set(students.map((s) => s.advisor).filter(Boolean)),
  ).sort();

  // Unique consultancy names across the advisor's scoped students — these come
  // from personalInfo.consultantNameLoc stored in each student's meta on Drive,
  // so the dropdown always reflects what's actually saved in the backend.
  const consultancyList = Array.from(
    new Set(
      scopedStudents
        .map((s) => (s.personalInfo?.consultantNameLoc || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));

  const filtered = scopedStudents.filter((s) => {
    const q = search.toLowerCase();
    const matchesSearch =
      !search ||
      (s.name || "").toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q) ||
      (s.phone || "").includes(q);
    const p = getOverallProgress(s);
    const matchesFilter =
      filter === "all" ||
      (filter === "complete" && p === 100) ||
      (filter === "progress" && p > 0 && p < 100) ||
      (filter === "notStarted" && p === 0);
    const matchesLoanStatus =
      loanStatusFilter === "all" ||
      (loanStatusFilter === "pending" && (!s.loanStatus || s.loanStatus === "pending")) ||
      s.loanStatus === loanStatusFilter;
    // Consultancy dropdown: exact name from the saved list, or "__none__" to
    // surface students whose consultancy hasn't been set yet.
    const consultancyValue = (s.personalInfo?.consultantNameLoc || "").trim();
    const matchesConsultancy =
      !consultancyFilter ||
      (consultancyFilter === "__none__"
        ? !consultancyValue
        : consultancyValue === consultancyFilter);
    return matchesSearch && matchesFilter && matchesLoanStatus && matchesConsultancy;
  });

  const rootUrl = import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID
    ? `https://drive.google.com/drive/folders/${import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID}`
    : null;

  if (!isAdmin) return null;

  return (
    <div className="admin-page">
      <div className="admin-container">
        {/* Header */}
        <div className="admin-header animate-fade-in">
          <div className="admin-header-left">
            <h1 className="admin-title">
              <div className="admin-title-icon"><Shield size={18} /></div>
              Admin Dashboard
            </h1>
            <p className="admin-sub">
              {adminRole === "advisor"
                ? `Advisor: ${adminAdvisorName} — showing your students only`
                : "Super Admin — all students"}
            </p>
          </div>

          <div className="header-actions">
            <button className="btn btn-secondary btn-sm" onClick={loadStudents} disabled={loading}>
              <RefreshCw size={13} className={loading ? "spin" : ""} />
              <span className="btn-label">Refresh</span>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate("/")}>
              <UserPlus size={13} />
              <span className="btn-label">Add Student</span>
            </button>
            {rootUrl && (
              <a className="btn btn-primary btn-sm" href={rootUrl} target="_blank" rel="noreferrer">
                <FolderOpen size={13} />
                <span className="btn-label">Root Drive</span>
              </a>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => setShowAccessManager(true)} title="Manage bankers and student access">
              <Send size={13} />
              <span className="btn-label">Banker Access</span>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowSettings(true)} title="Settings">
              <Settings size={13} />
              <span className="btn-label">Settings</span>
            </button>
          </div>
        </div>

        {/* Compact Stats Panel */}
        <StatsPanel
          stats={stats}
          loanStats={loanStats}
          filter={filter}
          setFilter={setFilter}
          loanStatusFilter={loanStatusFilter}
          setLoanStatusFilter={setLoanStatusFilter}
        />

        {/* Toolbar */}
        <div className="admin-toolbar">
          <div className="admin-search">
            <Search size={15} />
            <input
              className="search-input"
              placeholder="Search by name, email, or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="search-clear" onClick={() => setSearch("")}><X size={14} /></button>
            )}
          </div>

          <div className="toolbar-filter">
            {[
              { id: "all", label: "All" },
              { id: "complete", label: "Complete" },
              { id: "progress", label: "In Progress" },
              { id: "notStarted", label: "Not Started" },
            ].map((f) => (
              <button
                key={f.id}
                className={`filter-chip${filter === f.id ? " active" : ""}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Consultancy filter — visible to both advisor and superadmin */}
          <select
            className={`advisor-filter-select consultancy-filter-select${consultancyFilter ? " has-value" : ""}`}
            value={consultancyFilter}
            onChange={(e) => setConsultancyFilter(e.target.value)}
            aria-label="Filter students by consultancy"
          >
            <option value="">All Consultancies</option>
            {consultancyList.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value="__none__">— No consultancy set —</option>
          </select>

          {adminRole !== "advisor" && advisorList.length > 0 && (
            <select
              className="advisor-filter-select"
              value={advisorFilter}
              onChange={(e) => setAdvisorFilter(e.target.value)}
            >
              <option value="all">All Advisors</option>
              {advisorList.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          )}

          {bankers.length > 0 && (
            <select
              className="advisor-filter-select banker-filter-select"
              value={bankerFilter}
              onChange={(e) => setBankerFilter(e.target.value)}
            >
              <option value="all">All Bankers</option>
              {bankers.map((b) => (
                <option key={b.name} value={b.name}>{b.name}</option>
              ))}
            </select>
          )}

          <select
            className="advisor-filter-select loan-status-filter-select"
            value={loanStatusFilter}
            onChange={(e) => setLoanStatusFilter(e.target.value)}
          >
            <option value="all">All Loan Status</option>
            <option value="pending">Pending</option>
            <option value="inprocess">In Process</option>
            <option value="sanctioned">Sanctioned</option>
            <option value="rejected">Rejected</option>
            <option value="dropped">Dropped</option>
          </select>
        </div>

        {/* Error banner */}
        {error && (
          <div className="admin-error animate-fade-in">
            <AlertCircle size={15} />
            {error}
            <button className="close-err" onClick={() => setError("")}><X size={13} /></button>
          </div>
        )}

        {/* Table */}
        <div className="admin-table-wrap animate-fade-in">
          <div className="table-head">
            <div className="th th-name">Student</div>
            <div className="th th-meta">Metadata</div>
            <div className="th th-progress">Progress</div>
            <div className="th th-status">Status</div>
            <div className="th th-actions">Actions</div>
          </div>

          {loading ? (
            <div className="admin-loading">
              <div className="loading-dots"><span /><span /><span /></div>
              Loading students…
            </div>
          ) : filtered.length === 0 ? (
            <div className="admin-empty">
              <div className="admin-empty-icon"><Users size={28} /></div>
              <h3>
                {search || filter !== "all" || consultancyFilter
                  ? "No students match"
                  : adminRole === "advisor"
                    ? "No students assigned yet"
                    : "No students yet"}
              </h3>
              <p>
                {consultancyFilter === "__none__"
                  ? "Every student has a consultancy set."
                  : consultancyFilter
                    ? `No students found for consultancy "${consultancyFilter}".`
                    : search || filter !== "all"
                      ? "Try adjusting your search or filter."
                      : adminRole === "advisor"
                        ? `No students have selected ${adminAdvisorName} as their advisor yet.`
                        : "Add a student to get started."}
              </p>
              {(search || filter !== "all" || consultancyFilter) && (
                <button
                  className="btn btn-secondary btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => { setSearch(""); setFilter("all"); setConsultancyFilter(""); }}
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="student-list">
              {filtered.map((s) => {
                const k = studentKey(s);
                return (
                  <StudentRow
                    key={k}
                    student={s}
                    isOpen={expandedKey === k}
                    onToggle={() => setExpandedKey((cur) => (cur === k ? null : k))}
                    onDelete={(e) => { if (e) e.stopPropagation(); setConfirmDelete(s); }}
                    onOpenDrive={(e) => { if (e) e.stopPropagation(); openDriveFolder(s); }}
                    onViewReport={(e) => { if (e) e.stopPropagation(); setReportStudent(s); }}
                    onSendToBank={(e) => { if (e) e.stopPropagation(); setBankStudent(s); }}
                    onLoanStatusUpdate={(e) => { if (e) e.stopPropagation(); setLoanStatusStudent(s); }}
                    onRecoverMeta={(e) => { if (e) e.stopPropagation(); setRecoverStudent(s); }}
                    canEditConsultancy={adminRole === "advisor" || adminRole === "superadmin"}
                    onConsultancySave={(value) => handleConsultancySave(s, value)}
                    consultancySuggestions={consultancyList}
                    isDuplicate={isDuplicateStudent(s)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Loan Status Modal */}
      {loanStatusStudent && (
        <LoanStatusModal
          student={loanStatusStudent}
          onClose={() => setLoanStatusStudent(null)}
          onUpdated={handleLoanStatusChange}
        />
      )}

      {/* Recover Meta Modal */}
      {recoverStudent && (
        <RecoverMetaModal
          student={recoverStudent}
          onClose={() => setRecoverStudent(null)}
          onRestored={(recovered) => {
            setStudents((prev) => prev.map((s) =>
              s.name === recoverStudent.name ? { ...s, ...recovered } : s
            ));
            setRecoverStudent(null);
          }}
        />
      )}

      {/* Report Modal */}
      {reportStudent && (
        <ReportModal student={reportStudent} onClose={() => setReportStudent(null)} />
      )}

      {/* Grant Bank Access Modal */}
      {bankStudent && (
        <GrantBankAccessModal
          student={bankStudent}
          onClose={() => setBankStudent(null)}
          onAccessChanged={handleAccessChanged}
        />
      )}

      {/* Banker Access — manage loan officers, bank filters, and per-student access */}
      {showAccessManager && (
        <BankerAccessManagerModal
          students={scopedStudents}
          onClose={() => setShowAccessManager(false)}
          onAccessChanged={handleAccessChanged}
          onBankersChanged={loadBankers}
        />
      )}

      {/* Delete modal */}
      {confirmDelete && (
        <DeleteModal
          name={confirmDelete.name}
          deleting={deleting}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* Settings panel */}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          adminName={adminName}
          adminRole={adminRole}
        />
      )}

    </div>
  );
}
