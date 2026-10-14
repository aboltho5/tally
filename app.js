/* Tally: a free calorie tracker that runs as an iPhone home screen app.
   Data lives in this browser's localStorage. Food data comes from
   Open Food Facts (barcodes + packaged foods) and USDA FoodData Central
   (generic foods like "banana" or "chicken breast"). Barcodes are read
   with ZXing-C++ compiled to WebAssembly (barcode-detector package). */
"use strict";

const $ = (s) => document.querySelector(s);
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snacks"];
const USDA_DEMO = "DEMO_KEY";
const OZ = 28.3495;
const LB = 0.45359237;

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

const DEFAULT_SETTINGS = { goals: { kcal: 2200, p: 150, c: 220, f: 70 }, usdaKey: "", weightUnit: "lb", scanZoom: 2 };
let settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
let log = store.get("log", {});         // { "YYYY-MM-DD": [entry, ...] }
let foods = store.get("foods", {});     // { foodId: food }  recents, custom foods and recipes
let recent = store.get("recent", []);   // [foodId, ...] most recent first
let weights = store.get("weights", {}); // { "YYYY-MM-DD": kg }

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const saveLog = () => store.set("log", log);
const saveFoods = () => { store.set("foods", foods); store.set("recent", recent); };
const saveWeights = () => store.set("weights", weights);
const saveSettings = () => store.set("settings", settings);

/* ---------- helpers ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => r0(n).toLocaleString();
const fmt1 = (n) => r1(n).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

function dateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function keyToDate(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d, 12); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
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
            serving: { label, grams } | null,
            type: "recipe" (recipes only), servings, ingredients: [{ food, qty, unit }] } */

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
  if (food.type === "recipe") return [{ v: "serving", t: "servings" }];
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
  if (food.type === "recipe" && food.perServing) return `${fmt(food.perServing.kcal)} cal / serving`;
  if (food.perServing) return `${fmt(food.perServing.kcal)} cal / ${food.serving && food.serving.label ? food.serving.label : "serving"}`;
  if (food.per100 && food.serving && food.serving.grams) return `${fmt(food.per100.kcal * food.serving.grams / 100)} cal / ${food.serving.label || "serving"}`;
  if (food.per100) return `${fmt(food.per100.kcal)} cal / 100 g`;
  return "";
}

// copy of a food without per-user bookkeeping, for storing inside recipes
function cleanFood(f) { const { lastUse, ...rest } = f; return rest; }

/* ---------- Open Food Facts ---------- */
const OFF_FIELDS = "code,product_name,product_name_en,generic_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit";

