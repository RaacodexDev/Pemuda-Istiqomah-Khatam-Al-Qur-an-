// ============================================================
// PEMUDA ISTIQOMAH — script.js  (v4 — Stable & Deterministic)
//
// Perubahan kritis dari v3:
//  1. UUID-based userId — nama bukan lagi document key
//  2. ensureUser() pakai setDoc merge tanpa read-before-write
//  3. Timezone: Intl.DateTimeFormat (browser-native, tidak manual)
//  4. Semua timestamp wajib Firestore serverTimestamp / Timestamp
//  5. confirmRead() pakai runTransaction — atomic, anti race-condition
//  6. Streak logic deterministik dalam satu transaksi
//  7. Listener sort robust: null lastReadTime ditempatkan di akhir
//  8. progress = audit log only, tidak menyentuh stats sama sekali
//  9. Guard: listener tidak restart kalau userId tidak berubah
// ============================================================

import { initializeApp }       from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  Timestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

// ─── Firebase Config ─────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyCUb6aMT9ihXvo3vtC-lOYTupSKhxEelcM",
  authDomain:        "pemuda-istiqomah.firebaseapp.com",
  projectId:         "pemuda-istiqomah",
  storageBucket:     "pemuda-istiqomah.firebasestorage.app",
  messagingSenderId: "1021624369504",
  appId:             "1:1021624369504:web:9f615901f6d89b88d75e05",
  measurementId:     "G-PBVN1HYC3R",
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ─── App State ───────────────────────────────────────────────
let currentUserId   = null;   // UUID — stable, tidak pernah berubah
let currentName     = null;   // display only
let hasReadToday    = false;
let unsubUsers      = null;
let listenerStarted = false;  // guard: jangan restart listener saat re-render
let midnightTimer   = null;   // satu timer aktif untuk reset tengah malam

// ============================================================
// [1] DATE HELPERS — pakai Intl.DateTimeFormat (browser-native WIB)
//
// ALASAN ganti dari manual offset (+7*3600*1000):
//  - Intl otomatis handle DST kalau suatu saat TZ policy berubah
//  - Lebih eksplisit, tidak bisa typo angka offset
//  - Konsisten antara todayKey() dan timestamp comparison
// ============================================================

/** Kembalikan "YYYY-MM-DD" dalam timezone Asia/Jakarta */
const getDateInJakarta = (date = new Date(), offsetDays = 0) => {
  if (offsetDays !== 0) {
    date = new Date(date.getTime() + offsetDays * 86_400_000);
  }
  // toLocaleDateString dengan locale 'sv' menghasilkan format ISO YYYY-MM-DD
  return date.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
};

const todayKey     = () => getDateInJakarta(new Date(), 0);
const yesterdayKey = () => getDateInJakarta(new Date(), -1);

// ─── Util ────────────────────────────────────────────────────

/**
 * Konversi Firestore Timestamp / Date / null ke JS Date.
 * Selalu return Date, tidak pernah throw.
 */
const tsToDate = (ts) => {
  if (!ts)                     return null;
  if (ts instanceof Timestamp) return ts.toDate();
  if (ts instanceof Date)      return ts;
  return null;
};

const formatTime = (ts) => {
  const d = tsToDate(ts);
  if (!d) return "";
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
};

const formatDate = () =>
  new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long",
  });

// Format tanggal untuk streak card: "Rabu, 10 Juni · Hari ke-N"
const formatDateBadge = (createdAt) => {
  const dateStr = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long",
    timeZone: "Asia/Jakarta",
  });
  if (!createdAt) return dateStr;
  const created    = createdAt instanceof Timestamp ? createdAt.toDate() : new Date(createdAt);
  const todayWib   = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }));
  const createdWib = new Date(created.toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }));
  const diffDays   = Math.floor((todayWib - createdWib) / 86_400_000);
  const hariKe     = diffDays + 1;
  return `${dateStr} · Hari ke-${hariKe}`;
};

const initials = (name = "") =>
  (name.trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase()) || "?";

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ============================================================
// [2] UUID v4 — tidak butuh library, crypto.randomUUID tersedia
//     di semua modern browser (Chrome 92+, Firefox 95+, Safari 15.4+)
//     Fallback manual jika tidak tersedia (Android WebView lama)
// ============================================================
const generateUUID = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback RFC-4122 v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
};

