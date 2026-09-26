const KEY = "school-tracker-v2";
const SESSION = "school-tracker-session";
const state = load();
let openId = null;
let booting = false;
let needsConnect = false;
let cloudNote = "";
let cloudTimer = 0;
let cloudFlight = null;
let cloudAgain = false;
let wiping = false;
const TOKEN_KEY = "school-tracker-access";
const FIREBASE_KEY = "school-tracker-firebase";
const REFRESH_PREFIX = "school-tracker-refresh:";
const AUTH_SCOPE = "openid email profile";
let dragId = null;
let dragGroupId = null;

const BRANDS = [
  { name: "Carleton University", letters: "CU", color: "#c20430", font: "Syne" },
  { name: "Concordia University", letters: "Con", color: "#912338", font: "Libre Baskerville" },
  { name: "Dalhousie University", letters: "Dal", color: "#222", ink: "#ffd100", font: "Newsreader" },
  { name: "École de technologie supérieure", letters: "ÉTS", color: "#e2231a", font: "Syne" },
  { name: "McGill University", letters: "McG", color: "#ed1b2f", font: "Cormorant Garamond" },
  { name: "McMaster University", letters: "Mac", color: "#7a003c", font: "Newsreader" },
  { name: "Polytechnique Montréal", letters: "Poly", color: "#d52b1e", font: "Syne" },
  { name: "Queen's University", letters: "QU", color: "#00305e", font: "Libre Baskerville" },
  { name: "Simon Fraser University", letters: "SFU", color: "#cc0633", font: "Newsreader" },
  { name: "Toronto Metropolitan University", letters: "TMU", color: "#004c9b", font: "Syne" },
  { name: "Université de Montréal", letters: "UdeM", color: "#0072ce", font: "Newsreader" },
  { name: "Université du Québec à Montréal", letters: "UQAM", color: "#009fda", font: "Newsreader" },
  { name: "Université Laval", letters: "UL", color: "#e30513", font: "Cormorant Garamond" },
  { name: "University of Alberta", letters: "UA", color: "#007c41", font: "Playfair Display" },
  { name: "University of British Columbia", letters: "UBC", color: "#002145", font: "Playfair Display" },
  { name: "University of Ottawa", letters: "uOttawa", color: "#8b2332", font: "Libre Baskerville" },
  { name: "University of Toronto", letters: "UofT", color: "#002a5c", font: "Playfair Display" },
  { name: "University of Waterloo", letters: "UW", color: "#111", ink: "#f7c700", font: "Syne" },
  { name: "Western University", letters: "West", color: "#4f2683", font: "Cormorant Garamond" },
  { name: "York University", letters: "York", color: "#e31837", font: "Newsreader" },
].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

function blankTracker() {
  return {
    user: null,
    step: "login",
    page: "board",
    university: "",
    country: "",
    groups: [],
    courses: {},
    pending: [],
    found: [],
    wallpaper: "",
    summersAdded: false,
    updatedAt: 0,
  };
}
function accountKey(sub) {
  return KEY + ":" + sub;
}
function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function migrateLegacy() {
  const old = readStore(KEY);
  if (!old || !old.user || !old.user.sub) return;
  const key = accountKey(old.user.sub);
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(old));
  if (!localStorage.getItem(SESSION)) localStorage.setItem(SESSION, old.user.sub);
  localStorage.removeItem(KEY);
}
function loadAccount(sub) {
  return Object.assign(blankTracker(), readStore(accountKey(sub)) || {});
}
function load() {
  migrateLegacy();
  const sub = localStorage.getItem(SESSION);
  if (!sub) return blankTracker();
  const data = loadAccount(sub);
  if (!data.user || data.user.sub !== sub) return blankTracker();
  return data;
}
function save(options) {
  if (!state.user || !state.user.sub) {
    localStorage.removeItem(SESSION);
    return;
  }
  if (!options || !options.keepStamp) state.updatedAt = Date.now();
  localStorage.setItem(SESSION, state.user.sub);
  localStorage.setItem(accountKey(state.user.sub), JSON.stringify(state));
  if (!options || options.push !== false) scheduleCloud();
}
function settleLocal(local, user) {
  if (!local.university) replaceState(Object.assign(blankTracker(), { user: user, step: "uni" }));
  else replaceState(Object.assign(blankTracker(), local, { user: user, step: "app" }));
  save({ push: false, keepStamp: true });
}
async function adoptUser(user) {
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = 0;
  cloudAgain = false;
  if (cloudFlight) {
    try { await cloudFlight; } catch (error) { /* keep going with a cloud load */ }
  }
  const local = Object.assign(blankTracker(), loadAccount(user.sub), { user: user });
  openId = null;
  booting = true;
  needsConnect = false;
  cloudNote = "Opening your saved board…";
  replaceState(local);
  render();
  try {
    if (!firebaseConfigured()) {
      cloudNote = "Sync isn’t set up on this site yet. Your board is still on this device.";
      settleLocal(local, user);
      return;
    }
    const idToken = await ensureFirebaseToken(user.sub);
    if (!idToken) {
      needsConnect = true;
      cloudNote = "Sign in again to sync this board.";
      settleLocal(local, user);
      return;
    }
    await reconcile(user, local, idToken);
  } catch (error) {
    needsConnect = false;
    cloudNote = (error && error.message) || "Couldn’t open the saved board. This device is unchanged.";
    settleLocal(local, user);
  } finally {
    booting = false;
    render();
  }
}
function resetTracker(user, step) {
  const next = Object.assign(blankTracker(), { user, step });
  replaceState(next);
  openId = null;
  save();
}
function replaceState(next) {
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, blankTracker(), next);
}
function readAccess() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
    if (!parsed || !parsed.accessToken || !parsed.expiresAt) return null;
    if (parsed.expiresAt < Date.now() + 60000) return null;
    if (state.user && parsed.sub && parsed.sub !== state.user.sub) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}
