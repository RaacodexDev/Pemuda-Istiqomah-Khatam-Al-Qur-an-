// ============================================================
// PEMUDA ISTIQOMAH — script.js
// Firebase Firestore Real-Time Web App
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

// ─── Firebase Config ────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCUb6aMT9ihXvo3vtC-lOYTupSKhxEelcM",
  authDomain: "pemuda-istiqomah.firebaseapp.com",
  projectId: "pemuda-istiqomah",
  storageBucket: "pemuda-istiqomah.firebasestorage.app",
  messagingSenderId: "1021624369504",
  appId: "1:1021624369504:web:9f615901f6d89b88d75e05",
  measurementId: "G-PBVN1HYC3R"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ─── State ────────────────────────────────────────────────────
let currentUser    = null;
let unsubReaders   = null;
let unsubStats     = null;
let hasReadToday   = false;

// ─── Helpers ─────────────────────────────────────────────────
// Tanggal berdasarkan timezone Asia/Jakarta (WIB, UTC+7)
// Hindari toISOString() karena berbasis UTC → bisa geser hari di Indonesia
const getJakartaDateKey = (offsetDays = 0) => {
  const now = new Date();
  // Konversi ke WIB: UTC + 7 jam
  const wibMs = now.getTime() + (7 * 60 * 60 * 1000) + (offsetDays * 24 * 60 * 60 * 1000);
  const wib   = new Date(wibMs);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wib.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`; // "YYYY-MM-DD" dalam WIB
};

const todayKey     = () => getJakartaDateKey(0);
const yesterdayKey = () => getJakartaDateKey(-1);

const formatTime = (ts) => {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
};

const formatDate = () =>
  new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long"
  });

const initials = (name) =>
  name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();

// ─── Toast ────────────────────────────────────────────────────
function showToast(msg, type = "success", duration = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast hidden"; }, duration);
}

// ─── Screen Switch ────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// ─── LOGIN ────────────────────────────────────────────────────
window.handleLogin = async function () {
  const input = document.getElementById("nameInput");
  const name  = input.value.trim();
  if (!name) {
    showToast("⚠️ Masukkan nama kamu terlebih dahulu", "error");
    input.focus();
    return;
  }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div><span>Memuat...</span>`;

  try {
    await ensureUser(name);
    localStorage.setItem("pi_user", name);
    currentUser = name;
    await enterApp();
  } catch (e) {
    console.error(e);
    showToast("❌ Gagal masuk. Periksa koneksi internet.", "error");
    btn.disabled = false;
    btn.innerHTML = `<span>Mulai Perjalanan</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
  }
};

// ─── Ensure user doc exists ──────────────────────────────────
async function ensureUser(name) {
  const ref = doc(db, "users", name);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      nama: name,
      streak: 0,
      createdAt: serverTimestamp()
    });
  }
}

// ─── ENTER APP ────────────────────────────────────────────────
async function enterApp() {
  showScreen("mainApp");
  document.getElementById("greetingName").textContent = currentUser;
  document.getElementById("todayDate").textContent = formatDate();

  await refreshStreak();
  await checkTodayStatus();
  startRealtimeListeners();
}

// ─── Streak Logic ─────────────────────────────────────────────
async function refreshStreak() {
  const userRef  = doc(db, "users", currentUser);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return;

  const userData = userSnap.data();
  const today  = todayKey();
  const yester = yesterdayKey();

  const todaySnap = await getDoc(doc(db, "progress", `${currentUser}_${today}`));
  const yestSnap  = await getDoc(doc(db, "progress", `${currentUser}_${yester}`));

  let streak = userData.streak || 0;

  // If streak was last updated but not yesterday and not today → reset
  const lastReadKey = userData.lastReadDate || null;
  if (lastReadKey && lastReadKey !== today && lastReadKey !== yester) {
    streak = 0;
    await setDoc(userRef, { streak: 0 }, { merge: true });
  }

  document.getElementById("streakCount").textContent = streak;
}

// ─── Check today's read status ───────────────────────────────
async function checkTodayStatus() {
  const docId   = `${currentUser}_${todayKey()}`;
  const snap    = await getDoc(doc(db, "progress", docId));
  hasReadToday  = snap.exists() && snap.data().selesai === true;
  renderReadStatus(hasReadToday, snap.data());
}

function renderReadStatus(done, data) {
  const area = document.getElementById("readStatusArea");
  if (done) {
    const timeStr = data?.waktu ? formatTime(data.waktu) : "";
    area.innerHTML = `
      <div class="done-status">
        <div class="done-icon-wrap">✅</div>
        <div class="done-text">
          <strong>Alhamdulillah, selesai!</strong>
          <span>Kamu sudah membaca hari ini${timeStr ? ` pukul ${timeStr}` : ""}. Terus istiqomah!</span>
        </div>
      </div>`;
  } else {
    area.innerHTML = `
      <button class="btn-read" id="readBtn" onclick="confirmRead()">
        <div class="pulse-dot"></div>
        <span>Saya Sudah Membaca Hari Ini</span>
      </button>`;
  }
}

// ─── Confirm Read ─────────────────────────────────────────────
window.confirmRead = async function () {
  if (hasReadToday) return;

  const btn = document.getElementById("readBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div><span>Menyimpan...</span>`;
  }

  const today  = todayKey();
  const docId  = `${currentUser}_${today}`;
  const now    = new Date();

  try {
    // Save progress
    await setDoc(doc(db, "progress", docId), {
      nama:    currentUser,
      tanggal: today,
      waktu:   serverTimestamp(),
      selesai: true
    });

    // Update user streak
    await updateStreak(today);
    await refreshStreak();

    hasReadToday = true;
    renderReadStatus(true, { waktu: Timestamp.fromDate(now) });
    showToast("🌿 Barakallah! Catatan harian tersimpan.", "success");
  } catch (e) {
    console.error(e);
    showToast("❌ Gagal menyimpan. Coba lagi.", "error");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<div class="pulse-dot"></div><span>Saya Sudah Membaca Hari Ini</span>`;
    }
  }
};

// ─── Update streak ────────────────────────────────────────────
async function updateStreak(today) {
  const userRef  = doc(db, "users", currentUser);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return;

  const userData = userSnap.data();
  const lastReadDate = userData.lastReadDate || null;
  const yester = yesterdayKey();

  let newStreak;
  if (lastReadDate === yester) {
    newStreak = (userData.streak || 0) + 1;
  } else if (lastReadDate === today) {
    newStreak = userData.streak || 1; // already counted
  } else {
    newStreak = 1; // start fresh
  }

  await setDoc(userRef, {
    streak: newStreak,
    lastReadDate: today
  }, { merge: true });
}

// ─── Real-Time Listeners ──────────────────────────────────────
function startRealtimeListeners() {
  // 1. Today's readers — real-time
  const today = todayKey();
  const progressRef = collection(db, "progress");
  const qToday = query(progressRef, where("tanggal", "==", today), where("selesai", "==", true));

  if (unsubReaders) unsubReaders();
  unsubReaders = onSnapshot(qToday, async (snapshot) => {
    const readers = [];
    for (const docSnap of snapshot.docs) {
      const d = docSnap.data();
      // Get streak from user doc
      let streak = 0;
      try {
        const uSnap = await getDoc(doc(db, "users", d.nama));
        if (uSnap.exists()) streak = uSnap.data().streak || 0;
      } catch {}
      readers.push({ ...d, streak });
    }

    // Sort by waktu
    readers.sort((a, b) => {
      const ta = a.waktu?.toDate?.() || new Date(0);
      const tb = b.waktu?.toDate?.() || new Date(0);
      return ta - tb;
    });

    renderReaders(readers);
    renderStats(readers.length);
  });
}

// ─── Render Readers ───────────────────────────────────────────
function renderReaders(readers) {
  const list = document.getElementById("readersList");
  if (!readers.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span>🌙</span>
        <p>Belum ada yang membaca hari ini.<br>Jadilah yang pertama!</p>
      </div>`;
    return;
  }

  list.innerHTML = readers.map((r, i) => `
    <div class="reader-item" style="animation-delay:${i * 0.05}s">
      <div class="reader-avatar">${initials(r.nama)}</div>
      <div class="reader-info">
        <div class="reader-name">${escapeHtml(r.nama)}${r.nama === currentUser ? ' <span style="color:var(--emerald-400);font-size:0.7rem;">(kamu)</span>' : ""}</div>
        <div class="reader-time">${r.waktu ? "Pukul " + formatTime(r.waktu) : "Hari ini"}</div>
      </div>
      ${r.streak > 1 ? `<div class="reader-streak">🔥 ${r.streak}</div>` : ""}
      <div class="reader-check">✅</div>
    </div>
  `).join("");
}

