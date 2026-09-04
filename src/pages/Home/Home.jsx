import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  GraduationCap,
  Search,
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  FolderCheck,
  Activity,
  Rocket,
  User,
  Mail,
  Phone,
  UserCheck,
  AlertCircle,
  RefreshCw,
  Loader2,
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

/* ──────────────────────────────────────────────────────────────────────────
   Static content lives up here so copy edits never require touching markup.
   ────────────────────────────────────────────────────────────────────────── */

// The signature element of this page: the loan file's real sequence. It is
// numbered because the order genuinely matters to the student — it answers
// "what happens after I click" before they commit to anything.
const JOURNEY = [
  { title: "Create your file", detail: "Name, contact, and your finance advisor." },
  { title: "Upload documents", detail: "A guided checklist, sorted into your vault." },
  { title: "Lender review", detail: "Track every status change as it happens." },
  { title: "Sanction letter", detail: "Download, share, and close the loan." },
];

const TRUST = [
  { icon: ShieldCheck, label: "Bank-grade encryption" },
  { icon: Activity, label: "Live tracking" },
  { icon: FolderCheck, label: "Documents organised for you" },
];

/* Motion — one orchestrated page-load sequence, not scattered effects. */
const rise = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } },
};

const swap = {
  hidden: { opacity: 0, x: 16 },
  show: { opacity: 1, x: 0, transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, x: -16, transition: { duration: 0.18, ease: "easeIn" } },
};

/* Defined at module scope on purpose — a component declared inside Home()
   would be a new type on every render and would blow away input focus. */
