/* Tally: a free calorie tracker that runs as an iPhone home screen app.
   Data lives in this browser's localStorage. Food data comes from
   Open Food Facts (barcodes + packaged foods) and USDA FoodData Central
   (generic foods like "banana" or "chicken breast"). */
"use strict";

const $ = (s) => document.querySelector(s);
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
const USDA_DEMO = "DEMO_KEY";
const OZ = 28.3495;

/* ---------- storage ---------- */
const store = {
  get(k, d) {
    try { const v = localStorage.getItem("tally." + k); return v ? JSON.parse(v) : d; }
    catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem("tally." + k, JSON.stringify(v)); }
    catch { toast("Couldn't save. Phone storage may be full."); }
  },
};

let settings = store.get("settings", { goals: { kcal: 2200, p: 150, c: 220, f: 70 }, usdaKey: "" });
let log = store.get("log", {});        // { "YYYY-MM-DD": [entry, ...] }
let foods = store.get("foods", {});    // { foodId: food }  recents + custom foods
let recent = store.get("recent", []);  // [foodId, ...] most recent first

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const saveLog = () => store.set("log", log);
const saveFoods = () => { store.set("foods", foods); store.set("recent", recent); };

/* ---------- helpers ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => r0(n).toLocaleString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
let current = new Date();

function defaultMeal() {
  const h = new Date().getHours();
  if (h < 10) return "Breakfast";
  if (h < 15) return "Lunch";
  if (h < 21) return "Dinner";
  return "Snacks";
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

async function getJSON(url, ms = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* ---------- food model ----------
   food = { id, name, brand, source, barcode,
            per100: {kcal,p,c,f} | null,      nutrients per 100 g (or ml)
            perServing: {kcal,p,c,f} | null,  nutrients per serving
            serving: { label, grams } | null } */

function nutrientsFor(food, qty, unit) {
  let grams = null;
  if (unit === "g") grams = qty;
  else if (unit === "oz") grams = qty * OZ;
  else if (unit === "serving" && food.serving && food.serving.grams) grams = qty * food.serving.grams;

  // A serving uses the label's own per-serving numbers when we have them (matches the package exactly).
  if (unit === "serving" && food.perServing) {
    const s = food.perServing;
    return { kcal: s.kcal * qty, p: s.p * qty, c: s.c * qty, f: s.f * qty, grams };
  }
  if (grams != null && food.per100) {
    const k = grams / 100;
    return { kcal: food.per100.kcal * k, p: food.per100.p * k, c: food.per100.c * k, f: food.per100.f * k, grams };
  }
  if (food.perServing) {
    const servings = unit === "serving" ? qty : (grams != null && food.serving && food.serving.grams ? grams / food.serving.grams : qty);
    const s = food.perServing;
    return { kcal: s.kcal * servings, p: s.p * servings, c: s.c * servings, f: s.f * servings, grams };
  }
  return { kcal: 0, p: 0, c: 0, f: 0, grams };
}

function unitsFor(food) {
  const u = [];
  if (food.serving && (food.perServing || food.serving.grams)) {
    const g = food.serving.grams ? ` (${r1(food.serving.grams)} g)` : "";
    u.push({ v: "serving", t: `serving: ${food.serving.label || "1 serving"}${g}` });
  }
  if (food.per100 || (food.serving && food.serving.grams)) {
    u.push({ v: "g", t: "grams" });
    u.push({ v: "oz", t: "ounces" });
  }
  if (!u.length) u.push({ v: "serving", t: "serving" });
  return u;
}

function headlineKcal(food) {
  if (food.perServing) return `${fmt(food.perServing.kcal)} cal / ${food.serving && food.serving.label ? food.serving.label : "serving"}`;
  if (food.per100 && food.serving && food.serving.grams) return `${fmt(food.per100.kcal * food.serving.grams / 100)} cal / ${food.serving.label || "serving"}`;
  if (food.per100) return `${fmt(food.per100.kcal)} cal / 100 g`;
  return "";
}

/* ---------- Open Food Facts ---------- */
const OFF_FIELDS = "code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit";