// ─── Render Stats ─────────────────────────────────────────────
async function renderStats(doneCount) {
  // Total users
  let total = 0;
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    total = usersSnap.size;
  } catch {}

  const pending = Math.max(0, total - doneCount);
  const pct     = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  animateValue("statTotal",   total);
  animateValue("statDone",    doneCount);
  animateValue("statPending", pending);

  document.getElementById("progressFill").style.width   = `${pct}%`;
  document.getElementById("progressPercent").textContent = `${pct}%`;
}

function animateValue(id, target) {
  const el  = document.getElementById(id);
  const cur = parseInt(el.textContent) || 0;
  if (cur === target) return;
  const diff  = target - cur;
  const steps = 20;
  let step = 0;
  const t = setInterval(() => {
    step++;
    el.textContent = Math.round(cur + (diff * step / steps));
    if (step >= steps) { el.textContent = target; clearInterval(t); }
  }, 20);
}

// ─── Logout ───────────────────────────────────────────────────
window.handleLogout = function () {
  if (!confirm("Yakin mau keluar?")) return;
  if (unsubReaders) unsubReaders();
  if (unsubStats)   unsubStats();
  localStorage.removeItem("pi_user");
  currentUser  = null;
  hasReadToday = false;
  document.getElementById("nameInput").value = "";
  showScreen("loginScreen");
  showToast("👋 Sampai jumpa!", "success");
};

// ─── XSS protection ───────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── Enter key on login ──────────────────────────────────────
document.getElementById("nameInput").addEventListener("keydown", e => {
  if (e.key === "Enter") handleLogin();
});

// ─── Auto-login on load ───────────────────────────────────────
(async function init() {
  const saved = localStorage.getItem("pi_user");
  if (saved) {
    currentUser = saved;
    document.getElementById("nameInput").value = saved;
    try {
      await ensureUser(saved);
      await enterApp();
    } catch (e) {
      console.error("Auto-login failed:", e);
      showScreen("loginScreen");
    }
  } else {
    showScreen("loginScreen");
  }
})();