function Field({ id, label, required, icon: Icon, hint, children }) {
  return (
    <div className="sl-field">
      <label className="sl-field__label" htmlFor={id}>
        {label}
        {required && (
          <span className="sl-field__req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <div className="sl-field__control">
        {Icon && <Icon size={16} className="sl-field__icon" aria-hidden="true" />}
        {children}
      </div>
      {hint && <p className="sl-field__hint">{hint}</p>}
    </div>
  );
}

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
  const reduceMotion = useReducedMotion();

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

  const goWelcome = () => {
    setMode("welcome");
    setError("");
  };

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
      setError("Please enter a valid 10-digit mobile number (e.g. 9876543210).");
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
          "An application already exists with this email/phone. Use 'Resume my application' to continue.",
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
          email: isEmail ? finalIdentifier : found.email || "",
          phone: isEmail ? found.phone || "" : finalIdentifier,
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
    <div className="sl-home">
      {/* Ambient background stack — art, colour fields, grid. Purely decorative. */}
      <div className="sl-bg" aria-hidden="true">
        <span
          className="sl-bg__art"
          style={{ backgroundImage: `url(${heroImg})` }}
        />
        <span className="sl-bg__field sl-bg__field--indigo" />
        <span className="sl-bg__field sl-bg__field--amber" />
        <span className="sl-bg__grid" />
        <span className="sl-bg__veil" />
      </div>

      <main className="sl-shell">
        {/* ── Left: the pitch and the journey ───────────────────────────── */}
        <motion.section
          className="sl-hero"
          variants={stagger}
          initial={reduceMotion ? false : "hidden"}
          animate="show"
        >
          <motion.h1 className="sl-title" variants={rise}>
            Study abroad.
            <span className="sl-title__accent">Funded, not delayed.</span>
          </motion.h1>

          <motion.p className="sl-lede" variants={rise}>
            Set up your education loan file once. Upload documents through a
            guided checklist, and follow every lender update until your sanction
            letter is in hand.
          </motion.p>

          <motion.ol className="sl-journey" variants={rise}>
            {JOURNEY.map((step, i) => (
              <li className="sl-step" key={step.title}>
                <span className="sl-step__num">{String(i + 1).padStart(2, "0")}</span>
                <span className="sl-step__body">
                  <span className="sl-step__title">{step.title}</span>
                  <span className="sl-step__detail">{step.detail}</span>
                </span>
              </li>
            ))}
          </motion.ol>

          <motion.ul className="sl-trust" variants={rise}>
            {TRUST.map(({ icon: Icon, label }) => (
              <li className="sl-trust__pill" key={label}>
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
              </li>
            ))}
          </motion.ul>
        </motion.section>

        {/* ── Right: the action panel ───────────────────────────────────── */}
        <motion.aside
          className="sl-panel"
          variants={rise}
          initial={reduceMotion ? false : "hidden"}
          animate="show"
        >
          <div className="sl-card">
            <AnimatePresence mode="wait" initial={false}>
              {mode === "welcome" && (
                <motion.div
                  key="welcome"
                  className="sl-view"
                  variants={swap}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                >
                  <header className="sl-card__head">
                    <span className="sl-card__icon">
                      <Rocket size={20} />
                    </span>
                    <div>
                      <h2>Start here</h2>
                      <p>Two ways in — pick the one that fits.</p>
                    </div>
                  </header>

                  <div className="sl-choices">
                    <button
                      type="button"
                      className="sl-choice sl-choice--primary"
                      onClick={() => setMode("new")}
                    >
                      <span className="sl-choice__glint" aria-hidden="true" />
                      <span className="sl-choice__icon">
                        <GraduationCap size={22} />
                      </span>
                      <span className="sl-choice__body">
                        <span className="sl-choice__title">Start a new application</span>
                        <span className="sl-choice__detail">
                          Opens your document vault and checklist
                        </span>
                      </span>
                      <ArrowRight size={18} className="sl-choice__arrow" />
                    </button>

                    <button
                      type="button"
                      className="sl-choice sl-choice--ghost"
                      onClick={() => setMode("returning")}
                    >
                      <span className="sl-choice__glint" aria-hidden="true" />
                      <span className="sl-choice__icon">
                        <Search size={22} />
                      </span>
                      <span className="sl-choice__body">
                        <span className="sl-choice__title">Resume my application</span>
                        <span className="sl-choice__detail">
                          Continue with your registered email or phone
                        </span>
                      </span>
                      <ArrowRight size={18} className="sl-choice__arrow" />
                    </button>
                  </div>
                </motion.div>
              )}

              {mode === "new" && (
                <motion.div
                  key="new"
                  className="sl-view"
                  variants={swap}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                >
                  <header className="sl-card__head sl-card__head--form">
                    <button type="button" className="sl-back" onClick={goWelcome}>
                      <ArrowLeft size={14} />
                      Back
                    </button>
                    <h2>Create your application</h2>
                    <p>Three details and your file is open. Takes about a minute.</p>
                  </header>

                  <form onSubmit={handleNewStudent} className="sl-form" noValidate>
                    <Field id="sl-name" label="Full name" required icon={User}>
                      <input
                        id="sl-name"
                        className="sl-input"
                        placeholder="e.g. Rahul Sharma"
                        autoComplete="name"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                      />
                    </Field>

                    <div className="sl-form__row">
                      <Field id="sl-email" label="Email address" icon={Mail}>
                        <input
                          id="sl-email"
                          className="sl-input"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          placeholder="name@example.com"
                          value={form.email}
                          onChange={(e) => setForm({ ...form, email: e.target.value })}
                        />
                      </Field>

                      <Field id="sl-phone" label="Phone number" icon={Phone}>
                        <input
                          id="sl-phone"
                          className="sl-input"
                          type="tel"
                          inputMode="numeric"
                          autoComplete="tel"
                          placeholder="9876543210"
                          value={form.phone}
                          onChange={(e) => setForm({ ...form, phone: e.target.value })}
                        />
                      </Field>
                    </div>
                    <p className="sl-form__note">
                      Give us at least one — we use it to find your file later.
                    </p>

                    <Field id="sl-advisor" label="Finance advisor" required icon={UserCheck}>
                      <select
                        id="sl-advisor"
                        className="sl-input sl-input--select"
                        value={form.advisor}
                        onChange={(e) => setForm({ ...form, advisor: e.target.value })}
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
                    </Field>

                    {advisorError && (
                      <button type="button" className="sl-retry" onClick={retryAdvisors}>
                        <RefreshCw size={13} />
                        The advisor list didn&apos;t load. Try again
                      </button>
                    )}

                    {error && (
                      <div className="sl-alert" role="alert">
                        <AlertCircle size={16} className="sl-alert__icon" />
                        <span>{error}</span>
                      </div>
                    )}

                    <button type="submit" className="sl-submit" disabled={loading}>
                      {loading ? (
                        <>
                          <Loader2 size={16} className="sl-spin" />
                          <span>Creating your file…</span>
                        </>
                      ) : (
                        <>
                          <span>Create my application</span>
                          <ArrowRight size={16} />
                        </>
                      )}
                    </button>
                  </form>
                </motion.div>
              )}

              {mode === "returning" && (
                <motion.div
                  key="returning"
                  className="sl-view"
                  variants={swap}
                  initial="hidden"
                  animate="show"
                  exit="exit"
                >
                  <header className="sl-card__head sl-card__head--form">
                    <button type="button" className="sl-back" onClick={goWelcome}>
                      <ArrowLeft size={14} />
                      Back
                    </button>
                    <h2>Resume your application</h2>
                    <p>We&apos;ll pull up the file you already started.</p>
                  </header>

                  <form onSubmit={handleReturning} className="sl-form" noValidate>
                    <Field
                      id="sl-lookup"
                      label="Registered email or phone"
                      required
                      icon={Search}
                      hint="Use the same detail you registered with."
                    >
                      <input
                        id="sl-lookup"
                        className="sl-input"
                        placeholder="name@example.com or 9876543210"
                        autoComplete="username"
                        value={lookup}
                        onChange={(e) => setLookup(e.target.value)}
                      />
                    </Field>

                    {error && (
                      <div className="sl-alert" role="alert">
                        <AlertCircle size={16} className="sl-alert__icon" />
                        <span>{error}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      className="sl-submit sl-submit--alt"
                      disabled={loading}
                    >
                      {loading ? (
                        <>
                          <Loader2 size={16} className="sl-spin" />
                          <span>Looking up your file…</span>
                        </>
                      ) : (
                        <>
                          <Search size={16} />
                          <span>Find my application</span>
                        </>
                      )}
                    </button>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <p className="sl-panel__foot">
            Your details stay with your advisor and the lenders you apply to.
          </p>
        </motion.aside>
      </main>
    </div>
  );
}