function fromOFF(p) {
  if (!p) return null;
  const n = p.nutriments || {};
  const kcal100 = n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
  const kcalSrv = n["energy-kcal_serving"] ?? (n["energy_serving"] != null ? n["energy_serving"] / 4.184 : null);
  const per100 = kcal100 != null ? { kcal: num(kcal100), p: num(n.proteins_100g), c: num(n.carbohydrates_100g), f: num(n.fat_100g) } : null;
  const sqEarly = num(p.serving_quantity);
  const srv = (key, k100) => n[key] != null ? num(n[key]) : (per100 && sqEarly > 0 ? per100[k100] * sqEarly / 100 : 0);
  const perServing = kcalSrv != null ? { kcal: num(kcalSrv), p: srv("proteins_serving", "p"), c: srv("carbohydrates_serving", "c"), f: srv("fat_serving", "f") } : null;
  if (!per100 && !perServing) return null;
  const sq = num(p.serving_quantity);
  let serving = (p.serving_size || sq) ? { label: p.serving_size || "1 serving", grams: sq > 0 ? sq : null } : null;
  if (!serving && perServing && !per100) serving = { label: "1 serving", grams: null };
  const name = p.product_name_en || p.product_name || p.generic_name || "Unnamed product";
  return {
    id: "off:" + p.code,
    name: String(name).trim(),
    brand: (p.brands || "").split(",")[0].trim(),
    source: "Open Food Facts",
    barcode: p.code,
    per100,
    perServing: perServing && serving ? perServing : null,
    serving,
  };
}

async function offByBarcode(code) {
  const tries = [code];
  if (code.length === 12) tries.push("0" + code);           // UPC-A stored as EAN-13
  if (code.length === 13 && code[0] === "0") tries.push(code.slice(1));
  for (const c of tries) {
    try {
      const j = await getJSON(`https://world.openfoodfacts.org/api/v2/product/${c}.json?fields=${OFF_FIELDS}`);
      if (j && j.status === 1 && j.product) {
        const f = fromOFF({ ...j.product, code: j.product.code || c });
        if (f) return f;
      }
    } catch (e) { if (e.name === "AbortError") throw e; }
  }
  return null;
}

