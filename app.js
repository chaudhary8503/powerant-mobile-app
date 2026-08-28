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
    copperKg, pvcKg, ropes, ropeCost, drawCost,
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

const $ = (id) => document.getElementById(id);

const screens = {
  calc:   $("screen-calc"),
  result: $("screen-result"),
  login:  $("screen-login"),
  adminMenu: $("screen-admin-menu"),
  admin:  $("screen-admin"),
};

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove("is-active"));
  screens[name].classList.add("is-active");
  window.scrollTo(0, 0);
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
   4. SCREEN 1 - CLIENT CALCULATOR
   ============================================================ */
const calcError = $("calc-error");

let wireType = "flexible";
let resultMode = "shop";

function setResultMode(mode) {
  resultMode = mode;
  const isFactoryView = mode === "factory";
  $("calc-title").textContent = isFactoryView ? "Factory Rate" : "Shop Rate";
  $("result-title").textContent = isFactoryView ? "Factory Rate" : "Minimum to Maximum";
}

document.querySelectorAll("[data-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    wireType = btn.dataset.type;
    document.querySelectorAll("[data-type]").forEach(b =>
      b.classList.toggle("is-on", b === btn));
  });
});

$("btn-ok").addEventListener("click", async () => {
  hush(calcError);

  const v = {
    type:      wireType,
    wires:     parseFloat($("in-wires").value),
    thousands: parseFloat($("in-thousands").value),
    mm:        parseFloat($("in-mm").value),
    core:      parseFloat($("in-core").value),
    feet:      parseFloat($("in-feet").value),
  };

  const nums = [v.wires, v.thousands, v.mm, v.core, v.feet];
  if (nums.some(n => !Number.isFinite(n))) {
    say(calcError, "Fill in all five boxes with numbers.");
    return;
  }
  if (nums.some(n => n <= 0)) {
    say(calcError, "All numbers must be more than zero.");
    return;
  }
  if (!(v.core in PVC_PER_COIL[v.type])) {
    say(calcError, "Core must be 1, 2, 3, 4 or 5.");
    return;
  }
  const sizesForType = PVC_PER_COIL[v.type][v.core];
  if (!(v.mm in sizesForType)) {
    const typeLabel = v.type === "standard" ? "Standard" : "Flexible";
    say(calcError,
      `For ${typeLabel}, ${v.core} core, MM must be one of: ` +
      Object.keys(sizesForType).join(", ") +
      ". Other sizes are not available yet.");
    return;
  }

  busy(true);
  try {
    const snap = await getDoc(PARAMS_DOC);
    if (!snap.exists()) {
      say(calcError, "Today's rates are not set yet. Please try again later.");
      return;
    }
    const p = readParams(snap.data());
    const r = calculateRate(p, v);

    const isFactoryView = resultMode === "factory";
    $("result-title").textContent = isFactoryView ? "Factory Rate" : "Minimum to Maximum";
    $("result-single").hidden = !isFactoryView;
    $("result-range").hidden = isFactoryView;
    $("result-value").textContent = money(Math.round(r.factoryRate));
    $("result-min").textContent = money(Math.round(r.factoryRate * 1.10));
    $("result-max").textContent = money(Math.round(r.factoryRate * 1.25));
    $("result-length").textContent =
      `for ${v.feet.toLocaleString("en-PK")} feet` +
      (v.feet % COIL_FEET === 0
        ? ` (${v.feet / COIL_FEET} coil${v.feet === COIL_FEET ? "" : "s"})`
        : "");

    const typeLabel = v.type === "standard" ? "Standard" : "Flexible";
    $("result-recap").innerHTML =
      `<span class="chip">${typeLabel}</span>
       <span class="chip">Wires <b>${v.wires}</b></span>
       <span class="chip">Thousands <b>${v.thousands}</b></span>
       <span class="chip">MM <b>${v.mm}</b></span>
       <span class="chip">Core <b>${v.core}</b></span>`;

    $("result-stamp").textContent = snap.data().updatedAt
      ? `Rates updated ${new Date(snap.data().updatedAt).toLocaleDateString("en-GB")}`
      : "";

    show("result");
  } catch (err) {
    console.error(err);
    say(calcError, "Could not load today's rates. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

$("btn-back-calc").addEventListener("click", () => {
  show(resultMode === "factory" ? "adminMenu" : "calc");
});
$("btn-again").addEventListener("click",     () => show("calc"));

/* ============================================================
   5. SCREEN 3 - ADMIN LOGIN
   ============================================================ */
const loginError = $("login-error");

$("btn-to-login").addEventListener("click", () => {
  hush(loginError);
  if (auth.currentUser) { show("adminMenu"); }
  else                  { show("login"); }
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
    show("adminMenu");
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

$("btn-set-prices").addEventListener("click", async () => {
  show("admin");
  await loadAdminPanel();
});

$("btn-view-factory").addEventListener("click", () => {
  setResultMode("factory");
  show("calc");
});

$("btn-back-from-admin-menu").addEventListener("click", () => {
  setResultMode("shop");
  show("calc");
});

$("btn-back-from-admin").addEventListener("click", () => show("adminMenu"));

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
   6. SCREEN 4 - ADMIN PANEL
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

$("btn-signout").addEventListener("click", async () => {
  await signOut(auth);
  setResultMode("shop");
  show("calc");
});

$("btn-admin-signout").addEventListener("click", async () => {
  await signOut(auth);
  setResultMode("shop");
  show("calc");
});

/* ============================================================
   7. AUTH STATE
   ============================================================ */
onAuthStateChanged(auth, (user) => {
  if (!user) {
    setResultMode("shop");
    if (screens.adminMenu.classList.contains("is-active") || screens.admin.classList.contains("is-active")) {
      show("calc");
    }
  }
});