function fromOFF(p) {
  if (!p) return null;
  const n = p.nutriments || {};
  const kcal100 = n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
  const kcalSrv = n["energy-kcal_serving"] ?? (n["energy_serving"] != null ? n["energy_serving"] / 4.184 : null);
  const per100 = kcal100 != null ? { kcal: num(kcal100), p: num(n.proteins_100g), c: num(n.carbohydrates_100g), f: num(n.fat_100g) } : null;
  const sq = num(p.serving_quantity);
  const srv = (key, k100) => n[key] != null ? num(n[key]) : (per100 && sq > 0 ? per100[k100] * sq / 100 : 0);
  const perServing = kcalSrv != null ? { kcal: num(kcalSrv), p: srv("proteins_serving", "p"), c: srv("carbohydrates_serving", "c"), f: srv("fat_serving", "f") } : null;
  if (!per100 && !perServing) return null;
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

// Returns a food, null if the product isn't there, or throws on network failure.
async function offProduct(code) {
  const j = await getJSON(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`, 8000)
    .catch((e) => { if (e.status === 404) return null; throw e; });
  if (j && j.status === 1 && j.product) return fromOFF({ ...j.product, code: j.product.code || code });
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
const KCAL_IDS = [1008, 2047, 2048];

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

function usdaKey() { return (settings.usdaKey || "").trim() || USDA_DEMO; }

async function usdaSearch(q, dataTypes = ["Foundation", "SR Legacy", "Branded"], pageSize = 25) {
  const dt = dataTypes.map((d) => "&dataType=" + encodeURIComponent(d)).join("");
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${encodeURIComponent(usdaKey())}&query=${encodeURIComponent(q)}&pageSize=${pageSize}${dt}`;
  const j = await getJSON(url);
  return (j.foods || []).map(fromUSDA).filter(Boolean);
}

const stripZeros = (s) => String(s || "").replace(/^0+/, "");

async function usdaByBarcode(code) {
  const list = await usdaSearch(code, ["Branded"], 5);
  return list.find((f) => stripZeros(f.barcode) === stripZeros(code)) || null;
}

/* ---------- barcodes ---------- */
function upcEtoA(e) {
  // 8-digit UPC-E (number system, 6 digits, check) -> 12-digit UPC-A
  if (!/^[01]\d{7}$/.test(e)) return null;
  const ns = e[0], d = e.slice(1, 7), chk = e[7], last = d[5];
  let body;
  if ("012".includes(last)) body = d[0] + d[1] + last + "0000" + d[2] + d[3] + d[4];
  else if (last === "3") body = d[0] + d[1] + d[2] + "00000" + d[3] + d[4];
  else if (last === "4") body = d[0] + d[1] + d[2] + d[3] + "00000" + d[4];
  else body = d.slice(0, 5) + "0000" + last;
  return ns + body + chk;
}

function barcodeVariants(code, format) {
  const v = [code];
  if (format === "upc_e" || (code.length === 8 && /^[01]/.test(code) && format !== "ean_8")) {
    const a = upcEtoA(code);
    if (a) v.push(a, "0" + a);
  }
  if (code.length === 12) v.push("0" + code);            // UPC-A is stored as EAN-13 with a leading 0
  if (code.length === 13 && code[0] === "0") v.push(code.slice(1));
  return [...new Set(v)];
}

// Ask every source at once and take the first good answer instead of waiting on each in turn.
async function fetchBarcode(code, format) {
  const variants = barcodeVariants(code, format);
  let netFail = 0, attempts = 0;
  const wrap = (p) => p.then((f) => f || null, () => { netFail++; return null; });
  const offs = variants.map((c) => { attempts++; return wrap(offProduct(c)); });
  attempts++;
  const usda = wrap(usdaByBarcode(code));
  const firstOff = await new Promise((resolve) => {
    let left = offs.length;
    offs.forEach((p) => p.then((f) => { if (f) resolve(f); else if (--left === 0) resolve(null); }));
  });
  if (firstOff) return firstOff;
  const u = await usda;
  if (u) return u;
  if (netFail === attempts) { const e = new Error("offline"); e.offline = true; throw e; }
  return null;
}

function findLocalBarcode(code, format) {
  const vs = new Set(barcodeVariants(code, format).map(stripZeros));
  return Object.values(foods).find((f) => f.barcode && vs.has(stripZeros(f.barcode))) || null;
}

/* ---------- day view ---------- */
function totals(entries) {
  return entries.reduce((t, e) => ({ kcal: t.kcal + e.kcal, p: t.p + e.p, c: t.c + e.c, f: t.f + e.f }), { kcal: 0, p: 0, c: 0, f: 0 });
}

function render() {
  const key = dateKey(current);
  const today = dateKey(new Date());
  const yest = dateKey(addDays(new Date(), -1));
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

  renderWeightCard();

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
    const row = document.createElement("div");
    row.className = "meal-actions";
    const add = document.createElement("button");
    add.className = "meal-add";
    add.textContent = `Add to ${meal.toLowerCase()}`;
    add.addEventListener("click", () => openSearch(meal));
    row.appendChild(add);
    if (list.length) {
      const save = document.createElement("button");
      save.className = "meal-save";
      save.textContent = "Save as recipe";
      save.addEventListener("click", () => recipeFromMeal(list, meal));
      row.appendChild(save);
    }
    ml.appendChild(row);
    wrap.appendChild(sec);
  }
}

function amountText(e) {
  if (e.unit === "g") return `${r1(e.qty)} g`;
  if (e.unit === "oz") return `${r1(e.qty)} oz`;
  return `${r1(e.qty)} serving${e.qty === 1 ? "" : "s"}`;
}

function entryAsFood(e) {
  // Fallback when the source food is no longer saved: rebuild its numbers from the log entry.
  const q = e.qty || 1;
  const f = { id: e.foodId || "entry:" + e.id, name: e.name, brand: e.brand || "", source: "Your log", per100: null, perServing: null, serving: null };
  if (e.grams > 0) f.per100 = { kcal: e.kcal * 100 / e.grams, p: e.p * 100 / e.grams, c: e.c * 100 / e.grams, f: e.f * 100 / e.grams };
  if (e.unit === "serving" || !(e.grams > 0)) {
    f.perServing = { kcal: e.kcal / q, p: e.p / q, c: e.c / q, f: e.f / q };
    f.serving = { label: "1 serving", grams: e.grams > 0 ? e.grams / q : null };
  }
  return f;
}

/* ---------- amount sheet (log a food, or add it to a recipe) ---------- */
let activeFood = null, activeEntry = null, activeCtx = "log", activeIng = null, pendingMeal = null;
const picking = () => $("#recipe-sheet").open;

function openFood(food, entry = null, opts = {}) {
  activeFood = food;
  activeEntry = entry;
  activeCtx = opts.ctx || (picking() && !entry ? "ingredient" : "log");
  activeIng = opts.ingIndex ?? null;
  const isRecipe = food.type === "recipe";
  const ing = activeCtx === "ingredient";

  $("#food-name").textContent = food.name;
  $("#food-brand").textContent = food.brand || "";
  const sel = $("#food-unit");
  sel.innerHTML = unitsFor(food).map((u) => `<option value="${u.v}">${esc(u.t)}</option>`).join("");
  const setUnit = (u) => { if ([...sel.options].some((o) => o.value === u)) { sel.value = u; return true; } return false; };
  if (entry) {
    $("#food-qty").value = r1(entry.qty);
    setUnit(entry.unit);
    if (entry.meal) $("#food-meal").value = entry.meal;
  } else {
    const last = food.lastUse;
    if (last && setUnit(last.unit)) $("#food-qty").value = last.qty;
    else $("#food-qty").value = sel.value === "g" ? 100 : 1;
    $("#food-meal").value = pendingMeal || defaultMeal();
  }
  $("#food-meal-field").hidden = ing;
  $("#food-submit").disabled = false;
  $("#food-submit").textContent = ing ? (entry ? "Update ingredient" : "Add to recipe") : (entry ? "Save changes" : "Add to log");
  $("#food-delete").hidden = !entry;
  $("#food-delete").textContent = ing ? "Remove" : "Delete";
  $("#food-edit-recipe").hidden = !(isRecipe && !ing && foods[food.id]);
  $("#food-split-wrap").hidden = !(isRecipe && !ing && !entry);
  $("#food-split").checked = false;
  $("#food-ings").hidden = !isRecipe;
  if (isRecipe) $("#food-ings").textContent = (food.ingredients || []).map((i) => i.food.name).join(", ");
  $("#food-source").textContent = isRecipe
    ? `Your recipe, makes ${r1(food.servings)} serving${food.servings === 1 ? "" : "s"}`
    : food.source ? `Source: ${food.source}${food.barcode ? ", barcode " + food.barcode : ""}` : "";
  updatePreview();
  const d = $("#food-sheet");
  if (!d.open) d.showModal();
}

// Opens the amount sheet right away while a barcode is being looked up.
function showLookingUp(code) {
  activeFood = null;
  $("#food-name").textContent = "Looking up…";
  $("#food-brand").textContent = `Barcode ${code}`;
  $("#food-unit").innerHTML = "";
  $("#food-qty").value = "";
  $("#food-preview").innerHTML = `<div class="loading-bar"></div>`;
  $("#food-source").textContent = "";
  for (const id of ["#food-delete", "#food-edit-recipe", "#food-split-wrap", "#food-ings"]) $(id).hidden = true;
  $("#food-meal-field").hidden = picking();
  $("#food-submit").disabled = true;
  const d = $("#food-sheet");
  if (!d.open) d.showModal();
}

function updatePreview() {
  if (!activeFood) return;
  const n = nutrientsFor(activeFood, num($("#food-qty").value), $("#food-unit").value);
  $("#food-preview").innerHTML = previewHTML(n);
}
function previewHTML(n) {
  return `<div><b>${fmt(n.kcal)}</b><span>Calories</span></div><div><b>${r0(n.p)}g</b><span>Protein</span></div>` +
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
  if (String(food.id).startsWith("entry:")) return;
  foods[food.id] = { ...food, lastUse: { qty, unit } };
  recent = [food.id, ...recent.filter((id) => id !== food.id)];
  // keep custom foods and recipes forever, trim old recents
  const keep = new Set(recent.slice(0, 60));
  for (const id of Object.keys(foods)) if (!keep.has(id) && !foods[id].custom) delete foods[id];
  recent = recent.filter((id) => foods[id]);
  saveFoods();
}

function makeEntry(food, qty, unit, meal) {
  const n = nutrientsFor(food, qty, unit);
  return { foodId: food.id, name: food.name, brand: food.brand || "", meal, qty, unit, grams: n.grams,
    kcal: r1(n.kcal), p: r1(n.p), c: r1(n.c), f: r1(n.f) };
}

$("#food-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") return;
  if (!activeFood) { ev.preventDefault(); return; }
  const qty = num($("#food-qty").value);
  if (qty <= 0) { ev.preventDefault(); toast("Enter an amount above zero"); return; }
  const unit = $("#food-unit").value;

  if (activeCtx === "ingredient") {
    const item = { food: cleanFood(activeFood), qty, unit };
    if (activeIng != null) recipeDraft.ingredients[activeIng] = item;
    else recipeDraft.ingredients.push(item);
    rememberFood(activeFood, qty, unit);
    if ($("#search-sheet").open) $("#search-sheet").close();
    renderRecipe();
    return;
  }

  const meal = $("#food-meal").value;
  const key = dateKey(current);
  const list = log[key] || (log[key] = []);
  if (activeEntry) {
    const i = list.findIndex((e) => e.id === activeEntry.id);
    if (i >= 0) list[i] = { ...list[i], ...makeEntry(activeFood, qty, unit, meal) };
    toast("Changes saved");
  } else if (activeFood.type === "recipe" && $("#food-split").checked) {
    const factor = qty / (activeFood.servings || 1);
    let kcal = 0;
    for (const ing of activeFood.ingredients) {
      const e = makeEntry(ing.food, r1(ing.qty * factor * 100) / 100, ing.unit, meal);
      kcal += e.kcal;
      list.push({ id: uid(), at: Date.now(), ...e });
    }
    toast(`Added ${activeFood.ingredients.length} items, ${fmt(kcal)} cal`);
  } else {
    const e = makeEntry(activeFood, qty, unit, meal);
    list.push({ id: uid(), at: Date.now(), ...e });
    toast(`Added ${fmt(e.kcal)} cal to ${meal.toLowerCase()}`);
  }
  if ($("#search-sheet").open) $("#search-sheet").close();
  rememberFood(activeFood, qty, unit);
  saveLog();
  render();
});

