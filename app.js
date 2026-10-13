import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   1. REFERENCE DATA
   Verified line-by-line against the factory's master sheet - 115
   rows across all type/core combinations (1-5 core) - copper
   formula matched exactly on every row.

   PVC weight in kg for ONE 300-foot coil, by wire type, then
   core count, then MM size. Flexible and Standard share identical
   PVC weights everywhere both exist - kept as separate tables
   anyway because Standard has no 1mm product at all. Merging them
   would let the app quote a Standard 1mm cable that does not exist.

   Three values below were corrected in the factory's latest sheet
   from what an earlier version had (flagged where changed). Sizes
   absent below are sizes the factory's own master sheet also
   leaves unpriced - the app refuses those rather than guessing.

   Core 5 is new and only 1.5mm has a priced PVC weight so far -
   every other 5-core size will correctly show as unavailable
   until the factory provides more sizes.
   ============================================================ */
const PVC_PER_COIL = {
  flexible: {
    1: { 1:0.9, 1.5:1.3, 2.5:1.6, 4:2.5, 6:3.0, 10:4.1, 16:4.6,
         25:6.0, 35:6.5, 50:10.5, 70:16.0, 95:20.0 },
    2: { 1:7.0, 1.5:8.6, 2.5:11.2, 4:15.0, 6:17.0, 10:21.0 },       // 1mm new; 10mm corrected from 21.7
    3: { 1:8.2, 1.5:10.9, 2.5:13.8, 4:18.5, 6:21.0, 10:25.0, 16:32.0 }, // 1mm new; 16mm corrected from 32.8
    4: { 1:10.0, 1.5:13.0, 2.5:16.4, 4:22.5, 6:26.0, 10:31.6, 16:41.0 }, // 1mm new; 1.5mm corrected from 13.2
    5: { 1.5:14.0 },                                                 // new core level - only size priced so far
  },
  standard: {
    1: { 1.5:1.3, 2.5:1.6, 4:2.5, 6:3.0, 10:4.1, 16:4.6,
         25:6.0, 35:6.5, 50:10.5, 70:16.0, 95:20.0 },   // no 1mm - not a real product
    2: { 1.5:8.6, 2.5:11.2, 4:15.0, 6:17.0, 10:21.0 },  // 10mm corrected from 21.7
    3: { 1.5:10.9, 2.5:13.8, 4:18.5, 6:21.0, 10:25.0, 16:32.0 }, // 16mm corrected from 32.8
    4: { 1.5:13.0, 2.5:16.4, 4:22.5, 6:26.0, 10:31.6, 16:41.0 }, // 1.5mm corrected from 13.2
    5: { 1.5:14.0 },                                    // new core level - only size priced so far
  },
};

// Number of ropes (rassi) laid up in the cable, by core count.
// Not part of the factory's reference sheet - added per separate
// instruction: 1,2 core = none; 3 core = 3; 4 core = 5; 5 core = 6.
const ROPE_COUNT = { 1: 0, 2: 0, 3: 3, 4: 5, 5: 6 };

const COIL_FEET     = 300;
const FEET_TO_METRE = 0.3048;

/* ============================================================
   2. THE CALCULATION
   ============================================================ */

function copperPerCoil({ thousands, wires, core }) {
  return (thousands * thousands * wires * core * 330) / 800000;
}

function calculateRate(p, v) {
  const factor = v.feet / COIL_FEET;

  // --- weights ---
  const copperKg = copperPerCoil(v) * factor;
  const pvcKg    = PVC_PER_COIL[v.type][v.core][v.mm] * factor;

  // --- material (copper + pvc + rope) ---
  const copperCost = copperKg * p.copperRate;
  const pvcCost    = pvcKg    * p.pvcRate;

  const ropes    = ROPE_COUNT[v.core] || 0;
  const metres   = v.feet * FEET_TO_METRE;
  const ropeCost = metres * ropes * p.ropeRate;

  const material = copperCost + pvcCost + ropeCost;

  // --- drawing: per kg of copper, own rate per wire type ---
  const drawRate = (v.type === "standard") ? p.drawStandard : p.drawFlexible;
  const drawCost = copperKg * drawRate;

  // --- overheads: each is its own % of (material + drawing).
  //     They do not compound on one another. ---
  const base        = material + drawCost;
  const electricity = base * (p.elecPct   / 100);
  const labour      = base * (p.labourPct / 100);
  const other       = base * (p.otherPct  / 100);

  const factoryCost = base + electricity + labour + other;
  const margin      = factoryCost * (p.marginPct / 100);

  return {
    copperKg, pvcKg, ropes, metres, copperCost, pvcCost, ropeCost,
    drawRate, drawCost, base, electricity, labour, other,
    material, factoryCost, margin,
    factoryRate: factoryCost + margin,
  };
}

