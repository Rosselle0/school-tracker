(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SchoolSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_CLOUD_BYTES = 900000;
  const FILE_NAME = "school-tracker.json";
  const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

  function byteLength(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return String(text || "").length;
  }

  function pack(state) {
    const user = (state && state.user) || {};
    const doc = {
      sub: user.sub || "",
      updatedAt: state && state.updatedAt ? state.updatedAt : Date.now(),
      university: (state && state.university) || "",
      country: (state && state.country) || "",
      step: (state && state.step) || "",
      page: (state && state.page) || "board",
      groups: (state && state.groups) || [],
      courses: (state && state.courses) || {},
      pending: (state && state.pending) || [],
      found: (state && state.found) || [],
      wallpaper: (state && state.wallpaper) || "",
      summersAdded: !!(state && state.summersAdded),
      targetGroupId: (state && state.targetGroupId) || "",
    };
    const packed = JSON.parse(JSON.stringify(doc));
    if (byteLength(JSON.stringify(packed)) > MAX_CLOUD_BYTES) {
      packed.wallpaper = "";
      packed.wallpaperSkipped = true;
    }
    return packed;
  }

  function courseCount(doc) {
    if (!doc || !doc.courses || typeof doc.courses !== "object") return 0;
    return Object.keys(doc.courses).length;
  }

  function hasBoard(doc) {
    return !!(doc && doc.university);
  }

  function choose(local, remote) {
    const localBoard = hasBoard(local) ? local : null;
    const remoteBoard = hasBoard(remote) && remote.sub ? remote : null;
    if (localBoard && !remoteBoard) return { source: "local", doc: localBoard };
    if (remoteBoard && !localBoard) return { source: "remote", doc: remoteBoard };
    if (!localBoard && !remoteBoard) return null;
    const localLegacy = !localBoard.updatedAt;
    if (localLegacy && remoteBoard.updatedAt) {
      const localCourses = courseCount(localBoard);
      const remoteCourses = courseCount(remoteBoard);
      if (localCourses !== remoteCourses) {
        return localCourses > remoteCourses
          ? { source: "local", doc: localBoard }
          : { source: "remote", doc: remoteBoard };
      }
      const localSize = JSON.stringify(localBoard.courses || {}).length;
      const remoteSize = JSON.stringify(remoteBoard.courses || {}).length;
      if (localSize !== remoteSize) {
        return localSize > remoteSize
          ? { source: "local", doc: localBoard }
          : { source: "remote", doc: remoteBoard };
      }
      return { source: "remote", doc: remoteBoard };
    }
    if ((remoteBoard.updatedAt || 0) >= (localBoard.updatedAt || 0)) {
      return { source: "remote", doc: remoteBoard };
    }
    return { source: "local", doc: localBoard };
  }

  function applyDocument(doc, user, localWallpaper) {
    const university = (doc && doc.university) || "";
    const wallpaper = (doc && doc.wallpaper) || ((doc && doc.wallpaperSkipped) ? (localWallpaper || "") : "");
    let page = (doc && doc.page) || "board";
    if (!page || page === "login") page = "board";
    return {
      user: user,
      step: university ? "app" : "uni",
      page: page,
      university: university,
      country: (doc && doc.country) || "",
      groups: doc && Array.isArray(doc.groups) ? doc.groups : [],
      courses: doc && doc.courses && typeof doc.courses === "object" ? doc.courses : {},
      pending: doc && Array.isArray(doc.pending) ? doc.pending : [],
      found: doc && Array.isArray(doc.found) ? doc.found : [],
      wallpaper: wallpaper,
      summersAdded: !!(doc && doc.summersAdded),
      targetGroupId: (doc && doc.targetGroupId) || "",
      updatedAt: (doc && doc.updatedAt) || 0,
    };
  }

  function driveError(status, json) {
    const reason = json && json.error && json.error.errors && json.error.errors[0] && json.error.errors[0].reason;
    const raw = (json && json.error && json.error.message) || "";
    let message = "Couldn’t reach the saved board. Your latest changes are still on this device.";
    if (reason === "accessNotConfigured" || /has not been used|it is disabled|SERVICE_DISABLED/i.test(raw)) {
      message = "Google Drive needs to be turned on once in the LockedinSchool project.";
    } else if (status === 401) {
      message = "The Google sign-in expired. Connect the account again.";
    }
    const error = new Error(message);
    error.status = status;
    return error;
  }

  async function driveJson(fetchImpl, url, token, options) {
    const response = await fetchImpl(url, {
      method: (options && options.method) || "GET",
      headers: Object.assign({ Authorization: "Bearer " + token }, (options && options.headers) || {}),
      body: options && options.body,
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (error) { json = { raw: text }; }
    }
    if (!response.ok) throw driveError(response.status, json);
    return json;
  }

  async function findFileId(fetchImpl, token) {
    const query = encodeURIComponent("name = '" + FILE_NAME + "' and trashed = false");
    const json = await driveJson(fetchImpl, DRIVE_FILES + "?spaces=appDataFolder&fields=files(id,name)&q=" + query, token);
    const files = (json && json.files) || [];
    return files.length ? files[0].id : "";
  }

  function multipartBody(doc) {
    const boundary = "schooltracker";
    const meta = JSON.stringify({ name: FILE_NAME, parents: ["appDataFolder"] });
    const body = [
      "--" + boundary,
      "Content-Type: application/json; charset=UTF-8",
      "",
      meta,
      "--" + boundary,
      "Content-Type: application/json",
      "",
      JSON.stringify(doc),
      "--" + boundary + "--",
      "",
    ].join("\r\n");
    return { boundary: boundary, body: body };
  }

  async function loadDocument(fetchImpl, token) {
    const id = await findFileId(fetchImpl, token);
    if (!id) return null;
    const json = await driveJson(fetchImpl, DRIVE_FILES + "/" + encodeURIComponent(id) + "?alt=media", token);
    if (!json || typeof json !== "object") return null;
    return json;
  }

  async function saveDocument(fetchImpl, token, doc) {
    const id = await findFileId(fetchImpl, token);
    if (!id) {
      const built = multipartBody(doc);
      await driveJson(fetchImpl, DRIVE_UPLOAD + "?uploadType=multipart", token, {
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + built.boundary },
        body: built.body,
      });
      return;
    }
    await driveJson(fetchImpl, DRIVE_UPLOAD + "/" + encodeURIComponent(id) + "?uploadType=media", token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
  }

  async function deleteDocument(fetchImpl, token) {
    const id = await findFileId(fetchImpl, token);
    if (!id) return;
    await driveJson(fetchImpl, DRIVE_FILES + "/" + encodeURIComponent(id), token, { method: "DELETE" });
  }

  return {
    MAX_CLOUD_BYTES: MAX_CLOUD_BYTES,
    pack: pack,
    choose: choose,
    applyDocument: applyDocument,
    loadDocument: loadDocument,
    saveDocument: saveDocument,
    deleteDocument: deleteDocument,
  };
});

