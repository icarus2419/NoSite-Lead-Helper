/* NoSite Leads Helper — popup logic
 *
 * Talks to the content script via chrome.tabs.sendMessage, and persists
 * saved leads in chrome.storage.local under STORAGE_KEY.
 *
 * Everything is defensive: messaging can fail if the content script isn't
 * loaded (e.g. the Maps tab was open before the extension was installed), so
 * we try to inject it on demand and show a friendly message on failure.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "nosite_leads";

  const LEAD_STATUSES = [
    "Not Called",
    "No Answer",
    "Interested",
    "Sent Mockup",
    "Follow Up",
    "Closed",
    "Not Interested",
  ];

  /* ---- DOM refs ---- */
  const $ = (id) => document.getElementById(id);
  const statusBar = $("statusBar");
  const scanResultsSection = $("scanResultsSection");
  const scanResults = $("scanResults");
  const scanCount = $("scanCount");
  const leadsSection = $("leadsSection");
  const leadsList = $("leadsList");
  const leadsCount = $("leadsCount");

  /* ----------------------------------------------------------------------
   * Status messages
   * -------------------------------------------------------------------- */
  let statusTimer = null;
  function showStatus(message, type = "info", autoHide = true) {
    statusBar.textContent = message;
    statusBar.className = "status-bar " + type;
    statusBar.classList.remove("hidden");
    if (statusTimer) clearTimeout(statusTimer);
    if (autoHide) {
      statusTimer = setTimeout(() => statusBar.classList.add("hidden"), 5000);
    }
  }

  /* ----------------------------------------------------------------------
   * Button busy state — disable + show spinner during async work, then
   * restore the original label so async actions always give feedback.
   * -------------------------------------------------------------------- */
  function setBusy(btn, busyLabel) {
    if (!btn) return;
    if (btn._origHtml == null) btn._origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>' + escapeHtml(busyLabel || "Working…");
  }
  function clearBusy(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove("is-loading");
    if (btn._origHtml != null) {
      btn.innerHTML = btn._origHtml;
      btn._origHtml = null;
    }
  }

  /* ----------------------------------------------------------------------
   * Storage helpers (promisified)
   * -------------------------------------------------------------------- */
  function getLeads() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (res) => {
          resolve(Array.isArray(res[STORAGE_KEY]) ? res[STORAGE_KEY] : []);
        });
      } catch (e) {
        resolve([]);
      }
    });
  }

  function setLeads(leads) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: leads }, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Stable-ish id for a lead so we can dedupe and update.
  function leadId(lead) {
    if (lead.mapsUrl) return "u:" + lead.mapsUrl;
    return "n:" + (lead.name || "") + "|" + (lead.phone || "") + "|" + (lead.address || "");
  }

  async function addLead(lead) {
    const leads = await getLeads();
    const id = leadId(lead);
    if (leads.some((l) => leadId(l) === id)) {
      return { added: false, reason: "duplicate" };
    }
    if (!lead.dateAdded) lead.dateAdded = new Date().toISOString();
    leads.push(lead);
    await setLeads(leads);
    return { added: true };
  }

  /* ----------------------------------------------------------------------
   * Messaging the content script
   * -------------------------------------------------------------------- */
  function getActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs && tabs[0] ? tabs[0] : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message, _noContent: true });
          } else {
            resolve(response || { ok: false, error: "No response from page." });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e.message, _noContent: true });
      }
    });
  }

  // Try to (re)inject the content script if it isn't responding.
  function injectContentScript(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => resolve(!chrome.runtime.lastError)
        );
      } catch (e) {
        resolve(false);
      }
    });
  }

  // High-level: ensure we're on Maps, content script is alive, then send.
  async function messageContent(message) {
    const tab = await getActiveTab();
    if (!tab) {
      return { ok: false, error: "Could not find the active tab." };
    }
    if (!/https:\/\/www\.google\.[^/]+\/maps/.test(tab.url || "")) {
      return {
        ok: false,
        error: "Open Google Maps in this tab first (e.g. search \"barber Ottawa\"), then click the extension.",
      };
    }

    let res = await sendToTab(tab.id, message);
    if (res && res._noContent) {
      // Content script not present — inject and retry once.
      const injected = await injectContentScript(tab.id);
      if (injected) {
        res = await sendToTab(tab.id, message);
      }
    }
    return res;
  }

  /* ----------------------------------------------------------------------
   * Rendering: scan results
   * -------------------------------------------------------------------- */
  function websiteTag(status) {
    if (status === "No website detected")
      return '<span class="website-tag none">No website detected</span>';
    if (status === "Website found")
      return '<span class="website-tag has">Website found</span>';
    return '<span class="website-tag unknown">Website unknown</span>';
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Copy text to clipboard with a small confirmation.
  async function copyToClipboard(value) {
    try {
      await navigator.clipboard.writeText(value);
      showStatus("Copied: " + value, "success");
    } catch (e) {
      showStatus("Couldn't copy to clipboard.", "error");
    }
  }

  // Inline SVG icons (inherit currentColor). Kept small for the lead meta line.
  const ICONS = {
    star: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    phone: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    pin: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    tag: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    plus: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    check: '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  };

  // Build the meta line (category · rating · phone · address · city).
  // Phone is rendered as a click-to-copy span.
  function metaHtml(lead) {
    const parts = [];
    if (lead.category) parts.push(escapeHtml(lead.category));
    if (lead.rating)
      parts.push(ICONS.star + " " + escapeHtml(lead.rating) + (lead.reviews ? " (" + escapeHtml(lead.reviews) + ")" : ""));
    if (lead.phone)
      parts.push(
        ICONS.phone +
          ' <span class="copyable" role="button" tabindex="0" aria-label="Copy phone number ' +
          escapeHtml(lead.phone) + '" data-copy="' + escapeHtml(lead.phone) + '">' +
          escapeHtml(lead.phone) + "</span>"
      );
    if (lead.address) parts.push(ICONS.pin + " " + escapeHtml(lead.address));
    if (lead.city || lead.niche) parts.push(ICONS.tag + " " + escapeHtml([lead.niche, lead.city].filter(Boolean).join(" · ")));
    let html = parts.join(" · ");
    if (lead.mapsUrl) html += ' · <a href="' + escapeHtml(lead.mapsUrl) + '" target="_blank">Map</a>';
    return html;
  }

  // Friendly empty-state block with an illustrative icon.
  function emptyState(message) {
    return (
      '<div class="empty">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      "<div>" + escapeHtml(message) + "</div></div>"
    );
  }

  // Wire any .copyable spans inside a container (mouse + keyboard).
  function wireCopyables(container) {
    container.querySelectorAll(".copyable").forEach((el) => {
      const copy = () => copyToClipboard(el.getAttribute("data-copy"));
      el.addEventListener("click", copy);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          copy();
        }
      });
    });
  }

  // Keep the most recent scan so toggles can re-render without re-scanning.
  let lastScanLeads = [];

  async function renderScanResults(leads) {
    if (Array.isArray(leads)) lastScanLeads = leads;
    const hideUnknown = document.getElementById("hideUnknown").checked;
    const list = lastScanLeads.filter(
      (l) => !(hideUnknown && l.websiteStatus !== "No website detected")
    );

    // Which of these are already saved? Mark them.
    const saved = await getLeads();
    const savedIds = new Set(saved.map(leadId));

    scanResults.innerHTML = "";
    scanCount.textContent = String(list.length);

    if (!list.length) {
      scanResults.innerHTML =
        emptyState("No matching businesses in the visible results.");
      scanResultsSection.classList.remove("hidden");
      return;
    }

    list.forEach((lead) => {
      const isSaved = savedIds.has(leadId(lead));
      const card = document.createElement("div");
      card.className = "lead-card";
      card.innerHTML =
        '<div class="lead-name">' + escapeHtml(lead.name || "(no name)") + "</div>" +
        '<div class="lead-meta">' + metaHtml(lead) + "</div>" +
        websiteTag(lead.websiteStatus) +
        '<div><button class="scan-add-btn"' + (isSaved ? " disabled" : "") + ">" +
        (isSaved ? ICONS.check + " Saved" : ICONS.plus + " Save lead") + "</button></div>";

      const btn = card.querySelector(".scan-add-btn");
      btn.addEventListener("click", async () => {
        const r = await addLead(lead);
        if (r.added) {
          btn.innerHTML = ICONS.check + " Saved";
          btn.disabled = true;
          refreshLeadsCount();
        } else {
          showStatus("Already saved.", "warn");
        }
      });

      scanResults.appendChild(card);
    });

    wireCopyables(scanResults);
    scanResultsSection.classList.remove("hidden");
  }

  // Bulk-save every "No website detected" lead from the last scan.
  async function saveAllNoWebsite() {
    const candidates = lastScanLeads.filter((l) => l.websiteStatus === "No website detected");
    if (!candidates.length) {
      showStatus("No 'no website detected' leads to save.", "warn");
      return;
    }
    let added = 0;
    for (const lead of candidates) {
      const r = await addLead(lead);
      if (r.added) added++;
    }
    showStatus("Saved " + added + " new lead(s) (" + (candidates.length - added) + " already saved).", "success");
    refreshLeadsCount();
    renderScanResults(); // refresh saved markers
  }

  /* ----------------------------------------------------------------------
   * Rendering: saved leads (editable status + notes)
   * -------------------------------------------------------------------- */
  async function renderSavedLeads() {
    const all = await getLeads();
    leadsCount.textContent = String(all.length);

    // Apply search + status filters.
    const term = (document.getElementById("leadSearch").value || "").toLowerCase().trim();
    const statusF = document.getElementById("statusFilter").value;
    const leads = all.filter((l) => {
      if (statusF && l.status !== statusF) return false;
      if (term) {
        const hay = [l.name, l.phone, l.city, l.niche, l.category, l.address]
          .filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    // Apply sort.
    const sortBy = (document.getElementById("leadSort") || {}).value || "added-desc";
    const cmpStr = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base" });
    const byDate = (l) => Date.parse(l.dateAdded || "") || 0;
    leads.sort((a, b) => {
      switch (sortBy) {
        case "added-asc": return byDate(a) - byDate(b);
        case "name": return cmpStr(a.name, b.name);
        case "city": return cmpStr(a.city, b.city) || cmpStr(a.name, b.name);
        case "status": return cmpStr(a.status, b.status) || cmpStr(a.name, b.name);
        case "added-desc":
        default: return byDate(b) - byDate(a);
      }
    });

    leadsList.innerHTML = "";

    if (!all.length) {
      leadsList.innerHTML = emptyState("No saved leads yet. Scan a Maps page to get started.");
      leadsSection.classList.remove("hidden");
      return;
    }
    if (!leads.length) {
      leadsList.innerHTML = emptyState("No leads match the current filter.");
      leadsSection.classList.remove("hidden");
      return;
    }

    leads.forEach((lead) => {
      const id = leadId(lead);
      const card = document.createElement("div");
      card.className = "lead-card";

      const options = LEAD_STATUSES.map(
        (s) =>
          '<option value="' + s + '"' + (s === lead.status ? " selected" : "") + ">" + s + "</option>"
      ).join("");

      card.innerHTML =
        '<div class="lead-name">' + escapeHtml(lead.name || "(no name)") + "</div>" +
        '<div class="lead-meta">' + metaHtml(lead) + "</div>" +
        websiteTag(lead.websiteStatus) +
        '<div class="lead-edit hidden">' +
        '<label class="edit-label">Business name<input class="edit-name" type="text" value="' +
        escapeHtml(lead.name || "") + '" placeholder="Business name" /></label>' +
        '<label class="edit-label">Phone<input class="edit-phone" type="tel" value="' +
        escapeHtml(lead.phone || "") + '" placeholder="Phone" /></label>' +
        "</div>" +
        '<div class="lead-controls">' +
        '<select class="status-select" aria-label="Lead status">' + options + "</select>" +
        "</div>" +
        '<textarea class="lead-notes" placeholder="Notes...">' + escapeHtml(lead.notes || "") + "</textarea>" +
        '<div class="lead-actions">' +
        '<button class="mini-btn edit" type="button">Edit</button>' +
        '<button class="mini-btn save" type="button">Save changes</button>' +
        '<button class="mini-btn del" type="button">Delete</button>' +
        "</div>";

      // Toggle the name/phone edit fields.
      const editBox = card.querySelector(".lead-edit");
      card.querySelector(".mini-btn.edit").addEventListener("click", (e) => {
        const hidden = editBox.classList.toggle("hidden");
        e.currentTarget.textContent = hidden ? "Edit" : "Done";
        if (!hidden) card.querySelector(".edit-name").focus();
      });

      // Save name + phone + status + notes.
      card.querySelector(".mini-btn.save").addEventListener("click", async () => {
        const all = await getLeads();
        const target = all.find((l) => leadId(l) === id);
        if (target) {
          target.name = card.querySelector(".edit-name").value.trim() || target.name;
          target.phone = card.querySelector(".edit-phone").value.trim();
          target.status = card.querySelector(".status-select").value;
          target.notes = card.querySelector(".lead-notes").value;
          await setLeads(all);
          showStatus("Lead updated.", "success");
          renderSavedLeads();
        }
      });

      // Delete.
      card.querySelector(".mini-btn.del").addEventListener("click", async () => {
        const all = await getLeads();
        const next = all.filter((l) => leadId(l) !== id);
        await setLeads(next);
        renderSavedLeads();
        showStatus("Lead deleted.", "info");
      });

      leadsList.appendChild(card);
    });

    wireCopyables(leadsList);
    leadsSection.classList.remove("hidden");
  }

  async function refreshLeadsCount() {
    const leads = await getLeads();
    leadsCount.textContent = String(leads.length);
  }

  /* ----------------------------------------------------------------------
   * CSV export
   * -------------------------------------------------------------------- */
  function toCsvValue(v) {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  async function exportCsv() {
    const leads = await getLeads();
    if (!leads.length) {
      showStatus("No leads to export.", "warn");
      return;
    }
    const columns = [
      "name", "category", "rating", "reviews", "address", "phone",
      "mapsUrl", "websiteStatus", "niche", "city", "status", "notes", "dateAdded",
    ];
    const header = columns.join(",");
    const rows = leads.map((l) => columns.map((c) => toCsvValue(l[c])).join(","));
    const csv = [header].concat(rows).join("\n");

    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "nosite-leads-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showStatus("Exported " + leads.length + " leads.", "success");
    } catch (e) {
      showStatus("Export failed: " + e.message, "error");
    }
  }

  /* ----------------------------------------------------------------------
   * JSON backup & restore (lossless — preserves every field for re-import)
   * -------------------------------------------------------------------- */
  function downloadBlob(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportJson() {
    const leads = await getLeads();
    if (!leads.length) {
      showStatus("No leads to back up.", "warn");
      return;
    }
    const payload = {
      app: "NoSite Leads Helper",
      version: 1,
      exportedAt: new Date().toISOString(),
      leads,
    };
    try {
      downloadBlob(
        JSON.stringify(payload, null, 2),
        "application/json;charset=utf-8;",
        "nosite-leads-backup-" + new Date().toISOString().slice(0, 10) + ".json"
      );
      showStatus("Backed up " + leads.length + " leads (JSON).", "success");
    } catch (e) {
      showStatus("Backup failed: " + e.message, "error");
    }
  }

  // Merge imported leads into existing ones, de-duping by leadId.
  async function importJson(file) {
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const incoming = Array.isArray(parsed) ? parsed : parsed && parsed.leads;
      if (!Array.isArray(incoming)) {
        showStatus("That file doesn't look like a NoSite backup.", "error");
        return;
      }
      const existing = await getLeads();
      const seen = new Set(existing.map(leadId));
      let added = 0;
      for (const lead of incoming) {
        if (!lead || typeof lead !== "object") continue;
        const id = leadId(lead);
        if (seen.has(id)) continue;
        seen.add(id);
        if (!lead.dateAdded) lead.dateAdded = new Date().toISOString();
        existing.push(lead);
        added++;
      }
      await setLeads(existing);
      refreshLeadsCount();
      if (!leadsSection.classList.contains("hidden")) renderSavedLeads();
      showStatus(
        "Imported " + added + " new lead(s) (" + (incoming.length - added) + " already present).",
        "success"
      );
    } catch (e) {
      showStatus("Import failed: " + e.message, "error");
    }
  }

  /* ----------------------------------------------------------------------
   * Button wiring
   * -------------------------------------------------------------------- */
  function init() {
    // Populate the status filter dropdown.
    const statusFilter = $("statusFilter");
    LEAD_STATUSES.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      statusFilter.appendChild(opt);
    });

    // Scan-result toggles.
    $("saveAllBtn").addEventListener("click", saveAllNoWebsite);
    $("hideUnknown").addEventListener("change", () => renderScanResults());

    // Saved-lead filters (re-render on input).
    $("leadSearch").addEventListener("input", () => {
      if (!leadsSection.classList.contains("hidden")) renderSavedLeads();
    });
    statusFilter.addEventListener("change", () => {
      if (!leadsSection.classList.contains("hidden")) renderSavedLeads();
    });
    $("leadSort").addEventListener("change", () => {
      if (!leadsSection.classList.contains("hidden")) renderSavedLeads();
    });

    $("scanBtn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, "Scanning…");
      showStatus("Scanning visible results…", "info", false);
      try {
        const res = await messageContent({ action: "scan" });
        if (!res || !res.ok) {
          showStatus((res && res.error) || "Scan failed.", "error");
          return;
        }
        await renderScanResults(res.leads || []);
        leadsSection.classList.add("hidden");
        const detected = typeof res.detectedNone === "number" ? res.detectedNone : res.noWebsiteCount;
        const unknown = res.noWebsiteCount - detected;
        const ctx = res.context || {};
        const ctxNote = ctx.niche || ctx.city
          ? " · niche: " + [ctx.niche, ctx.city].filter(Boolean).join(", ")
          : "";
        showStatus(
          "Scanned " + res.allCount + " visible · " + detected + " no website" +
            (unknown > 0 ? " · " + unknown + " unknown" : "") + ctxNote,
          "success"
        );
      } finally {
        clearBusy(btn);
      }
    });

    $("saveCurrentBtn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      setBusy(btn, "Reading…");
      showStatus("Reading open business panel…", "info", false);
      try {
        const res = await messageContent({ action: "saveCurrent" });
        if (!res || !res.ok) {
          showStatus((res && res.error) || "Could not read the business.", "error");
          return;
        }
        const r = await addLead(res.lead);
        if (r.added) {
          showStatus("Saved: " + (res.lead.name || "business"), "success");
          refreshLeadsCount();
          // If the leads panel is open, refresh it.
          if (!leadsSection.classList.contains("hidden")) renderSavedLeads();
        } else {
          showStatus("That business is already saved.", "warn");
        }
      } finally {
        clearBusy(btn);
      }
    });

    $("showLeadsBtn").addEventListener("click", async () => {
      scanResultsSection.classList.add("hidden");
      await renderSavedLeads();
    });

    $("exportBtn").addEventListener("click", exportCsv);
    $("backupBtn").addEventListener("click", exportJson);
    $("restoreBtn").addEventListener("click", () => $("restoreFile").click());
    $("restoreFile").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      importJson(file);
      e.target.value = ""; // allow re-importing the same file
    });

    $("clearBtn").addEventListener("click", async () => {
      const leads = await getLeads();
      if (!leads.length) {
        showStatus("Nothing to clear.", "warn");
        return;
      }
      // Simple confirm using the popup itself.
      if (confirm("Delete all " + leads.length + " saved leads? This cannot be undone.")) {
        await setLeads([]);
        renderSavedLeads();
        showStatus("All leads cleared.", "info");
      }
    });

    refreshLeadsCount();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
