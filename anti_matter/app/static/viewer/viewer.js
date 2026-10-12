/* Read-only export viewer. All imported values reach the DOM as text, never HTML.
 * No storage, fetch, HA requests, external resources or embedded vault data.
 * i18n-dynamic: code.protocol_ code.conn_
 */
(function () {
  "use strict";
  var strings = JSON.parse(document.getElementById("strings").textContent);
  function t(key, vars) {
    var text = strings[key] || key;
    Object.keys(vars || {}).forEach(function (k) { text = text.replaceAll("{" + k + "}", String(vars[k])); });
    return text;
  }
  function text(value) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    Array.prototype.slice.call(arguments, 2).forEach(function (child) {
      if (child != null) node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }
  var root = document.getElementById("viewer"), vault = null, categories = new Map(), page = 0, loadId = 0;
  var SIZE = 50, MAX_BYTES = 16 * 1024 * 1024;
  var file = el("input", { type: "file", id: "viewer-file", accept: ".json,application/json" });
  var error = el("p", { id: "viewer-error", role: "alert", hidden: "" });
  var filename = el("p", { id: "viewer-filename", class: "subtle", "aria-live": "polite" });
  var search = el("input", { id: "viewer-search", type: "search", placeholder: t("search.placeholder") });
  var protocol = el("select", { id: "viewer-protocol", "aria-label": t("code.protocol") }, el("option", { value: "" }, t("viewer.all_protocols")));
  ["matter", "homekit", "zwave", "zigbee", "tuya", "other"].forEach(function (p) {
    protocol.appendChild(el("option", { value: p }, t(["code", "protocol_" + p].join("."))));
  });
  var category = el("select", { id: "viewer-category", "aria-label": t("categories.title") });
  var trash = el("input", { id: "viewer-trash", type: "checkbox" });
  var filters = el("section", { class: "filters", hidden: "", "aria-label": t("viewer.filters") },
    el("label", {}, t("viewer.search"), search),
    el("label", {}, t("code.protocol"), protocol),
    el("label", {}, t("categories.title"), category),
    el("label", { class: "check" }, trash, t("viewer.include_trash")));
  var count = el("p", { id: "viewer-count", role: "status" });
  var list = el("section", { id: "viewer-codes", "aria-label": t("viewer.codes") });
  var previous = el("button", { id: "viewer-previous", type: "button" }, t("viewer.previous"));
  var next = el("button", { id: "viewer-next", type: "button" }, t("viewer.next"));
  var navigation = el("nav", { class: "pagination", hidden: "", "aria-label": t("viewer.pages") }, previous, next);
  var clear = el("button", { id: "viewer-clear", type: "button", hidden: "" }, t("viewer.clear"));
  root.appendChild(el("header", {}, el("span", { class: "brand" }, "ANTI-MATTER"),
    el("h1", {}, t("viewer.title")), el("p", { class: "subtle" }, t("viewer.hint"))));
  root.appendChild(el("section", { class: "file-pick" }, el("label", { for: "viewer-file" }, t("viewer.choose")), file, clear, filename, error));
  root.appendChild(filters); root.appendChild(count); root.appendChild(list); root.appendChild(navigation);

  function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
  function validate(value) {
    return object(value) && Array.isArray(value.codes) && value.codes.length <= 100000 && value.codes.every(object) &&
      (value.categories == null || Array.isArray(value.categories) && value.categories.length <= 100000 && value.categories.every(object));
  }
  function resetFilters() { search.value = ""; protocol.value = ""; trash.checked = false; page = 0; }
  function categoryIds(c) {
    return (Array.isArray(c.category_ids) ? c.category_ids : c.category_id != null ? [c.category_id] : []).map(text).filter(Boolean);
  }
  function categoryNames(c) { return categoryIds(c).map(function (id) { return categories.get(id) || id; }); }
  function proto(c) {
    var p = text(c.code_type || "matter").toLowerCase();
    var custom = text(c.custom_standard).toLowerCase();
    if (p === "other" && (custom === "zigbee" || custom === "tuya")) return custom;
    return ["matter", "homekit", "zwave", "zigbee", "tuya"].includes(p) ? p : "other";
  }
  function setCategories() {
    categories = new Map((vault.categories || []).map(function (c) { return [text(c.id), text(c.name) || text(c.id)]; }));
    vault.codes.forEach(function (c) { categoryIds(c).forEach(function (id) { if (!categories.has(id)) categories.set(id, id); }); });
    category.replaceChildren(el("option", { value: "" }, t("viewer.all_categories")), el("option", { value: "none" }, t("categories.none")));
    Array.from(categories).sort(function (a, b) { return a[1].localeCompare(b[1]); }).forEach(function (entry) {
      // Prefix IDs so a real category named "none" never collides with Uncategorized.
      category.appendChild(el("option", { value: "id:" + entry[0] }, entry[1]));
    });
  }
  file.addEventListener("change", async function () {
    var chosen = file.files[0], request = ++loadId;
    if (!chosen) return;
    error.hidden = true;
    try {
      if (chosen.size > MAX_BYTES) throw Error("size");
      var parsed = JSON.parse((await chosen.text()).replace(/^\uFEFF/, ""));
      if (request !== loadId) return;
      if (!validate(parsed)) throw Error("format");
      vault = parsed; resetFilters(); setCategories();
      filename.textContent = chosen.name; filters.hidden = clear.hidden = false; render();
    } catch (_) {
      if (request !== loadId) return;
      error.textContent = t("viewer.invalid"); error.hidden = false;
    } finally { if (request === loadId) file.value = ""; }
  });
  clear.addEventListener("click", function () {
    loadId++; vault = null; categories.clear(); list.replaceChildren(); filename.textContent = count.textContent = "";
    filters.hidden = navigation.hidden = clear.hidden = error.hidden = true; file.value = ""; resetFilters();
  });
  [search, protocol, category, trash].forEach(function (control) {
    control.addEventListener(control === search ? "input" : "change", function () { page = 0; render(); });
  });
  previous.addEventListener("click", function () { page--; render(); count.scrollIntoView({ block: "nearest" }); });
  next.addEventListener("click", function () { page++; render(); count.scrollIntoView({ block: "nearest" }); });
  function render() {
    if (!vault) return;
    var q = search.value.trim().toLocaleLowerCase();
    var matches = vault.codes.filter(function (c) {
      if (!trash.checked && c.deleted_at) return false;
      if (protocol.value && proto(c) !== protocol.value) return false;
      var ids = categoryIds(c);
      if (category.value === "none" && ids.length || category.value.startsWith("id:") && !ids.includes(category.value.slice(3))) return false;
      if (!q) return true;
      return [c.name, c.manual_code, c.qr_payload, c.device_vendor, c.device_product, c.device_type, c.area, c.notes, c.description,
        c.custom_standard, c.ha_link && c.ha_link.entity_id].map(text).concat(categoryNames(c)).join(" ").toLocaleLowerCase().includes(q);
    });
    page = Math.max(0, Math.min(page, Math.ceil(matches.length / SIZE) - 1));
    var start = page * SIZE, end = Math.min(start + SIZE, matches.length);
    count.textContent = t("viewer.count", { start: matches.length ? start + 1 : 0, end: end, total: matches.length });
    list.replaceChildren.apply(list, matches.slice(start, end).map(card));
    if (!matches.length) list.appendChild(el("p", { class: "subtle" }, t("viewer.no_matches")));
    navigation.hidden = matches.length <= SIZE; previous.disabled = page === 0; next.disabled = end >= matches.length;
  }
  function pair(dl, key, value) {
    if (!text(value)) return;
    dl.appendChild(el("dt", {}, t(key))); dl.appendChild(el("dd", { dir: "auto" }, text(value)));
  }
  function card(c) {
    var p = proto(c), name = text(c.name) || t("scan.unnamed");
    var details = el("details", { class: "code" }, el("summary", {}, el("strong", { dir: "auto" }, name),
      el("span", { class: "tag" }, t(["code", "protocol_" + p].join("."))), el("span", { class: "subtle", dir: "auto" }, text(c.area)),
      c.deleted_at ? el("span", { class: "tag" }, t("trash.title")) : null));
    var built = false;
    details.addEventListener("toggle", function () {
      if (!details.open || built) return;
      built = true;
      var body = el("div", { class: "code-body" }), fields = el("dl");
      pair(fields, "code.other_manual", c.manual_code); pair(fields, "code.other_qr", c.qr_payload);
      pair(fields, "code.other_standard", c.custom_standard);
      pair(fields, "filter.vendor", c.device_vendor); pair(fields, "filter.product", c.device_product);
      pair(fields, "filter.type", c.device_type); pair(fields, "code.area", c.area);
      pair(fields, "categories.title", categoryNames(c).join(", "));
      pair(fields, "code.description", c.description); pair(fields, "code.notes", c.notes);
      if (p === "homekit") {
        pair(fields, "decode.hk_setup_id", c.setup_id); pair(fields, "code.homekit_category", c.homekit_category);
        pair(fields, "decode.hk_flags", c.homekit_flag);
      }
      if (p === "zwave") pair(fields, "code.decode_zwave_pin", c.zwave_pin);
      var connections = ["wifi", "matter", "zigbee", "bluetooth", "zwave"].filter(function (conn) { return c["conn_" + conn] === true; });
      pair(fields, "code.connectivity", connections.map(function (conn) { return t(["code", "conn_" + conn].join(".")); }).join(", "));
      pair(fields, "code.in_use", c.in_use === true ? t("card.in_use") : t("card.spare"));
      pair(fields, "ha.entity", c.ha_link && c.ha_link.entity_id);
      pair(fields, "viewer.device_id", c.ha_link && c.ha_link.device_id);
      pair(fields, "code.added_at", c.created_at);
      body.appendChild(fields);
      // Generate only a stored QR payload. Manual-only labels stay manual-only.
      var payload = text(c.qr_payload);
      if (payload && payload.length <= 8192) {
        try { body.prepend(qr(payload, name, p)); }
        catch (_) { body.prepend(el("p", { class: "subtle" }, t("viewer.qr_failed"))); }
      } else body.prepend(el("p", { class: "subtle" }, payload ? t("viewer.qr_failed") : t("card.no_qr")));
      details.appendChild(body);
    });
    return details;
  }
  function qr(payload, name, p) {
    var code = qrcode(0, "M"); code.addData(payload, "Byte"); code.make();
    var n = code.getModuleCount(), ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + (n + 8) + " " + (n + 8)); svg.setAttribute("class", "qr");
    svg.setAttribute("role", "img"); svg.setAttribute("aria-label", t("card.qr_label", { name: name, protocol: t(["code", "protocol_" + p].join(".")) }));
    svg.setAttribute("shape-rendering", "crispEdges");
    var bg = document.createElementNS(ns, "rect"); bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", "white"); svg.appendChild(bg);
    var pixels = document.createElementNS(ns, "path"), path = "";
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (code.isDark(y, x)) path += "M" + (x + 4) + " " + (y + 4) + "h1v1h-1z";
    pixels.setAttribute("d", path); pixels.setAttribute("fill", "black"); svg.appendChild(pixels);
    return svg;
  }
})();
