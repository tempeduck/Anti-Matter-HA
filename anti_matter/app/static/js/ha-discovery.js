/* Home Assistant discovery: preview, select, then add/fill blanks atomically.
 * i18n-dynamic: ha.discovery_status_ ha.discovery_reason_
 */
(function (global) {
  "use strict";
  var AM = global.AM, h = AM.h, t = AM.t, icon = AM.icon;
  var SHEET = "dialog-ha-discovery", D = null, wired = false, R = {};
  var FIELD_KEYS = {
    name: "code.name", device_vendor: "filter.vendor", device_product: "filter.product", area: "code.area",
    manual_code: "code.other_manual", qr_payload: "code.other_qr", setup_id: "decode.hk_setup_id",
    code_type: "code.protocol", homekit_category: "code.homekit_category", homekit_flag: "decode.hk_flags",
    zwave_pin: "code.decode_zwave_pin", custom_standard: "code.other_standard", ha_link: "ha.discovery_link",
  };
  function actionable(row) { return row.status === "new" || row.status === "update"; }
  function still(model) { return D === model && AM.sheets.isOpen(SHEET); }
  function visibleRows() {
    var q = D.query.trim().toLocaleLowerCase();
    return (D.data.rows || []).filter(function (row) {
      return !q || [row.name, row.existing_name, row.area, row.entity_id, row.protocol].join(" ").toLocaleLowerCase().includes(q);
    });
  }
  function footer() {
    var btn = AM.byId("had-apply"), n = D ? D.selected.size : 0;
    btn.textContent = t(D && D.busy ? "ha.discovery_applying" : "ha.discovery_apply", { count: n });
    btn.disabled = !D || D.loading || D.busy || !n || n > 1000;
    btn.setAttribute("aria-busy", String(!!(D && D.busy)));
    AM.$$("[data-close]", AM.byId(SHEET)).forEach(function (b) { b.disabled = !!(D && D.busy); });
    if (R.all && D && D.data) {
      var actionableRows = visibleRows().filter(actionable), selected = actionableRows.filter(function (row) { return D.selected.has(row.id); }).length;
      R.all.disabled = D.busy || !actionableRows.length;
      R.all.checked = !!actionableRows.length && selected === actionableRows.length;
      R.all.indeterminate = selected > 0 && selected < actionableRows.length;
    }
  }
  function renderRows() {
    var rows = visibleRows();
    AM.fill(R.list, rows.map(function (row) {
      var check = h("input", { type: "checkbox", id: "had-row-" + row.id, disabled: !actionable(row) || D.busy });
      check.checked = D.selected.has(row.id);
      check.addEventListener("change", function () { if (check.checked) D.selected.add(row.id); else D.selected.delete(row.id); footer(); });
      var fields = row.changes.map(function (key) { return t(FIELD_KEYS[key] || "code.device_details"); });
      return h("div", { class: "had-row", "data-status": row.status }, check,
        h("div", { class: "had-row__body" },
          h("label", { class: "had-row__name", for: check.id, dir: "auto" }, row.existing_name || row.name),
          h("span", { class: "tag" }, t(["ha", "discovery_status_" + row.status].join("."))),
          h("span", { class: "field__hint", dir: "auto" }, [row.name, row.area, row.protocol].filter(Boolean).join(" · ")),
          row.entity_id ? h("span", { class: "field__hint had-row__entity", dir: "ltr" }, row.entity_id) : null,
          fields.length ? h("span", { class: "field__hint" }, t("ha.discovery_fields", { fields: AM.fmt.list(fields) })) : null,
          row.metadata ? h("span", { class: "field__hint" }, AM.fmt.list(Object.keys(row.metadata).map(function (key) {
            return t("ha.discovery_value", { field: t(FIELD_KEYS[key] || "code.device_details"), value: row.metadata[key] });
          }))) : null,
          row.reason ? h("span", { class: "field__hint field__hint--warn" }, t(["ha", "discovery_reason_" + row.reason].join("."))) : null,
          row.target_id ? h("button", { class: "btn btn--sm", type: "button", disabled: D.busy, onclick: function () {
            AM.sheets.close(SHEET, null, "api"); AM.act("openEditor", row.target_id);
          } }, t("scan.open_existing")) : null));
    }));
    if (!rows.length) R.list.appendChild(h("p", { class: "field__hint" }, t("ha.discovery_no_matches")));
    footer();
  }
  function render() {
    if (!D) return;
    R = {};
    var kids = [h("p", { class: "field__hint" }, t("ha.discovery_hint"))];
    if (D.loading || D.busy) kids.push(h("div", { class: "notice", role: "status", "aria-live": "polite" },
      icon("loader-circle", "am-spin"), h("div", { class: "notice__body" }, t(D.busy ? "ha.discovery_applying" : "ha.discovery_searching"))));
    if (D.error) kids.push(h("div", { class: "notice notice--danger", role: "alert", id: "had-error" },
      icon("circle-alert"), h("div", { class: "notice__body" }, D.error)));
    if (D.result) kids.push(h("div", { class: "notice", role: "status", id: "had-success" },
      icon("circle-check"), h("div", { class: "notice__body" },
        h("b", null, t("ha.discovery_saved", D.result)), h("span", { dir: "ltr" }, t("ha.discovery_backup", { file: D.result.backup })))));
    if (!D.loading && !D.busy) kids.push(h("button", { class: "btn btn--sm", type: "button", id: "had-search-again", onclick: search },
      icon("search"), h("span", null, t("ha.discovery_search_again"))));
    if (D.data) {
      kids.push(h("p", { class: "field__hint", id: "had-summary", role: "status" }, t("ha.discovery_summary", {
        devices: D.data.devices_searched, without: D.data.without_codes, rows: D.data.rows.length,
      })));
      R.query = h("input", { class: "input", id: "had-filter", type: "search", "aria-label": t("ha.discovery_filter"), placeholder: t("ha.discovery_filter") });
      R.query.value = D.query; R.query.disabled = D.busy;
      R.query.addEventListener("input", function () { D.query = R.query.value; renderRows(); });
      R.all = h("input", { id: "had-select-all", type: "checkbox" });
      R.all.addEventListener("change", function () {
        visibleRows().filter(actionable).forEach(function (row) { if (R.all.checked) D.selected.add(row.id); else D.selected.delete(row.id); });
        renderRows();
      });
      R.list = h("div", { class: "had-list", id: "had-list" });
      kids.push(R.query, h("label", { class: "had-select" }, R.all, h("span", null, t("ha.discovery_select_all"))), R.list);
    }
    AM.fill(AM.byId("had-body"), kids);
    if (D.data) renderRows(); else footer();
  }
  async function search() {
    if (!D || D.busy) return;
    var model = D, request = ++D.request;
    if (D.abort) D.abort.abort();
    D.abort = new AbortController(); D.loading = true; D.data = null; D.error = ""; D.result = null; D.selected.clear(); D.query = "";
    render();
    try {
      var data = await AM.api("/ha/discover", { method: "POST", signal: D.abort.signal });
      if (still(model) && D.request === request) D.data = data;
    } catch (e) {
      if (still(model) && D.request === request && e.name !== "AbortError") D.error = t("ha.discovery_failed");
    } finally {
      if (still(model) && D.request === request) { D.loading = false; render(); }
    }
  }
  async function apply() {
    if (!D || D.loading || D.busy || !D.data || !D.selected.size) return;
    var model = D;
    D.busy = true; D.error = ""; render();
    try {
      var result = await AM.api("/ha/discover/apply", { method: "POST", body: { session_id: D.data.session_id, candidate_ids: Array.from(D.selected) } });
      if (still(model)) { D.result = result; D.data = null; D.selected.clear(); }
      AM.toast({ message: t("ha.discovery_saved", result), icon: "circle-check" });
      try { await AM.refresh({ force: true }); } catch (e) { AM.reportError(e); }
    } catch (e) {
      if (still(model)) {
        if (/^ha_discovery_(changed|source_changed|expired)$/.test(e.code || "")) {
          D.data = null; D.selected.clear(); D.error = t("ha.discovery_stale");
        } else D.error = e.userMessage || t("ha.discovery_apply_failed");
      }
    } finally { if (still(model)) { D.busy = false; render(); } }
  }
  function open() {
    if (AM.sheets.isOpen(SHEET)) return true;
    if (!wired) { wired = true; AM.byId("had-apply").addEventListener("click", apply); }
    D = { data: null, query: "", selected: new Set(), request: 0, loading: false, busy: false, error: "", result: null, abort: null };
    render();
    AM.sheets.open(SHEET, { beforeClose: function () { return !D || !D.busy; }, onClose: function () { if (D && D.abort) D.abort.abort(); D = null; R = {}; } });
    search(); return true;
  }
  AM.provide("openHaDiscovery", open);
  AM.on("locale", function () { if (D && AM.sheets.isOpen(SHEET)) render(); });
})(window);