function writeAccess(accessToken, expiresIn, sub) {
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: accessToken,
    expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
    sub: sub || (state.user && state.user.sub) || "",
  }));
}
function clearAccess() {
  sessionStorage.removeItem(TOKEN_KEY);
}
function refreshKey(sub) {
  return REFRESH_PREFIX + sub;
}
function clearCloudSession(sub) {
  clearAccess();
  sessionStorage.removeItem(FIREBASE_KEY);
  if (sub) localStorage.removeItem(refreshKey(sub));
}
function firebaseConfigured() {
  return !!(window.FIREBASE_API_KEY && window.FIREBASE_PROJECT_ID && window.SchoolSync);
}
function readFirebase(sub) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(FIREBASE_KEY) || "null");
    if (!parsed || parsed.sub !== sub || !parsed.idToken) return null;
    if (parsed.expiresAt < Date.now() + 60000) return null;
    return parsed.idToken;
  } catch (error) {
    return null;
  }
}
function storeFirebase(sub, idToken, expiresIn, refreshToken) {
  sessionStorage.setItem(FIREBASE_KEY, JSON.stringify({
    sub: sub,
    idToken: idToken,
    expiresAt: Date.now() + (Number(expiresIn) || 3600) * 1000,
  }));
  if (refreshToken) localStorage.setItem(refreshKey(sub), refreshToken);
}
async function exchangeGoogleAccess(accessToken, sub) {
  if (!firebaseConfigured() || !accessToken || !sub) return null;
  const response = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=" + encodeURIComponent(window.FIREBASE_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: "access_token=" + encodeURIComponent(accessToken) + "&providerId=google.com",
        requestUri: location.origin,
        returnSecureToken: true,
      }),
    }
  );
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || !json.idToken) return null;
  storeFirebase(sub, json.idToken, json.expiresIn, json.refreshToken);
  return json.idToken;
}
async function refreshFirebase(sub) {
  const refreshToken = localStorage.getItem(refreshKey(sub));
  if (!refreshToken || !firebaseConfigured()) return null;
  const response = await fetch(
    "https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(window.FIREBASE_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    }
  );
  const json = await response.json().catch(() => null);
  if (!response.ok || !json || !json.id_token) {
    localStorage.removeItem(refreshKey(sub));
    return null;
  }
  storeFirebase(sub, json.id_token, json.expires_in, json.refresh_token || refreshToken);
  return json.id_token;
}
async function ensureFirebaseToken(sub, options) {
  if (!firebaseConfigured() || !sub) return null;
  const cached = readFirebase(sub);
  if (cached) return cached;
  const refreshed = await refreshFirebase(sub);
  if (refreshed) return refreshed;
  const access = readAccess();
  if (access && access.accessToken && access.sub === sub) {
    const exchanged = await exchangeGoogleAccess(access.accessToken, sub);
    if (exchanged) return exchanged;
  }
  if (options && options.silent) {
    const got = await requestGoogleToken("");
    if (!got) return null;
    const profile = await profileFromToken(got.accessToken);
    if (!profile || profile.sub !== sub) return null;
    writeAccess(got.accessToken, got.expiresIn, profile.sub);
    return exchangeGoogleAccess(got.accessToken, sub);
  }
  return null;
}
function recompressDataUrl(dataUrl, max, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("image"));
    img.src = dataUrl;
  });
}
async function packForCloud(source) {
  const sync = window.SchoolSync;
  let current = source;
  if (source && source.wallpaper && sync.byteLength(source.wallpaper) > 700000) {
    try {
      current = Object.assign({}, source, { wallpaper: await recompressDataUrl(source.wallpaper, 1600, 0.7) });
    } catch (error) {
      current = source;
    }
  }
  let packed = sync.pack(current);
  if (packed.wallpaperSkipped && source && source.wallpaper) {
    try {
      const smaller = await recompressDataUrl(source.wallpaper, 1000, 0.55);
      packed = sync.pack(Object.assign({}, source, { wallpaper: smaller }));
    } catch (error) { /* the stripped pack still has the classes */ }
  }
  return packed;
}
async function reconcile(user, local, idToken) {
  const remote = await window.SchoolSync.loadDocument(fetch, idToken, user.sub);
  const decision = window.SchoolSync.merge(local, remote, user);
  replaceState(decision.state);
  if (!decision.upload) {
    save({ push: false, keepStamp: true });
    needsConnect = false;
    cloudNote = remote ? "Opened the saved board." : "";
    return;
  }
  const packed = await packForCloud(decision.state);
  const written = await window.SchoolSync.saveDocument(fetch, idToken, packed);
  if (written && written.updatedAt) state.updatedAt = written.updatedAt;
  save({ push: false, keepStamp: true });
  needsConnect = false;
  cloudNote = written && written.wallpaperSkipped && decision.state.wallpaper
    ? "Saved your classes. The picture was too big to sync."
    : "Saved to your Google account.";
}
function requestGoogleToken(prompt) {
  return new Promise((resolve) => {
    if (!window.google || !google.accounts || !google.accounts.oauth2 || !window.GOOGLE_CLIENT_ID) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const client = google.accounts.oauth2.initTokenClient({
      client_id: window.GOOGLE_CLIENT_ID,
      scope: AUTH_SCOPE,
      hint: (state.user && state.user.email) || "",
      callback: (resp) => {
        if (!resp || resp.error || !resp.access_token) finish(null);
        else finish({ accessToken: resp.access_token, expiresIn: resp.expires_in || 3600 });
      },
      error_callback: () => finish(null),
    });
    client.requestAccessToken({ prompt: prompt });
  });
}
async function profileFromToken(token) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!response.ok) return null;
  const profile = await response.json();
  if (!profile || !profile.sub) return null;
  return {
    sub: profile.sub,
    name: profile.name || "",
    email: profile.email || "",
    picture: profile.picture || "",
  };
}
function scheduleCloud() {
  if (booting || wiping || !state.user) return;
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => {
    cloudTimer = 0;
    pushCloudNow();
  }, 800);
}
async function pushCloudNow() {
  if (booting || wiping || !state.user || !state.user.sub) return;
  if (cloudFlight) {
    cloudAgain = true;
    return;
  }
  const sub = state.user.sub;
  const snapshot = JSON.parse(JSON.stringify(state));
  cloudNote = "Saving your board…";
  paintCloudNote();
  cloudFlight = (async () => {
    if (!firebaseConfigured()) {
      cloudNote = "Sync isn’t set up on this site yet. Your board is still on this device.";
      return;
    }
    const idToken = await ensureFirebaseToken(sub);
    if (!state.user || state.user.sub !== sub) return;
    if (!idToken) {
      needsConnect = true;
      cloudNote = "Sign in again to sync this board.";
      return;
    }
    const packed = await packForCloud(snapshot);
    const written = await window.SchoolSync.saveDocument(fetch, idToken, packed);
    if (!state.user || state.user.sub !== sub) return;
    needsConnect = false;
    cloudNote = written && written.wallpaperSkipped && snapshot.wallpaper
      ? "Saved your classes. The picture was too big to sync."
      : "Saved to your Google account.";
  })();
  try {
    await cloudFlight;
  } catch (error) {
    if (state.user && state.user.sub === sub) {
      cloudNote = (error && error.message) || "Couldn’t save to your account. Your latest changes are still on this device.";
    }
  } finally {
    cloudFlight = null;
    paintCloudNote();
    if (cloudAgain && !wiping && state.user && state.user.sub === sub && !booting) {
      cloudAgain = false;
      pushCloudNow();
    } else {
      cloudAgain = false;
    }
  }
}
function waitForGoogle() {
  return new Promise((resolve) => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      resolve(true);
      return;
    }
    let tries = 0;
    const wait = setInterval(() => {
      tries += 1;
      if (window.google && google.accounts && google.accounts.oauth2) {
        clearInterval(wait);
        resolve(true);
      } else if (tries > 50) {
        clearInterval(wait);
        resolve(false);
      }
    }, 100);
  });
}
async function trySilentSync() {
  if (!state.user || !state.user.sub) return;
  const local = JSON.parse(JSON.stringify(state));
  booting = true;
  cloudNote = "Opening your saved board…";
  render();
  try {
    if (!firebaseConfigured()) {
      cloudNote = "";
      return;
    }
    const idToken = await ensureFirebaseToken(state.user.sub, { silent: true });
    if (!idToken) {
      needsConnect = true;
      cloudNote = "Sign in again to sync this board.";
      return;
    }
    await reconcile(state.user, local, idToken);
  } catch (error) {
    cloudNote = (error && error.message) || "Couldn’t open the saved board. This device is unchanged.";
    replaceState(local);
    save({ push: false, keepStamp: true });
  } finally {
    booting = false;
    render();
  }
}
function renderSyncBanner() {
  const banner = el("div", "sync-banner");
  const text = el("span", "", cloudNote);
  text.id = "cloud-note";
  banner.append(text);
  if (!cloudNote && !needsConnect) banner.hidden = true;
  if (needsConnect) {
    const button = el("button", "primary", "Sync");
    button.type = "button";
    button.onclick = () => beginGoogleSignIn(text);
    banner.append(button);
    banner.hidden = false;
  }
  return banner;
}
function paintCloudNote() {
  const node = document.getElementById("cloud-note");
  if (!node) return;
  node.textContent = cloudNote;
  const banner = node.closest(".sync-banner");
  if (banner) banner.hidden = !cloudNote && !needsConnect;
}
async function deleteTrackerAccount() {
  if (!window.confirm("Delete your tracker account? Your university, classes, notes, and wallpaper are removed from this browser and from the saved copy. This does not delete your Google account.")) return;
  wiping = true;
  if (cloudTimer) clearTimeout(cloudTimer);
  cloudTimer = 0;
  cloudAgain = false;
  const sub = state.user && state.user.sub;
  const user = state.user;
  booting = true;
  cloudNote = "Deleting the saved board…";
  render();
  let failed = false;
  try {
    if (cloudFlight) {
      try { await cloudFlight; } catch (error) { /* delete replaces that save */ }
    }
    let idToken = sub ? await ensureFirebaseToken(sub, { silent: true }) : null;
    if (sub && !idToken) {
      const got = await requestGoogleToken("select_account");
      if (got) {
        const profile = await profileFromToken(got.accessToken);
        if (profile && profile.sub === sub) {
          writeAccess(got.accessToken, got.expiresIn, profile.sub);
          idToken = await exchangeGoogleAccess(got.accessToken, sub);
        }
      }
    }
    if (sub && firebaseConfigured() && !idToken) {
      failed = true;
      needsConnect = true;
      cloudNote = "Sign in again to delete the saved board.";
      replaceState(Object.assign(blankTracker(), loadAccount(sub), { user: user, step: user && loadAccount(sub).university ? "app" : "uni" }));
      return;
    }
    if (sub && idToken) await window.SchoolSync.deleteDocument(fetch, idToken, sub);
  } catch (error) {
    failed = true;
    needsConnect = false;
    cloudNote = "Couldn’t delete the saved board. Nothing was removed.";
    if (sub) replaceState(Object.assign(blankTracker(), loadAccount(sub), { user: user, step: "app" }));
    return;
  } finally {
    booting = false;
    if (failed) {
      wiping = false;
      render();
    }
  }
  if (sub) localStorage.removeItem(accountKey(sub));
  localStorage.removeItem(SESSION);
  clearCloudSession(sub);
  openId = null;
  needsConnect = false;
  cloudNote = "";
  wiping = false;
  replaceState(blankTracker());
  render();
}
function uniByName(name) {
  return BRANDS.find((uni) => uni.name === name) || null;
}
let schoolList = null;
function loadSchools() {
  if (schoolList) return Promise.resolve(schoolList);
  if (!loadSchools.pending) {
    loadSchools.pending = fetch("universities.json")
      .then((response) => response.json())
      .then((rows) => {
        schoolList = rows.map((row) => ({ name: row.name, country: row.country || "" }));
        return schoolList;
      });
  }
  return loadSchools.pending;
}
function initials(name) {
  const skip = /^(of|the|and|de|du|des|la|le|les|for|at|in|a)$/i;
  const words = String(name || "").split(/[^A-Za-zÀ-ÿ]+/).filter((word) => word && !skip.test(word));
  return words.slice(0, 3).map((word) => word[0].toUpperCase()).join("") || "•";
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function normalize(raw) {
  return String(raw || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}
function lookup(raw) {
  const key = normalize(raw);
  if (!key || !window.CONCORDIA) return null;
  const hit = window.CONCORDIA[key];
  if (!hit) return null;
  return { code: hit[0], title: hit[1], credits: hit[2] };
}
let catalogList = null;
function catalogCourses() {
  if (catalogList) return catalogList;
  catalogList = Object.values(window.CONCORDIA || {}).map(([code, title, credits]) => ({
    code,
    title,
    credits,
    key: normalize(code),
  }));
  catalogList.sort((a, b) => a.key.localeCompare(b.key));
  return catalogList;
}
function searchCatalog(raw) {
  const q = normalize(raw);
  if (!q) return [];
  const titleQuery = String(raw || "").trim().toLowerCase();
  const matches = [];
  for (const course of catalogCourses()) {
    if (course.key.startsWith(q) || (titleQuery.length > 2 && course.title.toLowerCase().includes(titleQuery))) {
      matches.push(course);
      if (matches.length >= 8) break;
    }
  }
  return matches;
}
function alreadyAdded(code) {
  const key = normalize(code);
  return Object.values(state.courses).some((item) => normalize(item.code) === key);
}
function insertCourse(course) {
  if (!course || !course.code || !course.title || alreadyAdded(course.code)) return false;
  if (!state.groups.length) state.groups = [{ id: uid(), name: "My classes", courseIds: [] }];
  const targeted = state.targetGroupId && state.groups.find((group) => group.id === state.targetGroupId);
  const group = targeted || state.groups[0];
  const id = uid();
  state.courses[id] = {
    code: course.code,
    title: course.title,
    credits: course.credits || 0,
    status: "todo",
    notes: "",
    tasks: [],
    log: [],
  };
  group.courseIds.push(id);
  return true;
}
function placeCourse(course) {
  if (!insertCourse(course)) return false;
  state.pending = [];
  state.step = "app";
  state.page = "board";
  save();
  render();
  return true;
}
function placeFoundCourses() {
  const found = state.found || [];
  if (!found.length) return false;
  found.forEach((course) => insertCourse(course));
  state.found = [];
  state.pending = [];
  state.step = "app";
  state.page = "board";
  save();
  return true;
}
function deleteCourse(id) {
  delete state.courses[id];
  state.groups.forEach((group) => {
    group.courseIds = group.courseIds.filter((courseId) => courseId !== id);
  });
  if (openId === id) openId = null;
  save();
  render();
}
function isConcordia(name) {
  return /concordia/i.test(name || "");
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";
  if (booting) {
    renderLoading(app);
    return;
  }
  if (!state.user) renderLogin(app);
  else if (!state.university || state.step === "uni") renderUni(app);
  else {
    if (state.step === "setup") state.page = "sequence";
    if (state.step === "codes") state.page = "codes";
    if (!state.page) state.page = "board";
    state.step = "app";
    placeFoundCourses();
    renderApp(app);
  }
  if (openId) renderDrawer();
  applyWallpaper();
}

function onThisComputer() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}
function googleButton(onClick) {
  const btn = el("button", "google");
  btn.type = "button";
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  mark.setAttribute("viewBox", "0 0 48 48");
  mark.setAttribute("class", "gmark");
  mark.innerHTML = '<path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.4 38.4 44 34 44 24c0-1.3-.1-2.7-.4-3.5z"/>';
  btn.append(mark, document.createTextNode("Continue with Google"));
  btn.onclick = onClick;
  return btn;
}
function beginGoogleSignIn(note) {
  note.textContent = "";
  requestGoogleToken("select_account").then(async (got) => {
    if (!got) {
      note.textContent = "Google didn’t finish sign-in. Try again.";
      return;
    }
    const profile = await profileFromToken(got.accessToken);
    if (!profile) {
      note.textContent = "Google didn’t return an account. Try again.";
      return;
    }
    writeAccess(got.accessToken, got.expiresIn, profile.sub);
    await adoptUser(profile);
  });
}
function renderLoading(app) {
  const scene = el("section", "scene");
  scene.append(el("p", "kicker", "Your classes, with the real names"));
  scene.append(el("h1", "", "School"));
  scene.append(el("p", "sub", cloudNote || "Opening your board…"));
  app.append(scene);
}
let googleWait = 0;
function renderLogin(app) {
  if (googleWait) clearInterval(googleWait);
  googleWait = 0;
  const scene = el("section", "scene");
  scene.append(el("p", "kicker", "Your classes, with the real names"));
  scene.append(el("h1", "", "School"));
  scene.append(el("p", "sub", "Sign in with Google. Your university, classes, and wallpaper sync to this account."));
  const note = el("p", "miss", cloudNote);
  if (onThisComputer()) {
    scene.append(googleButton(() => {
      location.href = "/oauth/start";
    }));
  } else {
    const slot = el("div", "google-slot");
    scene.append(slot);
    if (!window.GOOGLE_CLIENT_ID) {
      note.textContent = "Google sign-in isn’t configured on this site.";
    } else {
      const mount = () => {
        if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
        slot.replaceChildren(googleButton(() => beginGoogleSignIn(note)));
        return true;
      };
      if (!mount()) {
        let tries = 0;
        googleWait = setInterval(() => {
          tries += 1;
          if (mount() || tries > 50) {
            clearInterval(googleWait);
            googleWait = 0;
            if (tries > 50 && !slot.childElementCount) note.textContent = "Google sign-in didn’t load. Refresh and try again.";
          }
        }, 100);
      }
    }
  }
  scene.append(note);
  app.append(scene);
}

function renderUni(app) {
  const scene = el("section", "scene");
  const banner = renderSyncBanner();
  if (banner) scene.append(banner);
  scene.append(el("p", "kicker", "Hey " + (state.user.name || "").split(" ")[0]));
  scene.append(el("h2", "ask", "What university are you in?"));
  scene.append(el("p", "sub", "Type the school name, then pick it from the list."));
  let picked = state.university ? { name: state.university, country: state.country || "" } : null;
  const picker = uniPicker(state.university || "", (name, country) => {
    picked = name ? { name, country: country || "" } : null;
    next.disabled = !picked;
  });
  const next = el("button", "primary", "That’s the one");
  next.disabled = !picked;
  next.onclick = () => {
    if (!picked) return;
    state.university = picked.name;
    state.country = picked.country || "";
    state.step = "app";
    state.page = "sequence";
    if (!state.pending) state.pending = [];
    save();
    render();
  };
  scene.append(picker, el("div", "row"));
  scene.lastChild.append(next);
  app.append(scene);
}

function uniPicker(current, onPick) {
  const wrap = el("div", "uni-pick");
  const search = document.createElement("input");
  search.className = "uni-pick-btn";
  search.placeholder = "Choose your university";
  search.value = current || "";
  search.autocomplete = "off";
  const panel = el("div", "uni-panel");
  panel.hidden = true;
  const list = el("div", "uni-list");
  function choose(name, country) {
    search.value = name;
    panel.hidden = true;
    onPick(name, country || "");
  }
  function fill() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    if (!schoolList) {
      list.append(el("p", "miss", "Loading schools…"));
      return;
    }
    if (!query) {
      list.append(el("p", "miss", "Type a school name."));
      return;
    }
    const matches = [];
    for (const school of schoolList) {
      const name = school.name.toLowerCase();
      const country = school.country.toLowerCase();
      if (name.includes(query) || country.includes(query)) {
        matches.push(school);
        if (matches.length >= 16) break;
      }
    }
    if (!matches.length) {
      const typed = search.value.trim();
      const custom = el("button", "uni-option", "Use “" + typed + "”");
      custom.onclick = () => choose(typed, "");
      list.append(el("p", "miss", "No school on the list matches that."));
      list.append(custom);
      return;
    }
    matches.forEach((school) => {
      const item = el("button", "uni-option", "");
      const label = el("span", "");
      label.append(el("b", "", school.name), el("small", "", school.country));
      item.append(uniMark(school.name), label);
      item.onclick = () => choose(school.name, school.country);
      list.append(item);
    });
  }
  search.onfocus = () => {
    panel.hidden = false;
    loadSchools().then(fill).catch(() => {
      list.replaceChildren(el("p", "miss", "Couldn’t load the school list."));
    });
  };
  search.oninput = () => {
    onPick("", "");
    panel.hidden = false;
    loadSchools().then(fill).catch(() => {
      list.replaceChildren(el("p", "miss", "Couldn’t load the school list."));
    });
  };
  panel.append(list);
  wrap.append(search, panel);
  return wrap;
}

