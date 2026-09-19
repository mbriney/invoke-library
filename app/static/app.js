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
    action: null, // 'copy' | 'move' | 'delete' | 'delete-all-inputs' | 'delete-lookalike-inputs' | 'delete-paths'
    pendingPaths: null, // for delete-paths / mass actions
    folders: [],
    foldersLoaded: false,
    folderFilter: "",
    selectedFolder: "",
    kindFilter: "all", // all | output | input | lookalikes
    kindCounts: { all: 0, output: 0, input: 0, unknown: 0 },
    lookalikeGroups: [],
    lookalikeStats: null,
    lookalikeHamming: 14,
    lookalikeScanning: false,
    lookalikeProgress: null,
    lookalikeHasResult: false,
    lookalikePollTimer: null,
    bulkRunning: false,
    strongConfirmOk: false,
  };

  const DELETE_BATCH = 10;
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
    if (state.kindFilter === "lookalikes") {
      const paths = [];
      for (const g of state.lookalikeGroups) {
        for (const it of g.items || []) paths.push(it.path);
      }
      return paths;
    }
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

  function updateFilterActionButtons() {
    const delAll = $("#btn-delete-all-inputs");
    const delLook = $("#btn-delete-lookalike-inputs");
    const inputCount = (state.kindCounts && state.kindCounts.input) || 0;
    if (delAll) delAll.disabled = inputCount === 0 || state.bulkRunning;
    if (delLook) {
      const show = state.kindFilter === "lookalikes";
      delLook.hidden = !show;
      const mixedInputs = countLookalikeMixedInputs();
      delLook.disabled = !show || mixedInputs === 0 || state.bulkRunning;
      if (show) {
        delLook.textContent =
          mixedInputs > 0
            ? `Delete inputs in lookalike groups (${mixedInputs})`
            : "Delete inputs in lookalike groups";
      }
    }
    const lookControls = $("#lookalike-controls");
    if (lookControls) lookControls.hidden = state.kindFilter !== "lookalikes";
  }

  function countLookalikeMixedInputs() {
    let n = 0;
    for (const g of state.lookalikeGroups) {
      if (!g.mixed) continue;
      for (const it of g.items || []) {
        if (it.kind === "input") n += 1;
      }
    }
    return n;
  }

  function updateToolbar() {
    const n = state.selected.size;
    selCount.textContent = n ? `${n} selected` : "None";
    $("#btn-delete").disabled = n === 0;
    $("#btn-copy").disabled = n === 0;
    $("#btn-move").disabled = n === 0;
    updatePageSelectCheckbox();
    updateFilterActionButtons();
  }

  function makeCard(item) {
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
      try {
        grid.focus({ preventScroll: true });
      } catch (_) {
        grid.focus();
      }
    });
    const zoomBtn = card.querySelector(".zoom-btn");
    zoomBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(item.path);
    });
    return card;
  }

  function renderGrid() {
    grid.innerHTML = "";
    grid.className = "grid";
    if (state.kindFilter === "lookalikes") {
      renderLookalikes();
      return;
    }
    if (!state.items.length) {
      grid.innerHTML = `<div class="empty">No images found under outputs.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of state.items) frag.appendChild(makeCard(item));
    grid.appendChild(frag);
  }

  function renderLookalikes() {
    grid.className = "lookalike-wrap";
    if (!state.lookalikeGroups.length) {
      if (state.lookalikeScanning) {
        const pr = state.lookalikeProgress || {};
        const done = pr.done != null ? pr.done : 0;
        const total = pr.total != null ? pr.total : 0;
        const phase = pr.phase || "hashing";
        const msg =
          total > 0
            ? `Still scanning — ${phase} ${done}/${total}…`
            : "Still scanning library for lookalikes…";
        grid.innerHTML = `<div class="lookalike-empty scanning">${msg}</div>`;
      } else if (!state.lookalikeHasResult) {
        grid.innerHTML = `<div class="lookalike-empty scanning">Starting lookalike scan…</div>`;
      } else {
        grid.innerHTML = `<div class="lookalike-empty">No lookalike groups found (Hamming ≤ ${state.lookalikeHamming}). Raise Hamming or click Rescan after new uploads.</div>`;
      }
      return;
    }
    const frag = document.createDocumentFragment();
    state.lookalikeGroups.forEach((g, idx) => {
      const section = document.createElement("section");
      section.className = "lookalike-group" + (g.mixed ? " mixed" : "");
      section.dataset.groupId = g.id || `g${idx}`;

      const header = document.createElement("div");
      header.className = "lookalike-group-header";
      const title = document.createElement("div");
      title.className = "lookalike-group-title";
      const kinds = (g.kinds || []).join(" + ") || "group";
      title.innerHTML =
        `Group ${idx + 1} · ${g.size || (g.items || []).length} images · ${escapeHtml(kinds)}` +
        (g.mixed ? `<span class="badge-mixed">input + output</span>` : "");
      header.appendChild(title);

      const actions = document.createElement("div");
      actions.className = "lookalike-group-actions";
      const btnSelect = document.createElement("button");
      btnSelect.type = "button";
      btnSelect.textContent = "Select group";
      btnSelect.addEventListener("click", () => selectGroup(g));
      actions.appendChild(btnSelect);

      const btnKeepNewest = document.createElement("button");
      btnKeepNewest.type = "button";
      btnKeepNewest.className = "danger";
      btnKeepNewest.textContent = "Delete except newest";
      btnKeepNewest.addEventListener("click", () => {
        const items = [...(g.items || [])].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        const paths = items.slice(1).map((it) => it.path);
        if (!paths.length) {
          toast("Nothing to delete in this group", "error");
          return;
        }
        openDeletePathsModal(
          paths,
          `Delete ${paths.length} older lookalike(s) and keep the newest image. Deletes go through the InvokeAI API.`
        );
      });
      actions.appendChild(btnKeepNewest);

      const inputPaths = (g.items || []).filter((it) => it.kind === "input").map((it) => it.path);
      if (inputPaths.length) {
        const btnInputs = document.createElement("button");
        btnInputs.type = "button";
        btnInputs.className = "danger";
        btnInputs.textContent = `Delete inputs (${inputPaths.length})`;
        btnInputs.addEventListener("click", () => {
          openDeletePathsModal(
            inputPaths,
            `Delete ${inputPaths.length} Input-classified image(s) in this group via InvokeAI. Outputs stay.`
          );
        });
        actions.appendChild(btnInputs);
      }

      header.appendChild(actions);
      section.appendChild(header);

      const inner = document.createElement("div");
      inner.className = "grid";
      for (const item of g.items || []) inner.appendChild(makeCard(item));
      section.appendChild(inner);
      frag.appendChild(section);
    });
    grid.appendChild(frag);
  }

  function selectGroup(g) {
    for (const it of g.items || []) state.selected.add(it.path);
    renderGrid();
    updateToolbar();
  }

  function toggleSelect(path) {
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    renderGrid();
    updateToolbar();
  }

  function selectAllOnPage() {
    for (const p of pagePaths()) state.selected.add(p);
    renderGrid();
    updateToolbar();
  }

  function clearSelectionOnPage() {
    for (const p of pagePaths()) state.selected.delete(p);
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
      if (cfg.lookalike_hamming != null) state.lookalikeHamming = cfg.lookalike_hamming;
      const hamm = $("#lookalike-hamming");
      if (hamm) {
        const val = String(state.lookalikeHamming);
        if ([...hamm.options].some((o) => o.value === val)) hamm.value = val;
      }
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
      if (state.kindFilter === "lookalikes") {
        await loadLookalikes({ rescan: false });
        return;
      }
      stopLookalikePoll();
      const pager = $("#pager");
      if (pager) pager.style.display = "";
      const kindQ =
        state.kindFilter && state.kindFilter !== "all"
          ? `&kind=${encodeURIComponent(state.kindFilter)}`
          : "";
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

  function stopLookalikePoll() {
    if (state.lookalikePollTimer) {
      clearInterval(state.lookalikePollTimer);
      state.lookalikePollTimer = null;
    }
  }

  function formatLookalikeProgress(progress) {
    const pr = progress || {};
    const done = pr.done != null ? pr.done : 0;
    const total = pr.total != null ? pr.total : 0;
    const phase = pr.phase || "";
    if (phase === "grouping") return "Grouping lookalikes…";
    if (phase === "starting") return "Starting scan…";
    if (total > 0) return `Hashing ${done}/${total}…`;
    if (phase === "hashing") return "Hashing…";
    return phase ? `Scan: ${phase}` : "";
  }

  function applyLookalikePayload(data) {
    state.lookalikeGroups = data.groups || [];
    state.lookalikeStats = data.stats || null;
    state.lookalikeScanning = !!data.scanning;
    state.lookalikeProgress = data.progress || null;
    state.lookalikeHasResult = !!data.has_result || state.lookalikeGroups.length > 0;
    if (data.hamming != null) state.lookalikeHamming = data.hamming;
    const sel = $("#lookalike-hamming");
    if (sel) {
      const val = String(state.lookalikeHamming);
      if ([...sel.options].some((o) => o.value === val)) sel.value = val;
    }
    const progEl = $("#lookalike-progress");
    if (progEl) {
      if (state.lookalikeScanning) {
        progEl.textContent = formatLookalikeProgress(state.lookalikeProgress);
      } else if (data.error) {
        progEl.textContent = `Scan error: ${data.error}`;
      } else {
        progEl.textContent = state.lookalikeHasResult ? "Scan complete" : "";
      }
    }
  }

  function updateLookalikePageInfo() {
    const stats = state.lookalikeStats || {};
    const mixed =
      stats.mixed_groups != null
        ? stats.mixed_groups
        : state.lookalikeGroups.filter((g) => g.mixed).length;
    let line = `${state.lookalikeGroups.length} lookalike groups · ${mixed} mixed input/output · Hamming ≤ ${state.lookalikeHamming}`;
    if (state.lookalikeScanning) {
      line += ` · ${formatLookalikeProgress(state.lookalikeProgress)}`;
    }
    pageInfo.textContent = line;
  }

  function startLookalikePoll() {
    stopLookalikePoll();
    state.lookalikePollTimer = setInterval(async () => {
      if (state.kindFilter !== "lookalikes") {
        stopLookalikePoll();
        return;
      }
      try {
        const data = await api(
          `/api/lookalikes?hamming=${encodeURIComponent(state.lookalikeHamming)}`
        );
        applyLookalikePayload(data);
        updateLookalikePageInfo();
        updateKindChips();
        renderGrid();
        updateToolbar();
        if (!data.scanning) {
          stopLookalikePoll();
          statusLine.textContent = "";
          try {
            const countsData = await api(`/api/images?page=1&limit=1`);
            if (countsData.counts) state.kindCounts = countsData.counts;
            updateKindChips();
          } catch (_) {
            /* ignore */
          }
        } else {
          statusLine.textContent = formatLookalikeProgress(data.progress);
        }
      } catch (err) {
        statusLine.textContent = err.message || "Lookalike poll failed";
      }
    }, 1500);
  }

  async function requestLookalikeRefresh() {
    await api("/api/lookalikes/refresh", {
      method: "POST",
      body: JSON.stringify({
        hamming: state.lookalikeHamming,
        mixed_only: false,
      }),
    });
  }

  async function loadLookalikes({ rescan = false } = {}) {
    const pager = $("#pager");
    if (pager) pager.style.display = "none";
    updateFilterActionButtons();
    statusLine.textContent = rescan ? "Starting lookalike scan…" : "Loading lookalikes…";
    try {
      let data = await api(
        `/api/lookalikes?hamming=${encodeURIComponent(state.lookalikeHamming)}`
      );
      applyLookalikePayload(data);
      updateLookalikePageInfo();
      renderGrid();
      updateToolbar();
      updateKindChips();

      if (rescan || !data.has_result) {
        if (!data.scanning) {
          await requestLookalikeRefresh();
          data = await api(
            `/api/lookalikes?hamming=${encodeURIComponent(state.lookalikeHamming)}`
          );
          applyLookalikePayload(data);
          updateLookalikePageInfo();
          renderGrid();
        }
      }

      if (data.scanning || state.lookalikeScanning) {
        statusLine.textContent = formatLookalikeProgress(data.progress || state.lookalikeProgress);
        startLookalikePoll();
      } else {
        stopLookalikePoll();
        statusLine.textContent = "";
        try {
          const countsData = await api(`/api/images?page=1&limit=1`);
          if (countsData.counts) state.kindCounts = countsData.counts;
          updateKindChips();
        } catch (_) {
          /* ignore */
        }
      }
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

  function resetStrongConfirm() {
    state.strongConfirmOk = false;
    const gate = $("#confirm-gate");
    const chk = $("#chk-understand");
    const typed = $("#confirm-type");
    if (chk) chk.checked = false;
    if (typed) typed.value = "";
    if (gate) gate.hidden = true;
    updateConfirmEnabled();
  }

  function showStrongConfirmGate() {
    const gate = $("#confirm-gate");
    if (gate) gate.hidden = false;
    const chk = $("#chk-understand");
    const typed = $("#confirm-type");
    if (chk) chk.checked = false;
    if (typed) typed.value = "";
    state.strongConfirmOk = false;
    updateConfirmEnabled();
  }

  function updateConfirmEnabled() {
    const confirm = $("#btn-confirm");
    if (!confirm) return;
    if (state.bulkRunning) {
      confirm.disabled = true;
      return;
    }
    const needsGate =
      state.action === "delete-all-inputs" ||
      state.action === "delete-lookalike-inputs" ||
      state.action === "delete-paths";
    if (!needsGate) {
      confirm.disabled = false;
      return;
    }
    const chk = $("#chk-understand");
    const typed = $("#confirm-type");
    const typedOk = ((typed && typed.value) || "").trim() === "DELETE";
    const checkOk = !!(chk && chk.checked);
    state.strongConfirmOk = typedOk || checkOk;
    confirm.disabled = !state.strongConfirmOk;
  }

  function openModal(action) {
    state.action = action;
    state.pendingPaths = null;
    const backdrop = $("#modal");
    const confirmOnly = $("#confirm-only");
    const keepControls = $("#keep-controls");
    const title = $("#modal-title");
    const desc = $("#modal-desc");
    const n = state.selected.size;
    resetProgressPanel();
    resetStrongConfirm();

    if (action === "delete") {
      title.textContent = "Delete via InvokeAI";
      desc.textContent = `Permanently delete ${n} image(s) through the InvokeAI API (keeps the DB in sync). This cannot be undone.`;
      confirmOnly.style.display = "block";
      keepControls.style.display = "none";
      $("#btn-confirm").className = "danger";
      $("#btn-confirm").textContent = "Delete";
      updateConfirmEnabled();
    } else if (action === "delete-all-inputs") {
      const count = (state.kindCounts && state.kindCounts.input) || 0;
      title.textContent = "Delete all inputs";
      desc.textContent =
        `Permanently delete every image classified as an input (uploads, control/mask/user assets, etc.) through the InvokeAI API — the same classification as the Inputs filter. Outputs are not touched. This cannot be undone.` +
        (count ? ` About ${count} input(s) will be deleted.` : "");
      confirmOnly.style.display = "block";
      keepControls.style.display = "none";
      $("#btn-confirm").className = "danger";
      $("#btn-confirm").textContent = "Delete all inputs";
      showStrongConfirmGate();
    } else if (action === "delete-lookalike-inputs") {
      const count = countLookalikeMixedInputs();
      title.textContent = "Delete inputs in lookalike groups";
      desc.textContent =
        `In mixed input+output lookalike groups, delete only the Input-classified twins via InvokeAI and keep the Outputs. Usual case: you already have the generated copy. This cannot be undone.` +
        (count ? ` ${count} input(s) across mixed groups.` : "");
      confirmOnly.style.display = "block";
      keepControls.style.display = "none";
      $("#btn-confirm").className = "danger";
      $("#btn-confirm").textContent = "Delete lookalike inputs";
      showStrongConfirmGate();
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
      updateConfirmEnabled();
      loadFolders({ force: false });
    }
    backdrop.classList.add("open");
  }

  function openDeletePathsModal(paths, message) {
    state.action = "delete-paths";
    state.pendingPaths = paths.slice();
    const backdrop = $("#modal");
    const confirmOnly = $("#confirm-only");
    const keepControls = $("#keep-controls");
    resetProgressPanel();
    resetStrongConfirm();
    $("#modal-title").textContent = "Delete via InvokeAI";
    $("#modal-desc").textContent = message || `Permanently delete ${paths.length} image(s) via InvokeAI.`;
    confirmOnly.style.display = "block";
    keepControls.style.display = "none";
    $("#btn-confirm").className = "danger";
    $("#btn-confirm").textContent = "Delete";
    showStrongConfirmGate();
    backdrop.classList.add("open");
  }

  function closeModal() {
    if (state.bulkRunning) return;
    $("#modal").classList.remove("open");
    state.action = null;
    state.pendingPaths = null;
    resetProgressPanel();
    resetStrongConfirm();
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
      $("#progress-errors").textContent = errors ? `${errors} failed (continued with remaining)` : "";
    }
  }

  function setBulkUiRunning(running) {
    state.bulkRunning = running;
    const confirm = $("#btn-confirm");
    const cancel = $("#btn-cancel");
    if (confirm) confirm.disabled = running || (needsStrongConfirm() && !state.strongConfirmOk);
    if (cancel) cancel.disabled = running;
    const keep = $("#keep-controls");
    if (keep) {
      keep.querySelectorAll("input, button, select").forEach((el) => {
        el.disabled = running;
      });
    }
    const gate = $("#confirm-gate");
    if (gate) {
      gate.querySelectorAll("input").forEach((el) => {
        el.disabled = running;
      });
    }
    updateFilterActionButtons();
  }

  function needsStrongConfirm() {
    return (
      state.action === "delete-all-inputs" ||
      state.action === "delete-lookalike-inputs" ||
      state.action === "delete-paths"
    );
  }

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
      await loadFolders({ force: true });
      selectFolder(name);
      toast(`Created folder “${name}”`, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function fetchAllInputPaths() {
    const data = await api("/api/images/inputs");
    return (data.items || []).map((it) => it.path).filter(Boolean);
  }

  async function runDeletePaths(paths, { successToast } = {}) {
    const total = paths.length;
    let done = 0;
    let errors = 0;
    const failed = [];

    setBulkUiRunning(true);
    const confirmOnly = $("#confirm-only");
    if (confirmOnly) confirmOnly.style.display = "none";
    const gate = $("#confirm-gate");
    if (gate) gate.hidden = true;

    updateProgress({ label: "Deleting…", done: 0, total, current: "", errors: 0 });

    try {
      for (let i = 0; i < paths.length; i += DELETE_BATCH) {
        const batch = paths.slice(i, i + DELETE_BATCH);
        const label = batch.map(basename).join(", ");
        updateProgress({
          label: "Deleting…",
          done,
          total,
          current: label,
          errors,
        });
        await yieldToUi();
        try {
          await api("/api/actions/delete", {
            method: "POST",
            body: JSON.stringify({ paths: batch }),
          });
          done += batch.length;
          for (const path of batch) state.selected.delete(path);
        } catch (err) {
          // Fall back to one-at-a-time so a single bad file doesn't fail the whole batch
          for (const path of batch) {
            const name = basename(path);
            try {
              await api("/api/actions/delete", {
                method: "POST",
                body: JSON.stringify({ paths: [path] }),
              });
              done += 1;
              state.selected.delete(path);
            } catch (err2) {
              errors += 1;
              failed.push({ path, message: err2.message || "failed" });
              updateProgress({
                label: "Deleting…",
                done,
                total,
                current: `${name} — ${err2.message || "error"}`,
                errors,
              });
              await yieldToUi();
            }
          }
        }
        updateProgress({ label: "Deleting…", done, total, current: label, errors });
      }

      updateProgress({
        label: errors ? "Deleting finished with errors" : "Deleting complete",
        done,
        total,
        current: "",
        errors,
      });
      await yieldToUi();

      if (errors === 0) {
        toast(successToast || `Deleted ${done} via InvokeAI`, "ok");
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
        state.bulkRunning = false;
        const cancel = $("#btn-cancel");
        if (cancel) cancel.disabled = false;
        const confirm = $("#btn-confirm");
        if (confirm) confirm.disabled = true;
      }
      await loadImages();
    } catch (err) {
      toast(err.message || "Bulk delete failed", "error");
      state.bulkRunning = false;
      setBulkUiRunning(false);
    } finally {
      if (errors === 0) setBulkUiRunning(false);
    }
  }

  /**
   * Bulk copy / move / delete runs one file at a time so the progress bar can
   * update. On per-item errors we continue (error count in the panel); toast
   * summarizes at the end.
   */
  async function confirmAction() {
    if (!state.action || state.bulkRunning) return;

    if (needsStrongConfirm() && !state.strongConfirmOk) {
      toast("Confirm by checking the box or typing DELETE", "error");
      return;
    }

    if (state.action === "delete-all-inputs") {
      try {
        updateProgress({ label: "Listing all inputs…", done: 0, total: 0, current: "", errors: 0 });
        setBulkUiRunning(true);
        const paths = await fetchAllInputPaths();
        if (!paths.length) {
          toast("No inputs found", "error");
          setBulkUiRunning(false);
          closeModal();
          return;
        }
        await runDeletePaths(paths, { successToast: `Deleted ${paths.length} inputs via InvokeAI` });
      } catch (err) {
        toast(err.message || "Failed to list inputs", "error");
        setBulkUiRunning(false);
      }
      return;
    }

    if (state.action === "delete-lookalike-inputs") {
      const paths = [];
      for (const g of state.lookalikeGroups) {
        if (!g.mixed) continue;
        for (const it of g.items || []) {
          if (it.kind === "input") paths.push(it.path);
        }
      }
      if (!paths.length) {
        toast("No lookalike inputs to delete", "error");
        return;
      }
      await runDeletePaths(paths, {
        successToast: `Deleted ${paths.length} lookalike inputs via InvokeAI`,
      });
      return;
    }

    if (state.action === "delete-paths") {
      const paths = state.pendingPaths || [];
      if (!paths.length) return;
      await runDeletePaths(paths);
      return;
    }

    const paths = [...state.selected];
    if (!paths.length) return;

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

    const verb = action === "delete" ? "Deleting" : action === "move" ? "Moving" : "Copying";
    const endpoint =
      action === "delete"
        ? "/api/actions/delete"
        : action === "move"
          ? "/api/actions/move"
          : "/api/actions/copy";

    setBulkUiRunning(true);
    if (action !== "delete") {
      const keep = $("#keep-controls");
      if (keep) keep.style.display = "none";
    }
    const confirmOnly = $("#confirm-only");
    if (action === "delete" && confirmOnly) confirmOnly.style.display = "none";

    updateProgress({ label: `${verb}…`, done: 0, total, current: "", errors: 0 });

    try {
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const name = basename(path);
        updateProgress({ label: `${verb}…`, done, total, current: name, errors });
        await yieldToUi();

        try {
          const body =
            action === "delete" ? { paths: [path] } : { paths: [path], dest_folder: dest };
          await api(endpoint, { method: "POST", body: JSON.stringify(body) });
          done += 1;
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

        updateProgress({ label: `${verb}…`, done, total, current: name, errors });
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
      let label =
        k === "all" ? "All" : k === "output" ? "Outputs" : k === "input" ? "Inputs" : "Lookalikes";
      if (k === "all" && c.all != null) label = `All (${c.all})`;
      else if (k === "output" && c.output != null) label = `Outputs (${c.output})`;
      else if (k === "input" && c.input != null) label = `Inputs (${c.input})`;
      else if (k === "lookalikes" && state.lookalikeGroups) {
        const n = state.kindFilter === "lookalikes" ? state.lookalikeGroups.length : null;
        if (n != null) label = `Lookalikes (${n})`;
      }
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
        updateFilterActionButtons();
        loadImages();
      });
    }
    $("#btn-select-all").addEventListener("click", selectAllOnPage);
    const pageChk = $("#chk-select-all-page");
    if (pageChk) {
      pageChk.addEventListener("click", (e) => {
        e.preventDefault();
        toggleSelectAllOnPage();
      });
    }
    $("#btn-clear").addEventListener("click", clearSelection);
    $("#btn-delete").addEventListener("click", () => openModal("delete"));
    $("#btn-copy").addEventListener("click", () => openModal("copy"));
    $("#btn-move").addEventListener("click", () => openModal("move"));
    const btnDelAll = $("#btn-delete-all-inputs");
    if (btnDelAll) btnDelAll.addEventListener("click", () => openModal("delete-all-inputs"));
    const btnDelLook = $("#btn-delete-lookalike-inputs");
    if (btnDelLook) btnDelLook.addEventListener("click", () => openModal("delete-lookalike-inputs"));
    const chkUnderstand = $("#chk-understand");
    if (chkUnderstand) chkUnderstand.addEventListener("change", updateConfirmEnabled);
    const confirmType = $("#confirm-type");
    if (confirmType) confirmType.addEventListener("input", updateConfirmEnabled);
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
    $("#btn-refresh").addEventListener("click", () => {
      if (state.kindFilter === "lookalikes") loadLookalikes({ rescan: true });
      else loadImages();
    });
    const hammSel = $("#lookalike-hamming");
    if (hammSel) {
      hammSel.addEventListener("change", () => {
        const v = parseInt(hammSel.value, 10);
        if (!Number.isNaN(v)) {
          state.lookalikeHamming = v;
          if (state.kindFilter === "lookalikes") loadLookalikes({ rescan: false });
        }
      });
    }
    const btnRescan = $("#btn-lookalike-rescan");
    if (btnRescan) {
      btnRescan.addEventListener("click", () => loadLookalikes({ rescan: true }));
    }
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
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        const t = e.target;
        const tag = (t && t.tagName) || "";
        const onPageChk = pageChk && (t === pageChk || (t.closest && t.closest(".page-select-label")));
        if (
          !onPageChk &&
          (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable))
        ) {
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
