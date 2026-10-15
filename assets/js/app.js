(function () {
  "use strict";

  var STORE = "ollama-manager-form";
  var cfg = null;
  var selectedModel = null;
  var modelfileReady = false;
  var pollTimer = null;

  bootstrap.Tooltip.Default.container = "body";
  bootstrap.Tooltip.Default.trigger = "hover";

  function $(id) { return document.getElementById(id); }

  function esc(text) {
    var d = document.createElement("div");
    d.textContent = text;
    return d.innerHTML;
  }

  function api(url, body) {
    var opts = body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    return fetch(url, opts).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) { var e = new Error(data.error || "Request failed"); e.status = r.status; e.data = data; throw e; }
        return data;
      });
    });
  }

  function toast(message, kind) {
    var host = $("toastHost");
    var el = document.createElement("div");
    el.className = "toast toast-custom";
    el.setAttribute("role", "status");
    var icon = kind === "error" ? "bi-exclamation-triangle-fill text-danger" : "bi-check-circle-fill text-accent";
    el.innerHTML = '<div class="toast-header"><i class="bi ' + icon + ' me-2"></i>' +
      '<strong class="me-auto">Ollama Manager</strong>' +
      '<button type="button" class="btn-close" data-bs-dismiss="toast"></button></div>' +
      '<div class="toast-body"></div>';
    el.querySelector(".toast-body").textContent = message;
    host.appendChild(el);
    var t = new bootstrap.Toast(el, { delay: kind === "error" ? 9000 : 4000 });
    el.addEventListener("hidden.bs.toast", function () { el.remove(); });
    t.show();
  }

  function fail(err) {
    var detail = err.data && err.data.detail ? " (" + err.data.detail + ")" : "";
    toast(err.message + detail, "error");
  }

  function confirmBox(title, body, yesLabel, subject) {
    return new Promise(function (resolve) {
      var modalEl = $("confirmModal");
      var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      $("confirmTitle").textContent = title;
      $("confirmBody").textContent = body;
      $("confirmName").textContent = subject || "";
      $("confirmName").classList.toggle("d-none", !subject);
      $("confirmYes").textContent = yesLabel || "Yes, do it";
      var answered = false;
      function yes() { answered = true; modal.hide(); }
      function hidden() {
        $("confirmYes").removeEventListener("click", yes);
        modalEl.removeEventListener("hidden.bs.modal", hidden);
        resolve(answered);
      }
      $("confirmYes").addEventListener("click", yes);
      modalEl.addEventListener("hidden.bs.modal", hidden);
      modal.show();
    });
  }

  function hideTip(el) {
    var tip = el && bootstrap.Tooltip.getInstance(el);
    if (tip) tip.hide();
  }

  function initTooltips(root) {
    root.querySelectorAll("[title]").forEach(function (el) {
      bootstrap.Tooltip.getOrCreateInstance(el);
    });
  }

  function render(container, html) {
    if (container.dataset.rendered === html) return;
    container.dataset.rendered = html;
    container.querySelectorAll("[data-bs-original-title]").forEach(function (el) {
      var tip = bootstrap.Tooltip.getInstance(el);
      if (tip) tip.dispose();
    });
    container.innerHTML = html;
    initTooltips(container);
  }

  function busy(btn, on) {
    if (!btn) return;
    if (on) hideTip(btn);
    btn.disabled = on;
  }

  // ---------- form persistence ----------
  var FIELDS = { path: "ggufPath", name: "modelName", temperature: "temperature",
                 num_ctx: "numCtx", format: "promptFormat", system: "systemPrompt" };

  function saveForm() {
    var data = {};
    Object.keys(FIELDS).forEach(function (k) { data[k] = $(FIELDS[k]).value; });
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (e) {}
  }

  function applyDefaults() {
    $("ggufPath").value = cfg.default_models_dir;
    $("modelName").value = "";
    $("temperature").value = cfg.temperature;
    $("numCtx").value = cfg.num_ctx;
    $("promptFormat").value = "auto";
    $("systemPrompt").value = cfg.system;
  }

  function loadForm() {
    applyDefaults();
    try {
      var saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (saved) {
        Object.keys(FIELDS).forEach(function (k) {
          if (saved[k] !== undefined && saved[k] !== "") $(FIELDS[k]).value = saved[k];
        });
      }
    } catch (e) {}
    if (!$("promptFormat").value) $("promptFormat").value = "auto";
  }

  function formData() {
    var fmt = $("promptFormat").value;
    return {
      path: $("ggufPath").value.trim(),
      name: $("modelName").value.trim(),
      temperature: $("temperature").value.trim(),
      num_ctx: $("numCtx").value.trim(),
      system: $("systemPrompt").value,
      format: fmt === "auto" ? "" : fmt
    };
  }

  function markDirty() {
    modelfileReady = false;
    $("btnAddModel").disabled = true;
    saveForm();
  }

  // ---------- status / daemon ----------
  var SETTING_INPUTS = { OLLAMA_FLASH_ATTENTION: "setFlash", OLLAMA_KV_CACHE_TYPE: "setKv",
                         OLLAMA_NUM_PARALLEL: "setParallel", OLLAMA_MAX_LOADED_MODELS: "setMaxLoaded",
                         OLLAMA_NUM_CTX: "setNumCtx" };
  var settingsSynced = false;

  function renderStatus(s) {
    var badge = $("daemonBadge");
    var active = s.state === "active";
    badge.textContent = active ? "Running" : (s.state === "inactive" ? "Stopped" : s.state);
    badge.className = "badge badge-custom " + (active ? "alert-success-custom" : "alert-warning-custom");
    $("daemonVersion").textContent = s.version ? "v" + s.version : "";
    $("btnStart").disabled = active;
    $("btnStop").disabled = !active;

    if (!settingsSynced || document.activeElement !== $("keepAlive")) {
      if (!settingsSynced) $("keepAlive").value = s.keep_alive;
    }
    if (!settingsSynced) {
      Object.keys(SETTING_INPUTS).forEach(function (k) {
        if (s.env[k] !== undefined) $(SETTING_INPUTS[k]).value = s.env[k];
      });
      settingsSynced = true;
    }

    var v = s.vram;
    var bar = $("vramBar");
    if (v.available) {
      bar.style.width = v.percent + "%";
      bar.setAttribute("aria-valuenow", v.percent);
      bar.classList.toggle("bar-warn", v.percent >= 75 && v.percent < 90);
      bar.classList.toggle("bar-danger", v.percent >= 90);
      $("vramText").textContent = v.name + ": " + (v.used_mb / 1024).toFixed(1) + " GB of " +
        (v.total_mb / 1024).toFixed(1) + " GB used (" + v.percent + "%)";
    } else {
      bar.style.width = "0%";
      $("vramText").textContent = "No NVIDIA GPU information available.";
    }

    var list = $("loadedList");
    if (!s.loaded.length) {
      render(list, '<div class="list-group-item text-center text-faint">No models are loaded right now.</div>');
    } else {
      render(list, s.loaded.map(function (m) {
        return '<div class="list-group-item d-flex justify-content-between align-items-center gap-3">' +
          '<span><i class="bi bi-lightning-charge-fill text-accent me-2"></i><strong>' + esc(m.name) + '</strong>' +
          '<span class="text-faint ms-3">' + m.vram_mb + ' MB in VRAM</span></span>' +
          '<button class="btn btn-secondary btn-lg btn-icon" data-unload="' + esc(m.name) +
          '" title="Unload this model from memory now"><i class="bi bi-eject"></i>Unload</button></div>';
      }).join(""));
    }
  }

  function pollStatus() {
    if (document.hidden) return;
    api("/api/status").then(renderStatus).catch(function () {});
  }

  function daemon(action) {
    var btn = $({ start: "btnStart", stop: "btnStop", restart: "btnRestart" }[action]);
    busy(btn, true);
    api("/api/daemon", { action: action }).then(function () {
      toast("Daemon " + action + " requested.");
      settingsSynced = false;
      pollStatus();
    }).catch(fail).then(function () { busy(btn, false); pollStatus(); });
  }

  function saveSetting(key, value, btn) {
    confirmBox("Restart Ollama?", "Saving " + key + " restarts the daemon and unloads any loaded model.", "Save and restart")
      .then(function (ok) {
        if (!ok) return;
        busy(btn, true);
        api("/api/setting", { key: key, value: value }).then(function () {
          toast(key + " saved. Daemon restarted.");
          settingsSynced = false;
          setTimeout(pollStatus, 1500);
        }).catch(fail).then(function () { busy(btn, false); });
      });
  }

  // ---------- add model ----------
  function createModelfile() {
    var btn = $("btnCreateFile");
    busy(btn, true);
    api("/api/modelfile/create", formData()).then(function (r) {
      $("modelfilePreview").textContent = r.text;
      $("previewWrap").classList.remove("d-none");
      modelfileReady = true;
      $("btnAddModel").disabled = false;
      toast("Modelfile created: " + r.path);
    }).catch(fail).then(function () { busy(btn, false); });
  }

  function showAddModal(name) {
    $("addModalTitle").textContent = "Adding " + name;
    $("addModalText").textContent = "Ollama is reading the file. Large models can take a few minutes.";
    $("addModalLog").textContent = "";
    $("orbit").classList.remove("orbit-done", "orbit-failed");
    $("btnAddClose").classList.add("d-none");
    bootstrap.Modal.getOrCreateInstance($("addModal")).show();
  }

  function pollJob(jobId, name) {
    api("/api/jobs/" + jobId).then(function (job) {
      var log = $("addModalLog");
      log.textContent = job.lines.join("\n");
      log.scrollTop = log.scrollHeight;
      if (job.status === "running") { setTimeout(function () { pollJob(jobId, name); }, 1000); return; }
      var ok = job.status === "done";
      $("orbit").classList.add(ok ? "orbit-done" : "orbit-failed");
      $("addModalText").textContent = ok ? name + " was added to Ollama." : "Ollama could not add " + name + ".";
      $("btnAddClose").classList.remove("d-none");
      if (ok) loadModels();
    }).catch(function (err) {
      $("addModalText").textContent = err.message;
      $("btnAddClose").classList.remove("d-none");
    });
  }

  function addModel(overwrite) {
    var data = formData();
    data.overwrite = !!overwrite;
    api("/api/models/create", data).then(function (r) {
      showAddModal(data.name);
      pollJob(r.job, data.name);
    }).catch(function (err) {
      if (err.status === 409) {
        confirmBox("Replace existing model?", "A model named " + data.name + " already exists. Replace it?", "Replace")
          .then(function (ok) { if (ok) addModel(true); });
      } else { fail(err); }
    });
  }

  function browse() {
    var dir = $("ggufPath").value.trim();
    if (/\.gguf$/i.test(dir)) dir = dir.replace(/\/[^\/]*$/, "");
    api("/api/gguf-files?dir=" + encodeURIComponent(dir)).then(function (r) {
      $("browseDir").textContent = r.dir;
      var list = $("browseList");
      if (!r.files.length) {
        render(list, '<div class="list-group-item text-center text-faint">No .gguf files found here.</div>');
      } else {
        render(list, r.files.map(function (f) {
          return '<button type="button" class="list-group-item list-group-item-action" data-pick="' + esc(f.path) + '">' +
            '<i class="bi bi-file-earmark-binary me-2"></i>' + esc(f.name) +
            '<span class="text-faint ms-3">' + (f.size_mb / 1024).toFixed(1) + ' GB</span></button>';
        }).join(""));
      }
      bootstrap.Modal.getOrCreateInstance($("browseModal")).show();
    }).catch(fail);
  }

  function pickFile(path) {
    $("ggufPath").value = path;
    var base = path.split("/").pop().replace(/\.gguf$/i, "");
    if (!$("modelName").value.trim()) {
      $("modelName").value = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    }
    markDirty();
    bootstrap.Modal.getInstance($("browseModal")).hide();
  }

  // ---------- installed models ----------
  function loadModels() {
    api("/api/models").then(function (r) {
      var list = $("modelList");
      selectedModel = null;
      updateModelButtons();
      if (!r.models.length) {
        render(list, '<div class="list-group-item text-center text-faint">No models installed.</div>');
        return;
      }
      render(list, r.models.map(function (m) {
        return '<button type="button" role="option" class="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3" data-model="' + esc(m.name) + '">' +
          '<span><i class="bi bi-box-seam me-2"></i><strong>' + esc(m.name) + '</strong></span>' +
          '<span class="text-faint">' + esc(m.size) + ' &middot; ' + esc(m.modified) + '</span></button>';
      }).join(""));
    }).catch(function (err) {
      render($("modelList"), '<div class="list-group-item text-center text-faint">' + esc(err.message) + '</div>');
    });
  }

  function updateModelButtons() {
    ["btnRemove", "btnShow", "btnCopyName"].forEach(function (id) { $(id).disabled = !selectedModel; });
  }

  // ---------- cheat sheet and log ----------
  var CHEATS = [
    ["ollama list", "List installed models"],
    ["ollama ps", "Show models currently loaded in memory"],
    ["ollama show NAME", "Show details of a model"],
    ["ollama show --modelfile NAME", "Print a model's Modelfile"],
    ["ollama stop NAME", "Unload a model from memory"],
    ["ollama rm NAME", "Delete a model"],
    ["ollama cp OLD NEW", "Copy or rename a model"],
    ["ollama create NAME -f FILE", "Build a model from a Modelfile"],
    ["ollama pull NAME", "Download a model from the Ollama library"],
    ["ollama run NAME", "Chat with a model (loads it into VRAM)"],
    ["systemctl status ollama", "Check the service"],
    ["journalctl -u ollama -n 50 --no-pager", "Read the last 50 daemon log lines"],
    ["nvidia-smi", "Show GPU memory and processes"],
    ["curl http://127.0.0.1:11434/api/ps", "Ask the API what is loaded"]
  ];

  function buildCheats() {
    render($("cheatBody"), CHEATS.map(function (c) {
      return '<tr><td><code>' + esc(c[0]) + '</code></td><td>' + esc(c[1]) + '</td>' +
        '<td class="text-end"><button class="btn btn-secondary btn-lg" data-copy="' + esc(c[0]) +
        '" title="Copy this command"><i class="bi bi-clipboard"></i></button></td></tr>';
    }).join(""));
  }

  function copyText(text) {
    var done = function () { toast("Copied to clipboard."); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast("Copy failed.", "error"); });
    } else { toast("Clipboard is not available in this browser.", "error"); }
  }

  function loadLog() {
    api("/api/log").then(function (r) {
      var view = $("logView");
      view.textContent = r.text || "No activity recorded yet.";
      view.scrollTop = view.scrollHeight;
    }).catch(function () {});
  }

  // ---------- wiring ----------
  function wire() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest("button, [data-model], [data-pick]");
      if (!t) return;
      hideTip(t);
      if (t.dataset.unload) {
        api("/api/unload", { model: t.dataset.unload }).then(function () { toast("Unloaded " + t.dataset.unload + "."); pollStatus(); }).catch(fail);
      } else if (t.dataset.keepalive) {
        $("keepAlive").value = t.dataset.keepalive;
      } else if (t.dataset.setting) {
        saveSetting(t.dataset.setting, $(t.dataset.source).value.trim(), t);
      } else if (t.dataset.copy) {
        copyText(t.dataset.copy);
      } else if (t.dataset.pick) {
        pickFile(t.dataset.pick);
      } else if (t.dataset.model) {
        selectedModel = t.dataset.model;
        document.querySelectorAll("#modelList [data-model]").forEach(function (b) {
          b.classList.toggle("active", b === t);
        });
        updateModelButtons();
      }
    });

    $("btnStart").addEventListener("click", function () { daemon("start"); });
    $("btnStop").addEventListener("click", function () {
      confirmBox("Stop Ollama?", "Every loaded model will be unloaded.", "Stop it").then(function (ok) { if (ok) daemon("stop"); });
    });
    $("btnRestart").addEventListener("click", function () { daemon("restart"); });
    $("btnKeepAlive").addEventListener("click", function () {
      saveSetting("OLLAMA_KEEP_ALIVE", $("keepAlive").value.trim(), $("btnKeepAlive"));
    });

    $("btnBrowse").addEventListener("click", browse);
    $("btnCreateFile").addEventListener("click", createModelfile);
    $("btnAddModel").addEventListener("click", function () { if (modelfileReady) addModel(false); });
    $("btnResetAdd").addEventListener("click", function () {
      applyDefaults();
      markDirty();
      $("previewWrap").classList.add("d-none");
      $("formatHint").textContent = "";
      toast("Defaults restored.");
    });

    Object.keys(FIELDS).forEach(function (k) {
      var el = $(FIELDS[k]);
      el.addEventListener("input", markDirty);
      el.addEventListener("change", markDirty);
    });
    $("numCtx").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); });
    $("temperature").addEventListener("input", function () { this.value = this.value.replace(/[^0-9.]/g, ""); });
    $("setParallel").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); });
    $("setMaxLoaded").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); });

    $("btnRefresh").addEventListener("click", loadModels);
    $("btnRemove").addEventListener("click", function () {
      var name = selectedModel;
      if (!name) return;
      confirmBox("Remove this model?", "This permanently deletes it from Ollama. The .gguf file on your disk is kept.", "Remove", name)
        .then(function (ok) {
          if (!ok) return;
          api("/api/models/remove", { model: name }).then(function (r) { toast(r.message); loadModels(); loadLog(); }).catch(fail);
        });
    });
    $("btnShow").addEventListener("click", function () {
      var name = selectedModel;
      api("/api/models/show?name=" + encodeURIComponent(name)).then(function (r) {
        $("infoTitle").textContent = "Modelfile: " + name;
        $("infoBody").textContent = r.text;
        bootstrap.Modal.getOrCreateInstance($("infoModal")).show();
      }).catch(fail);
    });
    $("btnCopyName").addEventListener("click", function () { copyText(selectedModel); });
    $("btnLogRefresh").addEventListener("click", loadLog);
    $("addModal").addEventListener("hidden.bs.modal", loadLog);
  }

  function init() {
    api("/api/config").then(function (c) {
      cfg = c;
      var sel = $("promptFormat");
      sel.innerHTML = '<option value="auto">Auto-detect from file name</option>' +
        c.formats.map(function (f) { return '<option value="' + esc(f.key) + '">' + esc(f.label) + '</option>'; }).join("");
      loadForm();
      wire();
      buildCheats();
      initTooltips(document);
      pollStatus();
      loadModels();
      loadLog();
      pollTimer = setInterval(pollStatus, c.poll_seconds * 1000);
      $("footerPort").textContent = "Runs on localhost only, port " + location.port;
    }).catch(function (err) { toast(err.message, "error"); });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