$("#food-delete").addEventListener("click", () => {
  if (activeCtx === "ingredient") {
    if (activeIng != null) recipeDraft.ingredients.splice(activeIng, 1);
    $("#food-sheet").close();
    renderRecipe();
    return;
  }
  const key = dateKey(current);
  log[key] = (log[key] || []).filter((e) => e.id !== activeEntry.id);
  if (!log[key].length) delete log[key];
  saveLog();
  $("#food-sheet").close();
  render();
  toast("Deleted");
});

$("#food-edit-recipe").addEventListener("click", () => {
  const r = foods[activeFood.id];
  $("#food-sheet").close();
  if (r) openRecipe(r);
});

/* ---------- search sheet ---------- */
let searchSeq = 0, searchTimer;

function openSearch(meal = null) {
  if (!picking()) pendingMeal = meal;
  const p = picking();
  $("#search-context").hidden = !p;
  $("#open-quick").hidden = p;
  $("#open-new-recipe").hidden = p;
  $("#search-input").value = "";
  searchSeq++;
  showRecents();
  $("#search-sheet").showModal();
  setTimeout(() => $("#search-input").focus(), 50);
}

function chooseFood(food) {
  if (picking() && recipeDraft && food.id === recipeDraft.id) { toast("A recipe can't include itself"); return; }
  openFood(food);
}

