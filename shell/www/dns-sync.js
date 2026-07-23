(function () {
  const API_URL = "/cgi-bin/router-dns-text-sync.cgi";
  const SYNC_API_URL = "/cgi-bin/router-dns-github-sync.cgi";
  const state = {
    loading: false,
    text: "",
    selectedGroupId: "",
    progress: null,
    syncStatus: null,
    syncBlocked: true,
    uploadBlocked: true,
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
    const mod10 = value % 10;
    const mod100 = value % 100;
    const word =
      mod10 === 1 && mod100 !== 11
        ? "адрес"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "адреса"
          : "адресов";
    return value + " " + word;
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
      "uploadDnsBtn",
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
    if ($("syncDnsBtn")) {
      $("syncDnsBtn").disabled = busy || state.syncBlocked;
    }
    if ($("uploadDnsBtn")) {
      $("uploadDnsBtn").disabled = busy || state.uploadBlocked;
    }
    if ($("dnsText")) $("dnsText").disabled = busy;
  }

  function renderStats(payload) {
    const container = $("transferStats");
    if (!container) return;
    const metrics = payload || currentMetrics();
    const groupCount = Number(metrics.groupCount) || 0;
    const includeCount = Number(metrics.includeCount) || 0;
    container.innerHTML = `
      <div class="engine-inline-chip ${groupCount ? "chip-ok" : "chip-warn"}">
        <span class="label">Списков</span>
        <span class="value">${escapeHtml(groupCount)}</span>
      </div>
      <div class="engine-inline-chip ${includeCount ? "chip-ok" : "chip-muted"}">
        <span class="label">Адресов</span>
        <span class="value">${escapeHtml(includeCount)}</span>
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

  function compareVersionDates(left, right) {
    const leftTime = Date.parse(String(left || ""));
    const rightTime = Date.parse(String(right || ""));
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    if (leftTime === rightTime) return 0;
    return leftTime > rightTime ? 1 : -1;
  }

  function renderCompletedSyncAction(previousStatus, result, fallbackDirection) {
    const previous = previousStatus || {};
    const data = result || {};
    const completedStatus = Object.assign({}, previous, {
      secretConfigured: Boolean(previous.secretConfigured),
      localVersion: data.localVersion || previous.localVersion || "",
      localVersionKnown: true,
      localChanged: false,
      remoteVersion: data.remoteVersion || previous.remoteVersion || "",
      remoteCommit: data.remoteCommit || previous.remoteCommit || "",
      remoteError: "",
      lastDirection: data.direction || fallbackDirection || previous.lastDirection || "",
      lastSync: data.lastSync || new Date().toISOString(),
    });
    renderSyncStatus(completedStatus);
    return completedStatus;
  }

  function setSyncPresentation(options) {
    const data = options || {};
    const hub = $("dnsSyncHub");
    const badge = $("syncBadge");
    const icon = $("syncStateIcon");
    if (hub) hub.dataset.syncState = data.state || "ready";
    if (badge) {
      badge.className = "dns-status-badge " + (data.badgeKind || data.state || "ready");
      badge.textContent = data.badge || "Готово";
    }
    if (icon) icon.textContent = data.icon || "✓";
    if ($("syncHeadline")) $("syncHeadline").textContent = data.headline || "Можно синхронизировать";
    if ($("syncExplanation")) $("syncExplanation").textContent = data.explanation || "";
    if ($("syncDirectionLabel")) {
      $("syncDirectionLabel").textContent = data.directionLabel || "Обычное действие: GitHub → роутер";
    }
    if ($("syncDirectionIcon")) $("syncDirectionIcon").textContent = data.directionIcon || "←";
    if ($("syncDnsBtn")) $("syncDnsBtn").textContent = data.buttonText || "Скачать из GitHub на роутер";

    state.syncBlocked = Boolean(data.blocked);
    if ($("syncDnsBtn")) $("syncDnsBtn").disabled = state.loading || state.syncBlocked;

    ["localVersionCard", "remoteVersionCard"].forEach((id) => {
      const node = $(id);
      if (node) node.classList.remove("is-newer", "is-attention");
    });
    if (data.newerCard && $(data.newerCard)) $(data.newerCard).classList.add("is-newer");
    if (data.attentionCard && $(data.attentionCard)) $(data.attentionCard).classList.add("is-attention");
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
      setVersionNote("localVersionState", "ok", "Дата текущего списка");
    } else if (data.localChanged) {
      setVersionNote("localVersionState", "warn", "Изменён вручную — нужно подтвердить дату");
    } else {
      setVersionNote("localVersionState", "warn", "Версия ещё не учитывалась");
    }

    const remoteVersionNode = $("remoteVersionValue");
    if (remoteVersionNode) {
      remoteVersionNode.textContent = data.remoteVersion ? formatVersionDate(data.remoteVersion) : "Недоступна";
    }
    if (data.remoteError) {
      setVersionNote("remoteVersionState", "error", data.remoteError);
    } else if (data.remoteVersion) {
      const commit = String(data.remoteCommit || "").slice(0, 7);
      setVersionNote("remoteVersionState", "ok", commit ? "Последнее изменение · " + commit : "Дата файла получена");
    } else {
      setVersionNote("remoteVersionState", "warn", "Дата файла ещё не получена");
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
        ? "Токен сохранён — оставьте пустым, чтобы не менять"
        : "github_pat_…";
    }
    if ($("syncSecretState")) {
      $("syncSecretState").textContent = data.secretConfigured
        ? "Токен сохранён на роутере и не возвращается в браузер."
        : "Токен ещё не задан. Нужен fine-grained token с правом Contents: Read and write.";
    }
    if ($("syncSettingsSummary")) {
      $("syncSettingsSummary").textContent = data.repository
        ? `${data.repository} · ${data.branch || "main"}`
        : "Репозиторий, файл и токен доступа";
    }
    if ($("syncSettingsBadge")) {
      $("syncSettingsBadge").className = "dns-settings-badge " + (data.secretConfigured ? "ok" : "warn");
      $("syncSettingsBadge").textContent = data.secretConfigured ? "Подключено" : "Нужен токен";
    }
    if ($("syncSettingsDetails") && !data.secretConfigured) {
      $("syncSettingsDetails").open = true;
    }
    if ($("syncLastRun")) {
      $("syncLastRun").textContent = data.lastSync
        ? "Последнее действие: " + formatVersionDate(data.lastSync)
        : "Действия с GitHub ещё не выполнялись";
    }

    const needsCapture = Boolean(data.localChanged || !data.localVersionKnown);
    const captureButton = $("captureVersionBtn");
    if (captureButton) {
      captureButton.hidden = !needsCapture;
      captureButton.textContent = data.localChanged
        ? "Присвоить изменениям текущую дату"
        : "Присвоить роутеру текущую дату";
    }
    if ($("publishLocalState")) {
      if (!data.secretConfigured) {
        $("publishLocalState").className = "dns-publish-state warn";
        $("publishLocalState").textContent = "Сначала подключите GitHub.";
      } else if (data.remoteError) {
        $("publishLocalState").className = "dns-publish-state warn";
        $("publishLocalState").textContent = "Сначала восстановите соединение с GitHub.";
      } else if (needsCapture) {
        $("publishLocalState").className = "dns-publish-state warn";
        $("publishLocalState").textContent =
          "Перед отправкой нужно явно присвоить текущему списку дату этой секунды.";
      } else {
        $("publishLocalState").className = "dns-publish-state ok";
        $("publishLocalState").textContent =
          "Локальная версия зафиксирована: " + formatVersionDate(data.localVersion) + ".";
      }
    }
    if ($("publishSettingsSummary")) {
      $("publishSettingsSummary").textContent = needsCapture
        ? "Сначала подтвердите дату локального списка"
        : "Локальная версия: " + formatVersionDate(data.localVersion);
    }
    state.uploadBlocked = Boolean(!data.secretConfigured || needsCapture || data.remoteError);
    if ($("uploadDnsBtn")) $("uploadDnsBtn").disabled = state.loading || state.uploadBlocked;

    if (!data.secretConfigured) {
      setSyncPresentation({
        state: "setup",
        badgeKind: "setup",
        badge: "Нужна настройка",
        icon: "!",
        headline: "Подключите GitHub",
        explanation: "Укажите токен в настройках ниже. Обычное обновление будет скачивать список на роутер.",
        directionLabel: "GitHub не подключён",
        buttonText: "Сначала подключите GitHub",
        blocked: true,
      });
      return;
    }

    if (data.remoteError) {
      setSyncPresentation({
        state: "error",
        badgeKind: "error",
        badge: "GitHub недоступен",
        icon: "!",
        headline: "Не удалось проверить GitHub",
        explanation: "Проверьте репозиторий, токен или интернет-соединение и попробуйте скачать ещё раз.",
        directionLabel: "GitHub → роутер",
        directionIcon: "←",
        buttonText: "Попробовать скачать ещё раз",
        blocked: false,
      });
      return;
    }

    if (data.localChanged) {
      setSyncPresentation({
        state: "action",
        badgeKind: "action",
        badge: "Локальная дата не точна",
        icon: "↓",
        headline: "Можно намеренно взять версию GitHub",
        explanation:
          "Скачивание проигнорирует локальную дату и заменит DNS-списки содержимым GitHub. Перед заменой будет подтверждение.",
        directionLabel: "Принудительно: GitHub → роутер",
        directionIcon: "←",
        buttonText: "Скачать GitHub, отбросив локальные изменения",
        blocked: false,
        attentionCard: "localVersionCard",
      });
      return;
    }

    if (!data.localVersionKnown && data.remoteVersion) {
      setSyncPresentation({
        state: "action",
        badgeKind: "action",
        badge: "GitHub — источник",
        icon: "↓",
        headline: "Загрузить сохранённую версию из GitHub",
        explanation: "На роутере ещё нет подтверждённой даты. Список GitHub можно применить независимо от неё.",
        directionLabel: "GitHub → роутер",
        directionIcon: "←",
        buttonText: "Скачать из GitHub на роутер",
        blocked: false,
        newerCard: "remoteVersionCard",
      });
      return;
    }

    const order = compareVersionDates(data.localVersion, data.remoteVersion);
    if (order > 0) {
      setSyncPresentation({
        state: "action",
        badgeKind: "action",
        badge: "Роутер новее по дате",
        icon: "↓",
        headline: "Автоотправка в GitHub отключена",
        explanation:
          "Обычная кнопка не перезапишет GitHub. Если локальная дата ошибочна, можно намеренно скачать GitHub на роутер.",
        directionLabel: "Безопасное действие: GitHub → роутер",
        directionIcon: "←",
        buttonText: "Всё равно скачать из GitHub",
        blocked: false,
        newerCard: "localVersionCard",
      });
      return;
    }

    if (order < 0) {
      setSyncPresentation({
        state: "action",
        badgeKind: "action",
        badge: "GitHub свежее",
        icon: "↓",
        headline: "В GitHub есть более новая версия",
        explanation: "Скачайте её — роутер построит DNS-группы автоматически, не меняя назначенные маршруты.",
        directionLabel: "GitHub → роутер",
        directionIcon: "←",
        buttonText: "Скачать обновление из GitHub",
        blocked: false,
        newerCard: "remoteVersionCard",
      });
      return;
    }

    setSyncPresentation({
      state: "equal",
      badgeKind: "ready",
      badge: "Даты совпадают",
      icon: "↓",
      headline: "Можно перечитать версию GitHub",
      explanation: "Если содержимое уже совпадает, ничего не изменится. Если различается — версия GitHub станет основной.",
      directionLabel: "GitHub → роутер",
      directionIcon: "←",
      buttonText: "Проверить и скачать из GitHub",
      blocked: false,
    });
  }

  async function loadSyncStatus(options) {
    const opts = options || {};
    if (!opts.silent) setBusy(true);
    try {
      const data = await fetchJson(SYNC_API_URL + "?action=status", { cache: "no-store" });
      if (state.syncStatus && state.syncStatus.secretConfigured && !data.secretConfigured) {
        throw new Error(
          "Роутер временно не вернул сохранённое подключение GitHub. Настройки и токен не изменялись."
        );
      }
      renderSyncStatus(data);
      return data;
    } catch (error) {
      setVersionNote("remoteVersionState", "error", "Не удалось прочитать версии: " + error.message);
      state.uploadBlocked = true;
      if ($("uploadDnsBtn")) $("uploadDnsBtn").disabled = true;
      setSyncPresentation({
        state: "error",
        badgeKind: "error",
        badge: "Ошибка проверки",
        icon: "!",
        headline: "Не удалось проверить списки",
        explanation: "Соединение с роутером или GitHub прервалось. Нажмите «Проверить ещё раз».",
        directionLabel: "GitHub → роутер",
        directionIcon: "←",
        buttonText: "Попробовать скачать ещё раз",
        blocked: false,
      });
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
      if ($("syncSettingsDetails")) $("syncSettingsDetails").open = false;
      showBanner("ok", data.message || "GitHub подключён и проверен.");
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function downloadDns() {
    const status = state.syncStatus || {};
    const localLooksNewer =
      status.localVersionKnown && status.remoteVersion && compareVersionDates(status.localVersion, status.remoteVersion) > 0;
    const localIsUntracked = Boolean(status.localChanged);
    if (
      (localLooksNewer || localIsUntracked) &&
      !window.confirm(
        localIsUntracked
          ? "На роутере есть изменения, которых нет в сохранённой локальной версии. Скачать файл GitHub и заменить им текущие DNS-списки? Перед изменением создаётся backup running-config. VPN-профили и DNS-маршруты не изменятся."
          : "По дате версия роутера новее GitHub. Всё равно скачать GitHub и сделать его содержимое основной версией DNS-списков? Перед изменением создаётся backup running-config. VPN-профили и DNS-маршруты не изменятся."
      )
    ) {
      return;
    }

    setBusy(true);
    setProgress(8, "Шаг 1 из 4: скачиваем DNS-файл GitHub");
    showBanner("warn", "Скачиваем версию GitHub. Локальная дата не выбирает направление...");
    try {
      setProgress(28, "Шаг 2 из 4: проверяем и применяем файл");
      const data = await fetchJson(SYNC_API_URL + "?action=download", { method: "POST" });
      setProgress(78, "Шаг 3 из 4: перечитываем DNS-группы");
      await loadFromRouter();
      renderCompletedSyncAction(status, data, "download");
      setProgress(100, "Шаг 4 из 4: версия GitHub применена");
      showBanner("ok", data.message || "Версия GitHub применена на роутере.");
      finishProgress();
    } catch (error) {
      clearProgress();
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadDns() {
    const status = state.syncStatus || {};
    if (status.localChanged || !status.localVersionKnown) {
      showBanner("error", "Сначала присвойте текущему списку дату, затем повторите отправку.");
      if ($("dnsPublishDetails")) $("dnsPublishDetails").open = true;
      return;
    }
    if (
      !window.confirm(
        "Отправить текущие DNS-списки роутера в GitHub? Файл в репозитории будет заменён и появится новый коммит. Используйте это только если точно уверены, что версия роутера правильная."
      )
    ) {
      return;
    }

    setBusy(true);
    setProgress(8, "Шаг 1 из 4: читаем список роутера");
    showBanner("warn", "Явно отправляем текущий список роутера в GitHub...");
    try {
      setProgress(30, "Шаг 2 из 4: проверяем файл GitHub");
      const data = await fetchJson(SYNC_API_URL + "?action=upload", { method: "POST" });
      setProgress(78, "Шаг 3 из 4: обновляем даты версий");
      renderCompletedSyncAction(status, data, "upload");
      setProgress(100, "Шаг 4 из 4: отправка завершена");
      showBanner("ok", data.message || "Текущий список роутера отправлен в GitHub.");
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
      body.innerHTML = '<tr><td colspan="3" class="table-empty">На роутере пока нет DNS-списков.</td></tr>';
      renderGroupEditor(groups);
      return;
    }
    body.innerHTML = groups
      .map((group, index) => {
        const selectedClass = group.groupId === state.selectedGroupId ? " is-selected" : "";
        const includePreview = group.includes.slice(0, 3).join(", ");
        const includeExtra = group.includes.length > 3 ? " +" + (group.includes.length - 3) : "";
        return `
          <tr class="dns-transfer-row${selectedClass}" data-group-id="${escapeHtml(group.groupId)}">
            <td class="mono">${index + 1}</td>
            <td>${escapeHtml(group.description || group.groupId)}</td>
            <td>
              <div class="client-device-name">${escapeHtml(hostCountText(group.includes.length))}</div>
              <div class="client-device-meta">${escapeHtml(includePreview || "пусто")}${escapeHtml(includeExtra)}</div>
            </td>
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
      container.innerHTML = `
        <div class="dns-group-editor-empty">
          <span aria-hidden="true">←</span>
          <strong>Выберите список</strong>
          <small>Здесь появятся его название и адреса сайтов.</small>
        </div>
      `;
      return;
    }

    const disabled = state.loading ? " disabled" : "";
    container.innerHTML = `
      <div class="dns-group-editor-head">
        <div>
          <h3>${escapeHtml(group.description || group.groupId)}</h3>
          <div class="client-device-meta">Редактирование выбранного списка</div>
        </div>
        <span class="dns-group-id-pill">${escapeHtml(group.groupId)}</span>
      </div>
      <div class="field-stack dns-group-name-field">
        <label for="groupNameInput">Понятное название</label>
        <input id="groupNameInput" type="text" value="${escapeHtml(group.description || "")}"${disabled}>
      </div>
      <div class="field-stack">
        <label for="groupHostsText">Домены или IP — по одному в строке</label>
        <textarea id="groupHostsText" class="dns-hosts-text" spellcheck="false"${disabled}>${escapeHtml(
          group.includes.join("\n")
        )}</textarea>
      </div>
      <div class="dns-group-editor-actions">
        <button id="saveGroupTextBtn" class="secondary" type="button"${disabled}>Оставить черновиком</button>
        <button id="saveGroupApplyBtn" class="warning" type="button"${disabled}>Сохранить на роутер</button>
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
    if ($("syncDnsBtn")) $("syncDnsBtn").addEventListener("click", downloadDns);
    if ($("uploadDnsBtn")) $("uploadDnsBtn").addEventListener("click", uploadDns);
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
