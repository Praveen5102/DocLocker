import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  GraduationCap,
  Search,
  ArrowRight,
  TrendingUp,
  FolderOpen,
  Shield,
  Rocket,
} from "lucide-react";
import heroImg from "../../assets/bg.png";
import { useStudent } from "../../context/StudentContext";
import {
  saveStudentMeta,
  searchStudentByIdentifier,
  checkIdentifierExists,
  isValidPhone,
  isValidEmail,
} from "../../utils/driveApi";
import "./Home.css";

const API_URL = import.meta.env.VITE_API_URL ?? "";

export default function Home() {
  const [mode, setMode] = useState("welcome");
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    advisor: "",
  });
  const [lookup, setLookup] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [advisors, setAdvisors] = useState(null); // null = loading, [] = error/empty
  const [advisorError, setAdvisorError] = useState(false);
  const { setStudent } = useStudent();
  const navigate = useNavigate();

  // Wrapped in useCallback so it's stable to include as a dependency in useEffect
  const loadAdvisors = useCallback(() => {
    fetch(`${API_URL}/api/advisors`, { signal: AbortSignal.timeout(12000) })
      .then((r) => r.json())
      .then((d) => setAdvisors(d.success ? d.advisors || [] : []))
      .catch(() => {
        setAdvisors([]);
        setAdvisorError(true);
      });
  }, []);

  // Reset + reload — called from the retry button
  const retryAdvisors = () => {
    setAdvisors(null);
    setAdvisorError(false);
    loadAdvisors();
  };

  useEffect(() => {
    loadAdvisors();
  }, [loadAdvisors]);

  // ── New registration with duplicate check ─────────────────────────────────
  const handleNewStudent = async (e) => {
    e.preventDefault();

    if (!form.name.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (!form.email.trim() && !form.phone.trim()) {
      setError("Please enter at least one of email or phone number.");
      return;
    }
    if (!form.advisor) {
      setError("Please select your Finance Advisor.");
      return;
    }

    // Validate formats before hitting the network
    if (form.email.trim() && !isValidEmail(form.email.trim())) {
      setError("Please enter a valid email address (e.g. name@example.com).");
      return;
    }

    // Clean and validate phone number
    const cleanedPhone = form.phone.trim().replace(/\s+/g, "");
    if (form.phone.trim() && !isValidPhone(cleanedPhone)) {
      setError(
        "Please enter a valid 10-digit mobile number (e.g. 9876543210).",
      );
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Prioritize email as primary tracking key if both are given, else use cleaned phone
      const identifier = form.email.trim() || cleanedPhone;
      const exists = await checkIdentifierExists(identifier);

      if (exists) {
        setError(
          "An application already exists with this email/phone. Use 'Resume Submission' to continue.",
        );
        setLoading(false);
        return;
      }

      const studentData = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: cleanedPhone,
        advisor: form.advisor,
        createdAt: new Date().toISOString(),
        coApplicants: 1,
        uploads: {},
        personalInfo: {},
      };

      // Await meta save so the Drive folder exists before the student reaches
      // the portal and tries to upload. Failures are logged but non-blocking.
      await saveStudentMeta(studentData.name, studentData, identifier);

      setStudent(studentData);
      navigate("/portal");
    } catch (err) {
      console.error("New student creation error:", err);
      setError("Could not create application. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // ── Resume existing application ───────────────────────────────────────────
  const handleReturning = async (e) => {
    e.preventDefault();

    const cleanLookup = lookup.trim();
    if (!cleanLookup) {
      setError("Enter your registered email or phone number.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      let finalIdentifier = cleanLookup;

      // 1. Check if it's an email
      if (cleanLookup.includes("@")) {
        if (!isValidEmail(cleanLookup)) {
          setError("Please enter a valid email format.");
          setLoading(false);
          return;
        }
      } else {
        // 2. Treat as phone number
        finalIdentifier = cleanLookup.replace(/[^0-9+]/g, "");
        if (!isValidPhone(finalIdentifier)) {
          setError("Please enter a valid registered 10-digit mobile number.");
          setLoading(false);
          return;
        }
      }

      // 3. Request search from file backend utils
      const found = await searchStudentByIdentifier(finalIdentifier);
      if (found) {
        // found now contains the full meta. Ensure the typed identifier is set
        // so uploads work even if meta was saved without it.
        const isEmail = finalIdentifier.includes("@");
        setStudent({
          ...found,
          email: isEmail ? finalIdentifier : (found.email || ""),
          phone: isEmail ? (found.phone || "") : finalIdentifier,
        });
        navigate("/portal");
      } else {
        setError(
          "No active file found matching this detail. Please verify your entry or create a new application.",
        );
      }
    } catch (err) {
      console.error("Resume lookup error:", err);
      setError(
        "Unable to connect to service. Please check your network and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div
        className="home-page dashboard-viewport"
        style={{ backgroundImage: `url(${heroImg})` }}
      >
        <div className="home-split-layout">
          {/* Left Column */}
          <div className="brand-hero-column animate-fade-in">
            <div className="brand-wrapper">
              <h1 className="main-display-headline">
                Your Abroad Journey{" "}
                <span className="gradient-text-block">Starts Here</span>
              </h1>

              <p className="editorial-sub-headline">
                Streamline your Master's application process. Upload,
                automatically structure, and organize your files securely in a
                single, high-fidelity deployment platform.
              </p>

              <div className="hero-trust-row">
                {[
                  { icon: <Shield size={13} />, label: "Bank-Grade Security" },
                  { icon: <TrendingUp size={13} />, label: "Real-time Loan Tracking" },
                  { icon: <FolderOpen size={13} />, label: "Organized Document Vault" },
                ].map((item, idx) => (
                  <div key={idx} className="hero-trust-pill">
                    <span className="hero-trust-pill-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Column */}
          <div className="interactive-panel-column animate-fade-in">
            <div className="glass-workspace-card">
              {mode === "welcome" && (
                <div className="workspace-welcome-view">
                  <div className="workspace-header-row">
                    <div className="spark-icon-container">
                      <Rocket size={20} className="accent-color-icon" />
                    </div>
                    <div className="workspace-header">
                      <h2>Get Started</h2>
                      <p>
                        Select your deployment profile to manage application
                        assets
                      </p>
                    </div>
                  </div>

                  <div className="action-card-deck">
                    <button
                      className="premium-interactive-card new-node"
                      onClick={() => setMode("new")}
                    >
                      <div className="card-glint-overlay" />
                      <div className="card-icon-frame">
                        <GraduationCap size={24} />
                      </div>
                      <div className="card-seo-content">
                        <h3>New Registration</h3>
                        <p>
                          Initialize a secure folder path and clear file
                          structure tags
                        </p>
                      </div>
                      <div className="card-action-indicator">
                        <ArrowRight size={16} />
                      </div>
                    </button>

                    <button
                      className="premium-interactive-card returning-node"
                      onClick={() => setMode("returning")}
                    >
                      <div className="card-glint-overlay" />
                      <div className="card-icon-frame">
                        <Search size={24} />
                      </div>
                      <div className="card-seo-content">
                        <h3>Resume Submission File</h3>
                        <p>
                          Synchronize background progress states via
                          verification tracking
                        </p>
                      </div>
                      <div className="card-action-indicator">
                        <ArrowRight size={16} />
                      </div>
                    </button>
                  </div>
                </div>
              )}

              {mode === "new" && (
                <div className="workspace-form-view">
                  <div className="workspace-form-header">
                    <button
                      className="minimal-back-action"
                      onClick={() => {
                        setMode("welcome");
                        setError("");
                      }}
                    >
                      ← Back to selection
                    </button>
                    <h2>Create Application</h2>
                    <p>
                      Register your configuration specs to open the file
                      transfer portal
                    </p>
                  </div>

                  <form
                    onSubmit={handleNewStudent}
                    className="modular-form-layout"
                  >
                    <div className="interactive-input-block">
                      <label>
                        Full Name <span className="required-accent">*</span>
                      </label>
                      <input
                        className="premium-styled-input"
                        placeholder="e.g. Rahul Sharma"
                        value={form.name}
                        onChange={(e) =>
                          setForm({ ...form, name: e.target.value })
                        }
                      />
                      <div className="input-focus-border-line" />
                    </div>

                    <div className="interactive-input-block">
                      <label>Email Address</label>
                      <input
                        className="premium-styled-input"
                        type="email"
                        placeholder="name@example.com"
                        value={form.email}
                        onChange={(e) =>
                          setForm({ ...form, email: e.target.value })
                        }
                      />
                      <div className="input-focus-border-line" />
                    </div>

                    <div className="interactive-input-block">
                      <label>Phone Number</label>
                      <input
                        className="premium-styled-input"
                        placeholder="e.g. 9876543210"
                        value={form.phone}
                        onChange={(e) =>
                          setForm({ ...form, phone: e.target.value })
                        }
                      />
                      <div className="input-focus-border-line" />
                    </div>

                    <div className="interactive-input-block">
                      <label>
                        Finance Advisor{" "}
                        <span className="required-accent">*</span>
                      </label>
                      <select
                        className="premium-styled-input"
                        value={form.advisor}
                        onChange={(e) =>
                          setForm({ ...form, advisor: e.target.value })
                        }
                        disabled={advisors === null}
                      >
                        {advisors === null ? (
                          <option value="">Loading advisors…</option>
                        ) : advisors.length === 0 ? (
                          <option value="">No advisors available</option>
                        ) : (
                          <>
                            <option value="">Select your advisor</option>
                            {advisors.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </>
                        )}
                      </select>
                      {advisorError && (
                        <button
                          type="button"
                          onClick={retryAdvisors}
                          style={{
                            marginTop: 6,
                            fontSize: 12,
                            color: "var(--blue-light)",
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                            textDecoration: "underline",
                          }}
                        >
                          Could not load advisors — tap to retry
                        </button>
                      )}
                      <div className="input-focus-border-line" />
                    </div>

                    {error && <div className="panel-error-alert">{error}</div>}

                    <button
                      type="submit"
                      className="action-submit-button call-to-action"
                      disabled={loading}
                    >
                      {loading ? (
                        <span className="loading-dots">Provisioning Node</span>
                      ) : (
                        <>
                          <span>Initialize Storage Workspace</span>
                          <ArrowRight size={16} />
                        </>
                      )}
                    </button>
                  </form>
                </div>
              )}

              {mode === "returning" && (
                <div className="workspace-form-view">
                  <div className="workspace-form-header">
                    <button
                      className="minimal-back-action"
                      onClick={() => {
                        setMode("welcome");
                        setError("");
                      }}
                    >
                      ← Back to selection
                    </button>
                    <h2>Resume Progress</h2>
                    <p>Enter your registered email or phone to continue</p>
                  </div>

                  <form
                    onSubmit={handleReturning}
                    className="modular-form-layout"
                  >
                    <div className="interactive-input-block">
                      <label>
                        Email or Phone Number{" "}
                        <span className="required-accent">*</span>
                      </label>
                      <input
                        className="premium-styled-input"
                        placeholder="name@example.com or 9876543210"
                        value={lookup}
                        onChange={(e) => setLookup(e.target.value)}
                      />
                      <div className="input-focus-border-line" />
                    </div>

                    {error && <div className="panel-error-alert">{error}</div>}

                    <button
                      type="submit"
                      className="action-submit-button lookup-action"
                      disabled={loading}
                    >
                      {loading ? (
                        <span className="loading-dots">Fetching Schema</span>
                      ) : (
                        <>
                          <Search size={16} />
                          <span>Re-load Portal Session</span>
                        </>
                      )}
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
