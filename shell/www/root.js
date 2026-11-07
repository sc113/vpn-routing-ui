(function () {
  const READ_TIMEOUT_MS = 15000;
  const banner = document.getElementById("banner");
  const overviewStatusLine = document.getElementById("overviewStatusLine");
  const statusRows = document.getElementById("statusRows");
  const reloadBtn = document.getElementById("reloadBtn");
  const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
  const engineUpdateStatusEl = document.getElementById("engineUpdateInfo");
  const checkUiUpdateBtn = document.getElementById("checkUiUpdateBtn");
  const updateUiBtn = document.getElementById("updateUiBtn");
  const uiUpdateInfo = document.getElementById("uiUpdateInfo");
  const state = {
    status: null,
    profiles: null,
    runtime: [],
    runtimeLoading: false,
    runtimeError: "",
    statusSnapshotLoaded: false,
    systemHealth: null,
    systemHealthLoading: false,
    systemHealthError: "",
    packageUpdates: null,
    packageUpdatesLoading: false,
    packageUpdatesError: "",
    uiUpdate: null,
    uiUpdateLoading: false,
    uiUpdateError: "",
    actionBusy: null,
    reloadLoading: false,
  };

  function showBanner(kind, text) {
    if (!banner) {
      return;
    }
    banner.className = "banner show " + kind;
    banner.textContent = text;
  }

  function clearBanner() {
    if (!banner) {
      return;
    }
    banner.className = "banner";
    banner.textContent = "";
  }

  function setRefreshButtonLoading(button, loading) {
    if (!button) return;
    const text = button.querySelector("[data-refresh-text]");
    button.classList.toggle("is-loading", Boolean(loading));
    button.setAttribute("aria-busy", loading ? "true" : "false");
    if (text) {
      text.textContent = loading
        ? button.getAttribute("data-loading-label") || "Обновляем..."
        : "Обновить";
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeSystemHealth(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    const cpu = source.cpu && typeof source.cpu === "object" ? source.cpu : {};
    const load = source.load && typeof source.load === "object" ? source.load : {};
    const memory = source.memory && typeof source.memory === "object" ? source.memory : {};
    const processes =
      source.processes && typeof source.processes === "object" ? source.processes : {};
    return {
      sampledAt: String(source.sampledAt || "").trim(),
      cpu: {
        user: toNumber(cpu.user),
        system: toNumber(cpu.system),
        idle: toNumber(cpu.idle),
        softirq: toNumber(cpu.softirq),
        busy: cpu.busy == null ? 100 - toNumber(cpu.idle) : toNumber(cpu.busy),
        source: String(cpu.source || "").trim(),
      },
      load: {
        one: toNumber(load.one),
        five: toNumber(load.five),
        fifteen: toNumber(load.fifteen),
        onePercent: load.onePercent == null ? toNumber(load.one) * 100 : toNumber(load.onePercent),
        running: String(load.running || "").trim(),
      },
      memory: {
        totalKb: toNumber(memory.totalKb),
        availableKb: toNumber(memory.availableKb),
        usedKb: toNumber(memory.usedKb),
        usedPercent: toNumber(memory.usedPercent),
      },
      processes: {
        ndmCpu: toNumber(processes.ndmCpu),
        singboxCpu: toNumber(processes.singboxCpu),
        xrayCpu: toNumber(processes.xrayCpu),
        proxyCpu: toNumber(processes.proxyCpu),
        measured: processes.measured !== false,
      },
    };
  }

  function formatPercent(value, digits) {
    const number = toNumber(value);
    return number.toFixed(typeof digits === "number" ? digits : 0) + "%";
  }

  function healthChipClass(kind, value) {
    const number = toNumber(value);
    if (kind === "idle") {
      if (number <= 10) return "chip-bad";
      if (number <= 25) return "chip-warn";
      return "chip-ok";
    }
    if (kind === "load") {
      if (number >= 2.5) return "chip-bad";
      if (number >= 1.5) return "chip-warn";
      return "chip-ok";
    }
    if (kind === "mem") {
      if (number >= 88) return "chip-bad";
      if (number >= 75) return "chip-warn";
      return "chip-ok";
    }
    if (kind === "process") {
      if (number >= 60) return "chip-bad";
      if (number >= 30) return "chip-warn";
      return "chip-ok";
    }
    return "chip-muted";
  }

  function healthMetricTitle(kind, health) {
    if (!health) {
      return "";
    }
    if (kind === "idle") {
      return (
        "Свободный CPU роутера. Чем больше, тем лучше. " +
        "Нормально: выше 25%. Тревожно: ниже 10%, роутер почти занят."
      );
    }
    if (kind === "load") {
      return (
        "Средняя нагрузка за 1 минуту. Для этого роутера ориентир: до 1.5 нормально, " +
        "1.5-2.5 уже тяжело, выше 2.5 может быть перегруз."
      );
    }
    if (kind === "ndm") {
      return (
        "CPU процесса ndm, то есть control-plane KeeneticOS: DNS, правила, интерфейсы, ProxyN. " +
        "Если ndm высокий, роутер занят управлением/маршрутизацией, а не самим VPN-ядром."
      );
    }
    if (kind === "singbox") {
      return (
        "CPU процесса sing-box. Если высокий именно он, нагрузку создают VPN-профили/шифрование. " +
        "Если sing-box низкий, а роутер тормозит, причина чаще в Keenetic/ProxyN/conntrack."
      );
    }
    if (kind === "mem") {
      return (
        "Занятая оперативная память. Для Linux часть памяти уходит в кэш, это нормально. " +
        "Тревожно, если стабильно выше 85-90% и роутер начинает свопить или подвисать."
      );
    }
    return "";
  }

  function renderSystemHealthChips() {
    if (state.systemHealthLoading && !state.systemHealth) {
      return `
        <div class="engine-inline-chip chip-muted">
          <span class="label">Система</span>
          <span class="value">считываем...</span>
        </div>
      `;
    }
    if (state.systemHealthError && !state.systemHealth) {
      return `
        <div class="engine-inline-chip chip-bad" title="${escapeHtml(state.systemHealthError)}">
          <span class="label">Система</span>
          <span class="value">ошибка health</span>
        </div>
      `;
    }
    if (!state.systemHealth) {
      return `
        <div class="engine-inline-chip chip-muted">
          <span class="label">Система</span>
          <span class="value">снимок не считан</span>
        </div>
      `;
    }
    const health = state.systemHealth;
    const cpuBusy = Math.max(0, Math.min(100, toNumber(health.cpu.busy)));
    const processChips = health.processes.measured
      ? `
      <div class="engine-inline-chip ${healthChipClass("process", health.processes.ndmCpu)}" title="${escapeHtml(healthMetricTitle("ndm", health))}">
        <span class="label">KeeneticOS</span>
        <span class="value">${escapeHtml(formatPercent(health.processes.ndmCpu, 1))}</span>
      </div>
      <div class="engine-inline-chip ${healthChipClass("process", health.processes.singboxCpu)}" title="${escapeHtml(healthMetricTitle("singbox", health))}">
        <span class="label">VPN-ядро</span>
        <span class="value">${escapeHtml(formatPercent(health.processes.singboxCpu, 1))}</span>
      </div>`
      : "";
    return `
      <div class="engine-inline-chip ${healthChipClass("process", cpuBusy)}" title="${escapeHtml("Занятый CPU роутера. Чем меньше, тем спокойнее.")}">
        <span class="label">CPU занято</span>
        <span class="value">${escapeHtml(formatPercent(cpuBusy))}</span>
      </div>
      <div class="engine-inline-chip ${healthChipClass("process", health.load.onePercent)}" title="${escapeHtml("Load average за 1 минуту в процентах от числа CPU-ядер.")}">
        <span class="label">Load 1м</span>
        <span class="value">${escapeHtml(formatPercent(health.load.onePercent, 1))}</span>
      </div>
      ${processChips}
      <div class="engine-inline-chip ${healthChipClass("mem", health.memory.usedPercent)}" title="${escapeHtml(healthMetricTitle("mem", health))}">
        <span class="label">Память</span>
        <span class="value">${escapeHtml(formatPercent(health.memory.usedPercent, 1))}</span>
      </div>
    `;
  }

  function compactVersion(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    const match = text.match(/\b\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/);
    return match ? match[0] : text.split(/\r?\n/)[0];
  }

  function timestampToDate(value) {
    const epoch = toNumber(value);
    if (!epoch) {
      return null;
    }
    const date = new Date(epoch * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatShortDate(date) {
    if (!date) {
      return "не датировано";
    }
    return date.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
  }

  function formatUpdateAge(date) {
    if (!date) {
      return "дата обновления пока неизвестна";
    }
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const days = Math.max(0, Math.floor((today - start) / 86400000));
    if (days === 0) {
      return "сегодня";
    }
    if (days === 1) {
      return "вчера";
    }
    return days + " дн. назад";
  }

  function renderUpdatedChip(timestamp) {
    const date = timestampToDate(timestamp);
    if (!date) return "";
    const title = "Обновлено: " + date.toLocaleString("ru-RU") + " (" + formatUpdateAge(date) + ").";
    return `
      <div class="engine-inline-chip" title="${escapeHtml(title)}">
        <span class="label">Обновлено</span>
        <span class="value mono">${escapeHtml(formatShortDate(date))}</span>
      </div>
    `;
  }

  function compactPath(value) {
    const text = String(value || "").trim();
    if (!text) {
      return "Неизвестно";
    }
    const normalized = text.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : normalized;
  }

  function utf8ToBase64(value) {
    return btoa(unescape(encodeURIComponent(String(value || ""))));
  }

  function buildRouterSyncPayload(profiles) {
    return (Array.isArray(profiles) ? profiles : [])
      .map((profile) =>
        [
          "P",
          String((profile && profile.id) || ""),
          utf8ToBase64((profile && profile.name) || ""),
          profile && profile.enabled === false ? "0" : "1",
          String((profile && profile.localPort) || 0),
          String((profile && profile.routerProxyId) || ""),
        ].join("|")
      )
      .join("\n");
  }

  function githubReleaseUrl(engine) {
    return engine === "singbox"
      ? "https://github.com/SagerNet/sing-box/releases"
      : "https://github.com/XTLS/Xray-core/releases";
  }

  function actionBusyMatches(kind, engine, action) {
    return Boolean(
      state.actionBusy &&
        state.actionBusy.kind === kind &&
        state.actionBusy.engine === engine &&
        state.actionBusy.action === action
    );
  }

  function setControlsDisabled(disabled) {
    if (reloadBtn) {
      reloadBtn.disabled = disabled || state.reloadLoading;
      setRefreshButtonLoading(reloadBtn, state.reloadLoading);
    }
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = disabled || state.packageUpdatesLoading;
    }
    renderUiUpdateControls();
  }

  function shortRevision(value) {
    const revision = String(value || "").trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision.slice(0, 7) : "";
  }

  function formatUiVersionDate(timestamp) {
    const date = timestampToDate(timestamp);
    if (!date) {
      return "";
    }
    const day = date.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const time = date.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return day + " " + time;
  }

  function installedUiVersionLabel(update) {
    if (!update) {
      return "";
    }
    const revision = shortRevision(update.installedRevision);
    const updatedAt = formatUiVersionDate(update.installedAt);
    return [revision, updatedAt].filter(Boolean).join(" · ");
  }

  function uiUpdateStatusText(update) {
    if (!update) {
      return "Статус UI получен.";
    }
    const installed = installedUiVersionLabel(update);
    const latest = shortRevision(update.latestRevision);
    if (update.updateAvailable) {
      if (installed && latest) {
        return "Установлено: " + installed + ". Доступно: " + latest + ".";
      }
      if (latest) {
        return "Доступно обновление UI: " + latest + ".";
      }
    } else if (installed) {
      return "UI актуален: " + installed + ".";
    }
    return String(update.message || "Статус UI получен.");
  }

  function renderUiUpdateControls() {
    const busy = Boolean(state.actionBusy);
    const update = state.uiUpdate;
    const updateAvailable = Boolean(update && update.updateAvailable);

    if (uiUpdateInfo) {
      const installedDate = formatUiVersionDate(state.status && state.status.uiUpdatedAt);
      let text = installedDate
        ? "Установлено " + installedDate + " · обновления ещё не проверены"
        : "Обновления ещё не проверены";
      let kind = "";
      if (state.uiUpdateLoading) {
        text = "Проверяем UI...";
      } else if (state.uiUpdateError) {
        text = "Не удалось проверить UI.";
        kind = "error";
      } else if (update) {
        text = uiUpdateStatusText(update);
        kind = updateAvailable ? "available" : "ok";
      }
      uiUpdateInfo.className = "update-line-status" + (kind ? " " + kind : "");
      uiUpdateInfo.textContent = text;
    }

    if (checkUiUpdateBtn) {
      checkUiUpdateBtn.disabled = busy || state.uiUpdateLoading;
      checkUiUpdateBtn.textContent = state.uiUpdateLoading ? "Проверяем..." : "Проверить версию";
    }
    if (updateUiBtn) {
      updateUiBtn.disabled = busy || state.uiUpdateLoading || Boolean(update && !updateAvailable);
      updateUiBtn.title = !update
        ? "Проверить GitHub и предложить установить доступную версию интерфейса"
        : updateAvailable
          ? "Установить версию из GitHub. Веб-интерфейс кратко перезапустится."
          : "Установлена актуальная версия интерфейса.";
      if (!busy) updateUiBtn.textContent = "Обновить UI";
    }
  }

  function actionLabel(kind, action, busy) {
    if (kind === "package") {
      if (action === "install") {
        return busy ? "Устанавливаем..." : "Установить";
      }
      if (action === "remove") {
        return busy ? "Удаляем..." : "Удалить";
      }
      if (action === "update") {
        return busy ? "Обновляем..." : "Обновить";
      }
    }
    if (action === "start") {
      return busy ? "Запускаем..." : "Старт";
    }
    if (action === "stop") {
      return busy ? "Останавливаем..." : "Стоп";
    }
    if (action === "restart") {
      return busy ? "Перезапускаем..." : "Рестарт";
    }
    if (kind === "router" && action === "dns-refresh") {
      return busy ? "DNS reset..." : "DNS reset";
    }
    if (kind === "router" && action === "vpn-refresh") {
      return busy ? "VPN reset..." : "VPN reset";
    }
    if (kind === "router" && action === "status-refresh") {
      return busy ? "Считываем..." : "Считать статус";
    }
    return action;
  }

  function renderVersionValue(engine, versionText) {
    const version = compactVersion(versionText);
    if (!version) {
      return "—";
    }
    return `<a class="chip-link mono" href="${githubReleaseUrl(engine)}" target="_blank" rel="noreferrer noopener" title="Открыть релизы ${engine === "singbox" ? "sing-box" : "Xray"} на GitHub">${escapeHtml(version)} &#8599;</a>`;
  }

  function fetchJson(url, options) {
    const requestOptions = Object.assign({}, options || {});
    const timeoutMs = Math.max(0, Number(requestOptions.timeoutMs) || 0);
    delete requestOptions.timeoutMs;
    const controller = timeoutMs ? new AbortController() : null;
    const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : 0;
    if (controller) {
      requestOptions.signal = controller.signal;
    }
    return fetch(url, requestOptions)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok === false) {
          throw new Error(data.error || data.message || "HTTP " + response.status);
        }
        return data;
      })
      .catch((error) => {
        if (error && error.name === "AbortError") {
          throw new Error("Роутер не ответил за 15 секунд. Повтори попытку.");
        }
        throw error;
      })
      .finally(() => {
        if (timeoutId) window.clearTimeout(timeoutId);
      });
  }

  function loadRuntimeStatus() {
    return fetchJson("/cgi-bin/router-runtime-status.cgi", { cache: "no-store" });
  }

  function loadSystemHealth() {
    return fetchJson("/cgi-bin/router-system-health.cgi", { cache: "no-store" });
  }

  function engineUpdateInfo(engine) {
    const key = engine === "singbox" ? "singbox" : "xray";
    return state.packageUpdates && state.packageUpdates[key] ? state.packageUpdates[key] : null;
  }

  function renderPackageUpdateSummary() {
    if (!engineUpdateStatusEl) {
      return;
    }

    let text = "Проверка пакетов Entware ещё не запускалась.";
    let kind = "";
    if (state.packageUpdatesLoading) {
      text = "Проверяем пакеты Entware...";
    } else if (state.packageUpdatesError) {
      text = "Не удалось проверить пакеты Entware.";
      kind = "error";
    } else if (state.packageUpdates) {
      const { xray, singbox, refreshOk } = state.packageUpdates;
      const available = [
        ["Xray", xray],
        ["sing-box", singbox],
      ]
        .filter((entry) => {
          const info = entry[1];
          return info && info.safeOpkgUpdate;
        })
        .map((entry) => entry[0]);
      if (available.length) {
        text = "Через Entware можно обновить " + available.join(", ") + ".";
        kind = "available";
      } else {
        text = "Через Entware нет доступных пакетов для обновления.";
        kind = "ok";
      }
      if (refreshOk === false) {
        text = "По имеющимся спискам Entware " +
          (available.length ? "можно обновить " + available.join(", ") + "." : "подходящих обновлений нет.");
        kind = "warn";
      }
    }

    engineUpdateStatusEl.className = "update-line-status" + (kind ? " " + kind : "");
    engineUpdateStatusEl.textContent = text;
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = Boolean(state.actionBusy) || state.packageUpdatesLoading;
      checkUpdatesBtn.textContent = state.packageUpdatesLoading ? "Проверяем..." : "Проверить обновления";
    }
  }

  function renderUpdateChip(engine, updateState) {
    const info = engineUpdateInfo(engine);
    if (!info) return "";
    const version = String(info.opkgVersion || "").trim();
    const available = !updateState.disabled;
    const tone = !version || info.compatBlocked ? "chip-muted" : available ? "chip-ok" : "chip-warn";
    const suffix = available
      ? "доступен"
      : info.opkgPrerelease
        ? "предрелиз"
        : "недоступен";
    return `
      <div class="engine-inline-chip ${tone}" title="${escapeHtml(updateState.title)}">
        <span class="label">${version ? "Кандидат Entware" : "Entware"}</span>
        <span class="value">${version ? escapeHtml(version + " · " + suffix) : "обновление не найдено"}</span>
      </div>
    `;
  }

  function renderUpstreamChip(engine) {
    const info = engineUpdateInfo(engine);
    const url = (info && info.releasesUrl) || githubReleaseUrl(engine);
    const version = info ? compactVersion(info.upstreamVersion) : "";
    if (!version) return "";
    return `
      <div class="engine-inline-chip" title="Последний релиз проекта на GitHub. Кнопка «Обновить» устанавливает пакет из Entware.">
        <span class="label">Релиз GitHub</span>
        <span class="value">
          <a class="chip-link mono" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(version)} &#8599;</a>
        </span>
      </div>
    `;
  }

  function updateButtonState(engine, installed) {
    const info = engineUpdateInfo(engine);
    if (!installed) {
      return {
        disabled: " disabled",
        title: "Сначала установи пакет.",
      };
    }
    if (state.packageUpdatesLoading && !info) {
      return {
        disabled: " disabled",
        title: "Сначала дождись проверки обновлений.",
      };
    }
    if (!info) {
      return {
        disabled: " disabled",
        title: "Сначала нажмите «Проверить обновления».",
      };
    }
    if (info.opkgHasUpdate && info.opkgPrerelease) {
      return {
        disabled: " disabled",
        title: "Entware предлагает предрелиз. Установка этой версии отключена.",
      };
    }
    if (info.compatBlocked) {
      return {
        disabled: " disabled",
        title: "Обновление этого пакета через Entware отключено для данной архитектуры.",
      };
    }
    if (!info.safeOpkgUpdate) {
      return {
        disabled: " disabled",
        title: "По имеющимся спискам Entware подходящего пакета для обновления нет.",
      };
    }
    return {
      disabled: "",
      title: "Установить предложенную Entware версию пакета.",
    };
  }

  async function runEngineAction(engine, action) {
    const endpoint = engine === "singbox" ? "/cgi-bin/singbox-service.cgi" : "/cgi-bin/xray-service.cgi";
    const engineTitle = engine === "singbox" ? "sing-box" : "Xray";
    state.actionBusy = { kind: "service", engine, action };
    setControlsDisabled(true);
    renderAll();
    showBanner("warn", `Выполняем команду ${actionLabel("service", action, false).toLowerCase()} для ${engineTitle}...`);
    try {
      const data = await fetchJson(`${endpoint}?action=${encodeURIComponent(action)}`, {
        method: "POST",
        cache: "no-store",
      });
      await init(data.message || "Команда для сервиса выполнена.");
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  async function runPackageAction(engine, action) {
    const engineTitle = engine === "singbox" ? "sing-box" : "Xray";
    const actionTitleMap = {
      install: "установить",
      remove: "удалить",
      update: "обновить через opkg",
    };
    const actionTitle = actionTitleMap[action] || action;
    const warnText =
      action === "update"
        ? `\n\nПеред обновлением менеджер сделает бэкап init-скрипта и config-файла.`
        : "";
    if (!window.confirm(`Точно ${actionTitle} ${engineTitle}?${warnText}`)) {
      return;
    }

    state.actionBusy = { kind: "package", engine, action };
    setControlsDisabled(true);
    renderAll();
    showBanner(
      "warn",
      action === "update"
        ? `Идёт безопасное обновление ${engineTitle} через opkg. Это может занять до минуты...`
        : `Выполняем команду ${actionTitle} для ${engineTitle}...`
    );
    try {
      const data = await fetchJson(
        `/cgi-bin/package-manage.cgi?engine=${encodeURIComponent(engine)}&action=${encodeURIComponent(action)}`,
        {
          method: "POST",
          cache: "no-store",
        }
      );
      await init(data.message || "Команда для пакета выполнена.");
      await loadPackageUpdates(false, { quiet: true });
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function loadUiUpdateAvailability(options) {
    const opts = options || {};
    if (state.uiUpdateLoading || state.actionBusy) {
      return state.uiUpdate;
    }

    state.uiUpdateLoading = true;
    state.uiUpdateError = "";
    renderUiUpdateControls();
    try {
      const data = await fetchJson("/cgi-bin/ui-update.cgi?action=check", { cache: "no-store" });
      state.uiUpdate = data;
      if (!opts.quiet) {
        showBanner(data.updateAvailable ? "warn" : "ok", uiUpdateStatusText(data));
      }
      return data;
    } catch (error) {
      state.uiUpdate = null;
      state.uiUpdateError = error.message;
      if (!opts.quiet) {
        showBanner("error", "Не удалось проверить версию UI: " + error.message);
      }
      return null;
    } finally {
      state.uiUpdateLoading = false;
      renderUiUpdateControls();
    }
  }

  async function waitForUiUpdate() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await wait(1500);
      let data;
      try {
        data = await fetchJson("/cgi-bin/ui-update.cgi?action=status", { cache: "no-store" });
      } catch (error) {
        continue;
      }
      if (data.status === "success") {
        return data;
      }
      if (data.status === "failed") {
        throw new Error(data.message || "Обновление UI завершилось с ошибкой.");
      }
    }
    throw new Error("UI не вернулся после обновления за две минуты.");
  }

  async function runUiUpdate() {
    if (state.actionBusy) {
      return;
    }
    let update = state.uiUpdate;
    if (!update || !update.updateAvailable) {
      update = await loadUiUpdateAvailability({ quiet: false });
    }
    if (!update || !update.updateAvailable) {
      return;
    }

    const revision = shortRevision(update.latestRevision);
    const target = revision ? " " + revision : "";
    if (!window.confirm("Установить UI" + target + " из GitHub? Профили, DNS-группы и маршруты сохранятся.")) {
      return;
    }

    state.actionBusy = { kind: "ui", engine: "ui", action: "update" };
    setControlsDisabled(true);
    renderAll();
    if (updateUiBtn) {
      updateUiBtn.textContent = "Запускаем...";
    }
    showBanner("warn", "Ставим проверенную версию UI из GitHub. Интерфейс на несколько секунд перезапустится...");

    try {
      await fetchJson("/cgi-bin/ui-update.cgi?action=start", {
        method: "POST",
        cache: "no-store",
      });
      if (updateUiBtn) {
        updateUiBtn.textContent = "Обновляем UI...";
      }
      await waitForUiUpdate();
      window.location.reload();
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  async function runDnsRefresh() {
    if (state.actionBusy) {
      return;
    }
    state.actionBusy = { kind: "router", engine: "dns", action: "dns-refresh" };
    setControlsDisabled(true);
    renderAll();
    showBanner("warn", "Пересобираем live DNS-маршруты и перезапускаем dns-proxy intercept...");
    try {
      const data = await fetchJson("/cgi-bin/dns-route-refresh.cgi", {
        method: "POST",
        cache: "no-store",
      });
      await init(
        (data.message || "DNS-маршруты пересобраны.") +
          (data.backupPath ? " Бэкап: " + data.backupPath : "")
      );
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  async function runVpnRefresh() {
    if (state.actionBusy) {
      return;
    }

    const activeProfiles = Array.isArray(state.profiles) ? state.profiles : [];
    const hasEnabledXray = activeProfiles.some(
      (profile) => profile && profile.enabled && Number(profile.localPort || 0) > 0 && profile.engine === "xray"
    );
    const hasEnabledSingbox = activeProfiles.some(
      (profile) => profile && profile.enabled && Number(profile.localPort || 0) > 0 && profile.engine === "sing-box"
    );

    state.actionBusy = { kind: "router", engine: "vpn", action: "vpn-refresh" };
    setControlsDisabled(true);
    renderAll();
    showBanner(
      "warn",
      "Перезапускаем только реально используемые движки и мягко обновляем VPN-слой..."
    );

    try {
      const params = new URLSearchParams();
      if (hasEnabledXray) {
        params.set("xray", "1");
      }
      if (hasEnabledSingbox) {
        params.set("singbox", "1");
      }
      const data = await fetchJson(`/cgi-bin/vpn-route-refresh.cgi?${params.toString()}`, {
        method: "POST",
        cache: "no-store",
      });
      await init(
        (data.message || "VPN-слой перезапущен.") +
          (data.runtime ? " " + data.runtime : "") +
          (data.backupPath ? " Бэкап: " + data.backupPath : "")
      );
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  async function runStatusRefresh() {
    if (state.actionBusy || state.systemHealthLoading || state.runtimeLoading) {
      return;
    }
    state.actionBusy = { kind: "router", engine: "status", action: "status-refresh" };
    state.systemHealthLoading = true;
    state.runtimeLoading = true;
    state.systemHealthError = "";
    state.runtimeError = "";
    setControlsDisabled(true);
    renderAll();
    showBanner("warn", "Считываем живой статус роутера только по явному запросу...");
    try {
      const healthData = await loadSystemHealth();
      state.systemHealth = normalizeSystemHealth(healthData);
      state.systemHealthLoading = false;
      renderAll();

      const runtimeData = await loadRuntimeStatus();
      state.runtime = Array.isArray(runtimeData.proxies) ? runtimeData.proxies : [];
      state.runtimeLoading = false;
      state.statusSnapshotLoaded = true;
      renderAll();
      showBanner("ok", "Живой статус роутера перечитан.");
    } catch (error) {
      state.systemHealthLoading = false;
      state.runtimeLoading = false;
      if (!state.systemHealth) {
        state.systemHealthError = error.message;
      }
      if (!state.runtime.length) {
        state.runtimeError = error.message;
      }
      renderAll();
      showBanner("error", "Не удалось считать живой статус: " + error.message);
    } finally {
      state.actionBusy = null;
      setControlsDisabled(false);
      renderAll();
    }
  }

  function engineStatusLabel(installed, running) {
    return running ? "Запущен" : installed ? "Остановлен" : "Не установлен";
  }

  function renderOverviewStatus() {
    const status = state.status;
    if (!overviewStatusLine || !status) return;

    const profiles = state.profiles;
    const active = profiles ? profiles.filter((profile) => profile && profile.enabled !== false).length : 0;
    const profileStatus = profiles
      ? `Ключи <strong>${active} из ${profiles.length}</strong> включены`
      : "Статус ключей недоступен";
    const engines = [
      ["Xray", status.xrayInstalled, status.xrayRunning],
      ["sing-box", status.singboxInstalled, status.singboxRunning],
    ];
    overviewStatusLine.innerHTML = `
      <span title="Включённые профили среди сохранённых на роутере">
        ${profileStatus}
      </span>
      ${engines.map(([name, installed, running]) => `
        <span class="overview-engine-state${running ? " is-running" : ""}">
          <strong>${name}</strong> ${engineStatusLabel(installed, running).toLowerCase()}
        </span>
      `).join("")}
    `;
    overviewStatusLine.hidden = false;
  }

  function renderEngineRow(options) {
    const busy = Boolean(state.actionBusy);
    const engine = options.engine;
    const updateState = updateButtonState(engine, options.installed);
    const serviceDisabled = busy || !options.serviceEnabled ? " disabled" : "";
    const statusText = engineStatusLabel(options.installed, options.running);
    const packageButtons = options.installed
      ? `
          <button type="button" class="info" data-package-engine="${engine}" data-package-action="update"${busy ? " disabled" : updateState.disabled} title="${escapeHtml(updateState.title)}">${actionLabel("package", "update", actionBusyMatches("package", engine, "update"))}</button>
          <button type="button" class="danger" data-package-engine="${engine}" data-package-action="remove" title="Остановить сервис и удалить пакет после подтверждения"${busy ? " disabled" : ""}>${actionLabel("package", "remove", actionBusyMatches("package", engine, "remove"))}</button>
        `
      : `<button type="button" class="secondary" data-package-engine="${engine}" data-package-action="install" title="Установить пакет движка из Entware"${busy ? " disabled" : ""}>${actionLabel("package", "install", actionBusyMatches("package", engine, "install"))}</button>`;

    return `
      <section class="engine-row manage-engine-row summary-row-${engine}">
        <div class="engine-row-main">
          <div class="overview-engine-heading">
            <svg class="summary-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
              <path d="${options.icon}"/>
            </svg>
            <h3 class="engine-row-title">${options.title}</h3>
            <span class="status-pill ${options.running ? "status-ok" : "status-neutral"} tiny-status">${statusText}</span>
          </div>
          <div class="overview-engine-meta">
            <div class="engine-inline-chip">
              <span class="label">Установлено</span>
              <span class="value">${renderVersionValue(engine, options.version)}</span>
            </div>
            <div class="engine-inline-chip" title="${escapeHtml(options.configPath)}">
              <span class="label">Конфиг</span>
              <span class="value mono">${escapeHtml(compactPath(options.configPath))}</span>
            </div>
            ${renderUpdatedChip(options.updatedAt)}
            ${renderUpdateChip(engine, updateState)}
            ${renderUpstreamChip(engine)}
          </div>
        </div>
        <div class="overview-engine-actions">
          <div class="overview-action-group">
            <span class="overview-action-label">Пакет</span>
            <div class="overview-action-buttons">${packageButtons}</div>
          </div>
          <div class="overview-action-group">
            <span class="overview-action-label">Сервис</span>
            <div class="overview-action-buttons">
              <button type="button" class="secondary" data-engine="${engine}" data-engine-action="start" title="Запустить движок с конфигурацией на роутере"${serviceDisabled}>${actionLabel("service", "start", actionBusyMatches("service", engine, "start"))}</button>
              <button type="button" class="danger" data-engine="${engine}" data-engine-action="stop" title="Остановить движок и прервать подключения через него"${serviceDisabled}>${actionLabel("service", "stop", actionBusyMatches("service", engine, "stop"))}</button>
              <button type="button" class="warning" data-engine="${engine}" data-engine-action="restart" title="Перезапустить движок с сохранённой конфигурацией. Соединения через него кратко прервутся."${serviceDisabled}>${actionLabel("service", "restart", actionBusyMatches("service", engine, "restart"))}</button>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderEngineRows() {
    renderPackageUpdateSummary();
    const status = state.status;
    if (!statusRows || !status) {
      return;
    }

    statusRows.innerHTML = [
      renderEngineRow({
        engine: "xray",
        title: "Xray",
        installed: Boolean(status.xrayInstalled),
        running: Boolean(status.xrayRunning),
        serviceEnabled: Boolean(status.xrayInstalled),
        version: status.xrayVersion,
        updatedAt: status.xrayUpdatedAt,
        configPath: status.xrayConfigPath || "/opt/etc/xray/config.json",
        icon: "M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01",
      }),
      renderEngineRow({
        engine: "singbox",
        title: "sing-box",
        installed: Boolean(status.singboxInstalled),
        running: Boolean(status.singboxRunning),
        serviceEnabled: Boolean(status.singboxInstalled && status.singboxService),
        version: status.singboxVersion,
        updatedAt: status.singboxUpdatedAt,
        configPath: status.singboxConfigPath || "/opt/etc/sing-box/config.json",
        icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9",
      }),
    ].join("");
  }

  function renderAll() {
    renderOverviewStatus();
    renderUiUpdateControls();
    renderEngineRows();
  }

  async function loadPackageUpdates(refresh, options) {
    const opts = options || {};
    state.packageUpdatesLoading = true;
    state.packageUpdatesError = "";
    renderEngineRows();
    if (!opts.quiet) {
      showBanner("warn", refresh ? "Проверяем версии Xray и sing-box..." : "Загружаем версии Xray и sing-box...");
    }
    try {
      const data = await fetchJson(`/cgi-bin/package-updates.cgi?refresh=${refresh ? "1" : "0"}`, {
        cache: "no-store",
      });
      state.packageUpdates = data;
      state.packageUpdatesLoading = false;
      state.packageUpdatesError = "";
      renderEngineRows();
      if (!opts.quiet) {
        if (refresh && data.refreshOk === false) {
          showBanner("warn", "Не удалось обновить все списки Entware. Показаны версии по имеющимся данным.");
        } else {
          showBanner("ok", refresh ? "Версии Xray и sing-box проверены." : "Версии Xray и sing-box загружены.");
        }
      }
    } catch (error) {
      state.packageUpdatesLoading = false;
      state.packageUpdatesError = error.message;
      renderEngineRows();
      if (!opts.quiet) {
        showBanner("error", "Не удалось проверить обновления: " + error.message);
      }
    }
  }

  async function init(message) {
    if (!message) {
      showBanner("warn", "Загружаем данные с роутера...");
    }
    try {
      state.statusSnapshotLoaded = false;
      state.runtime = [];
      state.runtimeLoading = false;
      state.runtimeError = "";
      state.systemHealth = null;
      state.systemHealthLoading = false;
      state.systemHealthError = "";
      const [statusResult, profilesResult] = await Promise.allSettled([
        fetchJson("/cgi-bin/status.cgi", { cache: "no-store", timeoutMs: READ_TIMEOUT_MS }),
        fetchJson("/cgi-bin/xray-profiles.cgi", { cache: "no-store", timeoutMs: READ_TIMEOUT_MS }),
      ]);

      if (statusResult.status !== "fulfilled") {
        throw statusResult.reason;
      }

      state.status = statusResult.value;
      const profiles = profilesResult.status === "fulfilled" ? profilesResult.value?.profiles : null;
      state.profiles = Array.isArray(profiles) ? profiles : null;

      renderAll();

      if (message) {
        showBanner("ok", message);
      } else {
        clearBanner();
      }

    } catch (error) {
      state.systemHealthLoading = false;
      showBanner("error", "Не удалось загрузить состояние роутера: " + error.message);
    }
  }

  document.addEventListener("click", async function (event) {
    const actionBtn = event.target.closest("[data-engine-action]");
    if (actionBtn) {
      try {
        await runEngineAction(
          actionBtn.getAttribute("data-engine"),
          actionBtn.getAttribute("data-engine-action")
        );
      } catch (error) {
        showBanner("error", error.message);
      }
      return;
    }

    const routerBtn = event.target.closest("[data-router-action]");
    if (routerBtn) {
      try {
        const action = routerBtn.getAttribute("data-router-action");
        if (action === "dns-refresh") {
          await runDnsRefresh();
        } else if (action === "vpn-refresh") {
          await runVpnRefresh();
        } else if (action === "status-refresh") {
          await runStatusRefresh();
        }
      } catch (error) {
        showBanner("error", error.message);
      }
      return;
    }

    const packageBtn = event.target.closest("[data-package-action]");
    if (packageBtn) {
      try {
        await runPackageAction(
          packageBtn.getAttribute("data-package-engine"),
          packageBtn.getAttribute("data-package-action")
        );
      } catch (error) {
        showBanner("error", error.message);
      }
    }
  });

  if (reloadBtn) {
    reloadBtn.addEventListener("click", async function () {
      if (state.reloadLoading) return;
      state.reloadLoading = true;
      setControlsDisabled(false);
      showBanner("warn", "Обновляем данные обзора...");
      try {
        await init("Данные обзора обновлены.");
      } finally {
        state.reloadLoading = false;
        setControlsDisabled(false);
      }
    });
  }

  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener("click", function () {
      loadPackageUpdates(true, { quiet: false });
    });
  }

  if (checkUiUpdateBtn) {
    checkUiUpdateBtn.addEventListener("click", function () {
      loadUiUpdateAvailability({ quiet: false });
    });
  }

  if (updateUiBtn) {
    updateUiBtn.addEventListener("click", function () {
      runUiUpdate().catch((error) => showBanner("error", error.message));
    });
  }

  init();
})();