async function offSearch(q) {
  // Newer full-text search service first, legacy endpoint as a fallback.
  try {
    const j = await getJSON(`https://search.openfoodfacts.org/search?q=${encodeURIComponent(q)}&page_size=20&langs=en&fields=${OFF_FIELDS}`, 7000);
    const hits = j.hits || j.products || [];
    const list = hits.map(fromOFF).filter(Boolean);
    if (list.length) return list;
  } catch {}
  const j = await getJSON(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=${OFF_FIELDS}`, 9000);
  return (j.products || []).map(fromOFF).filter(Boolean);
}

/* ---------- USDA FoodData Central ---------- */
function fromUSDA(item) {
  const get = (ids) => {
    for (const n of item.foodNutrients || []) {
      if (ids.includes(n.nutrientId) && n.value != null) {
        if (ids === KCAL_IDS && n.unitName && n.unitName.toUpperCase() !== "KCAL") continue;
        return num(n.value);
      }
    }
    return null;
  };
  const kcal = get(KCAL_IDS);
  if (kcal == null) return null;
  const per100 = { kcal, p: get([1003]) || 0, c: get([1005]) || 0, f: get([1004]) || 0 };
  let serving = null;
  const unit = (item.servingSizeUnit || "").toLowerCase();
  if (item.servingSize && (unit === "g" || unit === "ml" || unit === "grm" || unit === "mlt")) {
    serving = { label: item.householdServingFullText || `${r1(item.servingSize)} ${unit.startsWith("m") ? "ml" : "g"}`, grams: num(item.servingSize) };
  }
  const branded = item.dataType === "Branded";
  return {
    id: "usda:" + item.fdcId,
    name: branded ? titleCase(item.description) : item.description,
    brand: branded ? titleCase(item.brandName || item.brandOwner || "") : "",
    source: branded ? "USDA (branded)" : "USDA",
    barcode: item.gtinUpc || null,
    generic: !branded,
    per100,
    perServing: null,
    serving,
  };
}
const KCAL_IDS = [1008, 2047, 2048];

function usdaKey() { return (settings.usdaKey || "").trim() || USDA_DEMO; }

async function usdaSearch(q, dataTypes = ["Foundation", "SR Legacy", "Branded"], pageSize = 25) {
  const dt = dataTypes.map((d) => "&dataType=" + encodeURIComponent(d)).join("");
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(usdaKey())}&query=${encodeURIComponent(q)}&pageSize=${pageSize}${dt}`;
  const j = await getJSON(url);
  return (j.foods || []).map(fromUSDA).filter(Boolean);
}

async function usdaByBarcode(code) {
  try {
    const list = await usdaSearch(code, ["Branded"], 5);
    const strip = (s) => String(s || "").replace(/^0+/, "");
    return list.find((f) => strip(f.barcode) === strip(code)) || null;
  } catch { return null; }
}

/* ---------- day view ---------- */
function totals(entries) {
  return entries.reduce((t, e) => ({ kcal: t.kcal + e.kcal, p: t.p + e.p, c: t.c + e.c, f: t.f + e.f }), { kcal: 0, p: 0, c: 0, f: 0 });
}

function render() {
  const key = dateKey(current);
  const today = dateKey(new Date());
  const yest = dateKey(new Date(Date.now() - 864e5));
  const label = key === today ? "Today" : key === yest ? "Yesterday"
    : current.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  $("#date-label").textContent = label;
  $("#label-sub").textContent = key === today ? "Your day so far" : current.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  $("#next-day").disabled = key >= today;
  $("#next-day").style.opacity = key >= today ? 0.3 : 1;

  const entries = log[key] || [];
  const t = totals(entries);
  const g = settings.goals;

  $("#cal-num").textContent = fmt(t.kcal);
  const left = g.kcal - t.kcal;
  $("#cal-left").textContent = left >= 0 ? `${fmt(left)} left of ${fmt(g.kcal)}` : `${fmt(-left)} over ${fmt(g.kcal)}`;
  $("#cal-bar").style.width = Math.min(100, g.kcal ? (t.kcal / g.kcal) * 100 : 0) + "%";
  $(".label").classList.toggle("is-over", left < 0);

  for (const m of ["p", "c", "f"]) {
    const row = document.querySelector(`.macro[data-m="${m}"]`);
    const pct = g[m] ? (t[m] / g[m]) * 100 : 0;
    row.querySelector(".m-amt").textContent = `${r0(t[m])}g of ${g[m]}g`;
    row.querySelector(".m-pct").textContent = `${r0(pct)}%`;
    row.querySelector(".m-bar span").style.width = Math.min(100, pct) + "%";
    row.classList.toggle("is-over", pct > 105);
  }

  const wrap = $("#meals");
  wrap.innerHTML = "";
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "empty-day";
    p.textContent = "Nothing logged yet. Scan a barcode or search for a food to start.";
    wrap.appendChild(p);
  }
  for (const meal of MEALS) {
    const list = entries.filter((e) => e.meal === meal);
    if (!list.length && !entries.length) continue;
    const sec = document.createElement("div");
    sec.className = "meal";
    sec.innerHTML = `<div class="meal-head"><h2>${meal}</h2><span>${fmt(totals(list).kcal)} cal</span></div><div class="meal-list"></div>`;
    const ml = sec.querySelector(".meal-list");
    for (const e of list) {
      const b = document.createElement("button");
      b.className = "entry";
      b.innerHTML = `<span class="e-name">${esc(e.name)}</span><span class="e-kcal">${fmt(e.kcal)}</span>
        <span class="e-meta"><span>${esc(amountText(e))}</span><span>P ${r0(e.p)}</span><span>C ${r0(e.c)}</span><span>F ${r0(e.f)}</span></span>`;
      b.addEventListener("click", () => openFood(foods[e.foodId] || entryAsFood(e), e));
      ml.appendChild(b);
    }
    const add = document.createElement("button");
    add.className = "meal-add";
    add.textContent = `Add to ${meal.toLowerCase()}`;
    add.addEventListener("click", () => openSearch(meal));
    ml.appendChild(add);
    wrap.appendChild(sec);
  }
}

