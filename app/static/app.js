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

  function updateToolbar() {
    const n = state.selected.size;
    selCount.textContent = n ? `${n} selected` : "None";
    $("#btn-delete").disabled = n === 0;
    $("#btn-copy").disabled = n === 0;
    $("#btn-move").disabled = n === 0;
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
      card.innerHTML = `
        <div class="check">${state.selected.has(item.path) ? "✓" : ""}</div>
        <img loading="lazy" alt="" src="/api/images/thumb?path=${encodeURIComponent(item.path)}" />
      `;
      card.addEventListener("click", (e) => {
        if (e.detail === 2) {
          openLightbox(item.path);
          return;
        }
        toggleSelect(item.path);
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
      const data = await api(`/api/images?page=${state.page}&limit=${state.limit}`);
      state.items = data.items || [];
      state.total = data.total || 0;
      state.pages = data.pages || 0;
      pageInfo.textContent = state.pages
        ? `Page ${state.page} / ${state.pages} · ${state.total} images`
        : `${state.total} images`;
      $("#btn-prev").disabled = state.page <= 1;
      $("#btn-next").disabled = !state.pages || state.page >= state.pages;
      statusLine.textContent = "";
      // Drop selections that left the visible set? Keep across pages.
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
    box.classList.add("open");
  }

  function closeLightbox() {
    $("#lightbox").classList.remove("open");
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
      loadFolders();
    }
    backdrop.classList.add("open");
  }

  function closeModal() {
    $("#modal").classList.remove("open");
    state.action = null;
  }

  async function loadFolders() {
    const sel = $("#folder-select");
    sel.innerHTML = `<option value="">Loading…</option>`;
    try {
      const data = await api("/api/keepers/folders");
      const folders = data.folders || [];
      if (!folders.length) {
        sel.innerHTML = `<option value="">(no folders yet — create one)</option>`;
      } else {
        sel.innerHTML = folders.map((f) => `<option value="${escapeAttr(f)}">${escapeHtml(f)}</option>`).join("");
      }
    } catch (err) {
      sel.innerHTML = `<option value="">Failed to load</option>`;
      toast(err.message, "error");
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  async function createFolder() {
    const input = $("#new-folder");
    const name = (input.value || "").trim();
    if (!name) return;
    try {
      await api("/api/keepers/folders", { method: "POST", body: JSON.stringify({ name }) });
      input.value = "";
      await loadFolders();
      $("#folder-select").value = name;
      toast(`Created folder “${name}”`, "ok");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function confirmAction() {
    const paths = [...state.selected];
    if (!paths.length || !state.action) return;
    const btn = $("#btn-confirm");
    btn.disabled = true;
    try {
      if (state.action === "delete") {
        const res = await api("/api/actions/delete", {
          method: "POST",
          body: JSON.stringify({ paths }),
        });
        toast(`Deleted ${ (res.deleted_images || []).length } via InvokeAI`, "ok");
      } else {
        const dest = $("#folder-select").value;
        if (!dest) {
          toast("Choose or create a destination folder", "error");
          return;
        }
        const endpoint = state.action === "move" ? "/api/actions/move" : "/api/actions/copy";
        const res = await api(endpoint, {
          method: "POST",
          body: JSON.stringify({ paths, dest_folder: dest }),
        });
        const n = (res.results || []).length;
        toast(
          state.action === "move"
            ? `Moved ${n} (copied + Invoke delete)`
            : `Copied ${n} to ${state.keepLabel}`,
          "ok"
        );
      }
      clearSelection();
      closeModal();
      await loadImages();
    } catch (err) {
      const hint =
        err.payload && err.payload.detail && err.payload.detail.hint
          ? ` — ${err.payload.detail.hint}`
          : "";
      toast(err.message + hint, "error");
    } finally {
      btn.disabled = false;
    }
  }

  function wire() {
    $("#btn-select-all").addEventListener("click", selectAllOnPage);
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
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") closeModal();
    });
    $("#lightbox").addEventListener("click", closeLightbox);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal();
        closeLightbox();
      }
    });
  }

  wire();
  loadConfig().then(loadImages);
})();