// ─── SVG Icons — Lucide flat monochrome, stroke 2px ─────────
// Semua ikon: 20px, stroke currentColor, rounded linecap/linejoin
// Warna diatur dari CSS (color: var(--accent) / inline style)
const ICONS = {
  // Flame — streak di reader list
  fire: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke="#f97316" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 01-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"/>
  </svg>`,

  // CheckCircle2 — reader list item check
  check: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    style="color:var(--accent)">
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
    <path d="M7.5 12l3 3 6-6"/>
  </svg>`,

  // CheckCircle2 large — done status card
  checkLg: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    style="color:var(--accent)">
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
    <path d="M7.5 12l3 3 6-6"/>
  </svg>`,

  // Moon — empty state
  moon: `<svg width="38" height="38" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
    style="opacity:0.3">
    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
  </svg>`,

  // Check — toast sukses
  leaf: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
    <path d="M7.5 12l3 3 6-6"/>
  </svg>`,

  // XCircle — toast error
  xCircle: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <path d="M15 9l-6 6M9 9l6 6"/>
  </svg>`,
};
const icon = (name, style = "") =>
  `<span class="pi-icon" style="vertical-align:-3px;${style}">${ICONS[name]}</span>`;

// ─── Toast & Screen ──────────────────────────────────────────
function showToast(msg, type = "success", duration = 3000) {
  const t = document.getElementById("toast");
  t.innerHTML  = msg;
  t.className  = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = "toast hidden"; }, duration);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// ============================================================
// [3] ensureUser — dua langkah kecil yang aman
//
// Step 1: setDoc merge → update nama + active (idempoten, tidak overwrite createdAt)
// Step 2: getDoc → cek createdAt, set hanya jika null
//
// Ini BUKAN race-condition karena:
//  - Kita tidak conditional-write berdasarkan nilai yang dibaca (streak dsb)
//  - Kita hanya mengisi field yang kosong → worst case: dua tab
//    sama-sama set createdAt dengan serverTimestamp → tidak apa-apa,
//    nilai akhir sedikit berbeda tapi bukan data corruption.
// ============================================================
async function ensureUser(userId, name) {
  const ref = doc(db, "users", userId);

  // Step 1: Pastikan nama & active selalu up-to-date
  await setDoc(ref, {
    nama:   name,
    active: true,
  }, { merge: true });

  // Step 2: Set createdAt hanya jika belum ada
  const snap = await getDoc(ref);
  if (snap.exists() && !snap.data().createdAt) {
    await setDoc(ref, { createdAt: serverTimestamp() }, { merge: true });
  }
}

// ============================================================
// normalizeName — standarisasi nama menjadi lowercase + trim
//
// Digunakan sebagai key di collection "nameIndex".
// Field "nama" di users tetap menyimpan tulisan asli (display).
//
// Contoh:
//   "Raffly" → "raffly"
//   " RAFFLY " → "raffly"
//   "raffly" → "raffly"
// ============================================================
function normalizeName(name) {
  return name.trim().toLowerCase();
}

// ============================================================
// resolveUserIdByName — atomic via runTransaction
//
// ALASAN pakai runTransaction (bukan getDoc+setDoc):
//   Tanpa transaksi: dua device login nama yang sama bersamaan
//   → keduanya getDoc → keduanya lihat "belum ada" → keduanya
//   buat UUID berbeda → duplikasi user.
//
//   Dengan transaksi: Firestore menjamin hanya satu yang berhasil
//   menulis. Yang kalah akan retry dan membaca dokumen yang
//   sudah dibuat, lalu return userId yang sama.
//
// NORMALISASI:
//   Key nameIndex menggunakan normalizeName(name) sehingga
//   "Raffly", "raffly", " RAFFLY " semuanya mengarah ke userId
//   yang sama. Field "nama" di users tetap menyimpan aslinya.
// ============================================================
async function resolveUserIdByName(name) {
  const normalizedKey = normalizeName(name);
  const indexRef      = doc(db, "nameIndex", normalizedKey);
  let resolvedId;

  await runTransaction(db, async (tx) => {
    const indexSnap = await tx.get(indexRef);

    if (indexSnap.exists()) {
      // Nama sudah ada (normalized key) — pakai userId lama, jangan buat UUID baru
      resolvedId = indexSnap.data().userId;
    } else {
      // Nama baru — buat UUID dan daftarkan secara atomic
      resolvedId = generateUUID();
      tx.set(indexRef, {
        userId:    resolvedId,
        createdAt: serverTimestamp(),
      });
    }
  });

  return resolvedId;
}


// ============================================================
// ZIKIR SCREEN
//
// Kapan muncul:
//  ✓ Login manual (ketik nama + klik tombol) untuk PERTAMA KALI
//    di sesi tab ini — cek sessionStorage "pi_zikir_shown"
//
// Kapan TIDAK muncul:
//  ✗ Auto-login (refresh / buka ulang) → langsung ke app
//  ✗ Login ke-2, ke-3 dst di tab yang sama → flag sudah ada
//  ✗ Logout lalu login ulang di tab yang sama → flag masih ada
//
// sessionStorage dipilih karena:
//  - Reset otomatis saat tab ditutup (sesi baru = muncul lagi)
//  - Tidak reset saat refresh (tidak spam zikir tiap F5)
// ============================================================

let _zikirTimer = null;

function shouldShowZikir() {
  return !sessionStorage.getItem("pi_zikir_shown");
}

function markZikirShown() {
  sessionStorage.setItem("pi_zikir_shown", "1");
}

function showZikirScreen(onDone) {
  markZikirShown();
  showScreen("zikirScreen");

  const btn       = document.getElementById("zikirLanjutBtn");
  const countdown = document.getElementById("zikirCountdown");
  const btnText   = document.getElementById("zikirBtnText");

  btn.disabled = true;
  btnText.textContent = "Lanjut";
  countdown.textContent = "5";
  countdown.style.display = "inline-flex";

  let sisa = 15;
  clearInterval(_zikirTimer);
  _zikirTimer = setInterval(() => {
    sisa--;
    if (sisa > 0) {
      countdown.textContent = sisa;
    } else {
      clearInterval(_zikirTimer);
      btn.disabled = false;
      countdown.style.display = "none";
      btnText.textContent = "Lanjut →";
    }
  }, 1000);

  window._zikirOnDone = onDone;
}

window.zikirLanjut = function () {
  clearInterval(_zikirTimer);
  if (typeof window._zikirOnDone === "function") {
    window._zikirOnDone();
    window._zikirOnDone = null;
  }
};


window.handleLogin = async function () {
  const input = document.getElementById("nameInput");
  const name  = input.value.trim();
  if (!name) {
    showToast(`${icon("xCircle","margin-right:6px")} Masukkan nama kamu terlebih dahulu`, "error");
    input.focus();
    return;
  }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner"></div><span>Memuat...</span>`;

  try {
    // Resolusi userId berdasarkan nama — konsisten lintas device/browser
    const userId = await resolveUserIdByName(name);
    localStorage.setItem("pi_userId", userId);
    localStorage.setItem("pi_name",   name);

    await ensureUser(userId, name);

    // Migrasi progress lama yang pakai nama (asli / normalized) sebagai userId.
    // Dijalankan secara berurutan sebelum enterApp agar listener tidak membaca
    // data lama saat halaman utama dimuat.
    await migrateProgress(name, userId);                 // nama asli → UUID
    await migrateProgress(normalizeName(name), userId);  // nama normalized → UUID

    currentUserId = userId;
    currentName   = name;

    // Login manual → SELALU tampilkan zikir screen
    // sessionStorage di-set di sini agar auto-login (refresh) skip zikir
    markZikirShown();
    showZikirScreen(() => enterApp());
  } catch (e) {
    console.error("[Login Error]", e);
    showToast(`${icon("xCircle","margin-right:6px")} Gagal masuk. Periksa koneksi internet.`, "error");
    btn.disabled = false;
    btn.innerHTML = `<span>Mulai Perjalanan</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
  }
};

// ─── Enter App ───────────────────────────────────────────────
async function enterApp() {
  showScreen("mainApp");
  document.getElementById("greetingName").textContent = currentName;
  document.getElementById("todayDate").textContent    = formatDateBadge();

  startUsersListener();
  scheduleMidnightReset();
}

// ============================================================
// AUTO-RESET TENGAH MALAM
//
// Menghitung ms menuju 00:00 WIB berikutnya, lalu reset state
// dan UI tanpa menyentuh Firestore sama sekali.
//
// - Hanya satu timer aktif setiap saat (midnightTimer).
// - Tidak mengubah streak, lastReadDate, atau data apapun di DB.
// - Setelah reset, jadwalkan ulang untuk hari berikutnya.
// ============================================================
function scheduleMidnightReset() {
  // Bersihkan timer lama agar tidak ada yang berjalan ganda
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }

  // Hitung waktu sekarang dan 00:00 berikutnya dalam WIB (Asia/Jakarta)
  const now        = new Date();
  const nowWIB     = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const nextMidnightWIB = new Date(nowWIB);
  nextMidnightWIB.setHours(24, 0, 0, 0); // mundurkan ke 00:00 hari berikutnya

  const msUntilMidnight = nextMidnightWIB - nowWIB;

  midnightTimer = setTimeout(() => {
    // reset seluruh tampilan untuk hari baru
    resetDailyUI();

    // jadwalkan lagi untuk hari berikutnya
    scheduleMidnightReset();
  }, msUntilMidnight);
}

// ============================================================
// RESET UI HARIAN
//
// Dipanggil tepat pukul 00:00 WIB.
// Hanya mereset state lokal dan tampilan.
// Tidak melakukan write ke Firestore.
//
// Tujuan:
// - Tombol "Saya Sudah Membaca Hari Ini" muncul lagi.
// - Daftar pembaca kemarin langsung hilang.
// - Statistik kembali 0.
// - Progress bar kembali kosong.
// - Tanggal header diperbarui.
// ============================================================
function resetDailyUI() {
  // reset state lokal
  hasReadToday = false;

  // tampilkan tombol baca lagi
  renderReadStatus(false);

  // kosongkan daftar pembaca hari sebelumnya
  renderReaders([]);

  // reset statistik harian
  renderStats(0, 0, 0);

  // pastikan progress bar benar-benar kosong
  document.getElementById("progressFill").style.width    = "0%";
  document.getElementById("progressPercent").textContent = "0%";

  // update tanggal
  document.getElementById("todayDate").textContent = formatDateBadge();
}

// ============================================================
// [5] REALTIME LISTENER — satu listener, semua data
//
// - query: active == true (semua peserta)
// - tidak restart jika listenerStarted && userId sama
// - snapshot memberikan semua users dalam satu read
// - dari snapshot ini kita derive: readers, total, done, pending
// - tidak ada getDoc/getDocs tambahan di dalam callback
// ============================================================
// ============================================================
// MIGRASI: document lama (ID = nama) → document baru (ID = UUID)
//
// Kapan dijalankan: sekali per snapshot, hanya jika ada duplikat.
// Idempotent: jika dijalankan ulang tidak merusak atau menduplikasi.
//
// Alur per grup nama yang sama:
//  1. Pisahkan: mana yang UUID, mana yang nama-as-ID (legacy)
//  2. Pilih data terbaru (lastReadTime terbesar) sebagai master
//  3. Merge ke document UUID
//  4. Hapus semua document legacy
// ============================================================

// Cek apakah string adalah UUID v4
const isUUID = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

// Set in-memory agar setiap grup hanya dimigrasi sekali per session
const _migratedGroups = new Set();

async function migrateOldUsers(allUsers) {
  // Kelompokkan berdasarkan nama (case-insensitive, trimmed)
  const groups = {};
  for (const u of allUsers) {
    const key = (u.nama ?? "").trim().toLowerCase();
    if (!key) continue;
    (groups[key] = groups[key] || []).push(u);
  }

  for (const [key, members] of Object.entries(groups)) {
    // Hanya proses grup yang punya lebih dari satu document
    if (members.length < 2) continue;
    // Skip jika grup ini sudah dimigrasi di session ini
    if (_migratedGroups.has(key)) continue;

    const uuidDocs   = members.filter(u => isUUID(u._id));
    const legacyDocs = members.filter(u => !isUUID(u._id));

    // Butuh minimal 1 doc UUID sebagai target
    if (uuidDocs.length === 0) continue;

    // Pilih document terbaru sebagai master data
    // (bandingkan lastReadTime; null dianggap paling lama)
    const allMembers = [...uuidDocs, ...legacyDocs];
    const master = allMembers.reduce((best, cur) => {
      const tb = tsToDate(best.lastReadTime);
      const tc = tsToDate(cur.lastReadTime);
      if (!tb && !tc) return best;
      if (!tb) return cur;
      if (!tc) return best;
      return tc > tb ? cur : best;
    });

    // Target selalu UUID doc — pilih UUID yang punya lastReadTime terbaru,
    // atau UUID pertama jika semua null
    const targetDoc = uuidDocs.reduce((best, cur) => {
      const tb = tsToDate(best.lastReadTime);
      const tc = tsToDate(cur.lastReadTime);
      if (!tb && !tc) return best;
      if (!tb) return cur;
      if (!tc) return best;
      return tc > tb ? cur : best;
    });

    const targetRef = doc(db, "users", targetDoc._id);

    // Data yang akan di-merge ke target: ambil field terbaik dari master
    const mergedData = {
      nama:         master.nama        ?? targetDoc.nama,
      active:       true,
      streak:       master.streak      ?? targetDoc.streak      ?? 0,
      lastReadDate: master.lastReadDate ?? targetDoc.lastReadDate ?? null,
      lastReadTime: master.lastReadTime ?? targetDoc.lastReadTime ?? null,
      createdAt:    targetDoc.createdAt ?? master.createdAt      ?? serverTimestamp(),
    };

    try {
      // Tulis data gabungan ke target UUID doc
      await setDoc(targetRef, mergedData, { merge: true });

      // Hapus semua legacy doc (non-UUID) dan UUID doc lain yang bukan target
      const toDelete = [
        ...legacyDocs,
        ...uuidDocs.filter(u => u._id !== targetDoc._id),
      ];
      await Promise.all(toDelete.map(u => deleteDoc(doc(db, "users", u._id))));

      _migratedGroups.add(key);
      console.log(`[Migration] "${key}": merged ${toDelete.length} doc(s) → ${targetDoc._id}`);
    } catch (e) {
      console.error(`[Migration Error] "${key}":`, e);
      // Gagal migrasi tidak boleh crash app — skip dan coba lagi snapshot berikut
    }
  }
}

// ============================================================
// [MIGRASI PROGRESS] migrateProgress(oldUserId, newUserId)
//
// Tujuan:
//   Menyatukan histori progress lama (userId = nama / old key)
//   ke UUID yang benar. Aman dijalankan berkali-kali (idempotent).
//
// Alur per dokumen lama:
//   1. Query progress where("userId", "==", oldUserId)
//   2. Untuk setiap doc lama (misal id "Raffly_2026-06-09"):
//      - Buat ref baru: "newUserId_tanggal" (misal "ba4B..._2026-06-09")
//      - Cek apakah doc tujuan sudah ada — jika sudah, skip (no overwrite)
//      - Jika belum ada: setDoc dengan data baru (userId = newUserId)
//      - Setelah berhasil: deleteDoc(oldRef)
//   3. Jika tidak ada progress lama, return tanpa error
//
// PENTING:
//   - oldUserId bisa berupa nama asli ("Raffly"), nama normalized
//     ("raffly"), atau UUID lama yang berbeda.
//   - Jangan jalankan jika oldUserId === newUserId (tidak perlu migrasi).
//   - Fire-and-forget dari sisi caller — error tidak crash app.
//   - Idempotent: jika dijalankan ulang, dokumen lama sudah tidak ada
//     sehingga query langsung empty dan return tanpa efek samping.
// ============================================================
async function migrateProgress(oldUserId, newUserId) {
  // Tidak perlu migrasi jika keduanya sama atau salah satu kosong
  if (!oldUserId || !newUserId || oldUserId === newUserId) return;

  try {
    const q    = query(
      collection(db, "progress"),
      where("userId", "==", oldUserId)
    );
    const snap = await getDocs(q);

    // Tidak ada progress lama — selesai tanpa error
    if (snap.empty) return;

    for (const oldDoc of snap.docs) {
      const oldData = oldDoc.data();
      const tanggal = oldData.tanggal;

      // Jika dokumen tidak punya field tanggal, skip (data tidak valid)
      if (!tanggal) continue;

      const newDocId = `${newUserId}_${tanggal}`;
      const newRef   = doc(db, "progress", newDocId);
      const oldRef   = doc(db, "progress", oldDoc.id);

      // Cek apakah dokumen tujuan sudah ada — jika sudah, jangan overwrite
      let targetExists = false;
      try {
        const targetSnap = await getDoc(newRef);
        targetExists = targetSnap.exists();
      } catch (_) {
        // Jika getDoc gagal, asumsikan tidak ada dan coba setDoc
      }

      if (!targetExists) {
        // Buat dokumen baru dengan userId yang benar (merge:true agar aman)
        const newData = { ...oldData, userId: newUserId };
        await setDoc(newRef, newData, { merge: true });
      }

      // Hapus dokumen lama setelah berhasil dipindahkan
      // (atau jika target sudah ada — hindari data ganda)
      await deleteDoc(oldRef);

      console.log(
        `[migrateProgress] "${oldDoc.id}" → "${newDocId}"` +
        (targetExists ? " (target sudah ada, old dihapus)" : "")
      );
    }
  } catch (e) {
    // Migrasi gagal tidak boleh crash app
    console.error("[migrateProgress Error]", e);
  }
}

function startUsersListener() {
  // Guard: jangan restart listener yang sudah jalan untuk userId yang sama
  if (listenerStarted) return;
  listenerStarted = true;

  if (unsubUsers) unsubUsers();

  const q = query(collection(db, "users"), where("active", "==", true));

  unsubUsers = onSnapshot(
    q,
    (snapshot) => {
      const today    = todayKey();
      const allUsers = snapshot.docs.map(d => ({ _id: d.id, ...d.data() }));

      // ── Migrasi doc lama (nama-as-ID → UUID) sebelum data diproses
      // Fire-and-forget: tidak await agar listener tidak blocking.
      // Snapshot berikutnya akan sudah bersih setelah migrasi selesai.
      migrateOldUsers(allUsers).catch(e => console.error("[Migration]", e));

      // ── Setelah migrasi, filter hanya doc UUID untuk stats & render
      // Doc legacy yang belum terhapus (race window) dieksklusi agar
      // tidak terhitung dua kali di statistik.
      const cleanUsers = allUsers.filter(u => isUUID(u._id));

      // ── Stats (semua derived dari cleanUsers, tidak ada query tambahan)
      const total     = cleanUsers.length;
      const doneUsers = cleanUsers.filter(u => u.lastReadDate === today);
      const doneCount = doneUsers.length;
      const pending   = total - doneCount; // dijamin >= 0

      // ── Update hasReadToday dari listener
      const me = cleanUsers.find(u => u._id === currentUserId);
      if (me) {
        const nowRead = me.lastReadDate === today;
        const area = document.getElementById("readStatusArea");
        const alreadyRendered = area && area.children.length > 0;
        if (!alreadyRendered || nowRead !== hasReadToday) {
          hasReadToday = nowRead;
          renderReadStatus(nowRead, me);
          document.getElementById("streakCount").textContent = me.streak ?? 0;
        }
        // Update date dengan hari ke-N berdasarkan createdAt
        document.getElementById("todayDate").textContent = formatDateBadge(me.createdAt);
      }

      // ── Sort: null lastReadTime ditempatkan di akhir (robust)
      const readers = [...doneUsers].sort((a, b) => {
        const ta = tsToDate(a.lastReadTime);
        const tb = tsToDate(b.lastReadTime);
        if (!ta && !tb) return 0;
        if (!ta) return 1;   // a ke akhir
        if (!tb) return -1;  // b ke akhir
        return ta - tb;
      });

      renderReaders(readers);
      renderStats(total, doneCount, pending);
    },
    (err) => {
      console.error("[Listener Error]", err);
      showToast(`${icon("xCircle","margin-right:6px")} Koneksi terputus. Coba refresh.`, "error", 5000);
    }
  );
}

// ============================================================
// [6] CONFIRM READ — runTransaction (atomic, anti race-condition)
//
// ALASAN pakai runTransaction:
//  - Tanpa transaksi: dua device/tab yang submit bersamaan bisa
//    sama-sama baca streak=5, lalu sama-sama tulis streak=6
//    padahal seharusnya hanya terjadi sekali.
//  - runTransaction: Firestore akan retry otomatis jika ada
//    conflict. Hasil akhir selalu konsisten.
//
// STREAK RULES (deterministik):
//  - lastReadDate === today    → idempoten, tidak ubah streak
//  - lastReadDate === yesterday → streak + 1
//  - selain itu (null / gap)   → streak = 1 (reset)
// ============================================================
window.confirmRead = async function () {
  if (hasReadToday) return;

  const btn = document.getElementById("readBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="spinner"></div><span>Menyimpan...</span>`;
  }

  const today   = todayKey();
  const yester  = yesterdayKey();
  const userRef = doc(db, "users", currentUserId);

  try {
    let finalStreak = 0;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(userRef);

      if (!snap.exists()) {
        throw new Error("User doc tidak ditemukan. Silakan logout dan login ulang.");
      }

      const data = snap.data();
      const last = data.lastReadDate ?? null; // string "YYYY-MM-DD" atau null

      // ── Streak logic — deterministik, satu tempat ──
      let newStreak;
      if (last === today) {
        // Idempoten: sudah pernah submit hari ini (mungkin dari tab lain)
        newStreak = data.streak ?? 1;
      } else if (last === yester) {
        // Lanjut streak
        newStreak = (data.streak ?? 0) + 1;
      } else {
        // Gap atau pertama kali
        newStreak = 1;
      }

      finalStreak = newStreak;

      // ── Satu write ke users doc ──
      // lastReadTime menggunakan Timestamp.now() bukan serverTimestamp()
      // karena serverTimestamp() tidak bisa dibaca langsung dalam transaksi
      // (nilainya pending sampai transaksi commit).
      // Untuk display waktu baca, Timestamp.now() (client time) cukup akurat.
      tx.set(userRef, {
        lastReadDate: today,
        lastReadTime: Timestamp.now(), // ← Firestore Timestamp, bukan string / Date
        streak:       newStreak,
        active:       true,
      }, { merge: true });
    });

    // ── Audit log ke progress (fire-and-forget, tidak await) ──
    // Tidak await agar UI tidak tergantung keberhasilan progress write
    setDoc(doc(db, "progress", `${currentUserId}_${today}`), {
      userId:  currentUserId,
      nama:    currentName,
      tanggal: today,
      selesai: true,
      waktu:   serverTimestamp(), // progress boleh pakai serverTimestamp
    }).catch(e => console.warn("[Progress log error — non-critical]", e));

    hasReadToday = true;
    document.getElementById("streakCount").textContent = finalStreak;
    renderReadStatus(true, { lastReadTime: Timestamp.now(), streak: finalStreak });
    showToast(`${icon("leaf","margin-right:6px")} Barakallah! Catatan harian tersimpan.`, "success");

  } catch (e) {
    console.error("[confirmRead Error]", e);
    showToast(`${icon("xCircle","margin-right:6px")} Gagal menyimpan. Coba lagi.`, "error");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<div class="pulse-dot"></div><span>Saya Sudah Membaca Hari Ini</span>`;
    }
  }
};

// ─── Render: Read Status ─────────────────────────────────────
function renderReadStatus(done, userData = {}) {
  const area = document.getElementById("readStatusArea");
  if (!area) return;

  if (done) {
    const timeStr = formatTime(userData.lastReadTime);
    area.innerHTML = `
      <div class="done-status">
        <div class="done-icon-wrap pi-icon">${ICONS.checkLg}</div>
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


function renderReaders(readers) {
  const list = document.getElementById("readersList");
  if (!list) return;

  if (!readers.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span class="pi-icon" style="font-size:0">${ICONS.moon}</span>
        <p>Belum ada yang membaca hari ini.<br>Jadilah yang pertama!</p>
      </div>`;
    return;
  }

  list.innerHTML = readers.map((u, i) => `
    <div class="reader-item" style="animation-delay:${i * 0.05}s">
      <div class="reader-avatar">${initials(u.nama)}</div>
      <div class="reader-info">
        <div class="reader-name">
          ${escapeHtml(u.nama ?? "?")}
          ${u._id === currentUserId
            ? `<span style="color:var(--accent);font-size:0.7rem;"> (kamu)</span>`
            : ""}
        </div>
        <div class="reader-time">
          ${u.lastReadTime ? "Pukul " + formatTime(u.lastReadTime) : "Hari ini"}
        </div>
      </div>
      ${(u.streak ?? 0) > 1
        ? `<div class="reader-streak">${icon("fire","margin-right:2px")} ${u.streak}</div>`
        : ""}
      <div class="reader-check pi-icon">${ICONS.check}</div>
    </div>
  `).join("");
}

// ─── Render: Stats ───────────────────────────────────────────
function renderStats(total, done, pending) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  animateValue("statTotal",   total);
  animateValue("statDone",    done);
  animateValue("statPending", pending);
  document.getElementById("progressFill").style.width   = `${pct}%`;
  document.getElementById("progressPercent").textContent = `${pct}%`;
}

function animateValue(id, target) {
  const el  = document.getElementById(id);
  if (!el) return;
  const cur   = parseInt(el.textContent) || 0;
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

// ─── Logout ──────────────────────────────────────────────────
window.handleLogout = function () {
  if (!confirm("Yakin mau keluar?")) return;
  if (unsubUsers) { unsubUsers(); unsubUsers = null; }
  if (midnightTimer) { clearTimeout(midnightTimer); midnightTimer = null; }
  listenerStarted = false;
  // Hapus keduanya — userId akan di-resolve ulang dari nameIndex
  // saat login berikutnya, jadi tidak ada risiko kehilangan data.
  localStorage.removeItem("pi_userId");
  localStorage.removeItem("pi_name");
  sessionStorage.removeItem("pi_zikir_shown"); // reset agar login ulang muncul zikir lagi
  currentUserId = null;
  currentName   = null;
  hasReadToday  = false;
  document.getElementById("nameInput").value = "";
  showScreen("loginScreen");
  showToast(`${icon("leaf","margin-right:6px")} Sampai jumpa!`, "success");
};

// ─── Enter key ───────────────────────────────────────────────
document.getElementById("nameInput").addEventListener("keydown", e => {
  if (e.key === "Enter") handleLogin();
});

// ============================================================
// [7] AUTO-LOGIN
//
// Kedua key ada di localStorage → verifikasi userId dengan
// nameIndex menggunakan normalizeName(savedName) sebagai key
// (konsisten dengan resolveUserIdByName).
// Jika nameIndex punya userId berbeda → pakai nameIndex sebagai
// source of truth, update cache.
// Setelah ensureUser, jalankan migrateProgress untuk menyatukan
// histori lama yang mungkin menggunakan nama sebagai userId.
// ============================================================
(async function init() {
  const savedId   = localStorage.getItem("pi_userId");
  const savedName = localStorage.getItem("pi_name");

  if (savedId && savedName) {
    document.getElementById("nameInput").value = savedName;
    try {
      // Verifikasi: nameIndex mungkin punya userId berbeda
      // (misal user pernah login di browser lain dulu).
      // Gunakan normalizeName agar konsisten dengan resolveUserIdByName.
      const normalizedKey = normalizeName(savedName);
      const indexSnap     = await getDoc(doc(db, "nameIndex", normalizedKey));
      const verifiedId    = indexSnap.exists()
        ? indexSnap.data().userId   // pakai nameIndex sebagai truth
        : savedId;                  // nameIndex belum ada, pakai cache

      // Update cache jika berbeda
      if (verifiedId !== savedId) {
        localStorage.setItem("pi_userId", verifiedId);
      }

      currentUserId = verifiedId;
      currentName   = savedName;
      await ensureUser(verifiedId, savedName);

      await migrateProgress(savedName, verifiedId);
      await migrateProgress(normalizeName(savedName), verifiedId);

      // Auto-login (refresh/kembali buka) → langsung ke app, tanpa zikir
      enterApp();
    } catch (e) {
      console.error("[Auto-login failed]", e);
      showScreen("loginScreen");
    }
  } else {
    showScreen("loginScreen");
  }
})();