/* ============================================================
   3. SETUP
   ============================================================ */
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

const PARAMS_DOC = doc(db, "settings", "daily");

// An admin session lasts this long from the moment of sign-in,
// no matter how active the admin is. After that they are signed
// out and must enter their password again.
const ADMIN_SESSION_TTL_MS = 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);

const screens = {
  calc:        $("screen-calc"),
  result:      $("screen-result"),
  login:       $("screen-login"),
  adminMenu:   $("screen-admin-menu"),
  adminCalc:   $("screen-admin-calc"),
  adminResult: $("screen-admin-result"),
  admin:       $("screen-admin"),
};

// Screens reachable only while signed OUT. Every other screen is
// reachable only while signed IN. A signed-in admin can never see
// the shop calculator - the only way back to it is signing out.
const PUBLIC_SCREENS = new Set(["calc", "result", "login"]);

function show(name) {
  const signedIn = !!auth.currentUser;
  if (signedIn  &&  PUBLIC_SCREENS.has(name)) name = "adminMenu";
  if (!signedIn && !PUBLIC_SCREENS.has(name)) name = "login";

  Object.values(screens).forEach(s => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo(0, 0);
}

function currentScreen() {
  return Object.keys(screens).find(k => screens[k].classList.contains("is-active"));
}

const veil = $("veil");
const busy = (on) => veil.classList.toggle("is-on", on);

function say(el, text) { el.textContent = text; el.hidden = false; }
function hush(...els)  { els.forEach(el => { el.hidden = true; }); }

const money = (n) =>
  n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function todayLabel() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

function readParams(raw) {
  const num = (x) => (Number.isFinite(parseFloat(x)) ? parseFloat(x) : 0);
  return {
    copperRate:   num(raw.copperRate),
    pvcRate:      num(raw.pvcRate),
    ropeRate:     num(raw.ropeRate),
    drawFlexible: num(raw.drawFlexible),
    drawStandard: num(raw.drawStandard),
    elecPct:      num(raw.elecPct),
    labourPct:    num(raw.labourPct),
    otherPct:     num(raw.otherPct),
    marginPct:    num(raw.marginPct),
  };
}

/* ============================================================
   4. ADMIN SESSION
   The expiry is measured from the ID token's auth_time - the
   moment the password was entered. Token refreshes do not move
   it, so the session cannot be stretched past one hour.
   ============================================================ */
let expiryTimer = null;

async function checkAdminSession() {
  const user = auth.currentUser;
  if (!user) return false;

  let expiresAt = 0;
  try {
    const { authTime } = await user.getIdTokenResult();
    expiresAt = Date.parse(authTime) + ADMIN_SESSION_TTL_MS;
  } catch (err) {
    // Token could not be read or refreshed - treat as expired.
    console.error(err);
  }

  if (!(Date.now() < expiresAt)) {
    await endAdminSession("expired");
    return false;
  }

  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(checkAdminSession, expiresAt - Date.now() + 500);
  return true;
}

async function endAdminSession(reason) {
  clearTimeout(expiryTimer);
  expiryTimer = null;
  await signOut(auth).catch(() => {});
  resetAdminCalc();
  hush(loginError);

  if (reason === "expired") {
    show("login");
    say(loginError, "Your session has expired. Please sign in again.");
  } else {
    show("calc");
  }
}

// Phones pause timers in the background - re-check on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkAdminSession();
});

/* ============================================================
   5. SHARED CALCULATOR HELPERS
   ============================================================ */
const calcError      = $("calc-error");
const adminCalcError = $("admin-calc-error");

// Each calculator keeps its own Flexible / Standard choice.
const wireType = { calc: "flexible", adminCalc: "flexible" };

document.querySelectorAll(".toggle").forEach(group => {
  const key = group.closest(".screen") === screens.adminCalc ? "adminCalc" : "calc";
  const btns = group.querySelectorAll("[data-type]");
  btns.forEach(btn => {
    btn.addEventListener("click", () => {
      wireType[key] = btn.dataset.type;
      btns.forEach(b => b.classList.toggle("is-on", b === btn));
    });
  });
});

