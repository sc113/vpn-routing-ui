(function () {
  const banner = document.getElementById("banner");
  const quickGrid = document.getElementById("quickGrid");
  const statusRows = document.getElementById("statusRows");
  const reloadBtn = document.getElementById("reloadBtn");
  const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
  const UI_VERSION = "20260528-0100";
  const state = {
    status: null,
    profiles: [],
    runtime: [],
    runtimeLoading: false,
    runtimeError: "",
    statusSnapshotLoaded: false,
    systemHealth: null,
    systemHealthLoading: false,
    systemHealthError: "",
    packageUpdates: null,
    packageUpdatesLoading: false,
    actionBusy: null,
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

  function boolPill(ok, yesText, noText) {
    const cls = ok ? "status-pill status-ok" : "status-pill status-bad";
    const text = ok ? yesText : noText;
    return `<span class="${cls}">${text}</span>`;
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
    const cpuBusy = Math.max(0, Math.min(100, 100 - toNumber(health.cpu.idle)));
    return `
      <div class="engine-inline-chip ${healthChipClass("process", cpuBusy)}" title="${escapeHtml("Занятый CPU роутера. Чем меньше, тем спокойнее.")}">
        <span class="label">CPU занято</span>
        <span class="value">${escapeHtml(formatPercent(cpuBusy))}</span>
      </div>
      <div class="engine-inline-chip ${healthChipClass("process", health.load.onePercent)}" title="${escapeHtml("Load average за 1 минуту в процентах от числа CPU-ядер.")}">
        <span class="label">Load 1м</span>
        <span class="value">${escapeHtml(formatPercent(health.load.onePercent, 1))}</span>
      </div>
      <div class="engine-inline-chip ${healthChipClass("process", health.processes.ndmCpu)}" title="${escapeHtml(healthMetricTitle("ndm", health))}">
        <span class="label">KeeneticOS</span>
        <span class="value">${escapeHtml(formatPercent(health.processes.ndmCpu, 1))}</span>
      </div>
      <div class="engine-inline-chip ${healthChipClass("process", health.processes.singboxCpu)}" title="${escapeHtml(healthMetricTitle("singbox", health))}">
        <span class="label">VPN-ядро</span>
        <span class="value">${escapeHtml(formatPercent(health.processes.singboxCpu, 1))}</span>
      </div>
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
      reloadBtn.disabled = disabled;
    }
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = disabled;
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
      return `<a class="chip-link mono" href="${githubReleaseUrl(engine)}" target="_blank" rel="noreferrer noopener">релизы &#8599;</a>`;
    }
    return `<a class="chip-link mono" href="${githubReleaseUrl(engine)}" target="_blank" rel="noreferrer noopener" title="Открыть релизы ${engine === "singbox" ? "sing-box" : "Xray"} на GitHub">${escapeHtml(version)} &#8599;</a>`;
  }

  function nextFreePort(profiles) {
    const used = new Set(
      (Array.isArray(profiles) ? profiles : [])
        .filter((profile) => profile && profile.enabled !== false && String(profile.engine || "xray") === "xray")
        .map((profile) => toNumber(profile.localPort))
        .filter(Boolean)
    );

    let candidate = 2086;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
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

  function renderUpdateChip(engine) {
    const info = engineUpdateInfo(engine);
    if (state.packageUpdatesLoading && !info) {
      return `
        <div class="engine-inline-chip chip-muted">
          <span class="label">Entware</span>
          <span class="value">проверяем...</span>
        </div>
      `;
    }
    if (!info) {
      return `
        <div class="engine-inline-chip chip-muted">
          <span class="label">Entware</span>
          <span class="value">не проверено</span>
        </div>
      `;
    }
    if (info.compatBlocked) {
      return `
        <div class="engine-inline-chip chip-warn" title="${escapeHtml(info.compatReason || "Обновление временно отключено по совместимости.")}">
          <span class="label">Entware</span>
          <span class="value mono">${escapeHtml(compactVersion(info.opkgVersion) || "заблокировано")}</span>
        </div>
      `;
    }
    if (info.opkgHasUpdate && info.opkgPrerelease) {
      return `
        <div class="engine-inline-chip chip-warn" title="В репозитории есть prerelease, автоматическое безопасное обновление отключено.">
          <span class="label">Entware</span>
          <span class="value mono">${escapeHtml(compactVersion(info.opkgVersion) || "prerelease")}</span>
        </div>
      `;
    }
    if (info.opkgHasUpdate) {
      return `
        <div class="engine-inline-chip chip-ok" title="Доступно безопасное обновление через opkg.">
          <span class="label">Entware</span>
          <span class="value mono">${escapeHtml(compactVersion(info.opkgVersion) || "обновление")}</span>
        </div>
      `;
    }
    return `
      <div class="engine-inline-chip chip-muted" title="По данным Entware безопасного обновления сейчас нет.">
        <span class="label">Entware</span>
        <span class="value">актуально</span>
      </div>
    `;
  }

  function renderUpstreamChip(engine) {
    const info = engineUpdateInfo(engine);
    const url = (info && info.releasesUrl) || githubReleaseUrl(engine);
    const version = info ? compactVersion(info.upstreamVersion) : "";
    return `
      <div class="engine-inline-chip" title="Справка по upstream-релизам. Ставить их напрямую на роутер стоит только вручную и осознанно.">
        <span class="label">Upstream</span>
        <span class="value">
          <a class="chip-link mono" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(version || "релизы")} &#8599;</a>
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
        title: "Сначала нажми Проверить обновления.",
      };
    }
    if (info.opkgHasUpdate && info.opkgPrerelease) {
      return {
        disabled: " disabled",
        title: "В Entware сейчас только prerelease. Безопасное обновление отключено.",
      };
    }
    if (info.compatBlocked) {
      return {
        disabled: " disabled",
        title: info.compatReason || "Обновление временно отключено по совместимости.",
      };
    }
    if (!info.safeOpkgUpdate) {
      return {
        disabled: " disabled",
        title: "Безопасных обновлений через opkg сейчас нет.",
      };
    }
    return {
      disabled: "",
      title: "Обновить пакет через Entware/opkg.",
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

  function quickCard(title, hint, chips, actionHtml) {
    const actions = String(actionHtml || "").trim();
    return `
      <section class="quick-card">
        <div class="quick-card-head">
          <div>
            <h3>${title}</h3>
            <p class="hint">${hint}</p>
          </div>
        </div>
        <div class="quick-card-body">
          ${chips}
        </div>
        ${actions ? `<div class="quick-card-actions">${actions}</div>` : ""}
      </section>
    `;
  }

  function renderQuickAccess() {
    if (!quickGrid || !state.status) {
      return;
    }
    const profileList = Array.isArray(state.profiles) ? state.profiles : [];
    const activeProfiles = profileList.filter((profile) => profile && profile.enabled !== false);

    quickGrid.innerHTML = [
      quickCard(
        "Профили и маршруты",
        "Одна страница для ключей, DNS-маршрутов, ProxyN runtime и полного маршрута устройств.",
        `
          <div class="engine-inline-chip">
            <span class="label">Всего</span>
            <span class="value">${profileList.length}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Активных</span>
            <span class="value">${activeProfiles.length}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Следующий socks</span>
            <span class="value mono">:${nextFreePort(profileList)}</span>
          </div>
          <div class="engine-inline-chip chip-muted">
            <span class="label">Разделы</span>
            <span class="value">ключи / DNS / клиенты</span>
          </div>
        `,
        `
          <a class="button-like" href="/profiles.html?v=${UI_VERSION}">Открыть конфигурации</a>
        `,
      ),
      quickCard(
        "DNS-группы",
        "Один текстовый файл для переноса domain-list групп и DNS-маршрутов между роутерами.",
        `
          <div class="engine-inline-chip chip-muted">
            <span class="label">Формат</span>
            <span class="value">dns-groups v1</span>
          </div>
          <div class="engine-inline-chip chip-muted">
            <span class="label">Имена групп</span>
            <span class="value">сохраняются</span>
          </div>
          <div class="engine-inline-chip chip-muted">
            <span class="label">Импорт</span>
            <span class="value">полная замена</span>
          </div>
        `,
        `
          <a class="button-like secondary" href="/dns-sync.html?v=${UI_VERSION}">Открыть DNS-группы</a>
        `
      ),
    ].join("");
  }

  function renderEngineRow(options) {
    const anyBusy = Boolean(state.actionBusy);
    const installDisabled = options.installed ? " disabled" : "";
    const removeDisabled = options.installed ? "" : " disabled";
    const serviceDisabled = options.serviceEnabled ? "" : " disabled";
    const updateState = updateButtonState(options.engine, options.installed);
    const installBusy = actionBusyMatches("package", options.engine, "install");
    const removeBusy = actionBusyMatches("package", options.engine, "remove");
    const updateBusy = actionBusyMatches("package", options.engine, "update");
    const startBusy = actionBusyMatches("service", options.engine, "start");
    const stopBusy = actionBusyMatches("service", options.engine, "stop");
    const restartBusy = actionBusyMatches("service", options.engine, "restart");

    return `
      <section class="engine-row manage-engine-row">
        <div class="engine-row-main">
          <div class="engine-row-title">${options.title}</div>
          <div class="engine-row-bubbles engine-row-bubbles-two">
            <div class="engine-chip-row">
              ${boolPill(options.running, "Запущен", options.installed ? "Остановлен" : "Не установлен")}
              <div class="engine-inline-chip">
                <span class="label">Пакет</span>
                <span class="value">${options.installed ? "установлен" : "не установлен"}</span>
              </div>
              <div class="engine-inline-chip">
                <span class="label">Версия</span>
                <span class="value">${renderVersionValue(options.engine, options.version)}</span>
              </div>
            </div>
            <div class="engine-chip-row">
              ${options.extraChipHtml || ""}
              ${renderUpdateChip(options.engine)}
              ${renderUpstreamChip(options.engine)}
            </div>
          </div>
        </div>
        <div class="engine-row-actions engine-row-actions-stack">
          <div class="action-cluster action-cluster-package">
            <button type="button" class="success" data-package-engine="${options.engine}" data-package-action="install"${anyBusy ? " disabled" : installDisabled}>${actionLabel("package", "install", installBusy)}</button>
            <button type="button" class="danger" data-package-engine="${options.engine}" data-package-action="remove"${anyBusy ? " disabled" : removeDisabled}>${actionLabel("package", "remove", removeBusy)}</button>
            <button type="button" class="info" data-package-engine="${options.engine}" data-package-action="update"${anyBusy ? " disabled" : updateState.disabled} title="${escapeHtml(updateState.title)}">${actionLabel("package", "update", updateBusy)}</button>
          </div>
          <div class="action-cluster action-cluster-service">
            <button type="button" class="success" data-engine="${options.engine}" data-engine-action="start"${anyBusy ? " disabled" : serviceDisabled}>${actionLabel("service", "start", startBusy)}</button>
            <button type="button" class="danger" data-engine="${options.engine}" data-engine-action="stop"${anyBusy ? " disabled" : serviceDisabled}>${actionLabel("service", "stop", stopBusy)}</button>
            <button type="button" class="warning" data-engine="${options.engine}" data-engine-action="restart"${anyBusy ? " disabled" : serviceDisabled}>${actionLabel("service", "restart", restartBusy)}</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderEngineRows() {
    if (!statusRows || !state.status) {
      return;
    }
    const xrayInstalled = Boolean(state.status.xrayInstalled);
    const singboxInstalled = Boolean(state.status.singboxInstalled);
    const singboxService = Boolean(state.status.singboxService);
    const xrayConfigPath = state.status.xrayConfigPath || "/opt/etc/xray/config.json";
    const singboxConfigPath = state.status.singboxConfigPath || "/opt/etc/sing-box/config.json";

    statusRows.innerHTML = [
      renderEngineRow({
        engine: "xray",
        title: "Xray",
        installed: xrayInstalled,
        running: Boolean(state.status.xrayRunning),
        serviceEnabled: xrayInstalled,
        version: state.status.xrayVersion,
        extraChipHtml: `
          <div class="engine-inline-chip" title="${escapeHtml(xrayConfigPath)}">
            <span class="label">Config</span>
            <span class="value mono">${escapeHtml(compactPath(xrayConfigPath))}</span>
          </div>
        `,
      }),
      renderEngineRow({
        engine: "singbox",
        title: "sing-box",
        installed: singboxInstalled,
        running: Boolean(state.status.singboxRunning),
        serviceEnabled: singboxInstalled && singboxService,
        version: state.status.singboxVersion,
        extraChipHtml: `
          <div class="engine-inline-chip" title="${escapeHtml(singboxConfigPath)}">
            <span class="label">Config</span>
            <span class="value mono">${escapeHtml(compactPath(singboxConfigPath))}</span>
          </div>
        `,
      }),
    ].join("");
  }

  function renderAll() {
    renderQuickAccess();
    renderEngineRows();
  }

  async function loadPackageUpdates(refresh, options) {
    const opts = options || {};
    state.packageUpdatesLoading = true;
    renderEngineRows();
    if (!opts.quiet) {
      showBanner("warn", refresh ? "Проверяем обновления через Entware и upstream..." : "Догружаем статус обновлений...");
    }
    try {
      const data = await fetchJson(`/cgi-bin/package-updates.cgi?refresh=${refresh ? "1" : "0"}`, {
        cache: "no-store",
      });
      state.packageUpdates = data;
      state.packageUpdatesLoading = false;
      renderEngineRows();
      if (!opts.quiet) {
        if (refresh && data.refreshOk === false) {
          showBanner("warn", "Индексы Entware перечитать не удалось полностью, но текущий статус обновлений всё равно показан.");
        } else {
          showBanner("ok", refresh ? "Статус обновлений перечитан." : "Статус обновлений загружен.");
        }
      }
    } catch (error) {
      state.packageUpdatesLoading = false;
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
        fetchJson("/cgi-bin/status.cgi", { cache: "no-store" }),
        fetchJson("/cgi-bin/xray-profiles.cgi", { cache: "no-store" }),
      ]);

      if (statusResult.status !== "fulfilled") {
        throw statusResult.reason;
      }

      state.status = statusResult.value;
      const profilesDoc = profilesResult.status === "fulfilled" ? profilesResult.value : { profiles: [] };
      state.profiles = Array.isArray(profilesDoc.profiles) ? profilesDoc.profiles : [];

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
    reloadBtn.addEventListener("click", function () {
      init("Состояние роутера перечитано.");
    });
  }

  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener("click", function () {
      loadPackageUpdates(true, { quiet: false });
    });
  }

  init();
})();