function uniMark(name) {
  const uni = uniByName(name);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "uni-mark");
  svg.setAttribute("aria-hidden", "true");
  const color = uni ? uni.color : "#1b1612";
  const ink = uni && uni.ink ? uni.ink : "#fff";
  const letters = uni ? uni.letters : initials(name);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "64");
  rect.setAttribute("height", "64");
  rect.setAttribute("rx", "16");
  rect.setAttribute("fill", color);
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("x", "32");
  text.setAttribute("y", "39");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("fill", ink);
  text.setAttribute("font-size", letters.length > 3 ? "13" : "18");
  text.setAttribute("font-family", "Georgia, serif");
  text.textContent = letters;
  svg.append(rect, text);
  return svg;
}

function renderCodes(app) {
  const scene = el("section", "scene");
  scene.append(el("p", "kicker", state.university));
  scene.append(el("h2", "ask", "What’s the class code?"));
  scene.append(el("p", "sub", "Add a class and it goes on your board."));
  const input = el("input", "field");
  input.placeholder = "Class code";
  input.autocomplete = "off";
  const hit = el("div", "hit");
  const titleInput = el("input", "field");
  titleInput.placeholder = "Title, if it isn’t in the catalog";
  titleInput.hidden = true;
  function choose(course) {
    if (alreadyAdded(course.code)) {
      input.value = "";
      titleInput.hidden = true;
      hit.innerHTML = "";
      hit.append(el("span", "miss", course.code + " is already on your board."));
      return;
    }
    placeCourse(course);
  }
  function refresh() {
    hit.innerHTML = "";
    const typed = normalize(input.value);
    if (!typed) {
      titleInput.hidden = true;
      return;
    }
    if (!isConcordia(state.university)) {
      titleInput.hidden = false;
      hit.append(el("span", "miss", "No catalog for that school yet. Type the title yourself."));
      return;
    }
    const matches = searchCatalog(input.value);
    titleInput.hidden = true;
    if (!matches.length) {
      if (typed.length >= 6) {
        titleInput.hidden = false;
        hit.append(el("span", "miss", "No Concordia class starts with that. Type the title if you still want it."));
      }
      return;
    }
    const box = el("div", "suggest");
    matches.forEach((course) => {
      const taken = alreadyAdded(course.code);
      const button = el("button", "suggest-item" + (taken ? " taken" : ""));
      button.append(el("b", "", course.code));
      button.append(el("span", "", taken ? "Already added" : course.title));
      if (!taken) button.onclick = () => choose(course);
      box.append(button);
    });
    hit.append(box);
  }
  input.oninput = refresh;
  const add = el("button", "primary", "Add class");
  add.onclick = () => {
    const found = isConcordia(state.university) ? lookup(input.value) : null;
    const code = found ? found.code : input.value.trim().toUpperCase();
    const title = found ? found.title : titleInput.value.trim();
    if (!code || !title) return;
    if (alreadyAdded(code)) {
      input.value = "";
      titleInput.value = "";
      hit.innerHTML = "";
      hit.append(el("span", "miss", code + " is already on your board."));
      return;
    }
    placeCourse({ code, title, credits: found ? found.credits : 0 });
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") add.click();
  });
  const actions = el("div", "row");
  actions.append(add);
  scene.append(input, hit, titleInput, actions);
  app.append(scene);
  setTimeout(() => input.focus(), 350);
}