function resultButton(food) {
  const b = document.createElement("button");
  b.className = "result";
  b.type = "button";
  const src = food.type === "recipe" ? `${(food.ingredients || []).length} ingredients` : food.source || "";
  b.innerHTML = `<span class="r-name">${esc(food.name)}</span><span class="r-kcal">${esc(headlineKcal(food))}</span>
    <span class="r-meta">${food.brand ? `<span>${esc(food.brand)}</span>` : ""}<span class="r-src">${esc(src)}</span></span>`;
  b.addEventListener("click", () => chooseFood(food));
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
  const byName = (a, b) => a.name.localeCompare(b.name);
  const recipes = Object.values(foods).filter((f) => f.type === "recipe" && !(recipeDraft && f.id === recipeDraft.id && picking())).sort(byName);
  const rec = recent.map((id) => foods[id]).filter((f) => f && f.type !== "recipe");
  const mine = Object.values(foods).filter((f) => f.custom && f.type !== "recipe").sort(byName);
  box.appendChild(section("Recipes", recipes));
  box.appendChild(section("Recent", rec.slice(0, 25)));
  box.appendChild(section("My foods", mine));
  if (!box.children.length) box.innerHTML = `<p class="status">Type a food to search millions of products. Foods you log show up here for one-tap re-adding.</p>`;
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const box = $("#search-results");
  const ql = q.toLowerCase();
  const localHits = Object.values(foods).filter((f) => (f.name + " " + (f.brand || "")).toLowerCase().includes(ql)).slice(0, 8);
  box.innerHTML = "";
  box.appendChild(section("Your foods and recipes", localHits));
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
      const code = f.barcode ? stripZeros(f.barcode) : null;
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

/* ---------- recipes ---------- */
let recipeDraft = null;

function recipeTotals(r) {
  return r.ingredients.reduce((t, i) => {
    const n = nutrientsFor(i.food, i.qty, i.unit);
    return { kcal: t.kcal + n.kcal, p: t.p + n.p, c: t.c + n.c, f: t.f + n.f };
  }, { kcal: 0, p: 0, c: 0, f: 0 });
}

function openRecipe(existing = null, preset = null) {
  recipeDraft = existing
    ? { id: existing.id, name: existing.name, servings: existing.servings || 1, ingredients: existing.ingredients.map((i) => ({ ...i })) }
    : { id: null, name: "", servings: 1, ingredients: [], ...(preset || {}) };
  $("#recipe-title").textContent = existing ? "Edit recipe" : "New recipe";
  $("#r-name").value = recipeDraft.name;
  $("#r-servings").value = recipeDraft.servings;
  $("#r-delete").hidden = !existing;
  renderRecipe();
  $("#recipe-sheet").showModal();
  if (!existing) setTimeout(() => $("#r-name").focus(), 50);
}

function renderRecipe() {
  const box = $("#r-list");
  box.innerHTML = "";
  if (!recipeDraft.ingredients.length) {
    box.innerHTML = `<p class="status small">No ingredients yet. Search or scan each one, with the amount you use.</p>`;
  }
  recipeDraft.ingredients.forEach((ing, i) => {
    const n = nutrientsFor(ing.food, ing.qty, ing.unit);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "entry";
    b.innerHTML = `<span class="e-name">${esc(ing.food.name)}</span><span class="e-kcal">${fmt(n.kcal)}</span>
      <span class="e-meta"><span>${esc(amountText(ing))}</span><span>P ${r0(n.p)}</span><span>C ${r0(n.c)}</span><span>F ${r0(n.f)}</span></span>`;
    b.addEventListener("click", () => openFood(ing.food, { qty: ing.qty, unit: ing.unit }, { ctx: "ingredient", ingIndex: i }));
    box.appendChild(b);
  });
  const servings = num($("#r-servings").value) || 1;
  const t = recipeTotals(recipeDraft);
  $("#r-per").textContent = servings === 1
    ? "Whole recipe"
    : `Per serving (whole recipe ${fmt(t.kcal)} cal, ${r1(servings)} servings)`;
  $("#r-preview").innerHTML = previewHTML({ kcal: t.kcal / servings, p: t.p / servings, c: t.c / servings, f: t.f / servings });
}
$("#r-servings").addEventListener("input", renderRecipe);
$("#r-name").addEventListener("input", () => { recipeDraft.name = $("#r-name").value; });

$("#r-add-search").addEventListener("click", () => openSearch());
$("#r-add-scan").addEventListener("click", () => openScanner());

$("#recipe-form").addEventListener("submit", (ev) => {
  if (ev.submitter && ev.submitter.value === "cancel") { recipeDraft = null; return; }
  const name = $("#r-name").value.trim();
  const servings = num($("#r-servings").value);
  if (!recipeDraft.ingredients.length) { ev.preventDefault(); toast("Add at least one ingredient"); return; }
  if (servings <= 0) { ev.preventDefault(); toast("Servings must be above zero"); return; }
  const t = recipeTotals(recipeDraft);
  const id = recipeDraft.id || "recipe:" + uid();
  const prev = foods[id] || {};
  foods[id] = {
    id, type: "recipe", custom: true, name, brand: "", source: "Your recipe",
    servings, ingredients: recipeDraft.ingredients,
    perServing: { kcal: t.kcal / servings, p: t.p / servings, c: t.c / servings, f: t.f / servings },
    per100: null, serving: { label: "1 serving", grams: null },
    lastUse: prev.lastUse,
  };
  saveFoods();
  recipeDraft = null;
  toast(prev.id ? "Recipe updated" : `Saved "${name}". Find it under Recipes in Search.`);
});

$("#r-delete").addEventListener("click", () => {
  if (!recipeDraft || !recipeDraft.id) return;
  if (!confirm("Delete this recipe? Days you already logged it stay as they are.")) return;
  delete foods[recipeDraft.id];
  recent = recent.filter((id) => id !== recipeDraft.id);
  saveFoods();
  recipeDraft = null;
  $("#recipe-sheet").close();
  toast("Recipe deleted");
});

$("#recipe-sheet").addEventListener("close", () => { recipeDraft = null; });

function recipeFromMeal(list, meal) {
  const ingredients = list.map((e) => ({ food: cleanFood(foods[e.foodId] || entryAsFood(e)), qty: e.qty, unit: e.unit }));
  openRecipe(null, { name: "", ingredients });
  $("#r-name").placeholder = `e.g. Usual ${meal.toLowerCase()}`;
}

$("#open-new-recipe").addEventListener("click", () => { $("#search-sheet").close(); openRecipe(); });

/* ---------- barcode scanning ----------
   Uses the browser's own BarcodeDetector where it exists (Android Chrome),
   otherwise ZXing-C++ compiled to WebAssembly. We run our own camera loop:
   higher resolution, decode only the area inside the box, and as fast as the
   phone can go instead of a fixed frame rate. */
const SCAN_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
let detector = null, detectorKind = "", scanStream = null, scanning = false, handled = false, scanTrack = null;
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

async function getDetector() {
  if (detector) return detector;
  try {
    if ("BarcodeDetector" in window && window.BarcodeDetector.getSupportedFormats) {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      if (SCAN_FORMATS.every((f) => sup.includes(f))) {
        detector = new window.BarcodeDetector({ formats: SCAN_FORMATS });
        detectorKind = "native";
        return detector;
      }
    }
  } catch {}
  const api = window.BarcodeDetectionAPI;
  if (api && api.BarcodeDetector) {
    prepareWasm(api);
    detector = new api.BarcodeDetector({ formats: SCAN_FORMATS });
    detectorKind = "zxing";
    return detector;
  }
  return null;
}

let wasmPrepared = false;
function prepareWasm(api = window.BarcodeDetectionAPI) {
  if (wasmPrepared || !api || !api.prepareZXingModule) return;
  wasmPrepared = true;
  const v = api.ZXING_WASM_VERSION;
  const overrides = v ? {
    locateFile: (path, prefix) => path.endsWith(".wasm") ? `https://cdn.jsdelivr.net/npm/zxing-wasm@${v}/dist/reader/${path}` : prefix + path,
  } : undefined;
  try { api.prepareZXingModule({ overrides, fireImmediately: true }); } catch {}
}

async function openScanner() {
  handled = false;
  const d = $("#scanner");
  $("#scan-hint").textContent = "Hold the barcode inside the box, about 6 inches away";
  $("#scan-manual-input").value = "";
  $("#scan-zoom").hidden = true;
  $("#scan-torch").hidden = true;
  d.classList.remove("got-it");
  if (!d.open) d.showModal();

  const det = await getDetector();
  if (!det) {
    $("#scan-hint").textContent = "The scanner didn't load. Check your connection, or type the number below.";
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (e) {
    $("#scan-hint").textContent = e && e.name === "NotAllowedError"
      ? "Camera access is off. Allow it for this site in iPhone Settings, or type the number below."
      : "Couldn't start the camera. Type the number below instead.";
    return;
  }
  if (!d.open || handled) { stopCamera(); return; }
  const video = $("#scan-video");
  video.srcObject = scanStream;
  try { await video.play(); } catch {}
  scanTrack = scanStream.getVideoTracks()[0];
  setupCameraExtras(scanTrack);
  scanning = true;
  scanLoop();
}

function setupCameraExtras(track) {
  let caps = {};
  try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch {}
  const adv = [];
  if (caps.focusMode && caps.focusMode.includes("continuous")) adv.push({ focusMode: "continuous" });
  if (adv.length) track.applyConstraints({ advanced: adv }).catch(() => {});
  if (caps.zoom && caps.zoom.max >= 1.5) {
    const btn = $("#scan-zoom");
    btn.hidden = false;
    const apply = (z) => {
      const zoom = Math.max(caps.zoom.min || 1, Math.min(caps.zoom.max, z));
      track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {});
      btn.textContent = z > 1 ? `${z}×` : "1×";
    };
    btn.onclick = () => { settings.scanZoom = settings.scanZoom > 1 ? 1 : 2; saveSettings(); apply(settings.scanZoom); };
    apply(settings.scanZoom || 2);
  }
  if (caps.torch) {
    const t = $("#scan-torch");
    t.hidden = false;
    let on = false;
    t.onclick = () => { on = !on; t.classList.toggle("on", on); track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); };
  }
}