function validateAndPrepareCalcForm(errorEl, type, fields) {
  const v = {
    type,
    wires:     parseFloat(fields.wires.value),
    thousands: parseFloat(fields.thousands.value),
    mm:        parseFloat(fields.mm.value),
    core:      parseFloat(fields.core.value),
    feet:      parseFloat(fields.feet.value),
  };

  const nums = [v.wires, v.thousands, v.mm, v.core, v.feet];
  if (nums.some(n => !Number.isFinite(n))) {
    say(errorEl, "Fill in all five boxes with numbers.");
    return null;
  }
  if (nums.some(n => n <= 0)) {
    say(errorEl, "All numbers must be more than zero.");
    return null;
  }
  if (!(v.core in PVC_PER_COIL[v.type])) {
    say(errorEl, "Core must be 1, 2, 3, 4 or 5.");
    return null;
  }
  const sizesForType = PVC_PER_COIL[v.type][v.core];
  if (!(v.mm in sizesForType)) {
    const typeLabel = v.type === "standard" ? "Standard" : "Flexible";
    say(errorEl,
      `For ${typeLabel}, ${v.core} core, MM must be one of: ` +
      Object.keys(sizesForType).join(", ") +
      ". Other sizes are not available yet.");
    return null;
  }

  return v;
}

function lengthLabel(v) {
  return `for ${v.feet.toLocaleString("en-PK")} feet` +
    (v.feet % COIL_FEET === 0
      ? ` (${v.feet / COIL_FEET} coil${v.feet === COIL_FEET ? "" : "s"})`
      : "");
}

function recapHtml(v) {
  const typeLabel = v.type === "standard" ? "Standard" : "Flexible";
  return `<span class="chip">${typeLabel}</span>
     <span class="chip">Wires <b>${v.wires}</b></span>
     <span class="chip">Thousands <b>${v.thousands}</b></span>
     <span class="chip">MM <b>${v.mm}</b></span>
     <span class="chip">Core <b>${v.core}</b></span>`;
}

function stampLabel(data) {
  return data.updatedAt
    ? `Rates updated ${new Date(data.updatedAt).toLocaleDateString("en-GB")}`
    : "";
}

function renderRateBreakdown(p, r) {
  const rs  = (n) => "Rs " + money(Math.round(n));
  const kg  = (n) => n.toLocaleString("en-PK", { maximumFractionDigits: 2 });
  const pct = (n) => n.toLocaleString("en-PK", { maximumFractionDigits: 2 });

  $("bd-copper").textContent = rs(r.copperCost);
  $("bd-copper-calc").textContent =
    `${kg(r.copperKg)} kg × ${rs(p.copperRate)}/kg = ${rs(r.copperCost)}`;

  $("bd-pvc").textContent = rs(r.pvcCost);
  $("bd-pvc-calc").textContent =
    `${kg(r.pvcKg)} kg × ${rs(p.pvcRate)}/kg = ${rs(r.pvcCost)}`;

  $("bd-rope").textContent = rs(r.ropeCost);
  $("bd-rope-calc").textContent = r.ropes > 0
    ? `${kg(r.metres)} m × ${r.ropes} ropes × ${rs(p.ropeRate)}/m = ${rs(r.ropeCost)}`
    : "No ropes used for this core count";

  $("bd-draw").textContent = rs(r.drawCost);
  $("bd-draw-calc").textContent =
    `${kg(r.copperKg)} kg × ${rs(r.drawRate)}/kg = ${rs(r.drawCost)}`;

  $("bd-elec").textContent = rs(r.electricity);
  $("bd-elec-calc").textContent =
    `${rs(r.base)} × ${pct(p.elecPct)}% = ${rs(r.electricity)}`;

  $("bd-labour").textContent = rs(r.labour);
  $("bd-labour-calc").textContent =
    `${rs(r.base)} × ${pct(p.labourPct)}% = ${rs(r.labour)}`;

  $("bd-other").textContent = rs(r.other);
  $("bd-other-calc").textContent =
    `${rs(r.base)} × ${pct(p.otherPct)}% = ${rs(r.other)}`;

  $("bd-factorycost").textContent = rs(r.factoryCost);

  $("bd-marginpct").textContent = p.marginPct;
  $("bd-margin").textContent = rs(r.margin);
  $("bd-margin-calc").textContent =
    `${rs(r.factoryCost)} × ${pct(p.marginPct)}% = ${rs(r.margin)}`;
}