function codesInText(text) {
  const found = [];
  if (!isConcordia(state.university)) return found;
  const re = /\b([A-Z]{3,4})\s*[- ]?\s*(\d{3}[A-Z]?)\b/g;
  let match;
  const upper = String(text || "").toUpperCase();
  while ((match = re.exec(upper))) {
    const course = lookup(match[1] + match[2]);
    if (course && !found.some((item) => normalize(item.code) === normalize(course.code))) found.push(course);
  }
  return found;
}
async function readUpload(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const data = new Uint8Array(await file.arrayBuffer());
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str).join(" ") + "\n";
    }
    return text;
  }
  const result = await window.Tesseract.recognize(file, "eng");
  return result.data.text || "";
}
function renderSetup(app) {
  const scene = el("section", "scene");
  scene.append(el("p", "kicker", state.university));
  scene.append(el("h2", "ask", "Drop the classes you need."));
  scene.append(el("p", "sub", "A picture or a PDF of the classes you need. Anything found goes straight onto your board."));
  const drop = el("label", "drop");
  drop.append(el("span", "", "Click here to choose a picture or file"));
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*,.pdf,application/pdf";
  file.hidden = true;
  const status = el("p", "hint", "");
  drop.append(file);
  file.onchange = async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    status.textContent = "Reading " + chosen.name + "…";
    try {
      const text = await readUpload(chosen);
      state.found = codesInText(text);
      if (!state.found.length) {
        status.textContent = "No class codes found. Add them manually.";
        save();
        return;
      }
      render();
    } catch (error) {
      status.textContent = "Couldn’t read that file. Add the classes manually.";
    }
  };
  const manual = el("button", "primary", "Add a class");
  manual.onclick = () => {
    state.step = "codes";
    state.pending = state.pending || [];
    save();
    render();
  };
  const row = el("div", "row");
  row.append(manual);
  scene.append(drop, status, row);
  app.append(scene);
}