function amountText(e) {
  if (e.unit === "g") return `${r1(e.qty)} g`;
  if (e.unit === "oz") return `${r1(e.qty)} oz`;
  if (e.unit === "kcal") return "Quick add";
  return `${r1(e.qty)} serving${e.qty === 1 ? "" : "s"}`;
}

function entryAsFood(e) {
  // Fallback when the source food was removed: rebuild per-serving numbers from the entry.
  const q = e.qty || 1;
  return { id: e.foodId || "entry:" + e.id, name: e.name, brand: e.brand || "", source: "Your log",
    per100: null, perServing: { kcal: e.kcal / q, p: e.p / q, c: e.c / q, f: e.f / q }, serving: { label: "1 serving", grams: null } };
}

/* ---------- log entry sheet ---------- */
let activeFood = null, activeEntry = null, pendingMeal = null;

function openFood(food, entry = null) {
  activeFood = food;
  activeEntry = entry;
  $("#food-name").textContent = food.name;
  $("#food-brand").textContent = food.brand || "";
  const sel = $("#food-unit");
  sel.innerHTML = unitsFor(food).map((u) => `<option value="${u.v}">${esc(u.t)}</option>`).join("");
  if (entry) {
    $("#food-qty").value = r1(entry.qty);
    if ([...sel.options].some((o) => o.value === entry.unit)) sel.value = entry.unit;
    $("#food-meal").value = entry.meal;
  } else {
    const last = food.lastUse;
    if (last && [...sel.options].some((o) => o.value === last.unit)) { sel.value = last.unit; $("#food-qty").value = last.qty; }
    else $("#food-qty").value = sel.value === "g" ? 100 : 1;
    $("#food-meal").value = pendingMeal || defaultMeal();
  }
  $("#food-submit").textContent = entry ? "Save changes" : "Add to log";
  $("#food-delete").hidden = !entry;
  $("#food-source").textContent = food.source ? `Source: ${food.source}${food.barcode ? ", barcode " + food.barcode : ""}` : "";
  updatePreview();
  const d = $("#food-sheet");
  if (!d.open) d.showModal();
}

function updatePreview() {
  if (!activeFood) return;
  const n = nutrientsFor(activeFood, num($("#food-qty").value), $("#food-unit").value);
  $("#food-preview").innerHTML =
    `<div><b>${fmt(n.kcal)}</b><span>Calories</span></div><div><b>${r0(n.p)}g</b><span>Protein</span></div>` +
    `<div><b>${r0(n.c)}g</b><span>Carbs</span></div><div><b>${r0(n.f)}g</b><span>Fat</span></div>`;
}
$("#food-qty").addEventListener("input", updatePreview);
$("#food-unit").addEventListener("change", () => {
  const u = $("#food-unit").value;
  const q = num($("#food-qty").value);
  if (u === "g" && q < 5) $("#food-qty").value = activeFood.serving && activeFood.serving.grams ? r1(activeFood.serving.grams * (q || 1)) : 100;
  if (u === "serving" && q > 20) $("#food-qty").value = 1;
  updatePreview();
});

function rememberFood(food, qty, unit) {
  foods[food.id] = { ...food, lastUse: { qty, unit } };
  recent = [food.id, ...recent.filter((id) => id !== food.id)];
  // keep custom foods forever, trim old recents
  const keep = new Set(recent.slice(0, 60));
  for (const id of Object.keys(foods)) if (!keep.has(id) && !foods[id].custom) delete foods[id];
  recent = recent.filter((id) => foods[id]);
  saveFoods();
}