/* ---------- feet confirmation (shared modal) ---------- */
const feetConfirm = $("feet-confirm");
let pending = null;   // { v, mode: "shop" | "factory" }

function askFeet(v, mode) {
  pending = { v, mode };
  $("feet-confirm-value").textContent = v.feet.toLocaleString("en-PK");
  feetConfirm.classList.add("is-on");
}

$("btn-feet-back").addEventListener("click", () => {
  pending = null;
  feetConfirm.classList.remove("is-on");
});

$("btn-feet-ok").addEventListener("click", async () => {
  feetConfirm.classList.remove("is-on");
  const job = pending;
  pending = null;
  if (!job) return;

  const isFactory = job.mode === "factory";
  const errorEl = isFactory ? adminCalcError : calcError;
  if (isFactory && !(await checkAdminSession())) return;

  busy(true);
  try {
    const snap = await getDoc(PARAMS_DOC);
    if (!snap.exists()) {
      say(errorEl, "Today's rates are not set yet. Please try again later.");
      return;
    }
    const p = readParams(snap.data());
    const r = calculateRate(p, job.v);

    if (isFactory) showFactoryResult(job.v, p, r, snap.data());
    else           showShopResult(job.v, r, snap.data());
  } catch (err) {
    console.error(err);
    say(errorEl, "Could not load today's rates. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

/* ============================================================
   6. SHOP CALCULATOR + RESULT  (signed out only)
   ============================================================ */
$("btn-ok").addEventListener("click", () => {
  hush(calcError);
  const v = validateAndPrepareCalcForm(calcError, wireType.calc, {
    wires:     $("in-wires"),
    thousands: $("in-thousands"),
    mm:        $("in-mm"),
    core:      $("in-core"),
    feet:      $("in-feet"),
  });
  if (v) askFeet(v, "shop");
});

function showShopResult(v, r, data) {
  $("result-min").textContent    = money(Math.round(r.factoryRate * 1.10));
  $("result-max").textContent    = money(Math.round(r.factoryRate * 1.25));
  $("result-length").textContent = lengthLabel(v);
  $("result-recap").innerHTML    = recapHtml(v);
  $("result-stamp").textContent  = stampLabel(data);
  show("result");
}

$("btn-back-calc").addEventListener("click", () => show("calc"));

/* ============================================================
   7. ADMIN LOGIN
   ============================================================ */
const loginError = $("login-error");

$("btn-to-login").addEventListener("click", () => {
  hush(loginError);
  show("login");
});

$("btn-back-from-login").addEventListener("click", () => show("calc"));

$("btn-login").addEventListener("click", async () => {
  hush(loginError);
  const email = $("in-email").value.trim();
  const pass  = $("in-password").value;

  if (!email || !pass) {
    say(loginError, "Enter your email and password.");
    return;
  }

  busy(true);
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    $("in-password").value = "";
    if (await checkAdminSession()) show("adminMenu");
  } catch (err) {
    console.error(err.code);
    say(loginError,
      (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password")
        ? "Email or password is wrong."
        : "Could not sign in. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

$("btn-toggle-password").addEventListener("click", () => {
  const passwordInput = $("in-password");
  const isHidden = passwordInput.type === "password";
  passwordInput.type = isHidden ? "text" : "password";
  $("btn-toggle-password").setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
  $("btn-toggle-password").setAttribute("title", isHidden ? "Hide password" : "Show password");
});

$("in-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

/* ============================================================
   8. ADMIN MENU
   ============================================================ */
$("btn-set-prices").addEventListener("click", async () => {
  if (!(await checkAdminSession())) return;
  show("admin");
  await loadAdminPanel();
});

$("btn-view-factory").addEventListener("click", async () => {
  if (!(await checkAdminSession())) return;
  hush(adminCalcError);
  show("adminCalc");
});

$("btn-admin-signout").addEventListener("click", () => endAdminSession("signout"));

/* ============================================================
   9. ADMIN FACTORY CALCULATOR + RESULT  (signed in only)
   ============================================================ */
const ADMIN_CALC_FIELDS = {
  wires:     $("in-admin-wires"),
  thousands: $("in-admin-thousands"),
  mm:        $("in-admin-mm"),
  core:      $("in-admin-core"),
  feet:      $("in-admin-feet"),
};

function resetAdminCalc() {
  Object.values(ADMIN_CALC_FIELDS).forEach(el => { el.value = ""; });
  ADMIN_CALC_FIELDS.feet.value = COIL_FEET;
  wireType.adminCalc = "flexible";
  screens.adminCalc.querySelectorAll("[data-type]").forEach(b =>
    b.classList.toggle("is-on", b.dataset.type === "flexible"));
  hush(adminCalcError);
}

$("btn-back-from-admin-calc").addEventListener("click", () => show("adminMenu"));

$("btn-admin-ok").addEventListener("click", () => {
  hush(adminCalcError);
  const v = validateAndPrepareCalcForm(adminCalcError, wireType.adminCalc, ADMIN_CALC_FIELDS);
  if (v) askFeet(v, "factory");
});

function showFactoryResult(v, p, r, data) {
  $("admin-result-value").textContent  = money(Math.round(r.factoryRate));
  $("admin-result-length").textContent = lengthLabel(v);
  $("admin-result-recap").innerHTML    = recapHtml(v);
  $("admin-result-stamp").textContent  = stampLabel(data);
  renderRateBreakdown(p, r);
  show("adminResult");
}

$("btn-back-admin-result").addEventListener("click", () => show("adminCalc"));

/* ============================================================
   10. ADMIN PANEL - SET PRICES
   ============================================================ */
const adminOk    = $("admin-ok");
const adminError = $("admin-error");

const ADMIN_FIELDS = [
  ["in-copper",    "copperRate"],
  ["in-pvc",       "pvcRate"],
  ["in-rope",      "ropeRate"],
  ["in-draw-flex", "drawFlexible"],
  ["in-draw-std",  "drawStandard"],
  ["in-elec",      "elecPct"],
  ["in-labour",    "labourPct"],
  ["in-other",     "otherPct"],
  ["in-margin",    "marginPct"],
];

async function loadAdminPanel() {
  $("admin-date").textContent = todayLabel();
  hush(adminOk, adminError);

  busy(true);
  try {
    const snap = await getDoc(PARAMS_DOC);
    if (snap.exists()) {
      const p = snap.data();
      ADMIN_FIELDS.forEach(([id, key]) => { $(id).value = p[key] ?? ""; });
      $("admin-lastsaved").textContent = p.updatedAt
        ? `Last updated ${new Date(p.updatedAt).toLocaleString("en-GB")}`
        : "";
    } else {
      ADMIN_FIELDS.forEach(([id]) => { $(id).value = ""; });
      $("in-margin").value = 5;
      $("admin-lastsaved").textContent = "No rates set yet.";
    }
  } catch (err) {
    console.error(err);
    say(adminError, "Could not load the current rates.");
  } finally {
    busy(false);
  }
}

$("btn-confirm").addEventListener("click", async () => {
  hush(adminOk, adminError);

  const p = {};
  for (const [id, key] of ADMIN_FIELDS) p[key] = parseFloat($(id).value);

  if (Object.values(p).some(n => !Number.isFinite(n))) {
    say(adminError, "Every box needs a number. Put 0 if it does not apply.");
    return;
  }
  if (Object.values(p).some(n => n < 0)) {
    say(adminError, "Rates cannot be negative.");
    return;
  }
  if (p.copperRate <= 0 || p.pvcRate <= 0) {
    say(adminError, "Copper and PVC rates must be more than zero.");
    return;
  }

  if (!(await checkAdminSession())) return;

  busy(true);
  try {
    await setDoc(PARAMS_DOC, {
      ...p,
      updatedAt: new Date().toISOString(),
      dateLabel: todayLabel(),
    });
    say(adminOk, `Rates are live for ${todayLabel()}.`);
    $("admin-lastsaved").textContent = `Last updated ${new Date().toLocaleString("en-GB")}`;
  } catch (err) {
    console.error(err);
    say(adminError, "Could not save. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

$("btn-back-from-admin").addEventListener("click", () => show("adminMenu"));
$("btn-signout").addEventListener("click", () => endAdminSession("signout"));

/* ============================================================
   11. AUTH STATE
   Firebase restores a saved sign-in on page load. If it is still
   inside its hour, go straight to the admin menu; otherwise sign
   out. If the user disappears, leave the admin screens.
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
  if (user) {
    if (await checkAdminSession() && PUBLIC_SCREENS.has(currentScreen())) {
      show("adminMenu");
    }
  } else if (!PUBLIC_SCREENS.has(currentScreen())) {
    show("calc");
  }
});