function go(page) {
  state.page = page;
  state.step = "app";
  openId = null;
  save();
  render();
}

function renderApp(app) {
  const shell = el("div", "shell");
  const bar = el("header", "app-bar");
  const menu = el("button", "menu-toggle", "Menu");
  menu.type = "button";
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-controls", "side-menu");
  bar.append(menu, el("p", "app-bar-title", state.university || "School"));
  const backdrop = el("button", "nav-backdrop");
  backdrop.type = "button";
  backdrop.setAttribute("aria-label", "Close menu");
  const nav = renderNav();
  nav.id = "side-menu";
  function setOpen(open) {
    nav.classList.toggle("open", open);
    backdrop.classList.toggle("on", open);
    menu.setAttribute("aria-expanded", open ? "true" : "false");
  }
  menu.onclick = () => setOpen(!nav.classList.contains("open"));
  backdrop.onclick = () => setOpen(false);
  const main = el("main", "main");
  const page = state.page || "board";
  if (page === "guide") renderGuide(main);
  else if (page === "left") renderLeft(main);
  else if (page === "sequence") renderSetup(main);
  else if (page === "codes") renderCodes(main);
  else if (page === "settings") renderSettings(main);
  else renderBoard(main);
  shell.append(bar, backdrop, nav);
  const banner = renderSyncBanner();
  if (banner) shell.append(banner);
  shell.append(main);
  app.append(shell);
}