$("#food-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") return;
  const qty = num($("#food-qty").value);
  if (qty <= 0) { ev.preventDefault(); toast("Enter an amount above zero"); return; }
  const unit = $("#food-unit").value;
  const n = nutrientsFor(activeFood, qty, unit);
  const key = dateKey(current);
  const list = log[key] || (log[key] = []);
  const data = { foodId: activeFood.id, name: activeFood.name, brand: activeFood.brand || "", meal: $("#food-meal").value,
    qty, unit, grams: n.grams, kcal: r1(n.kcal), p: r1(n.p), c: r1(n.c), f: r1(n.f) };
  if (activeEntry) {
    const i = list.findIndex((e) => e.id === activeEntry.id);
    if (i >= 0) list[i] = { ...list[i], ...data };
    toast("Changes saved");
  } else {
    list.push({ id: uid(), at: Date.now(), ...data });
    toast(`Added ${fmt(n.kcal)} cal to ${data.meal.toLowerCase()}`);
    if ($("#search-sheet").open) $("#search-sheet").close();
  }
  if (!String(activeFood.id).startsWith("entry:")) rememberFood(activeFood, qty, unit);
  saveLog();
  render();
});

$("#food-delete").addEventListener("click", () => {
  const key = dateKey(current);
  log[key] = (log[key] || []).filter((e) => e.id !== activeEntry.id);
  if (!log[key].length) delete log[key];
  saveLog();
  $("#food-sheet").close();
  render();
  toast("Deleted");
});

/* ---------- search sheet ---------- */
let searchSeq = 0, searchTimer;

function openSearch(meal = null) {
  pendingMeal = meal;
  const d = $("#search-sheet");
  $("#search-input").value = "";
  showRecents();
  d.showModal();
  setTimeout(() => $("#search-input").focus(), 50);
}

function resultButton(food) {
  const b = document.createElement("button");
  b.className = "result";
  b.type = "button";
  b.innerHTML = `<span class="r-name">${esc(food.name)}</span><span class="r-kcal">${esc(headlineKcal(food))}</span>
    <span class="r-meta">${food.brand ? `<span>${esc(food.brand)}</span>` : ""}<span class="r-src">${esc(food.source || "")}</span></span>`;
  b.addEventListener("click", () => openFood(food));
  return b;
}

function section(title, list) {
  const frag = document.createDocumentFragment();
  if (!list.length) return frag;
  const h = document.createElement("h4");
  h.textContent = title;
  frag.appendChild(h);
  list.forEach((f) => frag.appendChild(resultButton(f)));
  return frag;
}

function showRecents() {
  const box = $("#search-results");
  box.innerHTML = "";
  const rec = recent.map((id) => foods[id]).filter(Boolean);
  const mine = Object.values(foods).filter((f) => f.custom).sort((a, b) => a.name.localeCompare(b.name));
  box.appendChild(section("Recent", rec.slice(0, 25)));
  box.appendChild(section("My foods", mine));
  if (!rec.length && !mine.length) box.innerHTML = `<p class="status">Type a food to search millions of products. Foods you log show up here for one-tap re-adding.</p>`;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const box = $("#search-results");
  const ql = q.toLowerCase();
  const localHits = Object.values(foods).filter((f) => (f.name + " " + (f.brand || "")).toLowerCase().includes(ql)).slice(0, 8);
  box.innerHTML = "";
  box.appendChild(section("Your foods", localHits));
  const status = document.createElement("p");
  status.className = "status";
  status.textContent = "Searching…";
  box.appendChild(status);

  const [usda, off] = await Promise.allSettled([usdaSearch(q), offSearch(q)]);
  if (seq !== searchSeq) return; // a newer search started

  status.remove();
  const usdaList = usda.status === "fulfilled" ? usda.value : [];
  const offList = off.status === "fulfilled" ? off.value : [];
  const generic = usdaList.filter((f) => f.generic);
  const seen = new Set(localHits.map((f) => f.id));
  const brandedUSDA = usdaList.filter((f) => !f.generic);
  // interleave branded results from both databases, drop duplicate barcodes
  const branded = [], codes = new Set();
  for (let i = 0; i < Math.max(offList.length, brandedUSDA.length); i++) {
    for (const f of [offList[i], brandedUSDA[i]]) {
      if (!f || seen.has(f.id)) continue;
      const code = f.barcode ? String(f.barcode).replace(/^0+/, "") : null;
      if (code && codes.has(code)) continue;
      if (code) codes.add(code);
      branded.push(f);
    }
  }
  box.appendChild(section("Basic foods", generic.slice(0, 12)));
  box.appendChild(section("Brands and packaged", branded.slice(0, 30)));

  if (!generic.length && !branded.length) {
    const p = document.createElement("p");
    p.className = "status";
    const usdaLimited = usda.status === "rejected" && usda.reason && usda.reason.status === 429;
    p.textContent = usdaLimited
      ? "The shared USDA key hit its hourly limit. Add your own free key in Settings, or try again shortly."
      : (usda.status === "rejected" && off.status === "rejected")
        ? "Couldn't reach the food databases. Check your connection and try again."
        : `No matches for "${q}". Try fewer words, or tap Enter manually.`;
    box.appendChild(p);
  }
}

