(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SchoolSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const MAX_CLOUD_BYTES = 900000;

  function projectId() {
    if (typeof window !== "undefined" && window.FIREBASE_PROJECT_ID) return window.FIREBASE_PROJECT_ID;
    return "lockedinschool";
  }

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

  function hasData(doc) {
    if (!doc || typeof doc !== "object") return false;
    if (doc.university) return true;
    if (doc.wallpaper) return true;
    if (Array.isArray(doc.groups) && doc.groups.length) return true;
    if (Array.isArray(doc.pending) && doc.pending.length) return true;
    if (Array.isArray(doc.found) && doc.found.length) return true;
    if (doc.courses && typeof doc.courses === "object" && Object.keys(doc.courses).length) return true;
    return false;
  }

  function choose(local, remote) {
    const localBoard = hasData(local) ? local : null;
    const remoteBoard = hasData(remote) && remote.sub ? remote : null;
    if (localBoard && !remoteBoard) return { source: "local", doc: localBoard };
    if (remoteBoard && !localBoard) return { source: "remote", doc: remoteBoard };
    if (!localBoard && !remoteBoard) return null;
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
    const next = {
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
    return JSON.parse(JSON.stringify(next));
  }

  function merge(local, remote, user) {
    const signedIn = user || (local && local.user) || null;
    const localDoc = pack(Object.assign({}, local, { user: signedIn }));
    let cloud = remote;
    if (cloud && signedIn && cloud.sub && signedIn.sub && cloud.sub !== signedIn.sub) cloud = null;
    const choice = choose(localDoc, cloud);
    if (!choice) {
      return {
        source: "none",
        upload: false,
        state: applyDocument(null, signedIn, (local && local.wallpaper) || ""),
      };
    }
    if (choice.source === "remote") {
      return {
        source: "remote",
        upload: false,
        state: applyDocument(choice.doc, signedIn, (local && local.wallpaper) || ""),
      };
    }
    const state = JSON.parse(JSON.stringify(Object.assign({}, local, { user: signedIn })));
    if (!state.updatedAt) state.updatedAt = localDoc.updatedAt || Date.now();
    return { source: "local", upload: true, state: state };
  }

  function userDocUrl(sub) {
    return "https://firestore.googleapis.com/v1/projects/" + projectId()
      + "/databases/(default)/documents/users/" + encodeURIComponent(sub);
  }

  function firestoreError(status, json) {
    const raw = (json && json.error && json.error.message) || "";
    let message = "Couldn’t reach the saved board. Your latest changes are still on this device.";
    if (status === 401) message = "The Google sign-in expired. Connect the account again.";
    else if (/SERVICE_DISABLED|has not been used|it is disabled/i.test(raw)) {
      message = "The saved board isn’t turned on yet. Your latest changes are still on this device.";
    }
    const error = new Error(message);
    error.status = status;
    error.tooBig = status === 400 && /too large|exceeds|invalid/i.test(raw);
    return error;
  }

  async function readJson(response) {
    const text = typeof response.text === "function" ? await response.text() : "";
    if (!text) return null;
    try { return JSON.parse(text); } catch (error) { return { raw: text }; }
  }

  async function firestoreFetch(fetchImpl, idToken, url, options) {
    const response = await fetchImpl(url, {
      method: (options && options.method) || "GET",
      headers: Object.assign(
        { Authorization: "Bearer " + idToken },
        (options && options.headers) || {}
      ),
      body: options && options.body,
    });
    const json = await readJson(response);
    return { response: response, json: json };
  }

  function documentBody(doc) {
    return JSON.stringify({
      fields: {
        sub: { stringValue: doc.sub || "" },
        updatedAt: { integerValue: String(doc.updatedAt || 0) },
        json: { stringValue: JSON.stringify(doc) },
      },
    });
  }

  async function loadDocument(fetchImpl, idToken, sub) {
    if (!idToken || !sub) return null;
    const result = await firestoreFetch(fetchImpl, idToken, userDocUrl(sub));
    if (result.response.status === 404) return null;
    if (!result.response.ok) throw firestoreError(result.response.status, result.json);
    const raw = result.json && result.json.fields && result.json.fields.json && result.json.fields.json.stringValue;
    if (!raw) return null;
    let doc = null;
    try { doc = JSON.parse(raw); } catch (error) { return null; }
    if (!doc || doc.sub !== sub) return null;
    return doc;
  }

  async function writeDocument(fetchImpl, idToken, doc) {
    const result = await firestoreFetch(fetchImpl, idToken, userDocUrl(doc.sub), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: documentBody(doc),
    });
    if (!result.response.ok) throw firestoreError(result.response.status, result.json);
    return doc;
  }

  async function saveDocument(fetchImpl, idToken, doc) {
    if (!doc || !doc.sub) throw new Error("Missing account for the saved board.");
    try {
      return await writeDocument(fetchImpl, idToken, doc);
    } catch (error) {
      if (!doc.wallpaper || !(error && (error.tooBig || error.status === 400))) throw error;
      const stripped = Object.assign({}, doc, { wallpaper: "", wallpaperSkipped: true });
      return writeDocument(fetchImpl, idToken, stripped);
    }
  }

  async function deleteDocument(fetchImpl, idToken, sub) {
    if (!idToken || !sub) return;
    const result = await firestoreFetch(fetchImpl, idToken, userDocUrl(sub), { method: "DELETE" });
    if (result.response.status === 404) return;
    if (!result.response.ok) throw firestoreError(result.response.status, result.json);
  }

  return {
    MAX_CLOUD_BYTES: MAX_CLOUD_BYTES,
    pack: pack,
    hasData: hasData,
    choose: choose,
    merge: merge,
    applyDocument: applyDocument,
    byteLength: byteLength,
    loadDocument: loadDocument,
    saveDocument: saveDocument,
    deleteDocument: deleteDocument,
  };
});

