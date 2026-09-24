const DATA = window.TRACKER;
const KEY = "school-tracker-v1";

const state = load();
let openId = null;

const statsEl = document.getElementById("stats");
const pathsEl = document.getElementById("paths");
const noteEl = document.getElementById("path-note");
const boardEl = document.getElementById("board");
const natsciEl = document.getElementById("natsci");
const drawer = document.getElementById("drawer");
const drawerCard = document.getElementById("drawer-card");
const searchEl = document.getElementById("search");

function load() {
  const blank = { path: "regular-fall", filter: "left", query: "", items: {} };
  try {
    return Object.assign(blank, JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return blank;
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
}
function item(id) {
  if (!state.items[id]) {
    state.items[id] = { status: "todo", notes: "", tasks: [], log: [], code: "", name: "", credits: 0 };
  }
  return state.items[id];
}
function creditsLabel(n) {
  if (!n) return "";
  return (n % 1 ? n.toFixed(1) : String(n)) + " cr";
}
function meta(id) {
  if (DATA.catalog[id]) {
    const [code, name, credits] = DATA.catalog[id];
    return { code, name, credits, kind: "core", placeholder: false };
  }
  const rec = item(id);
  if (id.startsWith("coop-work")) {
    return { code: "COOP", name: rec.name || "Work term", credits: 0, kind: "work", placeholder: !rec.name };
  }
  if (id === "GENED") {
    return {
      code: rec.code || "GEN-ED",
      name: rec.name || "General education elective",
      credits: rec.credits || 3,
      kind: "gened",
      placeholder: !rec.code,
    };
  }
  if (id.startsWith("natsci")) {
    return {
      code: rec.code || "Natural science",
      name: rec.name || "Pick one of the two you still need",
      credits: rec.credits || 3,
      kind: "natsci",
      placeholder: !rec.code,
    };
  }
  return {
    code: rec.code || "Elective",
    name: rec.name || "Technical elective — pick the course",
    credits: rec.credits || 3,
    kind: "elective",
    placeholder: !rec.code,
  };
}
function currentPath() {
  return DATA.paths.find((p) => p.id === state.path) || DATA.paths[1];
}
function slots() {
  const list = [];
  currentPath().terms.forEach(([label, items]) => {
    items.forEach((slot) => list.push({ term: label, id: slotId(slot), raw: slot }));
  });
  list.push({ term: "Natural science", id: "natsci-1" });
  list.push({ term: "Natural science", id: "natsci-2" });
  const seen = new Set();
  return list.filter((slot) => {
    if (seen.has(slot.id)) return false;
    seen.add(slot.id);
    return true;
  });
}
function slotId(slot) {
  if (typeof slot === "string") return slot;
  if (slot[0] === "work") return slot[1];
  if (slot[0] === "gened") return "GENED";
  if (slot[0] === "elective") return slot[1];
  return String(slot);
}
function matches(id) {
  const rec = item(id);
  const info = meta(id);
  if (state.filter === "left" && rec.status === "done") return false;
  if (state.filter === "doing" && rec.status !== "doing") return false;
  if (state.filter === "done" && rec.status !== "done") return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return (info.code + " " + info.name + " " + rec.notes).toLowerCase().includes(q);
}

function render() {
  const path = currentPath();
  const all = slots();
  const done = all.filter((s) => item(s.id).status === "done").length;
  const doing = all.filter((s) => item(s.id).status === "doing").length;
  const left = all.length - done;
  statsEl.innerHTML = "";
  [
    [done, "done"],
    [doing, "doing now"],
    [left, "still left"],
  ].forEach(([n, label]) => {
    const box = document.createElement("div");
    box.className = "stat";
    const b = document.createElement("b");
    b.textContent = String(n);
    const span = document.createElement("span");
    span.textContent = label;
    box.append(b, span);
    statsEl.append(box);
  });
  let bar = document.querySelector(".bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "bar";
    bar.append(document.createElement("i"));
    statsEl.parentElement.after(bar);
  }
  bar.firstChild.style.width = all.length ? (done / all.length) * 100 + "%" : "0";

  pathsEl.innerHTML = "";
  DATA.paths.forEach((p) => {
    const btn = document.createElement("button");
    btn.textContent = p.label;
    btn.className = p.id === state.path ? "on" : "";
    btn.onclick = () => {
      state.path = p.id;
      save();
      render();
    };
    pathsEl.append(btn);
  });
  noteEl.textContent = path.note;

  natsciEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = "Natural science electives";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "You need 2. Pick them here so the code and the name stay on this page.";
  const grid = document.createElement("div");
  grid.className = "grid";
  ["natsci-1", "natsci-2"].forEach((id, i) => {
    if (matches(id)) grid.append(card(id, "Natural science " + (i + 1)));
  });
  natsciEl.append(h, hint, grid);
  if (!grid.childElementCount) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Both natural science electives are hidden by the current filter.";
    natsciEl.append(p);
  }

  boardEl.innerHTML = "";
  path.terms.forEach(([label, items]) => {
    const visible = items.map(slotId).filter((id, idx, arr) => arr.indexOf(id) === idx && matches(id));
    const section = document.createElement("section");
    section.className = "term";
    const title = document.createElement("h2");
    title.textContent = label;
    section.append(title);
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No classes this term.";
      section.append(p);
    } else if (!visible.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Nothing in this term matches the filter.";
      section.append(p);
    } else {
      const g = document.createElement("div");
      g.className = "grid";
      visible.forEach((id) => g.append(card(id, label)));
      section.append(g);
    }
    boardEl.append(section);
  });

  if (openId) renderDrawer(openId);
}