// The decode area: the on-screen box mapped onto the camera frame, with some margin.
function cropRect(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const view = $("#scan-view").getBoundingClientRect();
  const box = $("#scan-frame").getBoundingClientRect();
  const scale = Math.max(view.width / vw, view.height / vh); // object-fit: cover
  const ox = (view.width - vw * scale) / 2, oy = (view.height - vh * scale) / 2;
  const padX = box.width * 0.12, padY = box.height * 0.25;
  let x = (box.left - view.left - padX - ox) / scale, y = (box.top - view.top - padY - oy) / scale;
  let w = (box.width + padX * 2) / scale, h = (box.height + padY * 2) / scale;
  x = Math.max(0, x); y = Math.max(0, y);
  w = Math.min(vw - x, w); h = Math.min(vh - y, h);
  if (!(w > 20 && h > 20)) return { x: 0, y: 0, w: vw, h: vh };
  return { x, y, w, h };
}

async function scanLoop() {
  const video = $("#scan-video");
  const next = () => {
    if (!scanning) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => scanLoop());
    else requestAnimationFrame(() => scanLoop());
  };
  if (!scanning || handled) return;
  if (video.readyState < 2 || !video.videoWidth) { next(); return; }
  const r = cropRect(video);
  const maxW = 1100; // enough pixels for small barcodes, small enough to decode fast
  const s = Math.min(1, maxW / r.w);
  const cw = Math.round(r.w * s), ch = Math.round(r.h * s);
  if (scanCanvas.width !== cw) scanCanvas.width = cw;
  if (scanCanvas.height !== ch) scanCanvas.height = ch;
  scanCtx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
  try {
    const found = await detector.detect(scanCanvas);
    const hit = found && found.find((b) => /^\d{8,14}$/.test(b.rawValue));
    if (hit && scanning && !handled) { onScan(hit.rawValue, hit.format); return; }
  } catch {}
  next();
}

