import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ============================================================
   1. THE FORMULA  —  placeholder, swap in the real one later.
   p = today's parameters {a,b,c,d} set by the admin
   v = what the client typed {wires, thousands, mm, core}
   ============================================================ */
function calculateRate(p, v) {
  const rate =
      p.a * v.wires * v.core
    + p.b * v.mm * v.thousands
    + p.c * (v.wires + v.mm)
    + p.d;

  return Math.round(rate);
}

/* ============================================================
   2. SETUP
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

const money = (n) => n.toLocaleString("en-PK");

function todayLabel() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

/* ============================================================
   3. SCREEN 1  —  CLIENT CALCULATOR
   ============================================================ */
const calcError = $("calc-error");

$("btn-ok").addEventListener("click", async () => {
  hush(calcError);

  const v = {
    wires:     parseFloat($("in-wires").value),
    thousands: parseFloat($("in-thousands").value),
    mm:        parseFloat($("in-mm").value),
    core:      parseFloat($("in-core").value),
  };

  const blank = Object.entries(v).filter(([, n]) => !Number.isFinite(n));
  if (blank.length) {
    say(calcError, "Fill in all four boxes with numbers.");
    return;
  }
  if (Object.values(v).some(n => n < 0)) {
    say(calcError, "Numbers cannot be negative.");
    return;
  }

  busy(true);
  try {
    const snap = await getDoc(PARAMS_DOC);
    if (!snap.exists()) {
      say(calcError, "Today's rate is not set yet. Please try again later.");
      return;
    }
    const p = snap.data();

    $("result-value").textContent = money(calculateRate(p, v));
    $("result-recap").innerHTML =
      `<span class="chip">Wires <b>${v.wires}</b></span>
       <span class="chip">Thousands <b>${v.thousands}</b></span>
       <span class="chip">MM <b>${v.mm}</b></span>
       <span class="chip">Core <b>${v.core}</b></span>`;

    show("result");
  } catch (err) {
    console.error(err);
    say(calcError, "Could not load today's rate. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

$("btn-back-calc").addEventListener("click", () => show("calc"));
$("btn-again").addEventListener("click",     () => show("calc"));

/* ============================================================
   4. SCREEN 3  —  ADMIN LOGIN
   ============================================================ */
const loginError = $("login-error");

$("btn-to-login").addEventListener("click", () => {
  hush(loginError);
  show(auth.currentUser ? "admin" : "login");
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
    // onAuthStateChanged loads the panel
  } catch (err) {
    console.error(err.code);
    say(loginError,
      err.code === "auth/invalid-credential" || err.code === "auth/wrong-password"
        ? "Email or password is wrong."
        : "Could not sign in. Check your internet and try again.");
  } finally {
    busy(false);
  }
});

$("in-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

/* ============================================================
   5. SCREEN 4  —  ADMIN PANEL
   ============================================================ */
const adminOk    = $("admin-ok");
const adminError = $("admin-error");

async function loadAdminPanel() {
  $("admin-date").textContent = todayLabel();
  hush(adminOk, adminError);

  busy(true);
  try {
    const snap = await getDoc(PARAMS_DOC);
    if (snap.exists()) {
      const p = snap.data();
      $("in-a").value = p.a ?? "";
      $("in-b").value = p.b ?? "";
      $("in-c").value = p.c ?? "";
      $("in-d").value = p.d ?? "";
      $("admin-lastsaved").textContent =
        p.updatedAt ? `Last updated ${new Date(p.updatedAt).toLocaleString("en-GB")}` : "";
    } else {
      $("admin-lastsaved").textContent = "No parameters set yet.";
    }
  } catch (err) {
    console.error(err);
    say(adminError, "Could not load the current parameters.");
  } finally {
    busy(false);
  }
}

$("btn-confirm").addEventListener("click", async () => {
  hush(adminOk, adminError);

  const p = {
    a: parseFloat($("in-a").value),
    b: parseFloat($("in-b").value),
    c: parseFloat($("in-c").value),
    d: parseFloat($("in-d").value),
  };

  if (Object.values(p).some(n => !Number.isFinite(n))) {
    say(adminError, "All four parameters need a number.");
    return;
  }

  busy(true);
  try {
    await setDoc(PARAMS_DOC, {
      ...p,
      updatedAt: new Date().toISOString(),
      dateLabel: todayLabel(),
    });
    say(adminOk, `Parameters are live for ${todayLabel()}.`);
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
  show("calc");
});

/* ============================================================
   6. AUTH STATE
   ============================================================ */
onAuthStateChanged(auth, (user) => {
  if (user && screens.login.classList.contains("is-active")) {
    show("admin");
    loadAdminPanel();
  }
});