$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { searchSeq++; showRecents(); return; }
  if (q.length < 2) return;
  searchTimer = setTimeout(() => runSearch(q), 450);
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  const q = $("#search-input").value.trim();
  if (q) runSearch(q);
  $("#search-input").blur();
});

/* ---------- custom / quick add ---------- */
let customMode = "custom";

function openCustom({ barcode = "", quick = false } = {}) {
  customMode = quick ? "quick" : "custom";
  $("#custom-form").reset();
  $("#c-barcode").value = barcode;
  $("#custom-title").textContent = quick ? "Quick add" : "Enter manually";
  $("#custom-note").textContent = barcode
    ? `Barcode ${barcode} isn't in the databases yet. Copy the numbers off the label once and it'll scan instantly next time.`
    : quick ? "Log calories without saving a food." : "Copy the numbers off the package label.";
  $("#c-name").value = quick ? "Quick add" : "";
  $("#c-save").checked = !quick;
  $("#c-save").parentElement.hidden = quick || !!barcode;
  for (const id of ["#c-brand", "#c-serving", "#c-grams"]) $(id).closest(".field").hidden = quick;
  $("#custom-sheet").showModal();
  setTimeout(() => (quick ? $("#c-kcal") : $("#c-name")).focus(), 50);
}

$("#custom-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") return;
  const grams = num($("#c-grams").value) || null;
  const perServing = { kcal: num($("#c-kcal").value), p: num($("#c-p").value), c: num($("#c-c").value), f: num($("#c-f").value) };
  const barcode = $("#c-barcode").value || null;
  const food = {
    id: barcode ? "custom:" + barcode : "custom:" + uid(),
    name: $("#c-name").value.trim() || "Food",
    brand: $("#c-brand").value.trim(),
    source: "Entered by you",
    barcode,
    custom: !!barcode || $("#c-save").checked,
    serving: { label: $("#c-serving").value.trim() || "1 serving", grams },
    perServing,
    per100: grams ? { kcal: perServing.kcal * 100 / grams, p: perServing.p * 100 / grams, c: perServing.c * 100 / grams, f: perServing.f * 100 / grams } : null,
  };
  if (customMode === "quick") food.id = "entry:quick";
  if (food.custom) { foods[food.id] = food; saveFoods(); }
  if ($("#search-sheet").open) $("#search-sheet").close();
  setTimeout(() => openFood(food), 30);
});

$("#open-custom").addEventListener("click", () => openCustom());
$("#open-quick").addEventListener("click", () => openCustom({ quick: true }));

/* ---------- barcode scanning ---------- */
let scanner = null, scanning = false, handled = false;

async function openScanner() {
  if (!window.Html5Qrcode) { toast("Scanner is still loading. Try again in a second."); return; }
  pendingMeal = null;
  handled = false;
  $("#scanner").hidden = false;
  $("#scan-hint").textContent = "Line the barcode up inside the box";
  $("#scan-manual-input").value = "";
  const F = window.Html5QrcodeSupportedFormats;
  try {
    scanner = scanner || new window.Html5Qrcode("reader", {
      verbose: false,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 15,
        qrbox: (w, h) => ({ width: Math.floor(Math.min(w * 0.86, 340)), height: Math.floor(Math.min(h * 0.32, 170)) }),
        disableFlip: true,
      },
      (text) => onScan(text),
      () => {}
    );
    scanning = true;
  } catch (e) {
    scanning = false;
    $("#scan-hint").textContent = "Camera unavailable. Allow camera access for this site in Settings, or type the number below.";
  }
}