if (typeof module !== "undefined" && require.main === module) {
  const createMemoryStore = function () {
    const users = new Map();
    const docs = new Map();

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

    function subFromUrl(url) {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/documents\/users\/([^/]+)$/);
      return match ? decodeURIComponent(match[1]) : "";
    }

    return {
      issue: function (sub) {
        const token = "fb-" + sub;
        users.set(token, sub);
        return token;
      },
      writes: 0,
      fetch: function (url, options) {
        options = options || {};
        const sub = users.get(tokenOf(options.headers));
        if (!sub) return Promise.resolve(reply(401, { error: { message: "unauthorized" } }));
        const pathSub = subFromUrl(url);
        if (!pathSub || pathSub !== sub) {
          return Promise.resolve(reply(403, { error: { message: "permission denied" } }));
        }
        const method = options.method || "GET";
        if (method === "GET") {
          if (!docs.has(sub)) return Promise.resolve(reply(404, { error: { status: "NOT_FOUND" } }));
          return Promise.resolve(reply(200, JSON.parse(docs.get(sub))));
        }
        if (method === "PATCH") {
          const body = JSON.parse(options.body);
          const raw = body.fields.json.stringValue;
          const doc = JSON.parse(raw);
          if (!doc || doc.sub !== sub || body.fields.sub.stringValue !== sub) {
            return Promise.resolve(reply(403, { error: { message: "wrong owner" } }));
          }
          docs.set(sub, JSON.stringify(body));
          this.writes += 1;
          return Promise.resolve(reply(200, body));
        }
        if (method === "DELETE") {
          docs.delete(sub);
          return Promise.resolve(reply(200, {}));
        }
        return Promise.resolve(reply(404, { error: { message: "no route" } }));
      },
    };
  };

  const runSyncTests = async function () {
    const sync = require("./sync.js");
    const store = createMemoryStore();
    const tokenA = store.issue("user-a");
    const tokenB = store.issue("user-b");
    const course = {
      code: "COEN 243",
      title: "Programming Methodology",
      credits: 3,
      status: "todo",
      notes: "lab 1",
      tasks: [{ text: "finish lab 1", done: false }],
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
      wallpaper: "data:image/jpeg;base64,abc",
      updatedAt: 50,
    });
    await sync.saveDocument(store.fetch.bind(store), tokenA, saved);

    const fresh = await sync.loadDocument(store.fetch.bind(store), tokenA, "user-a");
    if (!fresh || fresh.university !== "Concordia University") throw new Error("fresh load missed university");
    if (!fresh.courses || fresh.courses.c1.code !== "COEN 243" || fresh.courses.c1.notes !== "lab 1") {
      throw new Error("fresh load missed class");
    }
    if (!fresh.courses.c1.tasks || fresh.courses.c1.tasks[0].text !== "finish lab 1") {
      throw new Error("fresh load missed task");
    }
    if (fresh.wallpaper !== "data:image/jpeg;base64,abc") throw new Error("fresh load missed wallpaper");

    saved.courses.c1.notes = "lab 2";
    saved.updatedAt = 60;
    await sync.saveDocument(store.fetch.bind(store), tokenA, saved);
    const updated = await sync.loadDocument(store.fetch.bind(store), tokenA, "user-a");
    if (!updated || updated.courses.c1.notes !== "lab 2" || updated.university !== "Concordia University") {
      throw new Error("second save did not load back");
    }

    const other = await sync.loadDocument(store.fetch.bind(store), tokenB, "user-b");
    if (other !== null) throw new Error("user B saw user A");
    const stolen = await store.fetch(
      "https://firestore.googleapis.com/v1/projects/lockedinschool/databases/(default)/documents/users/user-a",
      { headers: { Authorization: "Bearer " + tokenB } }
    );
    if (stolen.status !== 403) throw new Error("user B read user A by id");

    await sync.saveDocument(store.fetch.bind(store), tokenB, sync.pack({
      user: { sub: "user-b" },
      university: "McGill University",
      courses: { m: { code: "COMP 202", title: "Foundations", notes: "", tasks: [] } },
      groups: [],
      updatedAt: 20,
    }));
    const stillA = await sync.loadDocument(store.fetch.bind(store), tokenA, "user-a");
    const stillB = await sync.loadDocument(store.fetch.bind(store), tokenB, "user-b");
    if (stillA.university !== "Concordia University" || stillA.courses.c1.code !== "COEN 243") {
      throw new Error("user A changed after user B saved");
    }
    if (stillB.university !== "McGill University") throw new Error("user B board missing");

    const emptyLocal = {
      user: { sub: "user-a" },
      university: "",
      courses: {},
      groups: [],
      wallpaper: "",
      updatedAt: Date.now(),
    };
    const before = JSON.stringify(stillA);
    const writesBefore = store.writes;
    const emptyMerge = sync.merge(emptyLocal, stillA, emptyLocal.user);
    if (emptyMerge.upload) throw new Error("empty local must not clobber a full cloud doc");
    if (emptyMerge.source !== "remote") throw new Error("empty browser did not take the cloud board");
    if (emptyMerge.state.university !== "Concordia University") throw new Error("empty browser missed the university");
    if (emptyMerge.state.courses.c1.code !== "COEN 243" || emptyMerge.state.courses.c1.notes !== "lab 2") {
      throw new Error("empty browser missed the class");
    }
    if (emptyMerge.state.wallpaper !== "data:image/jpeg;base64,abc") throw new Error("empty browser missed the wallpaper");
    if (emptyMerge.upload) await sync.saveDocument(store.fetch.bind(store), tokenA, sync.pack(emptyMerge.state));
    const after = await sync.loadDocument(store.fetch.bind(store), tokenA, "user-a");
    if (JSON.stringify(after) !== before || store.writes !== writesBefore) {
      throw new Error("empty local must not clobber a full cloud doc");
    }

    const olderLocal = {
      user: { sub: "user-a" },
      university: "York University",
      courses: { y: { code: "EECS 1011", title: "Computers", notes: "old", tasks: [] } },
      groups: [],
      wallpaper: "",
      updatedAt: 10,
    };
    const older = sync.merge(olderLocal, after, olderLocal.user);
    if (older.upload || older.state.university !== "Concordia University") {
      throw new Error("older browser would replace the newer cloud board");
    }

    const newerLocal = Object.assign({}, olderLocal, { updatedAt: 90, university: "University of Toronto" });
    const newer = sync.merge(newerLocal, after, newerLocal.user);
    if (!newer.upload || newer.state.university !== "University of Toronto") {
      throw new Error("newer browser did not keep its board");
    }

    const cloudEmpty = sync.merge(newerLocal, null, newerLocal.user);
    if (!cloudEmpty.upload) throw new Error("browser with classes did not upload to an empty cloud");

    const bothEmpty = sync.merge(emptyLocal, null, emptyLocal.user);
    if (bothEmpty.upload) throw new Error("empty browser would create an empty cloud doc");

    await sync.deleteDocument(store.fetch.bind(store), tokenA, "user-a");
    if (await sync.loadDocument(store.fetch.bind(store), tokenA, "user-a") !== null) throw new Error("delete left the document");
    if ((await sync.loadDocument(store.fetch.bind(store), tokenB, "user-b")).university !== "McGill University") {
      throw new Error("delete removed the other account");
    }

    const bulky = sync.pack({
      user: { sub: "user-a" },
      university: "York University",
      courses: { y: { code: "EECS 1011", title: "Computers", notes: "keep me", tasks: [{ text: "quiz", done: false }] } },
      groups: [],
      wallpaper: "data:image/jpeg;base64," + "a".repeat(1000000),
      updatedAt: 9,
    });
    if (bulky.wallpaper !== "" || !bulky.wallpaperSkipped) throw new Error("big wallpaper was kept");
    if (bulky.courses.y.code !== "EECS 1011" || bulky.courses.y.notes !== "keep me") {
      throw new Error("wallpaper strip dropped the class");
    }
    if (JSON.stringify(bulky).length > sync.MAX_CLOUD_BYTES) throw new Error("packed document still too big");

    const applied = sync.applyDocument(bulky, { sub: "user-a" }, "local-picture");
    if (applied.wallpaper !== "local-picture") throw new Error("local wallpaper was not kept");
    if (applied.step !== "app" || applied.university !== "York University") throw new Error("apply missed the board");

    console.log("sync tests ok");
  };

  runSyncTests().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}