function card(id, term) {
  const info = meta(id);
  const rec = item(id);
  const el = document.createElement("article");
  el.className = "card" + (rec.status === "done" ? " done" : "");
  const code = document.createElement("h3");
  code.className = "code";
  code.textContent = info.code;
  const name = document.createElement("p");
  name.className = "name";
  name.textContent = info.name;
  const metaLine = document.createElement("p");
  metaLine.className = "meta";
  const bits = [term, creditsLabel(info.credits)].filter(Boolean);
  if (id === "COEN490") bits.push("two-term course");
  metaLine.textContent = bits.join(" · ");
  el.append(code, name, metaLine, statusButtons(id));
  const openTasks = rec.tasks.filter((t) => !t.done);
  if (openTasks.length) {
    const left = document.createElement("p");
    left.className = "left-count";
    left.textContent = openTasks.length + " thing" + (openTasks.length === 1 ? "" : "s") + " still open";
    el.append(left);
  }
  el.onclick = (event) => {
    if (event.target.closest("button")) return;
    openId = id;
    renderDrawer(id);
  };
  return el;
}

function statusButtons(id) {
  const rec = item(id);
  const wrap = document.createElement("div");
  wrap.className = "status";
  [
    ["todo", "Not started"],
    ["doing", "Doing"],
    ["done", "Done"],
  ].forEach(([value, label]) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className = value + (rec.status === value ? " on" : "");
    btn.onclick = (event) => {
      event.stopPropagation();
      item(id).status = value;
      save();
      render();
    };
    wrap.append(btn);
  });
  return wrap;
}

