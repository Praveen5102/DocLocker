import { useState, useEffect, useCallback } from "react";
import {
  Search, RefreshCw, AlertCircle, FileText, Eye, Download, ChevronDown,
  Building2, FolderOpen, X, GraduationCap, Banknote, FolderInput, KeyRound, EyeOff,
  CheckCircle, Upload, Archive,
} from "lucide-react";
import { useStudent } from "../../context/StudentContext";
import { getAllStudentsFromDrive, getStudentFiles, getFileProxyUrl, changeOwnPassword, updateLoanStatus, uploadSanctionLetter, getDownloadAllUrl } from "../../utils/driveApi";
import { getBankLogo } from "../../utils/bankOptions";
import "./BankerPortal.css";

const LOAN_STATUS_CONFIG = {
  pending:    { label: "Pending",    cls: "loan-pending" },
  inprocess:  { label: "In Process", cls: "loan-inprocess" },
  sanctioned: { label: "Sanctioned", cls: "loan-sanctioned" },
  disbursed:  { label: "Disbursed",  cls: "loan-disbursed" },
  rejected:   { label: "Rejected",   cls: "loan-rejected" },
  dropped:    { label: "Dropped",    cls: "loan-dropped" },
};

// Statuses that must carry an explanatory remark (mirrors backend validation)
const REMARK_STATUSES = ["rejected", "dropped"];
const REMARK_LABELS = {
  rejected: { label: "Rejection Remark", placeholder: "Describe the reason for rejection…" },
  dropped:  { label: "Drop Remark",      placeholder: "Describe why the application was dropped…" },
};

// Figures captured once a loan is marked disbursed (mirrors backend
// DISBURSEMENT_FIELDS validation in routes/bankerAccess.js).
const DISBURSEMENT_FIELDS = [
  { key: "loanAmount",      label: "Loan Amount",     unit: "₹",      placeholder: "e.g. 1200000" },
  { key: "tenureMonths",    label: "Tenure",           unit: "months", placeholder: "e.g. 84" },
  { key: "interestRate",    label: "Interest Rate",    unit: "%",      placeholder: "e.g. 10.5" },
  { key: "processingFee",   label: "Processing Fee",   unit: "₹",      placeholder: "e.g. 15000" },
  { key: "insuranceAmount", label: "Insurance Amount",  unit: "₹",      placeholder: "e.g. 8000" },
];
const EMPTY_DISBURSEMENT = { loanAmount: "", tenureMonths: "", interestRate: "", processingFee: "", insuranceAmount: "" };

function BpLoanBadge({ status }) {
  const cfg = LOAN_STATUS_CONFIG[status || "pending"] || LOAN_STATUS_CONFIG.pending;
  return <span className={`loan-badge ${cfg.cls}`}>{cfg.label}</span>;
}

const GROUP_ICONS = {
  "GOVT ID": Building2,
  "Academics": GraduationCap,
  "Other_Documents": FolderInput,
  "Others": FileText,
};
function groupIconFor(group) {
  if (GROUP_ICONS[group]) return GROUP_ICONS[group];
  if (group.startsWith("Loan")) return Banknote;
  return FolderOpen;
}

function formatBytes(size) {
  const n = parseInt(size, 10);
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const PREVIEWABLE = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);

function getTimeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function BankerPortal() {
  const { isAdmin, adminName, adminBank } = useStudent();

  const [students, setStudents] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openStudent, setOpenStudent] = useState(null);
  const [groups, setGroups] = useState({});
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState("");
  const [previewFile, setPreviewFile] = useState(null);

  const [showPwModal, setShowPwModal] = useState(false);
  const [curPass, setCurPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [showPwText, setShowPwText] = useState(false);
  const [pwMsg, setPwMsg] = useState(null);
  const [pwLoading, setPwLoading] = useState(false);

  const [downloadingAll, setDownloadingAll] = useState(false);

  const [loanModalStudent, setLoanModalStudent] = useState(null);
  const [loanStatus, setLoanStatus] = useState("pending");
  const [loanRemark, setLoanRemark] = useState("");
  const [loanSanctionFile, setLoanSanctionFile] = useState(null);
  const [loanDisbursement, setLoanDisbursement] = useState(EMPTY_DISBURSEMENT);
  const [loanLoading, setLoanLoading] = useState(false);
  const [loanLoadingMsg, setLoanLoadingMsg] = useState("");
  const [loanErr, setLoanErr] = useState("");

  const openLoanModal = (s) => {
    setLoanModalStudent(s);
    setLoanStatus(s.loanStatus || "pending");
    setLoanRemark(s.loanRemark || "");
    setLoanSanctionFile(null);
    setLoanDisbursement({ ...EMPTY_DISBURSEMENT, ...(s.loanDisbursement || {}) });
    setLoanErr("");
  };

  const handleLoanSubmit = async (e) => {
    e.preventDefault();
    if (REMARK_STATUSES.includes(loanStatus) && !loanRemark.trim()) {
      setLoanErr(`A remark is required when the loan is ${loanStatus === "rejected" ? "rejected" : "dropped"}.`);
      return;
    }
    let disbursementPayload = null;
    if (loanStatus === "disbursed") {
      for (const { key, label } of DISBURSEMENT_FIELDS) {
        const n = Number(loanDisbursement[key]);
        if (loanDisbursement[key] === "" || Number.isNaN(n) || n < 0) {
          setLoanErr(`Enter a valid ${label.toLowerCase()} to mark the loan as disbursed.`);
          return;
        }
      }
      disbursementPayload = Object.fromEntries(
        DISBURSEMENT_FIELDS.map(({ key }) => [key, Number(loanDisbursement[key])]),
      );
    }
    setLoanLoading(true);
    setLoanErr("");
    try {
      setLoanLoadingMsg("Updating status…");
      await updateLoanStatus(
        loanModalStudent.name,
        loanModalStudent.email || loanModalStudent.phone || "",
        loanStatus,
        loanRemark,
        disbursementPayload
      );
      if (loanStatus === "sanctioned" && loanSanctionFile) {
        setLoanLoadingMsg("Uploading sanction letter…");
        await uploadSanctionLetter(
          loanModalStudent.name,
          loanModalStudent.email || loanModalStudent.phone || "",
          loanSanctionFile
        );
      }
      setStudents((prev) =>
        prev.map((s) =>
          s.name === loanModalStudent.name
            ? { ...s, loanStatus, loanRemark, ...(disbursementPayload ? { loanDisbursement: disbursementPayload } : {}) }
            : s
        )
      );
      setLoanModalStudent(null);
    } catch (e2) {
      setLoanErr(e2.message || "Failed to update loan status.");
    } finally {
      setLoanLoading(false);
      setLoanLoadingMsg("");
    }
  };

  const handleDownloadAll = async (student) => {
    setDownloadingAll(true);
    try {
      const url = getDownloadAllUrl(student.name, student.email || student.phone || "");
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      setTimeout(() => setDownloadingAll(false), 1500);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPass.length < 6) { setPwMsg({ type: "err", text: "New password must be at least 6 characters." }); return; }
    if (newPass !== confirmPass) { setPwMsg({ type: "err", text: "Passwords do not match." }); return; }
    setPwLoading(true); setPwMsg(null);
    try {
      await changeOwnPassword(curPass, newPass);
      setPwMsg({ type: "ok", text: "Password updated successfully." });
      setCurPass(""); setNewPass(""); setConfirmPass("");
    } catch (e2) {
      setPwMsg({ type: "err", text: e2.message || "Failed to update password." });
    } finally {
      setPwLoading(false);
    }
  };

  const loadStudents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const fetched = await getAllStudentsFromDrive();
      setStudents(fetched || []);
    } catch (e) {
      setError("Could not load students: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadStudents();
  }, [isAdmin, loadStudents]);

  const handleOpenStudent = async (student) => {
    if (openStudent?.name === student.name) {
      setOpenStudent(null);
      return;
    }
    setOpenStudent(student);
    setGroups({});
    setGroupsError("");
    setGroupsLoading(true);
    try {
      const g = await getStudentFiles(student.name, student.email || student.phone || "");
      setGroups(g);
    } catch (e) {
      setGroupsError(e.message || "Could not load documents.");
    } finally {
      setGroupsLoading(false);
    }
  };

  const filtered = students.filter((s) => {
    const q = search.toLowerCase();
    if (!q) return true;
    return (s.name || "").toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q) ||
      (s.phone || "").includes(q);
  });

  if (!isAdmin) return null;

  return (
    <div className="banker-page">
      <div className="banker-container">

        {/* ── Welcome Hero ─────────────────────────────────────── */}
        <div className="bp-hero animate-fade-in">
          <div className="bp-hero-glow" />
          <div className="bp-hero-content">
            <div className="bp-hero-logo-wrap">
              <img
                src={getBankLogo(adminBank)}
                alt={adminBank || "Bank"}
                className="bp-hero-logo"
                onError={(e) => { e.target.style.display = "none"; }}
              />
            </div>
            <div className="bp-hero-text">
              <p className="bp-hero-greeting">{getTimeGreeting()}, {adminName}! 👋</p>
              <h1 className="bp-hero-bank">{adminBank || "Banker Portal"}</h1>
              <p className="bp-hero-tagline">Your loan application workspace — students shared with you appear below.</p>
            </div>
          </div>
          <div className="bp-hero-actions">
            <button className="btn btn-secondary btn-sm" onClick={loadStudents} disabled={loading}>
              <RefreshCw size={13} className={loading ? "spin" : ""} />
              <span>Refresh</span>
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setShowPwModal(true); setPwMsg(null); }}>
              <KeyRound size={13} />
              <span>Change Password</span>
            </button>
          </div>
        </div>

        <div className="banker-search">
          <Search size={15} />
          <input
            className="banker-search-input"
            placeholder="Search by name, email, or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="banker-search-clear" onClick={() => setSearch("")}><X size={14} /></button>
          )}
        </div>

        {error && (
          <div className="banker-error animate-fade-in">
            <AlertCircle size={15} />
            {error}
          </div>
        )}

        {loading ? (
          <div className="banker-loading">
            <div className="loading-dots"><span /><span /><span /></div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="banker-empty">
            <div className="banker-empty-icon"><FolderOpen size={28} /></div>
            <h3>No students shared with you yet</h3>
            <p>When an advisor grants you access to a student's application, it will appear here.</p>
          </div>
        ) : (
          <div className="banker-student-list">
            {filtered.map((s) => {
              const isOpen = openStudent?.name === s.name;
              const p = s.personalInfo || {};
              const fullName = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.fullName || s.name;
              return (
                <div key={s.name} className={`banker-card${isOpen ? " open" : ""}`}>
                  <button className="banker-card-header" onClick={() => handleOpenStudent(s)}>
                    <div className="banker-card-avatar">{(fullName || "?")[0].toUpperCase()}</div>
                    <div className="banker-card-info">
                      <span className="banker-card-name">{fullName}</span>
                      <span className="banker-card-contact">{s.email || s.phone || "No contact info"}</span>
                    </div>
                    <BpLoanBadge status={s.loanStatus} />
                    {p.loanAmount && (
                      <span className="meta-pill">₹{Number(p.loanAmount).toLocaleString("en-IN")}</span>
                    )}
                    <ChevronDown size={18} className={`banker-chevron${isOpen ? " open" : ""}`} />
                  </button>

                  {isOpen && (
                    <div className="banker-card-body animate-fade-in">
                      {/* Loan Status Row */}
                      <div className="bp-loan-status-row">
                        <Banknote size={14} className="bp-loan-icon" />
                        <span className="bp-loan-label">Loan Status</span>
                        <BpLoanBadge status={s.loanStatus} />
                        {REMARK_STATUSES.includes(s.loanStatus) && s.loanRemark && (
                          <span className="bp-loan-remark">"{s.loanRemark}"</span>
                        )}
                        <button
                          className="bp-loan-update-btn"
                          onClick={(e) => { e.stopPropagation(); openLoanModal(s); }}
                        >
                          Update
                        </button>
                      </div>

                      {groupsLoading ? (
                        <div className="banker-loading" style={{ padding: "24px 0" }}>
                          <div className="loading-dots"><span /><span /><span /></div>
                        </div>
                      ) : groupsError ? (
                        <div className="banker-error"><AlertCircle size={15} /> {groupsError}</div>
                      ) : Object.keys(groups).length === 0 ? (
                        <p className="banker-no-docs">No documents found for this student.</p>
                      ) : (
                        <>
                          {Object.entries(groups).map(([group, files]) => {
                            const GroupIcon = groupIconFor(group);
                            return (
                              <div key={group} className="banker-doc-group">
                                <div className="banker-doc-group-title">
                                  <GroupIcon size={14} /> {group.replace(/_/g, " ")}
                                  <span className="banker-doc-count">{files.length}</span>
                                </div>
                                <div className="banker-doc-list">
                                  {files.map((f) => (
                                    <div key={f.id} className="banker-doc-row">
                                      <FileText size={15} className="banker-doc-file-icon" />
                                      <div className="banker-doc-meta">
                                        <span className="banker-doc-name">{f.name}</span>
                                        <span className="banker-doc-size">{formatBytes(f.size)}</span>
                                      </div>
                                      <div className="banker-doc-actions">
                                        {PREVIEWABLE.has(f.mimeType) && (
                                          <button
                                            className="icon-btn"
                                            title="View"
                                            onClick={() => setPreviewFile(f)}
                                          >
                                            <Eye size={14} />
                                          </button>
                                        )}
                                        <a
                                          className="icon-btn"
                                          title="Download"
                                          href={getFileProxyUrl(f.id, "download")}
                                        >
                                          <Download size={14} />
                                        </a>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                          <div className="bp-download-all-bar">
                            <span className="bp-download-all-info">
                              {Object.values(groups).flat().length} document{Object.values(groups).flat().length !== 1 ? "s" : ""} across {Object.keys(groups).length} folder{Object.keys(groups).length !== 1 ? "s" : ""}
                            </span>
                            <button
                              className="btn bp-download-all-btn"
                              disabled={downloadingAll}
                              onClick={() => handleDownloadAll(s)}
                            >
                              {downloadingAll
                                ? <><RefreshCw size={13} className="spin" /> Preparing…</>
                                : <><Archive size={13} /> Download All</>

                              }
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {previewFile && (
        <div className="banker-preview-backdrop" onClick={() => setPreviewFile(null)}>
          <div className="banker-preview-box" onClick={(e) => e.stopPropagation()}>
            <div className="banker-preview-header">
              <span>{previewFile.name}</span>
              <div className="banker-preview-actions">
                <a className="icon-btn" title="Download" href={getFileProxyUrl(previewFile.id, "download")}>
                  <Download size={15} />
                </a>
                <button className="icon-btn" title="Close" onClick={() => setPreviewFile(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="banker-preview-body">
              {previewFile.mimeType === "application/pdf" ? (
                <iframe src={getFileProxyUrl(previewFile.id, "view")} title={previewFile.name} />
              ) : (
                <img src={getFileProxyUrl(previewFile.id, "view")} alt={previewFile.name} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Loan Status Update Modal */}
      {loanModalStudent && (
        <div className="modal-backdrop" onClick={() => !loanLoading && setLoanModalStudent(null)}>
          <div className="loan-status-modal animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="lsm-header">
              <div className="lsm-icon"><Banknote size={22} /></div>
              <div className="lsm-title-block">
                <h3 className="lsm-title">Update Loan Status</h3>
                <p className="lsm-sub">{loanModalStudent.name}</p>
              </div>
              <button className="lsm-close" onClick={() => setLoanModalStudent(null)} disabled={loanLoading}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleLoanSubmit} className="lsm-body">
              <div className="lsm-status-grid">
                {Object.entries(LOAN_STATUS_CONFIG).map(([key, cfg]) => (
                  <button
                    key={key}
                    type="button"
                    className={`lsm-option ${cfg.cls}${loanStatus === key ? " selected" : ""}`}
                    onClick={() => { setLoanStatus(key); if (!REMARK_STATUSES.includes(key)) setLoanRemark(""); if (key !== "sanctioned") setLoanSanctionFile(null); }}
                  >
                    <span className="lsm-option-dot" />
                    <span>{cfg.label}</span>
                    {loanStatus === key && <CheckCircle size={14} className="lsm-check" />}
                  </button>
                ))}
              </div>
              {REMARK_STATUSES.includes(loanStatus) && (
                <div className="lsm-remark-wrap">
                  <label className="lsm-remark-label">
                    {REMARK_LABELS[loanStatus].label} <span className="required-star">*</span>
                  </label>
                  <textarea
                    className="lsm-remark-input"
                    rows={3}
                    placeholder={REMARK_LABELS[loanStatus].placeholder}
                    value={loanRemark}
                    onChange={(e) => setLoanRemark(e.target.value)}
                  />
                </div>
              )}
              {loanStatus === "sanctioned" && (
                <div className="lsm-upload-wrap">
                  <label className="lsm-remark-label">
                    Sanction Letter <span className="lsm-optional">— optional</span>
                  </label>
                  <label className={`lsm-file-drop${loanSanctionFile ? " has-file" : ""}`}>
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" style={{ display: "none" }}
                      onChange={(e) => setLoanSanctionFile(e.target.files[0] || null)} />
                    {loanSanctionFile ? (
                      <div className="lsm-file-selected">
                        <FileText size={15} />
                        <span className="lsm-file-name">{loanSanctionFile.name}</span>
                        <button type="button" className="lsm-file-remove"
                          onClick={(e) => { e.preventDefault(); setLoanSanctionFile(null); }}>
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
              {loanStatus === "disbursed" && (
                <div className="lsm-disbursement-wrap">
                  <label className="lsm-remark-label">
                    Disbursement Details <span className="required-star">*</span>
                  </label>
                  <div className="lsm-disbursement-grid">
                    {DISBURSEMENT_FIELDS.map(({ key, label, unit, placeholder }) => (
                      <div className="lsm-disbursement-field" key={key}>
                        <label className="lsm-disbursement-label">{label}</label>
                        <div className="lsm-disbursement-input-wrap">
                          <span className="lsm-disbursement-unit">{unit}</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            inputMode="decimal"
                            className="lsm-disbursement-input"
                            placeholder={placeholder}
                            value={loanDisbursement[key]}
                            onChange={(e) => setLoanDisbursement((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {loanErr && <p className="lsm-error">{loanErr}</p>}
              <div className="lsm-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setLoanModalStudent(null)} disabled={loanLoading}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={loanLoading}>
                  {loanLoading ? <><RefreshCw size={13} className="spin" /> {loanLoadingMsg}</> : "Update Status"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showPwModal && (
        <div className="modal-backdrop" onClick={() => !pwLoading && setShowPwModal(false)}>
          <div className="modal-box bank-modal-box animate-fade-in" onClick={(e) => e.stopPropagation()}>
            <div className="modal-icon"><KeyRound size={28} /></div>
            <h3 className="bank-modal-title">Change Password</h3>
            <form onSubmit={handleChangePassword} className="settings-form">
              <div className="input-group">
                <label>Current Password</label>
                <div className="password-wrap">
                  <input className="input-field" type={showPwText ? "text" : "password"} placeholder="Your current password"
                    value={curPass} onChange={(e) => setCurPass(e.target.value)} autoFocus />
                  <button type="button" className="show-pass" onClick={() => setShowPwText(!showPwText)}>
                    {showPwText ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="input-group">
                <label>New Password</label>
                <input className="input-field" type={showPwText ? "text" : "password"} placeholder="Min. 6 characters"
                  value={newPass} onChange={(e) => setNewPass(e.target.value)} />
              </div>
              <div className="input-group">
                <label>Confirm New Password</label>
                <input className="input-field" type={showPwText ? "text" : "password"} placeholder="Repeat new password"
                  value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} />
              </div>
              {pwMsg && <p className={`settings-msg ${pwMsg.type}`}>{pwMsg.text}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setShowPwModal(false)} disabled={pwLoading}>
                  {pwMsg?.type === "ok" ? "Close" : "Cancel"}
                </button>
                <button type="submit" className="btn btn-primary" disabled={pwLoading}>
                  {pwLoading ? <><RefreshCw size={13} className="spin" /> Saving…</> : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