function stopCamera() {
  scanning = false;
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  scanTrack = null;
  const v = $("#scan-video");
  v.srcObject = null;
}

function closeScanner() {
  stopCamera();
  const d = $("#scanner");
  if (d.open) d.close();
}
$("#scanner").addEventListener("close", stopCamera);

function onScan(code, format) {
  if (handled) return;
  handled = true;
  $("#scanner").classList.add("got-it");
  setTimeout(() => { closeScanner(); lookupBarcode(String(code).replace(/\D/g, ""), format); }, 120);
}

async function lookupBarcode(code, format) {
  if (!code) return;
  const local = findLocalBarcode(code, format);
  if (local) { chooseFood(local); return; }
  showLookingUp(code);
  try {
    const food = await fetchBarcode(code, format);
    if (!$("#food-sheet").open || activeFood) return; // closed or replaced while waiting
    if (food) { openFood(food); return; }
    $("#food-sheet").close();
    openCustom({ barcode: code });
  } catch {
    if ($("#food-sheet").open && !activeFood) $("#food-sheet").close();
    toast("Couldn't reach the food database. Check your connection.");
  }
}

$("#scan-manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#scan-manual-input").value.replace(/\D/g, "");
  if (code.length < 6) { toast("Barcodes are usually 8, 12 or 13 digits"); return; }
  handled = true;
  closeScanner();
  lookupBarcode(code);
});
$("#scan-close").addEventListener("click", closeScanner);
$("#open-scan").addEventListener("click", () => { pendingMeal = null; openScanner(); });
$("#search-scan").addEventListener("click", () => openScanner());
$("#open-search").addEventListener("click", () => openSearch());

/* ---------- weight ---------- */
const unit = () => settings.weightUnit === "kg" ? "kg" : "lb";
const toDisplay = (kg) => unit() === "kg" ? kg : kg / LB;
const fromDisplay = (v) => unit() === "kg" ? v : v * LB;
let weightRange = 90;

function weightSeries() {
  return Object.keys(weights).sort().map((k) => ({ k, t: keyToDate(k).getTime(), v: toDisplay(weights[k]) }));
}

// 7-day average: for each weigh-in, the mean of all weigh-ins in the 7 days ending that day.
function withTrend(series) {
  const out = [];
  let lo = 0, sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i].v;
    while (series[i].t - series[lo].t > 6.5 * 864e5) { sum -= series[lo].v; lo++; }
    out.push({ ...series[i], avg: sum / (i - lo + 1) });
  }
  return out;
}