function renderDrawer(id) {
  const info = meta(id);
  const rec = item(id);
  drawer.hidden = false;
  drawerCard.innerHTML = "";

  const top = document.createElement("div");
  top.className = "drawer-top";
  const close = document.createElement("button");
  close.className = "ghost";
  close.textContent = "Close";
  close.onclick = () => {
    drawer.hidden = true;
    openId = null;
  };
  top.append(close);
  const code = document.createElement("h3");
  code.textContent = info.code;
  const name = document.createElement("p");
  name.textContent = info.name;
  drawerCard.append(top, code, name, statusButtons(id));

  if (info.kind === "elective" || info.kind === "natsci" || info.kind === "gened" || info.kind === "work") {
    drawerCard.append(picker(id, info.kind));
  }

  const taskLabel = document.createElement("label");
  taskLabel.textContent = "What’s left in this class";
  drawerCard.append(taskLabel);
  rec.tasks.forEach((task, index) => {
    const row = document.createElement("div");
    row.className = "task";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = task.done;
    check.onchange = () => {
      rec.tasks[index].done = check.checked;
      save();
      render();
    };
    const text = document.createElement("input");
    text.type = "text";
    text.value = task.text;
    text.oninput = () => {
      rec.tasks[index].text = text.value;
      save();
    };
    const del = document.createElement("button");
    del.className = "x";
    del.textContent = "Remove";
    del.onclick = () => {
      rec.tasks.splice(index, 1);
      save();
      render();
    };
    row.append(check, text, del);
    drawerCard.append(row);
  });
  const add = document.createElement("button");
  add.className = "ghost";
  add.textContent = "Add something left";
  add.onclick = () => {
    rec.tasks.push({ text: "", done: false });
    save();
    renderDrawer(id);
  };
  drawerCard.append(add);

  const notesLabel = document.createElement("label");
  notesLabel.textContent = "Notes";
  const notes = document.createElement("textarea");
  notes.placeholder = "Labs, deadlines, whatever you don’t want to forget.";
  notes.value = rec.notes;
  notes.oninput = () => {
    rec.notes = notes.value;
    save();
  };
  drawerCard.append(notesLabel, notes);

  const coachLabel = document.createElement("label");
  coachLabel.textContent = "Coach";
  const log = document.createElement("div");
  log.className = "log";
  if (!rec.log.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Ask what to do next, or write what’s stuck.";
    log.append(empty);
  }
  rec.log.forEach((entry) => {
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (entry.from === "coach" ? " coach" : "");
    const who = document.createElement("small");
    who.textContent = entry.from === "coach" ? "Coach" : "You";
    const text = document.createElement("div");
    text.textContent = entry.text;
    bubble.append(who, text);
    log.append(bubble);
  });
  const reply = document.createElement("textarea");
  reply.placeholder = "Write a note back, or say what you’re stuck on.";
  const actions = document.createElement("div");
  actions.className = "row";
  const saveNote = document.createElement("button");
  saveNote.className = "ghost";
  saveNote.textContent = "Save what I wrote";
  saveNote.onclick = () => {
    const text = reply.value.trim();
    if (!text) return;
    rec.log.push({ from: "me", text });
    rec.log.push({ from: "coach", text: coachReply(id, text) });
    reply.value = "";
    save();
    renderDrawer(id);
  };
  const coachBtn = document.createElement("button");
  coachBtn.className = "primary";
  coachBtn.textContent = "Coach me";
  coachBtn.onclick = () => {
    rec.log.push({ from: "coach", text: coachMessage(id) });
    save();
    renderDrawer(id);
  };
  actions.append(saveNote, coachBtn);
  drawerCard.append(coachLabel, log, reply, actions);
}