async function stopScanner() {
  if (scanner && scanning) { try { await scanner.stop(); } catch {} }
  scanning = false;
  $("#scanner").hidden = true;
}

async function onScan(code) {
  if (handled) return;
  handled = true;
  code = String(code).replace(/\D/g, "");
  await stopScanner();
  lookupBarcode(code);
}

async function lookupBarcode(code) {
  if (!code) return;
  const local = Object.values(foods).find((f) => f.barcode && String(f.barcode).replace(/^0+/, "") === code.replace(/^0+/, ""));
  if (local) { openFood(local); return; }
  toast(`Looking up ${code}…`);
  try {
    let food = await offByBarcode(code);
    if (!food) food = await usdaByBarcode(code);
    if (food) { openFood(food); return; }
    openCustom({ barcode: code });
  } catch {
    toast("Couldn't reach the food database. Check your connection.");
  }
}

$("#scan-manual").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#scan-manual-input").value.replace(/\D/g, "");
  if (code.length < 6) { toast("Barcodes are usually 8, 12 or 13 digits"); return; }
  handled = true;
  await stopScanner();
  lookupBarcode(code);
});
$("#scan-close").addEventListener("click", stopScanner);
$("#open-scan").addEventListener("click", openScanner);
$("#open-search").addEventListener("click", () => openSearch());

/* ---------- settings ---------- */
function openSettings() {
  const g = settings.goals;
  $("#g-kcal").value = g.kcal; $("#g-p").value = g.p; $("#g-c").value = g.c; $("#g-f").value = g.f;
  $("#s-key").value = settings.usdaKey || "";
  $("#settings-sheet").showModal();
}
$("#settings-form").addEventListener("submit", () => {
  settings.goals = {
    kcal: num($("#g-kcal").value) || 2200, p: num($("#g-p").value), c: num($("#g-c").value), f: num($("#g-f").value),
  };
  settings.usdaKey = $("#s-key").value.trim();
  store.set("settings", settings);
  render();
});
$("#open-settings").addEventListener("click", openSettings);

$("#export-btn").addEventListener("click", async () => {
  const data = JSON.stringify({ app: "tally", version: 1, exported: new Date().toISOString(), settings, log, foods, recent }, null, 1);
  const name = `tally-backup-${dateKey(new Date())}.json`;
  const file = new File([data], name, { type: "application/json" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Tally backup" }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== "tally") throw new Error();
    if (!confirm("Replace everything on this phone with the backup?")) return;
    settings = d.settings || settings; log = d.log || {}; foods = d.foods || {}; recent = d.recent || [];
    store.set("settings", settings); saveLog(); saveFoods();
    $("#settings-sheet").close();
    render();
    toast("Backup imported");
  } catch { toast("That file isn't a Tally backup"); }
  e.target.value = "";
});

$("#wipe-btn").addEventListener("click", () => {
  if (!confirm("Delete your whole food log, saved foods and goals from this phone? This can't be undone.")) return;
  for (const k of ["settings", "log", "foods", "recent"]) localStorage.removeItem("tally." + k);
  location.reload();
});

/* ---------- misc wiring ---------- */
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
// tap the dimmed backdrop to close a sheet
document.querySelectorAll("dialog.sheet").forEach((d) => d.addEventListener("click", (e) => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) d.close();
}));

$("#prev-day").addEventListener("click", () => { current = new Date(current.getTime() - 864e5); render(); });
$("#next-day").addEventListener("click", () => {
  const n = new Date(current.getTime() + 864e5);
  if (dateKey(n) <= dateKey(new Date())) { current = n; render(); }
});
$("#date-label").addEventListener("click", () => { current = new Date(); render(); });

// When the app comes back to the foreground on a new day, jump to today.
let lastSeen = dateKey(new Date());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") { if (scanning) stopScanner(); return; }
  const now = dateKey(new Date());
  if (now !== lastSeen) { lastSeen = now; current = new Date(); render(); }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

render();