function renderWeightCard() {
  const all = withTrend(weightSeries());
  const key = dateKey(current);
  const u = unit();
  const todays = weights[key];
  const valueEl = $("#wcard-value"), metaEl = $("#wcard-meta");
  if (!all.length) {
    valueEl.textContent = "Log weight";
    metaEl.textContent = "Tap to add a weigh-in";
    $("#wcard-sub").textContent = "";
    $("#wcard-spark").innerHTML = "";
    return;
  }
  const upto = all.filter((p) => p.k <= key);
  const last = upto[upto.length - 1] || all[all.length - 1];
  if (todays != null) {
    valueEl.textContent = `${fmt1(toDisplay(todays))} ${u}`;
  } else {
    valueEl.textContent = "Log weight";
  }
  const lastDay = keyToDate(last.k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  metaEl.textContent = todays != null ? `7-day average ${fmt1(last.avg)} ${u}` : `Last: ${fmt1(last.v)} ${u} on ${lastDay}`;
  const monthAgo = dateKey(addDays(keyToDate(last.k), -30));
  const base = upto.find((p) => p.k >= monthAgo);
  if (base && base !== last) {
    const ch = last.avg - base.avg;
    $("#wcard-sub").textContent = Math.abs(ch) < 0.05 ? "Steady this month" : `${ch < 0 ? "Down" : "Up"} ${fmt1(Math.abs(ch))} ${u} in 30 days`;
  } else $("#wcard-sub").textContent = "";
  const spark = upto.filter((p) => p.k >= monthAgo);
  $("#wcard-spark").innerHTML = spark.length >= 2 ? sparkSVG(spark) : "";
}

function sparkSVG(pts) {
  const W = 96, H = 36, t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vals = pts.map((p) => p.avg);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  const x = (t) => 2 + (t1 === t0 ? W / 2 : ((t - t0) / (t1 - t0)) * (W - 4));
  const y = (v) => 3 + (1 - (v - lo) / (hi - lo)) * (H - 6);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join("");
  const l = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path d="${d}" class="sp-line"/><circle cx="${x(l.t)}" cy="${y(l.avg)}" r="3" class="sp-dot"/></svg>`;
}

function openWeight(dateK = dateKey(current)) {
  document.querySelectorAll(".w-unit").forEach((e) => (e.textContent = unit()));
  $("#w-date").max = dateKey(new Date());
  setWeighDate(dateK);
  $("#weight-sheet").showModal();
  renderWeightSheet(); // after opening, so the chart can measure its width
}

function setWeighDate(k) {
  $("#w-date").value = k;
  const has = weights[k] != null;
  $("#w-value").value = has ? r1(toDisplay(weights[k])) : "";
  $("#w-save").textContent = has ? "Update" : "Save";
  $("#w-delete").hidden = !has;
}
$("#w-date").addEventListener("change", () => { if ($("#w-date").value) setWeighDate($("#w-date").value); });

$("#weigh-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const k = $("#w-date").value, v = num($("#w-value").value);
  if (!k) return;
  if (k > dateKey(new Date())) { toast("That date is in the future"); return; }
  if (v <= 0) { toast("Enter your weight"); return; }
  weights[k] = Math.round(fromDisplay(v) * 1000) / 1000;
  saveWeights();
  setWeighDate(k);
  $("#w-value").blur();
  renderWeightSheet();
  render();
  toast("Weight saved");
});
$("#w-delete").addEventListener("click", () => {
  const k = $("#w-date").value;
  delete weights[k];
  saveWeights();
  setWeighDate(k);
  renderWeightSheet();
  render();
  toast("Weigh-in deleted");
});

$("#w-range").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  weightRange = num(b.dataset.days);
  renderWeightSheet();
});

function niceStep(span) {
  const raw = span / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

function renderWeightSheet() {
  document.querySelectorAll("#w-range button").forEach((b) => b.setAttribute("aria-selected", String(num(b.dataset.days) === weightRange)));
  const u = unit();
  const all = withTrend(weightSeries());
  const startK = weightRange ? dateKey(addDays(new Date(), -weightRange)) : "";
  const pts = all.filter((p) => p.k >= startK);
  const chart = $("#w-chart");
  const readout = $("#w-readout");
  const describe = (p) => `${keyToDate(p.k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${fmt1(p.v)} ${u}, average ${fmt1(p.avg)}`;

  if (pts.length < 2) {
    chart.innerHTML = `<p class="status small">${all.length ? "Log a couple more weigh-ins in this range to see a trend." : "Your trend shows up here after a couple of weigh-ins. Weigh in first thing in the morning for the steadiest numbers."}</p>`;
    readout.textContent = pts.length ? describe(pts[0]) : "";
    $("#w-legend").hidden = true;
    $("#w-stats").innerHTML = "";
  } else {
    $("#w-legend").hidden = false;
    const W = Math.max(280, chart.clientWidth || 340), H = 190;
    const L = 40, R = 10, T = 10, B = 24;
    const t0 = weightRange ? Math.min(pts[0].t, addDays(new Date(), -weightRange).getTime()) : pts[0].t;
    const t1 = Math.max(pts[pts.length - 1].t, weightRange ? Date.now() : pts[pts.length - 1].t);
    const vals = pts.flatMap((p) => [p.v, p.avg]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const minSpan = u === "kg" ? 2 : 4;
    if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
    const step = niceStep(hi - lo);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    let g = "";
    for (let v = lo; v <= hi + 1e-9; v += step) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`;
      g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${Number.isInteger(step) ? r0(v) : v.toFixed(1)}</text>`;
    }
    const fmtD = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    g += `<text x="${L}" y="${H - 6}" class="ax">${fmtD(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="ax">${fmtD(t1)}</text>`;
    const dots = pts.map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${pts.length > 120 ? 2 : 3}" class="w-dot"/>`).join("");
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.avg).toFixed(1)}`).join("");
    chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Weight over time">${g}${dots}
      <path d="${line}" class="w-trend"/><line class="cross" y1="${T}" y2="${H - B}" x1="-10" x2="-10"/>
      <circle class="sel" r="5" cx="-10" cy="-10"/><rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent" class="hit"/></svg>`;
    const svg = chart.querySelector("svg");
    const cross = svg.querySelector(".cross"), sel = svg.querySelector(".sel");
    const pick = (p) => {
      cross.setAttribute("x1", x(p.t)); cross.setAttribute("x2", x(p.t));
      sel.setAttribute("cx", x(p.t)); sel.setAttribute("cy", y(p.v));
      readout.textContent = describe(p);
    };
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      pick(best);
    };
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerdown", onMove);
    pick(pts[pts.length - 1]);

    const first = pts[0], last = pts[pts.length - 1];
    const days = (last.t - first.t) / 864e5;
    const ch = last.avg - first.avg;
    const perWeek = days >= 7 ? (ch / days) * 7 : null;
    const sign = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmt1(Math.abs(n));
    $("#w-stats").innerHTML =
      `<div><b>${fmt1(last.avg)}</b><span>7-day average, ${u}</span></div>` +
      `<div><b>${sign(ch)}</b><span>Change in range, ${u}</span></div>` +
      `<div><b>${perWeek == null ? "–" : sign(perWeek)}</b><span>Per week, ${u}</span></div>`;
  }

  const hist = $("#w-history");
  hist.innerHTML = "";
  const rows = all.slice().reverse().slice(0, 120);
  if (!rows.length) hist.innerHTML = `<p class="status small">No weigh-ins yet.</p>`;
  rows.forEach((p, i) => {
    const prev = rows[i + 1];
    const diff = prev ? p.v - prev.v : null;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "w-row";
    b.innerHTML = `<span>${keyToDate(p.k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: p.k.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric" })}</span>
      <span class="w-diff">${diff == null ? "" : (diff > 0 ? "+" : diff < 0 ? "−" : "±") + fmt1(Math.abs(diff))}</span><b>${fmt1(p.v)} ${u}</b>`;
    b.addEventListener("click", () => { setWeighDate(p.k); $("#weight-sheet").scrollTo({ top: 0, behavior: "smooth" }); });
    hist.appendChild(b);
  });
}

