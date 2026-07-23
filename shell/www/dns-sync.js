(function () {
  const API_URL = "/cgi-bin/router-dns-text-sync.cgi";
  const SYNC_API_URL = "/cgi-bin/router-dns-github-sync.cgi";
  const state = {
    loading: false,
    text: "",
    selectedGroupId: "",
    progress: null,
    syncStatus: null,
  };
  let progressClearTimer = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function showBanner(kind, text) {
    const banner = $("banner");
    if (!banner) return;
    banner.className = "banner show " + kind;
    banner.textContent = text;
  }

  function clearBanner() {
    const banner = $("banner");
    if (!banner) return;
    banner.className = "banner";
    banner.textContent = "";
  }

  function clampProgressPercent(value) {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number) || number <= 0) return 0;
    if (number >= 100) return 100;
    return number;
  }

  function renderProgress() {
    const progress = $("dnsProgress");
    if (!progress) return;
    const data = state.progress;
    progress.hidden = !data;
    if (!data) return;
    const percent = clampProgressPercent(data.percent);
    const stepNode = $("dnsProgressStep");
    const percentNode = $("dnsProgressPercent");
    const barNode = $("dnsProgressBar");
    if (stepNode) stepNode.textContent = data.step || "Выполняем операцию на роутере";
    if (percentNode) percentNode.textContent = percent + "%";
    if (barNode) barNode.style.width = percent + "%";
  }

  function setProgress(percent, step) {
    window.clearTimeout(progressClearTimer);
    state.progress = {
      percent: clampProgressPercent(percent),
      step: step || "Выполняем операцию на роутере",
    };
    renderProgress();
  }

  function clearProgress() {
    window.clearTimeout(progressClearTimer);
    state.progress = null;
    renderProgress();
  }

  function finishProgress() {
    window.clearTimeout(progressClearTimer);
    progressClearTimer = window.setTimeout(clearProgress, 1200);
  }

  function fetchJson(url, options) {
    return fetch(url, options).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.message || "HTTP " + response.status);
      }
      return data;
    });
  }

  function decodeBase64(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return decodeURIComponent(
        Array.from(atob(raw))
          .map((char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
      );
    } catch (error) {
      try {
        return atob(raw);
      } catch (nestedError) {
        return "";
      }
    }
  }

  function encodeBase64(value) {
    return btoa(unescape(encodeURIComponent(String(value || ""))));
  }

  function dnsRuleOrder(groupId) {
    const match = String(groupId || "").match(/^domain-list(\d+)$/);
    return match ? Number(match[1]) : 999999;
  }

  function ensureParsedGroup(groups, groupId) {
    const key = String(groupId || "");
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: key,
        description: "",
        route: "",
        includes: [],
      });
    }
    return groups.get(key);
  }

  function parseTransferText(text) {
    const groups = new Map();
    const isV2 = /(?:^|\n)# vpn-routing-ui dns-groups v2(?:\r?\n|$)/.test(String(text || ""));
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach((line) => {
        const parts = line.split("|");
        if (parts[0] === "G" && /^domain-list\d+$/.test(parts[1] || "")) {
          const group = ensureParsedGroup(groups, parts[1]);
          group.description = isV2 ? parts.slice(2).join("|") : decodeBase64(parts[2] || "");
          group.route = "";
          return;
        }
        if (parts[0] === "I" && /^domain-list\d+$/.test(parts[1] || "")) {
          const group = ensureParsedGroup(groups, parts[1]);
          const includeValue = parts.slice(2).join("|").trim();
          if (includeValue) {
            group.includes.push(includeValue);
          }
        }
      });

    return Array.from(groups.values()).sort((left, right) => dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId));
  }

  function serializeTransferText(groups) {
    const lines = [
      "# vpn-routing-ui dns-groups v2",
      "# G|domain-listN|name/description",
      "# I|domain-listN|include-value",
      "# generated " + new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ];

    groups
      .slice()
      .sort((left, right) => dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId))
      .forEach((group) => {
        const groupId = String(group.groupId || "").trim();
        if (!/^domain-list\d+$/.test(groupId)) {
          return;
        }
        lines.push(["G", groupId, group.description || ""].join("|"));
        (Array.isArray(group.includes) ? group.includes : []).forEach((includeValue) => {
          lines.push(["I", groupId, includeValue].join("|"));
        });
      });

    return lines.join("\n") + "\n";
  }

  function ensureSelectedGroup(groups) {
    if (!groups.length) {
      state.selectedGroupId = "";
      return null;
    }
    const current = groups.find((group) => group.groupId === state.selectedGroupId);
    if (current) {
      return current;
    }
    state.selectedGroupId = groups[0].groupId;
    return groups[0];
  }

  function selectedGroup(groups) {
    return groups.find((group) => group.groupId === state.selectedGroupId) || null;
  }

  function currentMetrics() {
    const groups = parseTransferText(state.text);
    return {
      groupCount: groups.length,
      includeCount: groups.reduce((sum, group) => sum + group.includes.length, 0),
      routeCount: groups.filter((group) => group.route).length,
    };
  }

  function hostCountText(count) {
    const value = Number(count) || 0;
    return value + " шт.";
  }

  function setBusy(busy) {
    state.loading = busy;
    [
      "reloadBtn",
      "copyTextBtn",
      "downloadTextBtn",
      "openFileBtn",
      "validateTextBtn",
      "applyTextBtn",
      "addGroupBtn",
      "captureVersionBtn",
      "syncDnsBtn",
      "refreshSyncStatusBtn",
      "saveSyncSettingsBtn",
      "syncRepositoryInput",
      "syncBranchInput",
      "syncPathInput",
      "syncKeyInput",
      "syncSecretInput",
      "groupNameInput",
      "groupHostsText",
      "saveGroupTextBtn",
      "saveGroupApplyBtn",
      "discardGroupBtn",
    ].forEach((id) => {
      const element = $(id);
      if (element) element.disabled = busy;
    });
    if ($("dnsText")) $("dnsText").disabled = busy;
  }

  function renderStats(payload) {
    const container = $("transferStats");
    if (!container) return;
    const metrics = payload || currentMetrics();
    const groupCount = Number(metrics.groupCount) || 0;
    const includeCount = Number(metrics.includeCount) || 0;
    const routeCount = Number(metrics.routeCount) || 0;
    container.innerHTML = `
      <div class="engine-inline-chip ${groupCount ? "chip-ok" : "chip-warn"}">
        <span class="label">Группы</span>
        <span class="value">${escapeHtml(groupCount)}</span>
      </div>
      <div class="engine-inline-chip ${includeCount ? "chip-ok" : "chip-muted"}">
        <span class="label">Хосты</span>
        <span class="value">${escapeHtml(includeCount)}</span>
      </div>
      <div class="engine-inline-chip ${routeCount ? "chip-ok" : "chip-muted"}">
        <span class="label">Маршруты</span>
        <span class="value">${escapeHtml(routeCount)}</span>
      </div>
      <div class="engine-inline-chip chip-muted">
        <span class="label">Формат</span>
        <span class="value">${/(?:^|\n)# vpn-routing-ui dns-groups v2(?:\r?\n|$)/.test(state.text) ? "dns-groups v2" : "dns-groups v1"}</span>
      </div>
    `;
  }

  function formatVersionDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return new Intl.DateTimeFormat("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function setVersionNote(id, kind, text) {
    const node = $(id);
    if (!node) return;
    node.className = "dns-version-note" + (kind ? " " + kind : "");
    node.textContent = text;
  }

  function renderSyncStatus(payload) {
    const data = payload || {};
    state.syncStatus = data;

    const localVersionNode = $("localVersionValue");
    if (localVersionNode) {
      localVersionNode.textContent = data.localVersionKnown
        ? formatVersionDate(data.localVersion)
        : data.localChanged
          ? "Не зафиксирована"
          : "Не задана";
    }
    if (data.localVersionKnown) {
      setVersionNote("localVersionState", "ok", "Текущий снимок учтён в системе версий");
    } else if (data.localChanged) {
      setVersionNote(
        "localVersionState",
        "warn",
        "DNS-группы изменились. Нажми «Считать текущую версию», чтобы присвоить текущую секунду."
      );
    } else {
      setVersionNote("localVersionState", "warn", "Считай текущую версию перед первой отправкой на GitHub");
    }

    const remoteVersionNode = $("remoteVersionValue");
    if (remoteVersionNode) {
      remoteVersionNode.textContent = data.remoteVersion ? formatVersionDate(data.remoteVersion) : "Недоступна";
    }
    if (data.remoteError) {
      setVersionNote("remoteVersionState", "error", data.remoteError);
    } else if (data.remoteVersion) {
      const commit = String(data.remoteCommit || "").slice(0, 7);
      setVersionNote("remoteVersionState", "ok", commit ? "Коммит " + commit : "Дата DNS-файла получена");
    } else {
      setVersionNote("remoteVersionState", "warn", "Версия DNS-файла ещё не получена");
    }

    if ($("syncRepositoryValue")) {
      $("syncRepositoryValue").textContent = data.repository || "Не настроен";
    }
    if ($("syncRepositoryState")) {
      $("syncRepositoryState").textContent = [data.branch, data.path].filter(Boolean).join(" · ") || "Укажи источник";
    }
    if ($("syncRepositoryInput")) $("syncRepositoryInput").value = data.repository || "";
    if ($("syncBranchInput")) $("syncBranchInput").value = data.branch || "";
    if ($("syncPathInput")) $("syncPathInput").value = data.path || "";
    if ($("syncKeyInput")) $("syncKeyInput").value = data.key || "";
    if ($("syncSecretInput")) {
      $("syncSecretInput").value = "";
      $("syncSecretInput").placeholder = data.secretConfigured
        ? "Секрет сохранён — оставь пустым, чтобы не менять"
        : "Введи Personal access token";
    }
    if ($("syncSecretState")) {
      $("syncSecretState").textContent = data.secretConfigured
        ? "Секрет сохранён на роутере и не возвращается в браузер."
        : "Секрет ещё не задан. Нужен токен с доступом к содержимому репозитория.";
    }
  }

  async function loadSyncStatus(options) {
    const opts = options || {};
    if (!opts.silent) setBusy(true);
    try {
      const data = await fetchJson(SYNC_API_URL + "?action=status", { cache: "no-store" });
      renderSyncStatus(data);
      return data;
    } catch (error) {
      setVersionNote("remoteVersionState", "error", "Не удалось прочитать версии: " + error.message);
      if (!opts.silent) showBanner("error", "Не удалось прочитать версии DNS: " + error.message);
      throw error;
    } finally {
      if (!opts.silent) setBusy(false);
    }
  }

  async function recordCurrentVersion() {
    return fetchJson(SYNC_API_URL + "?action=mark-current", { method: "POST" });
  }

  async function captureCurrentVersion() {
    setBusy(true);
    setProgress(20, "Считываем текущие DNS-группы");
    showBanner("warn", "Фиксируем текущую версию роутера...");
    try {
      const data = await recordCurrentVersion();
      setProgress(75, "Обновляем состояние версий");
      await loadSyncStatus({ silent: true });
      setProgress(100, "Текущая версия зафиксирована");
      showBanner("ok", `${data.message || "Текущая версия зафиксирована."} ${formatVersionDate(data.localVersion)}`);
      finishProgress();
    } catch (error) {
      clearProgress();
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSyncSettings() {
    const repository = ($("syncRepositoryInput") ? $("syncRepositoryInput").value : "").trim();
    const branch = ($("syncBranchInput") ? $("syncBranchInput").value : "").trim();
    const path = ($("syncPathInput") ? $("syncPathInput").value : "").trim();
    const key = ($("syncKeyInput") ? $("syncKeyInput").value : "").trim();
    const secret = ($("syncSecretInput") ? $("syncSecretInput").value : "").trim();
    if (!repository || !branch || !path || !key) {
      showBanner("error", "Заполни репозиторий, ветку, путь файла и ключ / логин GitHub.");
      return;
    }

    setBusy(true);
    showBanner("warn", "Сохраняем настройки GitHub...");
    try {
      const body = [
        "repository=" + repository,
        "branch=" + branch,
        "path=" + path,
        "key=" + key,
        "secret=" + secret,
      ].join("\n");
      const data = await fetchJson(SYNC_API_URL + "?action=settings", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
      });
      await loadSyncStatus({ silent: true });
      showBanner("ok", data.message || "Настройки GitHub сохранены.");
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function syncDns() {
    setBusy(true);
    setProgress(8, "Шаг 1 из 4: читаем версии и DNS-группы");
    showBanner("warn", "Сравниваем версию роутера с версией DNS-файла GitHub...");
    try {
      setProgress(28, "Шаг 2 из 4: выбираем более новую сторону");
      const data = await fetchJson(SYNC_API_URL + "?action=sync", { method: "POST" });
      setProgress(78, "Шаг 3 из 4: перечитываем DNS-группы");
      await loadFromRouter();
      await loadSyncStatus({ silent: true });
      setProgress(100, "Шаг 4 из 4: синхронизация завершена");
      showBanner("ok", data.message || "DNS-группы синхронизированы.");
      finishProgress();
    } catch (error) {
      clearProgress();
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  function renderGroupsTable() {
    const body = $("groupsTableBody");
    if (!body) return;
    const groups = parseTransferText(state.text);
    ensureSelectedGroup(groups);
    if (!groups.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">Вставь DNS-файл или получи снимок с роутера.</td></tr>';
      renderGroupEditor(groups);
      return;
    }
    body.innerHTML = groups
      .map((group, index) => {
        const routeClass = group.route ? "status-pill status-ok tiny-status" : "status-pill status-neutral tiny-status";
        const selectedClass = group.groupId === state.selectedGroupId ? " is-selected" : "";
        const includePreview = group.includes.slice(0, 3).join(", ");
        const includeExtra = group.includes.length > 3 ? " +" + (group.includes.length - 3) : "";
        return `
          <tr class="dns-transfer-row${selectedClass}" data-group-id="${escapeHtml(group.groupId)}">
            <td class="mono">${index + 1}</td>
            <td class="mono">${escapeHtml(group.groupId)}</td>
            <td>${escapeHtml(group.description || group.groupId)}</td>
            <td>
              <div class="client-device-name">${escapeHtml(hostCountText(group.includes.length))}</div>
              <div class="client-device-meta">${escapeHtml(includePreview || "пусто")}${escapeHtml(includeExtra)}</div>
            </td>
            <td><span class="${routeClass}">${escapeHtml(group.route || "не назначен")}</span></td>
          </tr>
        `;
      })
      .join("");
    renderGroupEditor(groups);
  }

  function renderGroupEditor(groups) {
    const container = $("groupEditor");
    if (!container) return;
    const group = selectedGroup(groups);
    if (!group) {
      container.innerHTML = '<div class="dns-group-editor-empty">Выбери DNS-группу слева, чтобы править её хосты.</div>';
      return;
    }

    const disabled = state.loading ? " disabled" : "";
    const routeClass = group.route ? "status-pill status-ok tiny-status" : "status-pill status-neutral tiny-status";
    container.innerHTML = `
      <div class="dns-group-editor-head">
        <div>
          <h3>${escapeHtml(group.description || group.groupId)}</h3>
          <div class="client-device-meta mono">${escapeHtml(group.groupId)}</div>
        </div>
        <span class="${routeClass}">${escapeHtml(group.route || "маршрут не назначен")}</span>
      </div>
      <div class="field-stack dns-group-name-field">
        <label for="groupNameInput">Название списка</label>
        <input id="groupNameInput" type="text" value="${escapeHtml(group.description || "")}"${disabled}>
      </div>
      <div class="field-stack">
        <label for="groupHostsText">Хосты, домены или IP, по одному в строке</label>
        <textarea id="groupHostsText" class="dns-hosts-text" spellcheck="false"${disabled}>${escapeHtml(
          group.includes.join("\n")
        )}</textarea>
      </div>
      <div class="dns-group-editor-actions">
        <button id="saveGroupTextBtn" class="secondary" type="button"${disabled}>Сохранить в текст</button>
        <button id="saveGroupApplyBtn" class="warning" type="button"${disabled}>Сохранить эту группу</button>
        <button id="discardGroupBtn" class="ghost" type="button"${disabled}>Отменить</button>
      </div>
    `;
  }

  function renderText(text, payload) {
    state.text = String(text || "");
    if ($("dnsText")) {
      $("dnsText").value = state.text;
    }
    ensureSelectedGroup(parseTransferText(state.text));
    renderStats(payload);
    renderGroupsTable();
  }

  function readTextArea() {
    state.text = $("dnsText") ? $("dnsText").value : "";
    ensureSelectedGroup(parseTransferText(state.text));
    renderStats();
    renderGroupsTable();
  }

  function normalizeHostsInput(value) {
    const seen = new Set();
    const hosts = [];
    const invalid = [];

    String(value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach((line) => {
        if (!/^[A-Za-z0-9._:/*-]+$/.test(line)) {
          invalid.push(line);
          return;
        }
        const key = line.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          hosts.push(line);
        }
      });

    if (invalid.length) {
      return {
        ok: false,
        error:
          "Keenetic не примет эти строки: " +
          invalid.slice(0, 4).join(", ") +
          (invalid.length > 4 ? "..." : ""),
      };
    }

    return { ok: true, hosts };
  }

  function nextGroupId(groups) {
    const used = new Set(groups.map((group) => group.groupId));
    let index = 0;
    while (used.has("domain-list" + index)) {
      index += 1;
    }
    return "domain-list" + index;
  }

  async function applySelectedGroup(group, options) {
    const opts = options || {};
    const suffix = opts.allowShrink ? "&allowShrink=1" : "";
    setBusy(true);
    setProgress(10, "Шаг 1 из 3: готовим DNS-группу");
    showBanner("warn", "Сохраняем на роутер только выбранную DNS-группу без изменения DNS-маршрута...");
    try {
      setProgress(35, "Шаг 2 из 3: отправляем группу на роутер");
      const data = await fetchJson(API_URL + "?action=apply-group" + suffix, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: serializeTransferText([group]),
      });
      let versionNote = "";
      try {
        await recordCurrentVersion();
        await loadSyncStatus({ silent: true });
      } catch (versionError) {
        versionNote = " Версию не удалось зафиксировать: " + versionError.message;
      }
      setProgress(100, "Шаг 3 из 3: группа сохранена");
      showBanner(
        "ok",
        `${data.message || "DNS-группа сохранена на роутер."} ${group.description || group.groupId}: добавлено ${hostCountText(
          data.includesApplied || 0
        )}, удалено ${hostCountText(data.includesRemoved || 0)}.${versionNote}`
      );
      finishProgress();
    } catch (error) {
      clearProgress();
      throw error;
    } finally {
      setBusy(false);
    }
  }

  function saveSelectedGroup(applyRouter) {
    const groups = parseTransferText(state.text);
    const group = selectedGroup(groups);
    if (!group) {
      showBanner("error", "Сначала выбери DNS-группу.");
      return Promise.resolve();
    }

    const hostResult = normalizeHostsInput($("groupHostsText") ? $("groupHostsText").value : "");
    if (!hostResult.ok) {
      showBanner("error", hostResult.error);
      return Promise.resolve();
    }

    const previousHostCount = Array.isArray(group.includes) ? group.includes.length : 0;
    group.description = ($("groupNameInput") ? $("groupNameInput").value : "").trim() || group.groupId;
    group.includes = hostResult.hosts;
    state.selectedGroupId = group.groupId;
    renderText(serializeTransferText(groups));

    if (!applyRouter) {
      showBanner("ok", `Группа ${group.description || group.groupId} обновлена в тексте.`);
      return Promise.resolve();
    }

    const allowShrink =
      previousHostCount > 0 &&
      group.includes.length < previousHostCount &&
      window.confirm(
        `В группе ${group.description || group.groupId} станет меньше хостов: ${previousHostCount} -> ${
          group.includes.length
        }. Точно сохранить удаление?`
      );
    if (previousHostCount > 0 && group.includes.length < previousHostCount && !allowShrink) {
      showBanner("warn", "Сохранение на роутер отменено: список хостов стал меньше.");
      return Promise.resolve();
    }

    return applySelectedGroup(group, { allowShrink });
  }

  function addGroup() {
    readTextArea();
    const groups = parseTransferText(state.text);
    const groupId = nextGroupId(groups);
    groups.push({
      groupId,
      description: "new-group",
      route: "",
      includes: [],
    });
    state.selectedGroupId = groupId;
    renderText(serializeTransferText(groups));
    showBanner("ok", "Добавлена новая DNS-группа. Заполни название и хосты.");
  }

  function scrollHashTargetIntoView() {
    const hash = String(window.location.hash || "").slice(1);
    if (!hash || !/^[A-Za-z0-9_-]+$/.test(hash)) {
      return;
    }
    const target = document.getElementById(hash);
    if (target) {
      target.scrollIntoView({ block: "start" });
    }
  }

  function scheduleHashScroll() {
    scrollHashTargetIntoView();
    window.setTimeout(scrollHashTargetIntoView, 250);
    window.setTimeout(scrollHashTargetIntoView, 1000);
  }

  async function loadFromRouter(message) {
    setBusy(true);
    showBanner("warn", "Читаем DNS-файл с роутера...");
    try {
      const data = await fetchJson(API_URL, { cache: "no-store" });
      renderText(data.exportText || "", data);
      scheduleHashScroll();
      if (message) {
        showBanner("ok", message);
      } else {
        clearBanner();
      }
    } catch (error) {
      showBanner("error", "Не удалось получить DNS-файл: " + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function validateText() {
    readTextArea();
    if (!state.text.trim()) {
      showBanner("error", "Вставь DNS-файл перед проверкой.");
      return;
    }
    setBusy(true);
    showBanner("warn", "Проверяем DNS-файл...");
    try {
      const data = await fetchJson(API_URL + "?action=validate", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: state.text,
      });
      renderStats(data);
      showBanner(
        "ok",
        `Текст корректен: ${data.groupCount || 0} групп, ${hostCountText(data.includeCount || 0)}, ${data.routeCount || 0} маршрутов.`
      );
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyText() {
    readTextArea();
    if (!state.text.trim()) {
      showBanner("error", "Вставь DNS-файл перед сохранением.");
      return;
    }
    const metrics = currentMetrics();
    if (!metrics.groupCount) {
      showBanner("error", "В тексте не найдено ни одной DNS-группы.");
      return;
    }
    if (
      !window.confirm(
        `Добавить или обновить DNS-группы из поля? Будет обработано групп: ${metrics.groupCount}, ${hostCountText(metrics.includeCount)}. DNS-маршруты и ProxyN не изменятся. Перед изменением создаётся backup running-config.`
      )
    ) {
      return;
    }

    setBusy(true);
    setProgress(10, "Шаг 1 из 4: проверяем DNS-файл");
    showBanner("warn", "Применяем DNS-группы на роутер без изменения DNS-маршрутов...");
    try {
      setProgress(30, "Шаг 2 из 4: отправляем DNS-группы на роутер");
      const data = await fetchJson(API_URL + "?action=apply", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: state.text,
      });
      let versionNote = "";
      try {
        await recordCurrentVersion();
        await loadSyncStatus({ silent: true });
      } catch (versionError) {
        versionNote = " Версию не удалось зафиксировать: " + versionError.message;
      }
      setProgress(82, "Шаг 3 из 4: перечитываем DNS-файл с роутера");
      await loadFromRouter(
        `${data.message || "DNS-файл сохранён на роутер."} Обновлено групп: ${data.updatedGroups || 0}, создано: ${
          data.createdGroups || 0
        }, добавлено ${hostCountText(data.includesApplied || 0)}, удалено ${hostCountText(data.includesRemoved || 0)}. Маршруты не изменялись.${versionNote}`
      );
      setProgress(100, "Шаг 4 из 4: DNS-файл сохранён");
      finishProgress();
    } catch (error) {
      showBanner("error", error.message);
      clearProgress();
    } finally {
      setBusy(false);
    }
  }

  async function copyText() {
    readTextArea();
    try {
      await navigator.clipboard.writeText(state.text || "");
      showBanner("ok", "DNS-файл скопирован.");
    } catch (error) {
      if ($("dnsText")) {
        $("dnsText").focus();
        $("dnsText").select();
      }
      showBanner("warn", "Не удалось скопировать автоматически, текст выделен вручную.");
    }
  }

  function downloadText() {
    readTextArea();
    const blob = new Blob([state.text || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "vpn-routing-ui-dns-groups.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function openFile() {
    const input = $("importFileInput");
    if (input) input.click();
  }

  async function importFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      renderText(text);
      showBanner("ok", `Файл открыт: ${file.name}. Проверь текст и сохрани на роутер.`);
    } catch (error) {
      showBanner("error", "Не удалось прочитать файл: " + error.message);
    } finally {
      event.target.value = "";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if ($("reloadBtn")) $("reloadBtn").addEventListener("click", () => loadFromRouter("DNS-файл перечитан с роутера."));
    if ($("captureVersionBtn")) $("captureVersionBtn").addEventListener("click", captureCurrentVersion);
    if ($("syncDnsBtn")) $("syncDnsBtn").addEventListener("click", syncDns);
    if ($("refreshSyncStatusBtn")) $("refreshSyncStatusBtn").addEventListener("click", () => loadSyncStatus());
    if ($("saveSyncSettingsBtn")) $("saveSyncSettingsBtn").addEventListener("click", saveSyncSettings);
    if ($("dnsText")) $("dnsText").addEventListener("input", readTextArea);
    if ($("copyTextBtn")) $("copyTextBtn").addEventListener("click", copyText);
    if ($("downloadTextBtn")) $("downloadTextBtn").addEventListener("click", downloadText);
    if ($("openFileBtn")) $("openFileBtn").addEventListener("click", openFile);
    if ($("importFileInput")) $("importFileInput").addEventListener("change", importFile);
    if ($("validateTextBtn")) $("validateTextBtn").addEventListener("click", validateText);
    if ($("applyTextBtn")) $("applyTextBtn").addEventListener("click", applyText);
    if ($("addGroupBtn")) $("addGroupBtn").addEventListener("click", addGroup);
    if ($("groupsTableBody")) {
      $("groupsTableBody").addEventListener("click", (event) => {
        const row = event.target.closest("[data-group-id]");
        if (!row) return;
        state.selectedGroupId = row.getAttribute("data-group-id") || "";
        renderGroupsTable();
        const editor = $("groupEditor");
        if (editor && editor.getBoundingClientRect().top > window.innerHeight * 0.72) {
          editor.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      });
    }
    if ($("groupEditor")) {
      $("groupEditor").addEventListener("click", (event) => {
        if (event.target.closest("#saveGroupTextBtn")) {
          saveSelectedGroup(false);
          return;
        }
        if (event.target.closest("#saveGroupApplyBtn")) {
          saveSelectedGroup(true).catch((error) => showBanner("error", error.message));
          return;
        }
        if (event.target.closest("#discardGroupBtn")) {
          renderGroupsTable();
        }
      });
    }
    loadFromRouter().then(
      () => loadSyncStatus({ silent: true }).catch(() => {}),
      () => loadSyncStatus({ silent: true }).catch(() => {})
    );
  });
})();