if (typeof module !== "undefined" && require.main === module) {
const createMemoryDrive = function () {
  const users = new Map();
  const files = new Map();
  let seq = 1;

  function tokenOf(headers) {
    const header = (headers && (headers.Authorization || headers.authorization)) || "";
    return header.replace(/^Bearer\s+/i, "");
  }

  function reply(status, json) {
    const text = json == null ? "" : JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(text); },
    };
  }

  function jsonChunks(body) {
    const found = [];
    String(body || "").split(/\r\n\r\n/).forEach((part) => {
      const start = part.indexOf("{");
      const end = part.lastIndexOf("}");
      if (start < 0 || end < start) return;
      try { found.push(JSON.parse(part.slice(start, end + 1))); } catch (error) { /* skip */ }
    });
    return found;
  }

  return {
    issue: function (sub) {
      const token = "token-" + sub;
      users.set(token, sub);
      return token;
    },
    idFor: function (sub) {
      const file = files.get(sub);
      return file ? file.id : "";
    },
    fetch: function (url, options) {
      options = options || {};
      const sub = users.get(tokenOf(options.headers));
      if (!sub) return Promise.resolve(reply(401, { error: { message: "unauthorized" } }));
      const parsed = new URL(url);
      const method = options.method || "GET";
      const fileMatch = parsed.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      const uploadMatch = parsed.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);

      if (parsed.pathname === "/drive/v3/files" && method === "GET") {
        const file = files.get(sub);
        return Promise.resolve(reply(200, { files: file ? [{ id: file.id, name: "school-tracker.json" }] : [] }));
      }
      if (fileMatch && method === "GET") {
        const file = files.get(sub);
        if (!file || file.id !== decodeURIComponent(fileMatch[1])) return Promise.resolve(reply(404, {}));
        return Promise.resolve(reply(200, JSON.parse(file.body)));
      }
      if (parsed.pathname === "/upload/drive/v3/files" && method === "POST") {
        const chunks = jsonChunks(options.body);
        const doc = chunks.filter((item) => item && item.sub).pop();
        if (!doc || doc.sub !== sub) return Promise.resolve(reply(403, { error: { message: "wrong owner" } }));
        const id = "file-" + seq++;
        files.set(sub, { id: id, body: JSON.stringify(doc) });
        return Promise.resolve(reply(200, { id: id }));
      }
      if (uploadMatch && method === "PATCH") {
        const file = files.get(sub);
        if (!file || file.id !== decodeURIComponent(uploadMatch[1])) return Promise.resolve(reply(404, {}));
        const doc = JSON.parse(options.body);
        if (!doc || doc.sub !== sub) return Promise.resolve(reply(403, { error: { message: "wrong owner" } }));
        file.body = JSON.stringify(doc);
        return Promise.resolve(reply(200, { id: file.id }));
      }
      if (fileMatch && method === "DELETE") {
        const file = files.get(sub);
        if (!file || file.id !== decodeURIComponent(fileMatch[1])) return Promise.resolve(reply(404, {}));
        files.delete(sub);
        return Promise.resolve(reply(204, null));
      }
      return Promise.resolve(reply(404, { error: { message: "no route" } }));
    },
  };
}

