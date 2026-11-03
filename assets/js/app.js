(function () {
  "use strict";

  var STORE = "ollama-manager-form";
  var cfg = null;
  var selectedModel = null;
  var modelfileReady = false;
  var pollTimer = null;
  var LAST_MODEL_KEY = "ollama-manager-last-model";
  var loadedNow = [];
  var daemonActive = false;

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

  // ---------- quick unload / load last ----------
  function lastModel() {
    try { return localStorage.getItem(LAST_MODEL_KEY) || ""; } catch (e) { return ""; }
  }

  // Whatever is in memory, however it got there (Load button, chat, ollama run), counts as "last".
  function rememberLastModel(loaded) {
    loadedNow = loaded.map(function (m) { return m.name; });
    if (!loaded.length) return;
    var newest = loaded.reduce(function (a, b) { return (b.expires_at || "") > (a.expires_at || "") ? b : a; });
    if (newest.name && newest.name !== lastModel()) {
      try { localStorage.setItem(LAST_MODEL_KEY, newest.name); } catch (e) {}
    }
  }

  function updateQuickButtons() {
    var last = lastModel();
    $("btnUnloadAll").disabled = !loadedNow.length;
    $("btnLoadLast").disabled = !last || !daemonActive || loadedNow.indexOf(last) >= 0;
    $("lastModelText").textContent = last
      ? "Last model: " + last + (loadedNow.indexOf(last) >= 0 ? " (loaded now)" : "")
      : "No model remembered yet. The last one you load is remembered here.";
  }

  function loadModel(name) {
    api("/api/models/load", { model: name }).then(function (r) {
      showAddModal(name, true);
      pollJob(r.job, name, true);
    }).catch(fail);
  }

  function renderStatus(s) {
    chatLoaded = s.loaded.map(function (m) { return m.name; });
    refreshChatModels();
    var badge = $("daemonBadge");
    var active = s.state === "active";
    badge.textContent = active ? "Running" : (s.state === "inactive" ? "Stopped" : s.state);
    badge.className = "badge badge-custom " + (active ? "alert-success-custom" : "alert-warning-custom");
    $("daemonVersion").textContent = s.version ? "v" + s.version : "";
    $("btnStart").disabled = active;
    $("btnStop").disabled = !active;
    daemonActive = active;
    rememberLastModel(s.loaded);
    updateQuickButtons();

    if (!settingsSynced || document.activeElement !== $("keepAlive")) {
      if (!settingsSynced) $("keepAlive").value = s.keep_alive;
    }
    if (!settingsSynced) {
      Object.keys(SETTING_INPUTS).forEach(function (k) {
        if (s.env[k] !== undefined) $(SETTING_INPUTS[k]).value = s.env[k];
      });
      // Default OLLAMA_NUM_CTX to 8192 if not set
      if (!$("setNumCtx").value) $("setNumCtx").value = "8192";
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

  function showAddModal(name, loading) {
    $("addModalTitle").textContent = (loading ? "Loading " : "Adding ") + name;
    $("addModalText").textContent = loading
      ? "Ollama is moving the model into memory. Large models can take a minute."
      : "Ollama is reading the file. Large models can take a few minutes.";
    $("addModalLog").textContent = "";
    $("orbit").classList.remove("orbit-done", "orbit-failed");
    $("btnAddClose").classList.add("d-none");
    bootstrap.Modal.getOrCreateInstance($("addModal")).show();
  }

  function pollJob(jobId, name, loading) {
    api("/api/jobs/" + jobId).then(function (job) {
      var log = $("addModalLog");
      log.textContent = job.lines.join("\n");
      log.scrollTop = log.scrollHeight;
      if (job.status === "running") {
        if (loading) $("addModalText").textContent = "Loading into memory... " + (job.elapsed || 0) + "s";
        setTimeout(function () { pollJob(jobId, name, loading); }, 1000);
        return;
      }
      var ok = job.status === "done";
      $("orbit").classList.add(ok ? "orbit-done" : "orbit-failed");
      $("addModalText").textContent = loading
        ? (ok ? name + " is loaded and ready." : "Ollama could not load " + name + ".")
        : (ok ? name + " was added to Ollama." : "Ollama could not add " + name + ".");
      $("btnAddClose").classList.remove("d-none");
      if (ok && !loading) loadModels();
      if (loading) pollStatus();
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
      chatInstalled = r.models.map(function (m) { return m.name; });
      refreshChatModels();
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
    ["btnLoad", "btnRemove", "btnShow", "btnCopyName"].forEach(function (id) { $(id).disabled = !selectedModel; });
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

  // ---------- chat ----------
  var CHAT_AUTOSAVE_KEY = "ollama-manager-chat-autosave";
  var chat = { id: null, model: "", messages: [], dirty: false, streaming: false, abort: null, savedCount: 0 };
  var chatLoaded = [];
  var chatInstalled = [];

  function autosaveOn() {
    try { return localStorage.getItem(CHAT_AUTOSAVE_KEY) === "1"; } catch (e) { return false; }
  }

  function updateChatButtons() {
    var busyNow = chat.streaming;
    $("chatModel").disabled = busyNow;
    $("btnChatNew").disabled = busyNow || !chat.messages.length;
    $("btnChatSave").disabled = busyNow || !chat.messages.length || !chat.dirty;
    $("btnChatClear").disabled = busyNow || !chat.model || !chat.savedCount;
    $("btnChatSend").disabled = !chat.model;
    $("btnChatSend").classList.toggle("d-none", busyNow);
    $("btnChatStop").classList.toggle("d-none", !busyNow);
  }

  function refreshChatModels() {
    var sel = $("chatModel");
    var names = chatLoaded.slice();
    chatInstalled.forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
    if (chat.model && names.indexOf(chat.model) < 0) names.push(chat.model);
    function opts(list) {
      return list.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join("");
    }
    var rest = names.filter(function (n) { return chatLoaded.indexOf(n) < 0; });
    var html = '<option value="">Choose a model</option>' +
      (chatLoaded.length ? '<optgroup label="Loaded in memory">' + opts(chatLoaded) + '</optgroup>' : "") +
      (rest.length ? '<optgroup label="Installed (loads on first message)">' + opts(rest) + '</optgroup>' : "");
    if (sel.dataset.rendered !== html) {
      sel.dataset.rendered = html;
      sel.innerHTML = html;
    }
    if (!chat.model && chatLoaded.length && !chat.messages.length) {
      chat.model = chatLoaded[0];
      loadSaved();
    }
    sel.value = chat.model;
    updateChatButtons();
  }

  // Messages are stored as the plain text the model wrote. ``` fences are turned into code
  // blocks only when displayed, so nothing extra is kept in the database.
  function splitBlocks(text) {
    var parts = [];
    var buf = [];
    var code = false;
    var lang = "";
    function flush(isCode) {
      var body = buf.join("\n");
      if (!isCode) body = body.replace(/^\n+|\n+$/g, "");
      if (isCode || body.trim()) parts.push({ code: isCode, lang: lang, text: body });
      buf = [];
    }
    text.split("\n").forEach(function (line) {
      var open = !code && line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (open) { flush(false); code = true; lang = open[1]; return; }
      if (code && /^\s*```\s*$/.test(line)) { flush(true); code = false; lang = ""; return; }
      buf.push(line);
    });
    flush(code);   // an unclosed fence is a block still being written
    return parts;
  }

  function fillBody(el, text, streaming) {
    el.querySelectorAll("[data-bs-original-title]").forEach(function (t) {
      var tip = bootstrap.Tooltip.getInstance(t);
      if (tip) tip.dispose();
    });
    el.textContent = "";
    splitBlocks(text).forEach(function (part) {
      if (!part.code) {
        var p = document.createElement("div");
        p.className = "chat-part";
        p.textContent = part.text;
        el.appendChild(p);
        return;
      }
      var box = document.createElement("div");
      box.className = "chat-code";
      var head = document.createElement("div");
      head.className = "chat-code-head";
      var label = document.createElement("span");
      label.textContent = part.lang || "code";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-secondary btn-sm btn-icon chat-copy";
      btn.setAttribute("aria-label", "Copy this code");
      btn.innerHTML = '<i class="bi bi-clipboard"></i>';
      if (!streaming) btn.title = "Copy this code";   // tooltips are added once the reply is complete
      btn.addEventListener("click", function () {
        copyCode(part.text, btn);
      });
      head.appendChild(label);
      head.appendChild(btn);
      var pre = document.createElement("pre");
      var codeEl = document.createElement("code");
      codeEl.textContent = part.text;
      pre.appendChild(codeEl);
      box.appendChild(head);
      box.appendChild(pre);
      el.appendChild(box);
    });
    if (!streaming) initTooltips(el);
  }

  function copyCode(text, btn) {
    var icon = btn.querySelector("i");
    function done() {
      icon.className = "bi bi-clipboard-check";
      setTimeout(function () { icon.className = "bi bi-clipboard"; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast("Copy failed.", "error"); });
    } else { toast("Clipboard is not available in this browser.", "error"); }
  }

  function chatBubble(role, text) {
    var el = document.createElement("div");
    el.className = "chat-msg chat-msg-" + role;
    var who = document.createElement("div");
    who.className = "chat-who";
    who.textContent = role === "user" ? "You" : (chat.model || "Model");
    var body = document.createElement("div");
    body.className = "chat-text";
    fillBody(body, text, false);
    el.appendChild(who);
    el.appendChild(body);
    return el;
  }

  function renderChat() {
    var log = $("chatLog");
    log.querySelectorAll("[data-bs-original-title]").forEach(function (t) {
      var tip = bootstrap.Tooltip.getInstance(t);
      if (tip) tip.dispose();
    });
    log.textContent = "";
    if (!chat.messages.length) {
      var empty = document.createElement("p");
      empty.className = "chat-empty";
      empty.textContent = chat.model ? "Say something to " + chat.model + "." : "Choose a model to begin.";
      log.appendChild(empty);
    } else {
      chat.messages.forEach(function (m) {
        if (m.role !== "system") log.appendChild(chatBubble(m.role, m.content));
      });
      log.scrollTop = log.scrollHeight;
    }
    updateChatButtons();
  }

  function resetChat(model) {
    chat.id = null;
    chat.messages = [];
    chat.dirty = false;
    chat.model = model;
    renderChat();
  }

  function confirmDiscard() {
    if (chat.messages.length && chat.dirty) {
      return confirmBox("Discard this conversation?", "It has not been saved.", "Discard");
    }
    return Promise.resolve(true);
  }

  function loadSaved() {
    var model = chat.model;
    if (!model) {
      chat.savedCount = 0;
      render($("chatSaved"), '<div class="list-group-item text-center text-faint">Choose a model to see its saved conversations.</div>');
      updateChatButtons();
      return;
    }
    api("/api/chat/conversations?model=" + encodeURIComponent(model)).then(function (r) {
      if (model !== chat.model) return;
      chat.savedCount = r.conversations.length;
      updateChatButtons();
      if (!r.conversations.length) {
        render($("chatSaved"), '<div class="list-group-item text-center text-faint">Nothing saved for this model.</div>');
        return;
      }
      render($("chatSaved"), r.conversations.map(function (c) {
        return '<div class="list-group-item chat-saved-row' + (c.id === chat.id ? " active" : "") + '">' +
          '<button type="button" class="chat-open" data-chat-open="' + c.id + '" title="Open this conversation">' +
          '<strong class="chat-title">' + esc(c.title) + '</strong>' +
          '<span class="text-faint">' + esc(c.updated) + ' &middot; ' + c.count + ' messages</span></button>' +
          '<button type="button" class="btn btn-danger btn-lg btn-icon" data-chat-del="' + c.id +
          '" title="Delete this conversation"><i class="bi bi-trash3"></i></button></div>';
      }).join(""));
    }).catch(function () {});
  }

  function chatSave(manual) {
    var model = chat.model;
    var snapshot = chat.messages.slice();
    if (!model || !snapshot.length) return Promise.resolve();
    function post(id) { return api("/api/chat/save", { model: model, messages: snapshot, id: id }); }
    return post(chat.id).catch(function (err) {
      if (err.status === 404 && chat.id !== null) { chat.id = null; return post(null); }
      throw err;
    }).then(function (r) {
      chat.id = r.id;
      chat.dirty = false;
      updateChatButtons();
      loadSaved();
      if (manual) toast("Conversation saved.");
    }).catch(fail);
  }

  function chatSend() {
    var input = $("chatInput");
    var text = input.value.trim();
    if (chat.streaming) return;
    if (!chat.model) { toast("Choose a model first.", "error"); return; }
    if (!text) return;

    var wasDirty = chat.dirty;
    var history = chat.messages.concat([{ role: "user", content: text }]);
    var reply = { role: "assistant", content: "" };
    chat.messages = history.concat([reply]);
    chat.dirty = true;
    input.value = "";
    chat.streaming = true;
    renderChat();
    var bubble = $("chatLog").lastChild;
    bubble.classList.add("pending");
    var bodyEl = bubble.querySelector(".chat-text");
    var log = $("chatLog");
    var streamError = "";
    var finished = false;

    function handle(line) {
      if (!line.trim()) return;
      var item = JSON.parse(line);
      if (item.system) {
        chat.messages.unshift({ role: "system", content: item.system });
      } else if (item.delta) {
        var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        reply.content += item.delta;
        fillBody(bodyEl, reply.content, true);
        if (atBottom) log.scrollTop = log.scrollHeight;
      } else if (item.error) {
        streamError = item.error;
      } else if (item.done) {
        finished = true;
      }
    }

    function pump(reader, decoder, buf) {
      return reader.read().then(function (chunk) {
        if (chunk.done) { handle(buf); return; }
        var lines = (buf + decoder.decode(chunk.value, { stream: true })).split("\n");
        var rest = lines.pop();
        lines.forEach(handle);
        return pump(reader, decoder, rest);
      });
    }

    chat.abort = new AbortController();
    fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: chat.model, messages: history }),
      signal: chat.abort.signal
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (d) { throw new Error(d.error || "Request failed"); });
      }
      return pump(r.body.getReader(), new TextDecoder(), "");
    }).catch(function (err) {
      if (err.name !== "AbortError") streamError = err.message;
      else finished = true;
    }).then(function () {
      chat.abort = null;
      chat.streaming = false;
      if (!streamError && !finished) streamError = "The reply was interrupted.";
      if (!reply.content) {
        chat.messages = history.slice(0, -1);
        chat.dirty = wasDirty;
        if (!input.value) input.value = text;
      }
      if (streamError) toast(streamError, "error");
      renderChat();
      if (reply.content && autosaveOn()) chatSave(false);
    });
  }

  function showPrompt() {
    var used = chat.messages.length && chat.messages[0].role === "system" ? chat.messages[0].content : null;
    api("/api/prompt?model=" + encodeURIComponent(chat.model)).then(function (r) {
      var names = Object.keys(r.variables);
      var width = names.reduce(function (w, n) { return Math.max(w, n.length); }, 0) + 6;
      function pad(text) { while (text.length < width) text += " "; return text; }
      var lines = names.map(function (n) {
        return pad("{{" + n + "}}") + String(r.variables[n] === null ? "(not a variable)" : r.variables[n]).replace(/\n/g, " | ") +
          (r.descriptions[n] ? "   [" + r.descriptions[n] + "]" : "");
      });
      $("infoTitle").textContent = "System prompt";
      $("infoBody").textContent =
        (used ? "USED BY THIS CONVERSATION (fixed when it began):\n\n" + used + "\n\n\nWOULD BE USED FOR A NEW CONVERSATION:\n\n" : "WOULD BE USED FOR A NEW CONVERSATION:\n\n") +
        r.rendered +
        "\n\n\nEdit the template: " + r.file + "\nAdd your own variables: " + r.variables_file +
        (r.frozen ? "" : "\n(PROMPT_FREEZE is off: the prompt is refilled on every message.)") +
        "\n\nVARIABLES RIGHT NOW\n\n" + lines.join("\n");
      bootstrap.Modal.getOrCreateInstance($("infoModal")).show();
    }).catch(fail);
  }

  function initChat() {
    $("chatAutosave").checked = autosaveOn();
    $("chatAutosave").addEventListener("change", function () {
      try { localStorage.setItem(CHAT_AUTOSAVE_KEY, this.checked ? "1" : "0"); } catch (e) {}
      if (this.checked) {
        toast("Auto-save is on. Conversations are stored in data/chat on this machine.");
        if (chat.dirty && chat.messages.length && !chat.streaming) chatSave(false);
      }
    });

    $("chatModel").addEventListener("change", function () {
      var sel = this;
      var next = sel.value;
      confirmDiscard().then(function (ok) {
        if (!ok) { sel.value = chat.model; return; }
        resetChat(next);
        loadSaved();
      });
    });

    $("btnChatNew").addEventListener("click", function () {
      confirmDiscard().then(function (ok) { if (ok) { resetChat(chat.model); loadSaved(); } });
    });
    $("btnChatSave").addEventListener("click", function () { chatSave(true); });
    $("btnChatClear").addEventListener("click", function () {
      var model = chat.model;
      confirmBox("Clear saved conversations?",
        "Every saved conversation for this model will be deleted. This cannot be undone.",
        "Clear them", model).then(function (ok) {
        if (!ok) return;
        api("/api/chat/clear", { model: model }).then(function (r) {
          if (model === chat.model) {
            chat.id = null;
            chat.dirty = chat.messages.length > 0;
            loadSaved();
          }
          toast("Cleared " + r.removed + " saved conversation" + (r.removed === 1 ? "." : "s."));
        }).catch(fail);
      });
    });

    $("btnChatPrompt").addEventListener("click", showPrompt);
    $("btnChatExpand").addEventListener("click", function () {
      var log = $("chatLog");
      log.style.height = "";   // forget any height set by dragging the corner
      var tall = log.classList.toggle("chat-log-tall");
      this.querySelector("i").className = tall ? "bi bi-arrows-angle-contract" : "bi bi-arrows-angle-expand";
      this.querySelector("span").textContent = tall ? "Shrink" : "Expand";
      log.scrollTop = log.scrollHeight;
    });
    $("btnChatSend").addEventListener("click", chatSend);
    $("btnChatStop").addEventListener("click", function () { if (chat.abort) chat.abort.abort(); });
    $("chatInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); }
    });

    $("chatSaved").addEventListener("click", function (e) {
      var open = e.target.closest("[data-chat-open]");
      var del = e.target.closest("[data-chat-del]");
      if (chat.streaming) return;
      if (open) {
        var id = parseInt(open.dataset.chatOpen, 10);
        confirmDiscard().then(function (ok) {
          if (!ok) return;
          api("/api/chat/conversation/" + id).then(function (c) {
            chat.id = c.id;
            chat.messages = c.messages;
            chat.dirty = false;
            renderChat();
            loadSaved();
          }).catch(fail);
        });
      } else if (del) {
        var delId = parseInt(del.dataset.chatDel, 10);
        var title = del.parentNode.querySelector(".chat-title").textContent;
        confirmBox("Delete this conversation?", "It will be removed from the database.", "Delete", title).then(function (ok) {
          if (!ok) return;
          api("/api/chat/delete", { id: delId }).then(function () {
            if (chat.id === delId) { chat.id = null; chat.dirty = chat.messages.length > 0; }
            loadSaved();
            updateChatButtons();
          }).catch(fail);
        });
      }
    });

    window.addEventListener("beforeunload", function (e) {
      if (chat.dirty && chat.messages.length) { e.preventDefault(); e.returnValue = ""; }
    });

    renderChat();
    loadSaved();
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
    $("btnLoad").addEventListener("click", function () { loadModel(selectedModel); });
    $("btnLoadLast").addEventListener("click", function () { var last = lastModel(); if (last) loadModel(last); });
    $("btnUnloadAll").addEventListener("click", function () {
      var names = loadedNow.slice();
      busy($("btnUnloadAll"), true);
      Promise.all(names.map(function (n) { return api("/api/unload", { model: n }); })).then(function () {
        toast("Unloaded " + names.join(", ") + ".");
      }).catch(fail).then(pollStatus);
    });
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
    $("btnLogClear").addEventListener("click", function () {
      confirmBox("Clear the activity log?", "Every recorded add and remove event will be erased. This cannot be undone.", "Clear log").then(function (ok) {
        if (!ok) return;
        api("/api/log/clear", {}).then(function () { toast("Log cleared."); loadLog(); }).catch(fail);
      });
    });
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
      initChat();
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
