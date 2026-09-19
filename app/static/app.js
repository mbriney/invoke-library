(() => {
  const state = {
    page: 1,
    limit: 48,
    pages: 0,
    total: 0,
    items: [],
    selected: new Set(),
    keepLabel: "Keepers",
    appTitle: "Invoke Library",
    action: null, // 'copy' | 'move' | 'delete'
    folders: [],
    foldersLoaded: false, // warm in-memory list across modal open/close
    folderFilter: "",
    selectedFolder: "",
    kindFilter: "all", // all | output | input
    kindCounts: { all: 0, output: 0, input: 0, unknown: 0 },
    bulkRunning: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const selCount = $("#sel-count");
  const statusLine = $("#status-line");
  const pageInfo = $("#page-info");
  const toastEl = $("#toast");

  function toast(msg, kind = "ok") {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${kind}`;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove("show"), 4200);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
    });
    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      const detail = data && data.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : detail && detail.message
            ? detail.message
            : typeof data === "string"
              ? data
              : `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function pagePaths() {
    return state.items.map((item) => item.path);
  }

  function pageSelectionState() {
    const paths = pagePaths();
    if (!paths.length) return { selected: 0, total: 0 };
    let selected = 0;
    for (const p of paths) {
      if (state.selected.has(p)) selected += 1;
    }
    return { selected, total: paths.length };
  }

  function updatePageSelectCheckbox() {
    const chk = $("#chk-select-all-page");
    if (!chk) return;
    const { selected, total } = pageSelectionState();
    chk.disabled = total === 0;
    chk.indeterminate = selected > 0 && selected < total;
    chk.checked = total > 0 && selected === total;
  }

  function updateToolbar() {
    const n = state.selected.size;
    selCount.textContent = n ? `${n} selected` : "None";
    $("#btn-delete").disabled = n === 0;
    $("#btn-copy").disabled = n === 0;
    $("#btn-move").disabled = n === 0;
    updatePageSelectCheckbox();
  }

  function renderGrid() {
    grid.innerHTML = "";
    if (!state.items.length) {
      grid.innerHTML = `<div class="empty">No images found under outputs.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of state.items) {
      const card = document.createElement("div");
      card.className = "card" + (state.selected.has(item.path) ? " selected" : "");
      card.dataset.path = item.path;
      const kind = item.kind || "unknown";
      const kindLabel = kind === "output" ? "Output" : kind === "input" ? "Input" : "Unknown";
      card.innerHTML = `
        <div class="check">${state.selected.has(item.path) ? "✓" : ""}</div>
        <span class="kind-badge ${kind}">${kindLabel}</span>
        <img loading="lazy" alt="" src="/api/images/thumb?path=${encodeURIComponent(item.path)}" />
        <button type="button" class="zoom-btn" aria-label="View full size" title="View full size">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            <path fill="currentColor" d="M12 10h-2v2H9v-2H7V9h2V7h1v2h2v1z"/>
          </svg>
        </button>
      `;
      card.addEventListener("click", (e) => {
        if (e.target.closest(".zoom-btn")) return;
        if (e.detail === 2) {
          openLightbox(item.path);
          return;
        }
        toggleSelect(item.path);
        try { grid.focus({ preventScroll: true }); } catch (_) { grid.focus(); }
      });
      const zoomBtn = card.querySelector(".zoom-btn");
      zoomBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(item.path);
      });
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function toggleSelect(path) {
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    renderGrid();
    updateToolbar();
  }

  function selectAllOnPage() {
    for (const item of state.items) state.selected.add(item.path);
    renderGrid();
    updateToolbar();
  }

  function clearSelectionOnPage() {
    for (const item of state.items) state.selected.delete(item.path);
    renderGrid();
    updateToolbar();
  }

  function toggleSelectAllOnPage() {
    const { selected, total } = pageSelectionState();
    if (total === 0) return;
    if (selected === total) clearSelectionOnPage();
    else selectAllOnPage();
  }

  function clearSelection() {
    state.selected.clear();
    renderGrid();
    updateToolbar();
  }

  async function loadConfig() {
    try {
      const cfg = await api("/api/config");
      state.keepLabel = cfg.keep_label || "Keepers";
      state.appTitle = cfg.app_title || "Invoke Library";
      document.title = state.appTitle;
      const titleEl = $("#app-title");
      if (titleEl) titleEl.textContent = state.appTitle;
      $("#btn-copy").textContent = `Copy to ${state.keepLabel}`;
      $("#btn-move").textContent = `Move to ${state.keepLabel}`;
      const modalTitle = $("#modal-keep-title");
      if (modalTitle) modalTitle.textContent = `Send to ${state.keepLabel}`;
    } catch (_) {
      /* optional */
    }
  }

  async function loadImages() {
    statusLine.textContent = "Loading…";
    try {
      const kindQ = state.kindFilter && state.kindFilter !== "all" ? `&kind=${encodeURIComponent(state.kindFilter)}` : "";
      const data = await api(`/api/images?page=${state.page}&limit=${state.limit}${kindQ}`);
      state.items = data.items || [];
      state.total = data.total || 0;
      state.pages = data.pages || 0;
      if (data.counts) state.kindCounts = data.counts;
      updateKindChips();
      const filterNote = state.kindFilter !== "all" ? ` · ${state.kindFilter}s` : "";
      pageInfo.textContent = state.pages
        ? `Page ${state.page} / ${state.pages} · ${state.total} images${filterNote}`
        : `${state.total} images${filterNote}`;
      $("#btn-prev").disabled = state.page <= 1;
      $("#btn-next").disabled = !state.pages || state.page >= state.pages;
      statusLine.textContent = "";
      renderGrid();
      updateToolbar();
    } catch (err) {
      statusLine.textContent = err.message;
      toast(err.message, "error");
    }
  }

  function openLightbox(path) {
    const box = $("#lightbox");
    const img = $("#lightbox-img");
    img.src = `/api/images/file?path=${encodeURIComponent(path)}`;
    img.alt = path.split("/").pop() || "Full image";
    box.classList.add("open");
    box.setAttribute("aria-hidden", "false");
  }

  function closeLightbox() {
    const box = $("#lightbox");
    box.classList.remove("open");
    box.setAttribute("aria-hidden", "true");
    $("#lightbox-img").src = "";
  }

  function openModal(action) {
    state.action = action;
    const backdrop = $("#modal");
    const confirmOnly = $("#confirm-only");
    const keepControls = $("#keep-controls");
    const title = $("#modal-title");
    const desc = $("#modal-desc");
    const n = state.selected.size;

    if (action === "delete") {
      title.textContent = "Delete via InvokeAI";
      desc.textContent = `Permanently delete ${n} image(s) through the InvokeAI API (keeps the DB in sync). This cannot be undone.`;
      confirmOnly.style.display = "block";
      keepControls.style.display = "none";
      $("#btn-confirm").className = "danger";
      $("#btn-confirm").textContent = "Delete";
    } else {
      title.textContent = action === "move" ? `Move to ${state.keepLabel}` : `Copy to ${state.keepLabel}`;
      desc.textContent =
        action === "move"
          ? `Copy ${n} image(s) to a ${state.keepLabel} folder, then delete originals via InvokeAI.`
          : `Copy ${n} image(s) to a ${state.keepLabel} folder (originals stay in Invoke).`;
      confirmOnly.style.display = "none";
      keepControls.style.display = "block";
      $("#btn-confirm").className = "primary";
      $("#btn-confirm").textContent = action === "move" ? "Move" : "Copy";
      state.folderFilter = "";
      const filterEl = $("#folder-filter");
      if (filterEl) filterEl.value = "";
      resetProgressPanel();
      // Reuse in-memory folder list when warm; first open / force still network-loads.
      loadFolders({ force: false });
    }
    backdrop.classList.add("open");
  }

  function closeModal() {
    if (state.bulkRunning) return;
    $("#modal").classList.remove("open");
    state.action = null;
    resetProgressPanel();
  }

  function filteredFolders() {
    const q = (state.folderFilter || "").trim().toLowerCase();
    if (!q) return state.folders.slice();
    return state.folders.filter((f) => f.toLowerCase().includes(q));
  }

  function updateSelectedFolderLabel() {
    const el = $("#folder-selected");
    if (!el) return;
    if (state.selectedFolder) {
      el.innerHTML = `Selected: <strong>${escapeHtml(state.selectedFolder)}</strong>`;
    } else {
      el.textContent = "No folder selected";
    }
  }

  function selectFolder(path) {
    state.selectedFolder = path || "";
    renderFolderList();
    updateSelectedFolderLabel();
  }

  function renderFolderList() {
    const list = $("#folder-list");
    if (!list) return;
    const folders = filteredFolders();
    list.innerHTML = "";
    if (!state.folders.length) {
      list.innerHTML = `<div class="folder-list-empty">No folders yet — create one below</div>`;
      return;
    }
    if (!folders.length) {
      list.innerHTML = `<div class="folder-list-empty">No folders match “${escapeHtml(state.folderFilter.trim())}”</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const f of folders) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "folder-item" + (f === state.selectedFolder ? " selected" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", f === state.selectedFolder ? "true" : "false");
      btn.title = f;
      btn.textContent = f;
      btn.addEventListener("click", () => selectFolder(f));
      frag.appendChild(btn);
    }
    list.appendChild(frag);
  }

  async function loadFolders({ force = false } = {}) {
    const list = $("#folder-list");
    const warm = state.foldersLoaded && !force;
    if (warm) {
      renderFolderList();
      updateSelectedFolderLabel();
      return;
    }
    if (list) list.innerHTML = `<div class="folder-list-empty">Loading…</div>`;
    const refreshBtn = $("#btn-refresh-folders");
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const q = force ? "?refresh=1" : "";
      const data = await api(`/api/keepers/folders${q}`);
      state.folders = data.folders || [];
      state.foldersLoaded = true;
      if (state.selectedFolder && !state.folders.includes(state.selectedFolder)) {
        state.selectedFolder = "";
      }
      if (!state.selectedFolder && state.folders.length === 1) {
        state.selectedFolder = state.folders[0];
      }
      renderFolderList();
      updateSelectedFolderLabel();
    } catch (err) {
      if (list) list.innerHTML = `<div class="folder-list-empty">Failed to load folders</div>`;
      toast(err.message, "error");
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function basename(path) {
    const parts = String(path || "").split("/");
    return parts[parts.length - 1] || path || "";
  }

  function resetProgressPanel() {
    const panel = $("#progress-panel");
    if (!panel) return;
    panel.hidden = true;
    $("#progress-label").textContent = "Working…";
    $("#progress-bar").style.width = "0%";
    $("#progress-text").textContent = "0 / 0";
    $("#progress-current").textContent = "";
    $("#progress-errors").textContent = "";
  }

  function showProgressPanel() {
    const panel = $("#progress-panel");
    if (panel) panel.hidden = false;
  }

  function updateProgress({ label, done, total, current, errors }) {
    showProgressPanel();
    if (label != null) $("#progress-label").textContent = label;
    const t = Math.max(0, total || 0);
    const d = Math.max(0, Math.min(done || 0, t || done || 0));
    const pct = t ? Math.round((d / t) * 100) : 0;
    $("#progress-bar").style.width = `${pct}%`;
    $("#progress-text").textContent = `${d} / ${t}`;
    if (current != null) $("#progress-current").textContent = current;
    if (errors != null) {
      $("#progress-errors").textContent = errors
        ? `${errors} failed (continued with remaining)`
        : "";
    }
  }

  function setBulkUiRunning(running) {
    state.bulkRunning = running;
    const confirm = $("#btn-confirm");
    const cancel = $("#btn-cancel");
    if (confirm) confirm.disabled = running;
    if (cancel) cancel.disabled = running;
    const keep = $("#keep-controls");
    if (keep) {
      keep.querySelectorAll("input, button, select").forEach((el) => {
        el.disabled = running;
      });
    }
  }

  /** Yield so the browser can paint between sequential awaits. */
  function yieldToUi() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  async function createFolder() {
    const input = $("#new-folder");
    const name = (input.value || "").trim();
    if (!name || state.bulkRunning) return;
    try {
      await api("/api/keepers/folders", { method: "POST", body: JSON.stringify({ name }) });
      input.value = "";
      // Server invalidates/rebuilds cache on create; force client reload.
      await loadFolders({ force: true });
      selectFolder(name);
      toast(`Created folder “${name}”`, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /**
   * Bulk copy / move / delete runs one file at a time so the progress bar can
   * update. On per-item errors we continue (error count in the panel); toast
   * summarizes at the end.
   */
  async function confirmAction() {
    const paths = [...state.selected];
    if (!paths.length || !state.action || state.bulkRunning) return;

    let dest = "";
    if (state.action !== "delete") {
      dest = state.selectedFolder;
      if (!dest) {
        toast("Choose or create a destination folder", "error");
        return;
      }
    }

    const action = state.action;
    const total = paths.length;
    let done = 0;
    let errors = 0;
    const failed = [];

    const verb =
      action === "delete" ? "Deleting" : action === "move" ? "Moving" : "Copying";
    const endpoint =
      action === "delete"
        ? "/api/actions/delete"
        : action === "move"
          ? "/api/actions/move"
          : "/api/actions/copy";

    setBulkUiRunning(true);
    // Hide folder picker noise while running keep actions; delete already hides it.
    if (action !== "delete") {
      const keep = $("#keep-controls");
      if (keep) keep.style.display = "none";
    }
    const confirmOnly = $("#confirm-only");
    if (action === "delete" && confirmOnly) confirmOnly.style.display = "none";

    updateProgress({
      label: `${verb}…`,
      done: 0,
      total,
      current: "",
      errors: 0,
    });

    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const name = basename(path);
        updateProgress({
          label: `${verb}…`,
          done,
          total,
          current: name,
          errors,
        });
        await yieldToUi();

        try {
          const body =
            action === "delete"
              ? { paths: [path] }
              : { paths: [path], dest_folder: dest };
          await api(endpoint, { method: "POST", body: JSON.stringify(body) });
          done += 1;
          // Drop from selection as each succeeds so a partial failure leaves the rest selected.
          state.selected.delete(path);
        } catch (err) {
          errors += 1;
          failed.push({ path, message: err.message || "failed" });
          updateProgress({
            label: `${verb}…`,
            done,
            total,
            current: `${name} — ${err.message || "error"}`,
            errors,
          });
          await yieldToUi();
        }

        updateProgress({
          label: `${verb}…`,
          done,
          total,
          current: name,
          errors,
        });
      }

      updateProgress({
        label: errors ? `${verb} finished with errors` : `${verb} complete`,
        done,
        total,
        current: "",
        errors,
      });
      await yieldToUi();

      if (errors === 0) {
        toast(
          action === "delete"
            ? `Deleted ${done} via InvokeAI`
            : action === "move"
              ? `Moved ${done} (copied + Invoke delete)`
              : `Copied ${done} to ${state.keepLabel}`,
          "ok"
        );
        state.selected.clear();
        setBulkUiRunning(false);
        closeModal();
      } else {
        const first = failed[0];
        toast(
          `${done} ok, ${errors} failed` +
            (first ? ` — first: ${basename(first.path)}: ${first.message}` : ""),
          "error"
        );
        updateToolbar();
        renderGrid();
        // Re-enable cancel so user can dismiss; keep confirm disabled until modal closed.
        state.bulkRunning = false;
        const cancel = $("#btn-cancel");
        if (cancel) cancel.disabled = false;
        const confirm = $("#btn-confirm");
        if (confirm) confirm.disabled = true;
      }
      await loadImages();
    } catch (err) {
      toast(err.message || "Bulk action failed", "error");
      state.bulkRunning = false;
      setBulkUiRunning(false);
    } finally {
      if (errors === 0) {
        setBulkUiRunning(false);
      }
    }
  }


  function updateKindChips() {
    const root = $("#kind-filter");
    if (!root) return;
    const c = state.kindCounts || {};
    for (const btn of root.querySelectorAll(".kind-chip")) {
      const k = btn.dataset.kind;
      btn.classList.toggle("active", k === state.kindFilter);
      let label = k === "all" ? "All" : k === "output" ? "Outputs" : "Inputs";
      if (k === "all" && c.all != null) label = `All (${c.all})`;
      else if (k === "output" && c.output != null) label = `Outputs (${c.output})`;
      else if (k === "input" && c.input != null) label = `Inputs (${c.input})`;
      btn.textContent = label;
    }
  }

  function wire() {
    const kindRoot = $("#kind-filter");
    if (kindRoot) {
      kindRoot.addEventListener("click", (e) => {
        const btn = e.target.closest(".kind-chip");
        if (!btn) return;
        const k = btn.dataset.kind;
        if (!k || k === state.kindFilter) return;
        state.kindFilter = k;
        state.page = 1;
        updateKindChips();
        loadImages();
      });
    }
    $("#btn-select-all").addEventListener("click", selectAllOnPage);
    const pageChk = $("#chk-select-all-page");
    if (pageChk) {
      pageChk.addEventListener("click", (e) => {
        // Use click (not change) so we can decide from pre-toggle state via indeterminate/checked.
        e.preventDefault();
        toggleSelectAllOnPage();
      });
    }
    $("#btn-clear").addEventListener("click", clearSelection);
    $("#btn-delete").addEventListener("click", () => openModal("delete"));
    $("#btn-copy").addEventListener("click", () => openModal("copy"));
    $("#btn-move").addEventListener("click", () => openModal("move"));
    $("#btn-prev").addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        loadImages();
      }
    });
    $("#btn-next").addEventListener("click", () => {
      if (state.page < state.pages) {
        state.page += 1;
        loadImages();
      }
    });
    $("#btn-refresh").addEventListener("click", loadImages);
    $("#btn-cancel").addEventListener("click", closeModal);
    $("#btn-confirm").addEventListener("click", confirmAction);
    $("#btn-create-folder").addEventListener("click", createFolder);
    const refreshFoldersBtn = $("#btn-refresh-folders");
    if (refreshFoldersBtn) {
      refreshFoldersBtn.addEventListener("click", () => loadFolders({ force: true }));
    }
    $("#folder-filter").addEventListener("input", (e) => {
      state.folderFilter = e.target.value || "";
      renderFolderList();
    });
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") closeModal();
    });
    $("#lightbox").addEventListener("click", (e) => {
      if (e.target.id === "lightbox" || e.target.id === "lightbox-close") {
        closeLightbox();
      }
    });
    $("#lightbox-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeLightbox();
    });
    $("#lightbox-img").addEventListener("click", (e) => {
      e.stopPropagation();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!state.bulkRunning) closeModal();
        closeLightbox();
      }
      // Ctrl/Cmd+A: select all on current page when focus is in the grid (avoid fighting browser elsewhere).
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const t = e.target;
        const tag = (t && t.tagName) || "";
        const onPageChk = pageChk && (t === pageChk || (t.closest && t.closest(".page-select-label")));
        if (!onPageChk && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable))) {
          return;
        }
        if ($("#modal") && $("#modal").classList.contains("open")) return;
        if ($("#lightbox") && $("#lightbox").classList.contains("open")) return;
        const inGrid = t === grid || grid.contains(t);
        if (!inGrid && !onPageChk) return;
        e.preventDefault();
        selectAllOnPage();
      }
    });
  }

  wire();
  loadConfig().then(loadImages);
})();