$("#open-weight").addEventListener("click", () => openWeight());

/* ---------- settings ---------- */
function openSettings() {
  const g = settings.goals;
  $("#g-kcal").value = g.kcal; $("#g-p").value = g.p; $("#g-c").value = g.c; $("#g-f").value = g.f;
  $("#s-key").value = settings.usdaKey || "";
  $("#s-unit").value = unit();
  $("#settings-sheet").showModal();
}
$("#settings-form").addEventListener("submit", () => {
  settings.goals = {
    kcal: num($("#g-kcal").value) || 2200, p: num($("#g-p").value), c: num($("#g-c").value), f: num($("#g-f").value),
  };
  settings.usdaKey = $("#s-key").value.trim();
  settings.weightUnit = $("#s-unit").value;
  saveSettings();
  render();
});
$("#open-settings").addEventListener("click", openSettings);

$("#export-btn").addEventListener("click", async () => {
  const data = JSON.stringify({ app: "tally", version: 2, exported: new Date().toISOString(), settings, log, foods, recent, weights }, null, 1);
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
    settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    log = d.log || {}; foods = d.foods || {}; recent = d.recent || []; weights = d.weights || {};
    saveSettings(); saveLog(); saveFoods(); saveWeights();
    $("#settings-sheet").close();
    render();
    toast("Backup imported");
  } catch { toast("That file isn't a Tally backup"); }
  e.target.value = "";
});

$("#wipe-btn").addEventListener("click", () => {
  if (!confirm("Delete your whole food log, recipes, weigh-ins, saved foods and goals from this phone? This can't be undone.")) return;
  for (const k of ["settings", "log", "foods", "recent", "weights"]) localStorage.removeItem("tally." + k);
  location.reload();
});

/* ---------- misc wiring ---------- */
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
// tap the dimmed backdrop to close a sheet (not the recipe builder, so a stray tap can't lose your work)
document.querySelectorAll("dialog.sheet:not([data-keep-open])").forEach((d) => d.addEventListener("click", (e) => {
  if (e.target !== d) return;
  const r = d.getBoundingClientRect();
  if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) d.close();
}));

$("#prev-day").addEventListener("click", () => { current = addDays(current, -1); render(); });
$("#next-day").addEventListener("click", () => {
  const n = addDays(current, 1);
  if (dateKey(n) <= dateKey(new Date())) { current = n; render(); }
});
$("#date-label").addEventListener("click", () => { current = new Date(); render(); });

// When the app comes back to the foreground on a new day, jump to today.
let lastSeen = dateKey(new Date());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") { if (scanning) closeScanner(); return; }
  const now = dateKey(new Date());
  if (now !== lastSeen) { lastSeen = now; current = new Date(); render(); }
});

// Warm up the barcode decoder in the background so the first scan doesn't wait on it.
window.addEventListener("load", () => setTimeout(() => prepareWasm(), 800));

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

render();