function renderNav() {
  const nav = el("aside", "nav");
  const uni = uniByName(state.university);
  const brand = el("div", "brand");
  brand.append(uniMark(state.university));
  const names = el("div");
  names.append(el("p", "kicker", "Your school"));
  const title = el("h1", "uni-title", state.university);
  title.style.fontFamily = (uni ? uni.font : "Fraunces") + ", Georgia, serif";
  names.append(title);
  brand.append(names);
  nav.append(brand);
  [
    ["board", "Board"],
    ["guide", "Study guide"],
    ["left", "What’s left"],
    ["sequence", "Sequence/drop"],
    ["codes", "Add a class"],
    ["settings", "Settings"],
  ].forEach(([id, label]) => {
    const button = el("button", "nav-item" + (state.page === id ? " on" : ""), label);
    button.onclick = () => go(id);
    nav.append(button);
  });
  const foot = el("div", "nav-foot");
  if (state.user.picture) {
    const img = document.createElement("img");
    img.src = state.user.picture;
    img.alt = "";
    foot.append(img);
  }
  foot.append(el("span", "", state.user.name || state.user.email));
  const out = el("button", "ghost", "Sign out");
  out.onclick = () => {
    const sub = state.user && state.user.sub;
    state.user = null;
    state.step = "login";
    state.university = "";
    openId = null;
    needsConnect = false;
    cloudNote = "";
    clearCloudSession(sub);
    localStorage.removeItem(SESSION);
    render();
  };
  foot.append(out);
  nav.append(foot);
  return nav;
}

let pomoMode = "focus";
let pomoLeft = 25 * 60;
let pomoRunning = false;
let pomoTick = 0;
function formatPomo(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
}
function paintPomo() {
  const time = document.getElementById("pomo-time");
  const mode = document.getElementById("pomo-mode");
  if (time) time.textContent = formatPomo(pomoLeft);
  if (mode) mode.textContent = pomoMode === "focus" ? "Focus" : "Break";
}
function startPomo() {
  if (pomoRunning) return;
  pomoRunning = true;
  pomoTick = setInterval(() => {
    pomoLeft -= 1;
    if (pomoLeft <= 0) {
      pomoMode = pomoMode === "focus" ? "break" : "focus";
      pomoLeft = pomoMode === "focus" ? 25 * 60 : 5 * 60;
    }
    paintPomo();
  }, 1000);
}
function stopPomo() {
  pomoRunning = false;
  if (pomoTick) clearInterval(pomoTick);
  pomoTick = 0;
}
function studySearchLinks(course) {
  const query = course.code + " " + course.title;
  return {
    studocu: "https://www.studocu.com/en/search?q=" + encodeURIComponent(query),
    youtube: "https://www.youtube.com/results?search_query=" + encodeURIComponent(query + " lecture"),
  };
}
function fillGuidePanel(panel, course) {
  panel.append(el("h3", "", course.code));
  panel.append(el("p", "", course.title));
  const openTasks = (course.tasks || []).filter((task) => !task.done && task.text.trim());
  if (openTasks.length) panel.append(el("p", "miss", openTasks.map((task) => task.text).join(" · ")));
  if (course.notes) panel.append(el("p", "", course.notes));
  panel.append(el("h3", "term-label", "Pomodoro"));
  const mode = el("p", "miss", pomoMode === "focus" ? "Focus" : "Break");
  mode.id = "pomo-mode";
  const time = el("p", "pomo-time", formatPomo(pomoLeft));
  time.id = "pomo-time";
  const toggle = el("button", "primary", pomoRunning ? "Stop" : "Start");
  toggle.type = "button";
  toggle.onclick = () => {
    if (pomoRunning) stopPomo();
    else startPomo();
    toggle.textContent = pomoRunning ? "Stop" : "Start";
  };
  const help = document.createElement("details");
  help.className = "pomo-help";
  const summary = document.createElement("summary");
  summary.textContent = "What this helps";
  help.append(summary, el("p", "", "Focus in short blocks, then take a real break. Twenty-five minutes on the class, five minutes away."));
  panel.append(mode, time, toggle, help);
  panel.append(el("h3", "term-label", "Look it up"));
  const links = studySearchLinks(course);
  const row = el("div", "row");
  const studocu = el("a", "primary link-btn", "Studocu");
  studocu.href = links.studocu;
  studocu.target = "_blank";
  studocu.rel = "noopener noreferrer";
  const youtube = el("a", "ghost link-btn", "YouTube lectures");
  youtube.href = links.youtube;
  youtube.target = "_blank";
  youtube.rel = "noopener noreferrer";
  row.append(studocu, youtube);
  const open = el("button", "ghost", "Open class");
  open.type = "button";
  open.onclick = () => {
    openId = course.id;
    render();
  };
  panel.append(row, open);
}
function renderGuide(main) {
  const scene = el("section", "scene");
  scene.append(el("h2", "ask", "Study guide"));
  scene.append(el("p", "sub", "Pick a class. A timer and a couple of places to look sit inside."));
  const courses = coursesInOrder();
  const select = document.createElement("select");
  select.className = "guide-pick";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = courses.length ? "Choose a class" : "Add a class first";
  select.append(placeholder);
  select.disabled = !courses.length;
  courses.forEach((course) => {
    const option = document.createElement("option");
    option.value = course.id;
    option.textContent = course.code + " — " + course.title;
    select.append(option);
  });
  const panel = el("div", "guide-panel");
  panel.hidden = true;
  select.onchange = () => {
    const course = courses.find((item) => item.id === select.value);
    panel.hidden = !course;
    panel.replaceChildren();
    if (course) fillGuidePanel(panel, course);
  };
  scene.append(select, panel);
  main.append(scene);
}