const runSyncTests = async function () {
  const sync = require("./sync.js");
  const drive = createMemoryDrive();
  const tokenA = drive.issue("user-a");
  const tokenB = drive.issue("user-b");
  const course = {
    code: "COEN 243",
    title: "Programming Methodology",
    credits: 3,
    status: "todo",
    notes: "lab 1",
    tasks: [],
    log: [],
  };
  const saved = sync.pack({
    user: { sub: "user-a", email: "a@example.com" },
    university: "Concordia University",
    country: "Canada",
    page: "board",
    step: "app",
    groups: [{ id: "g1", name: "Fall", courseIds: ["c1"] }],
    courses: { c1: course },
    wallpaper: "",
    updatedAt: 50,
  });
  await sync.saveDocument(drive.fetch, tokenA, saved);

  const fresh = await sync.loadDocument(drive.fetch, tokenA);
  if (!fresh || fresh.university !== "Concordia University") throw new Error("fresh load missed university");
  if (!fresh.courses || fresh.courses.c1.code !== "COEN 243" || fresh.courses.c1.notes !== "lab 1") {
    throw new Error("fresh load missed class");
  }
  saved.courses.c1.notes = "lab 2";
  saved.updatedAt = 60;
  await sync.saveDocument(drive.fetch, tokenA, saved);
  const updated = await sync.loadDocument(drive.fetch, tokenA);
  if (!updated || updated.courses.c1.notes !== "lab 2" || updated.university !== "Concordia University") {
    throw new Error("second save did not load back");
  }

  const other = await sync.loadDocument(drive.fetch, tokenB);
  if (other !== null) throw new Error("user B saw user A");

  const stolen = await drive.fetch(
    "https://www.googleapis.com/drive/v3/files/" + drive.idFor("user-a") + "?alt=media",
    { headers: { Authorization: "Bearer " + tokenB } }
  );
  if (stolen.status !== 404) throw new Error("user B read user A by id");

  await sync.saveDocument(drive.fetch, tokenB, sync.pack({
    user: { sub: "user-b" },
    university: "McGill University",
    courses: { m: { code: "COMP 202", title: "Foundations" } },
    groups: [],
    updatedAt: 20,
  }));
  const stillA = await sync.loadDocument(drive.fetch, tokenA);
  const stillB = await sync.loadDocument(drive.fetch, tokenB);
  if (stillA.university !== "Concordia University" || stillA.courses.c1.code !== "COEN 243") {
    throw new Error("user A changed after user B saved");
  }
  if (stillB.university !== "McGill University") throw new Error("user B board missing");

  const browser2 = sync.choose({ university: "", courses: {} }, stillA);
  if (!browser2 || browser2.source !== "remote" || browser2.doc.university !== "Concordia University") {
    throw new Error("empty browser did not take the cloud board");
  }
  if (browser2.doc.courses.c1.code !== "COEN 243") throw new Error("empty browser missed the class");

  await sync.deleteDocument(drive.fetch, tokenA);
  if (await sync.loadDocument(drive.fetch, tokenA) !== null) throw new Error("delete left the document");
  if ((await sync.loadDocument(drive.fetch, tokenB)).university !== "McGill University") {
    throw new Error("delete removed the other account");
  }

  const bulky = sync.pack({
    user: { sub: "user-a" },
    university: "York University",
    courses: { y: { code: "EECS 1011", title: "Computers" } },
    groups: [],
    wallpaper: "data:image/jpeg;base64," + "a".repeat(1000000),
    updatedAt: 9,
  });
  if (bulky.wallpaper !== "" || !bulky.wallpaperSkipped) throw new Error("big wallpaper was kept");
  if (bulky.courses.y.code !== "EECS 1011") throw new Error("wallpaper strip dropped the class");
  if (JSON.stringify(bulky).length > sync.MAX_CLOUD_BYTES) throw new Error("packed document still too big");

  const applied = sync.applyDocument(bulky, { sub: "user-a" }, "local-picture");
  if (applied.wallpaper !== "local-picture") throw new Error("local wallpaper was not kept");
  if (applied.step !== "app" || applied.university !== "York University") throw new Error("apply missed the board");

  console.log("sync tests ok");
}

  runSyncTests().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