function picker(id, kind) {
  const rec = item(id);
  const wrap = document.createElement("div");
  wrap.className = "pick";
  const label = document.createElement("label");
  label.textContent = kind === "work" ? "Where this work term is" : "Which course is this";
  wrap.append(label);

  if (kind === "work" || kind === "gened") {
    const code = document.createElement("input");
    code.className = "field";
    code.placeholder = kind === "work" ? "Employer or role" : "Course code";
    code.value = kind === "work" ? rec.name : rec.code;
    code.oninput = () => {
      if (kind === "work") rec.name = code.value;
      else rec.code = code.value;
      save();
      render();
    };
    wrap.append(code);
    if (kind === "gened") {
      const name = document.createElement("input");
      name.className = "field";
      name.style.marginTop = "8px";
      name.placeholder = "Course name";
      name.value = rec.name;
      name.oninput = () => {
        rec.name = name.value;
        save();
        render();
      };
      wrap.append(name);
    }
    return wrap;
  }

  const select = document.createElement("select");
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "Choose a course";
  select.append(blank);
  const list = kind === "natsci" ? [["Natural science", DATA.natural]] : DATA.technical;
  list.forEach(([group, courses]) => {
    const og = document.createElement("optgroup");
    og.label = group;
    courses.forEach(([code, name, credits]) => {
      const opt = document.createElement("option");
      opt.value = code + "|" + name + "|" + credits;
      opt.textContent = code + " — " + name;
      if (rec.code === code) opt.selected = true;
      og.append(opt);
    });
    select.append(og);
  });
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Type my own";
  if (rec.code && ![...select.options].some((o) => o.value.startsWith(rec.code + "|"))) custom.selected = true;
  select.append(custom);
  const customCode = document.createElement("input");
  customCode.className = "field";
  customCode.placeholder = "Code";
  customCode.value = rec.code;
  customCode.style.marginTop = "8px";
  const customName = document.createElement("input");
  customName.className = "field";
  customName.placeholder = "Name";
  customName.value = rec.name;
  customName.style.marginTop = "8px";
  function showCustom(on) {
    customCode.hidden = !on;
    customName.hidden = !on;
  }
  showCustom(select.value === "custom");
  select.onchange = () => {
    if (select.value === "custom") {
      showCustom(true);
      return;
    }
    showCustom(false);
    if (!select.value) {
      rec.code = "";
      rec.name = "";
      rec.credits = 0;
    } else {
      const [code, name, credits] = select.value.split("|");
      rec.code = code;
      rec.name = name;
      rec.credits = Number(credits);
    }
    save();
    render();
  };
  customCode.oninput = () => {
    rec.code = customCode.value;
    save();
    render();
  };
  customName.oninput = () => {
    rec.name = customName.value;
    save();
    render();
  };
  wrap.append(select, customCode, customName);
  return wrap;
}

function coachMessage(id) {
  const info = meta(id);
  const rec = item(id);
  const open = rec.tasks.filter((t) => !t.done && t.text.trim());
  if (info.placeholder) {
    return "This slot doesn’t have a real course yet. Pick the code first, then you’ll stop having to look it up.";
  }
  if (rec.status === "done") {
    return info.code + " is marked done. If a grade, lab, or report is still hanging, add it under what’s left so it doesn’t vanish.";
  }
  if (rec.status === "todo") {
    return "You haven’t started " + info.code + " — " + info.name + ". " + (info.credits ? "It’s " + creditsLabel(info.credits) + ". " : "") + "Put the first deadline in “what’s left”, then flip it to Doing.";
  }
  if (open.length) {
    return "Still open in " + info.code + ": " + open.map((t) => t.text).join(", ") + ". Do the smallest one first and check it off.";
  }
  return "You’re in " + info.code + " but the leftover list is empty. Add the labs, assignments, or the final so “left” means something concrete.";
}
function coachReply(id, text) {
  const info = meta(id);
  const rec = item(id);
  const open = rec.tasks.filter((t) => !t.done && t.text.trim());
  const next = open[0] ? " Next open item: " + open[0].text + "." : " Add the next deadline while it’s in your head.";
  return "Saved on " + info.code + ". You wrote: “" + text.slice(0, 140) + (text.length > 140 ? "…”" : "”.") + next;
}

document.getElementById("filters").onclick = (event) => {
  const btn = event.target.closest("button");
  if (!btn) return;
  state.filter = btn.dataset.filter;
  document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b === btn));
  save();
  render();
};
searchEl.oninput = () => {
  state.query = searchEl.value;
  save();
  render();
};
drawer.onclick = (event) => {
  if (event.target === drawer) {
    drawer.hidden = true;
    openId = null;
  }
};

searchEl.value = state.query;
document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("on", b.dataset.filter === state.filter));
render();