function renderLeft(main) {
  const scene = el("section", "scene");
  const all = coursesInOrder();
  const done = all.filter((course) => course.status === "done").length;
  scene.append(el("h2", "ask", "What’s left"));
  scene.append(el("p", "sub", done + " done · " + (all.length - done) + " still open."));
  state.groups.forEach((group) => {
    const pending = group.courseIds.map((id) => state.courses[id]).filter((course) => course && course.status !== "done");
    if (!pending.length) return;
    scene.append(el("h3", "term-label", group.name));
    pending.forEach((course) => scene.append(el("p", "", course.code + " — " + course.title)));
  });
  main.append(scene);
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    img.src = url;
  });
}
function applyWallpaper() {
  let layer = document.getElementById("wallpaper");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "wallpaper";
    layer.setAttribute("aria-hidden", "true");
    document.body.prepend(layer);
  }
  if (state.user && state.wallpaper) {
    layer.hidden = false;
    layer.style.backgroundImage = "url(" + JSON.stringify(state.wallpaper) + ")";
  } else {
    layer.hidden = true;
    layer.style.backgroundImage = "";
  }
}
let wallpaperNote = "";
function renderSettings(main) {
  const scene = el("section", "scene");
  scene.append(el("h2", "ask", "Settings"));
  scene.append(el("p", "sub", "Signed in as " + (state.user.email || state.user.name || "this Google account") + ". This account keeps the same board on your phone and computer."));
  scene.append(el("h3", "term-label", "Wallpaper"));
  scene.append(el("p", "miss", "A picture from this phone or computer, behind the pages on every device signed in to this account."));
  const pick = el("label", "drop");
  pick.append(el("span", "", state.wallpaper ? "Change picture" : "Choose a picture"));
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/*";
  file.hidden = true;
  pick.append(file);
  const note = el("p", "miss", wallpaperNote);
  wallpaperNote = "";
  file.onchange = async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    const previous = state.wallpaper || "";
    try {
      state.wallpaper = await shrinkImage(chosen);
      save();
      render();
    } catch (error) {
      state.wallpaper = previous;
      wallpaperNote = "Couldn’t keep that picture. Try a smaller one.";
      render();
    }
  };
  scene.append(pick, note);
  if (state.wallpaper) {
    const clear = el("button", "ghost", "Use the plain background");
    clear.type = "button";
    clear.onclick = () => {
      state.wallpaper = "";
      save();
      render();
    };
    scene.append(clear);
  }
  scene.append(el("h3", "term-label", "Have you changed school?"));
  scene.append(el("p", "miss", "Pick the new school. Your classes and terms for this account are cleared, then you start that school’s setup."));
  let picked = "";
  let pickedCountry = "";
  const picker = uniPicker("", (name, country) => {
    picked = name;
    pickedCountry = country || "";
    switchBtn.disabled = !picked || picked === state.university;
  });
  const switchBtn = el("button", "primary", "Switch school");
  switchBtn.disabled = true;
  switchBtn.onclick = () => {
    if (!picked || picked === state.university) return;
    if (!window.confirm("Switch to " + picked + "? This clears your classes and terms for this account.")) return;
    const user = state.user;
    const wallpaper = state.wallpaper || "";
    resetTracker(user, "uni");
    state.university = picked;
    state.country = pickedCountry;
    state.wallpaper = wallpaper;
    save();
    render();
  };
  scene.append(picker);
  const row = el("div", "row");
  row.append(switchBtn);
  scene.append(row);
  scene.append(el("h3", "term-label", "Delete tracker account"));
  scene.append(el("p", "miss", "This removes your university, classes, notes, and wallpaper from this browser and from the saved copy for this Google account. It does not delete the Google account."));
  const wipe = el("button", "danger", "Delete tracker account");
  wipe.type = "button";
  wipe.onclick = () => { deleteTrackerAccount(); };
  scene.append(wipe);
  main.append(scene);
}

function coursesInOrder() {
  const list = [];
  state.groups.forEach((group) => {
    group.courseIds.forEach((id) => {
      const course = state.courses[id];
      if (course) list.push(Object.assign({ id }, course));
    });
  });
  return list;
}

function renderBoard(app) {
  const bar = el("header", "topbar");
  bar.append(el("h2", "page-title", "Board"));
  const hint = el("p", "hint board-hint", "Drag a term by the grip to reorder it. Summers sit with the other terms.");
  app.append(bar, hint);
  const board = el("div", "board");
  state.groups.forEach((group) => board.append(groupColumn(group)));
  board.append(addTermColumn());
  const fromFile = el("button", "ghost", "From a picture or file");
  fromFile.onclick = () => go("sequence");
  const addClass = el("button", "primary", "Add a code");
  addClass.onclick = () => {
    state.pending = [];
    go("codes");
  };
  const tools = el("div", "group board-tools");
  tools.append(fromFile, addClass);
  board.append(tools);
  app.append(board);
}

function addTermColumn() {
  const col = el("section", "group add-term");
  const open = el("button", "add-term-open", "+ Add a term");
  open.onclick = () => {
    col.replaceChildren();
    const form = el("form", "add-term-form");
    const input = document.createElement("input");
    input.placeholder = "Term name";
    input.value = "New term";
    const row = el("div", "row");
    const saveBtn = el("button", "primary", "Add term");
    saveBtn.type = "submit";
    const cancel = el("button", "ghost", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => render();
    row.append(saveBtn, cancel);
    form.append(input, row);
    form.onsubmit = (event) => {
      event.preventDefault();
      const name = input.value.trim() || "New term";
      state.groups.push({ id: uid(), name, courseIds: [] });
      save();
      render();
    };
    col.append(form);
    input.focus();
    input.select();
  };
  col.append(open);
  col.ondragover = (event) => {
    if (!dragGroupId) return;
    event.preventDefault();
    col.classList.add("over");
  };
  col.ondragleave = () => col.classList.remove("over");
  col.ondrop = (event) => {
    if (!dragGroupId) return;
    event.preventDefault();
    const from = state.groups.findIndex((item) => item.id === dragGroupId);
    if (from >= 0) {
      const [item] = state.groups.splice(from, 1);
      state.groups.push(item);
    }
    dragGroupId = null;
    save();
    render();
  };
  return col;
}

function groupColumn(group) {
  const col = el("section", "group");
  col.dataset.group = group.id;
  const head = el("div", "group-head");
  const grip = el("span", "grip", "⋮⋮");
  grip.draggable = true;
  grip.title = "Drag to move this term";
  grip.ondragstart = (event) => {
    dragGroupId = group.id;
    dragId = null;
    event.dataTransfer.setData("text/plain", group.id);
    event.dataTransfer.effectAllowed = "move";
  };
  const name = document.createElement("input");
  name.value = group.name;
  name.oninput = () => {
    group.name = name.value;
    save();
  };
  const remove = el("button", "mini", "×");
  remove.title = "Remove this term";
  remove.onclick = () => {
    const loose = group.courseIds.slice();
    const index = state.groups.findIndex((item) => item.id === group.id);
    state.groups = state.groups.filter((item) => item.id !== group.id);
    if (loose.length) {
      const home = state.groups[index] || state.groups[index - 1];
      if (home) home.courseIds.push(...loose);
      else state.groups.push({ id: uid(), name: "My classes", courseIds: loose });
    }
    save();
    render();
  };
  head.append(grip, name, remove);
  col.append(head);
  group.courseIds.forEach((id) => {
    if (state.courses[id]) col.append(courseCard(id));
  });
  col.ondragover = (event) => {
    event.preventDefault();
    col.classList.add("over");
  };
  col.ondragleave = () => col.classList.remove("over");
  col.ondrop = (event) => {
    event.preventDefault();
    col.classList.remove("over");
    if (dragGroupId) {
      if (dragGroupId !== group.id) {
        const from = state.groups.findIndex((item) => item.id === dragGroupId);
        const to = state.groups.findIndex((item) => item.id === group.id);
        if (from >= 0 && to >= 0) {
          const [item] = state.groups.splice(from, 1);
          state.groups.splice(to, 0, item);
        }
      }
      dragGroupId = null;
      save();
      render();
      return;
    }
    if (!dragId) return;
    state.groups.forEach((g) => {
      g.courseIds = g.courseIds.filter((id) => id !== dragId);
    });
    group.courseIds.push(dragId);
    dragId = null;
    save();
    render();
  };
  return col;
}

function courseCard(id) {
  const course = state.courses[id];
  const card = el("article", "card" + (course.status === "done" ? " done" : ""));
  card.draggable = true;
  card.ondragstart = (event) => {
    dragId = id;
    dragGroupId = null;
    event.stopPropagation();
  };
  const top = el("div", "card-top");
  top.append(el("h3", "code", course.code));
  const remove = el("button", "mini card-x", "×");
  remove.type = "button";
  remove.draggable = false;
  remove.title = "Delete this class";
  remove.onpointerdown = (event) => event.stopPropagation();
  remove.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteCourse(id);
  };
  top.append(remove);
  card.append(top);
  card.append(el("p", "name", course.title));
  card.append(statusButtons(id));
  card.onclick = (event) => {
    if (event.target.closest("button")) return;
    openId = id;
    render();
  };
  return card;
}

function statusButtons(id) {
  const course = state.courses[id];
  const wrap = el("div", "status");
  [["todo", "Not started"], ["doing", "Doing"], ["done", "Done"]].forEach(([value, label]) => {
    const btn = el("button", value + (course.status === value ? " on" : ""), label);
    btn.onclick = (event) => {
      event.stopPropagation();
      course.status = value;
      save();
      render();
    };
    wrap.append(btn);
  });
  return wrap;
}

function renderDrawer() {
  const course = state.courses[openId];
  if (!course) return;
  const layer = el("div");
  layer.id = "drawer";
  const panel = el("aside", "drawer");
  const close = el("button", "ghost", "Close");
  close.onclick = () => {
    openId = null;
    render();
  };
  panel.append(close, el("h3", "", course.code), el("p", "", course.title), statusButtons(openId));
  panel.append(el("label", "", "What’s left"));
  course.tasks.forEach((task, index) => {
    const row = el("div", "task");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = task.done;
    check.onchange = () => {
      course.tasks[index].done = check.checked;
      save();
    };
    const text = document.createElement("input");
    text.type = "text";
    text.value = task.text;
    text.oninput = () => {
      course.tasks[index].text = text.value;
      save();
    };
    const del = el("button", "mini", "Remove");
    del.onclick = () => {
      course.tasks.splice(index, 1);
      save();
      render();
    };
    row.append(check, text, del);
    panel.append(row);
  });
  const add = el("button", "ghost", "Add something left");
  add.onclick = () => {
    course.tasks.push({ text: "", done: false });
    save();
    render();
  };
  panel.append(add);
  panel.append(el("label", "", "Notes"));
  const notes = document.createElement("textarea");
  notes.value = course.notes;
  notes.placeholder = "Labs, deadlines, whatever you don’t want to forget.";
  notes.oninput = () => {
    course.notes = notes.value;
    save();
  };
  panel.append(notes);
  panel.append(el("label", "", "Coach"));
  course.log.forEach((entry) => {
    const bubble = el("div", "bubble" + (entry.from === "coach" ? " coach" : ""));
    bubble.append(el("small", "", entry.from === "coach" ? "Coach" : "You"));
    bubble.append(el("div", "", entry.text));
    panel.append(bubble);
  });
  const reply = document.createElement("textarea");
  reply.placeholder = "Write what’s stuck.";
  const coach = el("button", "primary", "Coach me");
  coach.onclick = () => {
    course.log.push({ from: "coach", text: coachMessage(course) });
    save();
    render();
  };
  const saveNote = el("button", "ghost", "Save what I wrote");
  saveNote.onclick = () => {
    const text = reply.value.trim();
    if (!text) return;
    course.log.push({ from: "me", text });
    course.log.push({ from: "coach", text: "Saved on " + course.code + ". Next open item: " + (course.tasks.find((t) => !t.done && t.text.trim())?.text || "add the next deadline.") });
    reply.value = "";
    save();
    render();
  };
  const actions = el("div", "row");
  actions.append(saveNote, coach);
  panel.append(reply, actions);
  layer.append(panel);
  layer.onclick = (event) => {
    if (event.target === layer) {
      openId = null;
      render();
    }
  };
  document.getElementById("app").append(layer);
}

function coachMessage(course) {
  const open = course.tasks.filter((t) => !t.done && t.text.trim());
  if (course.status === "done") return course.code + " is marked done. Add anything still hanging so it doesn’t disappear.";
  if (course.status === "todo") return "You haven’t started " + course.code + " — " + course.title + ". Put the first deadline in what’s left, then flip it to Doing.";
  if (open.length) return "Still open in " + course.code + ": " + open.map((t) => t.text).join(", ") + ".";
  return "You’re in " + course.code + " and the leftover list is empty. Add the labs or the final.";
}

let bootPromise = null;
if (location.hash.startsWith("#signed-in=")) {
  try {
    const signedInUser = JSON.parse(decodeURIComponent(location.hash.slice("#signed-in=".length)));
    history.replaceState(null, "", location.pathname + location.search);
    bootPromise = adoptUser(signedInUser);
  } catch (error) {
    console.error(error);
  }
}
if (!bootPromise) {
  if (state.user) trySilentSync();
  else render();
}
