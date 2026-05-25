const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const UI_VERSION = "20260526-0205";
const LOCAL_SOCKS_PUBLIC_BIND = "192.168.1.1";
const LOCAL_SOCKS_INTERNAL_BIND = "127.0.0.1";
const DIRECT_DNS_ROUTE_TARGET = "ISP";
const DIRECT_DNS_SELECT_VALUE = "__direct__";
const AUTO_STORM_LOOPBACK_THRESHOLD = 200;

const SYSTEM_OUTBOUND_TAGS = new Set(["direct", "blocked"]);
const SYSTEM_OUTBOUND_PROTOCOLS = new Set(["freedom", "blackhole"]);

const PROTOCOL_LABELS = {
  shadowsocks: "Shadowsocks",
  trojan: "Trojan",
  socks: "Socks",
  vless: "VLESS",
  vmess: "VMess",
};

const PROTOCOL_ID_TOKENS = {
  shadowsocks: "ss",
  trojan: "trojan",
  socks: "socks",
  vless: "vless",
  vmess: "vmess",
};

const state = {
  status: null,
  profilesDoc: { version: 1, profiles: [] },
  appliedProfilesSignature: "",
  appliedDnsRoutesSignature: "",
  routerProxies: [],
  routerRuntime: [],
  routerRuntimeLoading: false,
  routerRuntimeError: "",
  statusSnapshotLoaded: false,
  systemHealth: null,
  systemHealthLoading: false,
  systemHealthError: "",
  dnsRoutes: [],
  dnsRoutesLoading: false,
  dnsRoutesError: "",
  selectedId: null,
  egressResults: {},
  probeResults: {},
  pingAllInFlight: false,
  saveInFlight: false,
  dnsRefreshInFlight: false,
  vpnRefreshInFlight: false,
  proxyRuntimeBusyId: "",
  proxyRuntimeBusyAction: "",
  clientPoliciesLoading: false,
  clientPoliciesError: "",
  clientPoliciesLoaded: false,
  clientPolicyBusyMac: "",
  clientHosts: [],
  clientPolicies: [],
  clientAssignments: [],
  layoutReady: false,
  modalMode: null,
  modalProfileId: null,
  modalDraft: null,
};

function $(id) {
  return document.getElementById(id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function makeProfilesSignature(doc) {
  return JSON.stringify(normalizeProfilesDoc(doc));
}

function makeDnsRoutesSignature(routes, profiles) {
  return buildDnsRouteSyncPayload(routes || state.dnsRoutes, profiles || getProfiles());
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
  return toNumber(value).toFixed(typeof digits === "number" ? digits : 0) + "%";
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

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactVersion(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "Неизвестно";
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

function inboundListenAddress(inbound) {
  return String((inbound || {}).listen || "").trim();
}

function githubReleaseUrl(engine, versionText) {
  return engine === "singbox"
    ? "https://github.com/SagerNet/sing-box/releases"
    : "https://github.com/XTLS/Xray-core/releases";
}

function renderVersionValue(engine, versionText) {
  const version = compactVersion(versionText);
  if (!version) {
    return `<a class="chip-link mono" href="${githubReleaseUrl(engine, versionText)}" target="_blank" rel="noreferrer noopener">релизы &#8599;</a>`;
  }
  return `<a class="chip-link mono" href="${githubReleaseUrl(engine, versionText)}" target="_blank" rel="noreferrer noopener">${escapeHtml(version)} &#8599;</a>`;
}

function showBanner(kind, text) {
  const banner = $("banner");
  if (!banner) {
    return;
  }
  banner.className = "banner show " + kind;
  banner.textContent = text;
}

function clearBanner() {
  const banner = $("banner");
  if (!banner) {
    return;
  }
  banner.className = "banner";
  banner.textContent = "";
}

function setStartupLoading(visible, text) {
  const box = $("startupLoading");
  const textNode = $("startupLoadingText");
  if (!box) {
    return;
  }
  box.hidden = !visible;
  if (textNode && text) {
    textNode.textContent = text;
  }
}

function isProfilesDirty() {
  return makeProfilesSignature(state.profilesDoc) !== String(state.appliedProfilesSignature || "");
}

function isDnsRoutesDirty() {
  if (!state.appliedDnsRoutesSignature) {
    return false;
  }
  return makeDnsRoutesSignature(getDnsRoutes(), getProfiles()) !== String(state.appliedDnsRoutesSignature || "");
}

function markProfilesApplied(doc) {
  state.appliedProfilesSignature = makeProfilesSignature(doc || state.profilesDoc);
}

function markDnsRoutesApplied(routes, profiles) {
  state.appliedDnsRoutesSignature = makeDnsRoutesSignature(routes || state.dnsRoutes, profiles || getProfiles());
}

function renderDirtyNotice() {
  const notice = $("dirtyNotice");
  const text = $("dirtyNoticeText");
  const button = $("dirtySaveBtn");
  if (!notice || !text || !button) {
    return;
  }

  const dirty =
    !state.dnsRoutesLoading &&
    (Boolean(state.appliedProfilesSignature) || Boolean(state.appliedDnsRoutesSignature)) &&
    (isProfilesDirty() || isDnsRoutesDirty());
  const visible = dirty || state.saveInFlight;
  notice.hidden = !visible;
  button.disabled = !dirty || state.saveInFlight;
  button.textContent = state.saveInFlight ? "Отправляем..." : "Отправить на роутер";

  if (state.saveInFlight) {
    text.textContent = "Изменения отправляются на роутер. Пока идёт применение, повторные действия временно заблокированы.";
    return;
  }

  if (!dirty) {
    return;
  }

  const profiles = getProfiles();
  const enabledCount = profiles.filter((profile) => profile.enabled).length;
  text.textContent =
    "Изменения пока сохранены только локально. Профилей: " +
    profiles.length +
    ", активных: " +
    enabledCount +
    ". Нажми кнопку справа, чтобы отправить всё на роутер.";
}

function updateBusyControls() {
  const busy = Boolean(
    state.saveInFlight ||
      state.dnsRefreshInFlight ||
      state.vpnRefreshInFlight ||
      state.proxyRuntimeBusyId ||
      state.clientPolicyBusyMac
  );
  const hasAssignedDnsRoutes = getCurrentDnsAssignments().size > 0;

  if ($("reloadBtn")) {
    $("reloadBtn").disabled = busy;
  }
  if ($("pingAllBtn")) {
    $("pingAllBtn").disabled = busy || state.pingAllInFlight;
  }
  if ($("openCreateBtn")) {
    $("openCreateBtn").disabled = busy;
  }
  if ($("replaceLinkBtn")) {
    $("replaceLinkBtn").disabled = busy;
  }
  if ($("duplicateBtn")) {
    $("duplicateBtn").disabled = busy;
  }
  if ($("deleteBtn")) {
    $("deleteBtn").disabled = busy;
  }
  if ($("applyProfileJsonBtn")) {
    $("applyProfileJsonBtn").disabled = busy;
  }
  if ($("autoPortBtn")) {
    $("autoPortBtn").disabled = busy;
  }
  if ($("pingSelectedBtn")) {
    $("pingSelectedBtn").disabled = busy;
  }
  if ($("dnsBulkProfileSelect")) {
    const shouldDisable =
      busy ||
      state.dnsRoutesLoading ||
      Boolean(state.dnsRoutesError) ||
      !getProfiles().length ||
      !hasAssignedDnsRoutes;
    $("dnsBulkProfileSelect").disabled = shouldDisable;
  }
  if ($("dnsBulkApplyBtn")) {
    const noBulkProfile = !String(($("dnsBulkProfileSelect") && $("dnsBulkProfileSelect").value) || "").trim();
    $("dnsBulkApplyBtn").disabled =
      busy ||
      state.dnsRoutesLoading ||
      Boolean(state.dnsRoutesError) ||
      noBulkProfile ||
      !hasAssignedDnsRoutes;
  }
  if ($("modalSaveBtn")) {
    $("modalSaveBtn").disabled = busy;
    $("modalSaveBtn").textContent = busy ? "Сохраняем..." : "Сохранить изменения";
  }
}

function setSaveInFlight(value) {
  state.saveInFlight = Boolean(value);
  renderDirtyNotice();
  renderSummary();
  renderProfilesTable();
  renderDnsBulkControls();
  renderDnsRoutesTable();
  renderProxyRuntimeTable();
  renderSelectedOverview();
  updateBusyControls();
}

function runDnsRefresh() {
  if (
    state.dnsRefreshInFlight ||
    state.vpnRefreshInFlight ||
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.clientPolicyBusyMac
  ) {
    return Promise.reject(
      new Error("Подожди завершения текущей операции, потом запусти DNS reset ещё раз.")
    );
  }
  state.dnsRefreshInFlight = true;
  updateBusyControls();
  renderSummary();
  renderClientPolicies();
  showBanner("warn", "Пересобираем live DNS-маршруты и перезапускаем dns-proxy intercept...");

  return fetchJson("/cgi-bin/dns-route-refresh.cgi", {
    method: "POST",
    cache: "no-store",
  })
    .then((data) =>
      init(
        (data && data.message ? data.message : "DNS-маршруты пересобраны.") +
          (data && data.backupPath ? " Бэкап: " + data.backupPath : "")
      )
    )
    .finally(() => {
      state.dnsRefreshInFlight = false;
      updateBusyControls();
      renderSummary();
      renderClientPolicies();
    });
}

function runVpnRefresh() {
  if (
    state.vpnRefreshInFlight ||
    state.dnsRefreshInFlight ||
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.clientPolicyBusyMac
  ) {
    return Promise.reject(
      new Error("Подожди завершения текущей операции, потом запусти VPN reset ещё раз.")
    );
  }
  if (isProfilesDirty()) {
    return Promise.reject(
      new Error("Сначала отправь локальные изменения профилей на роутер, а потом запускай VPN reset.")
    );
  }

  state.vpnRefreshInFlight = true;
  updateBusyControls();
  renderSummary();
  renderClientPolicies();
  showBanner(
    "warn",
    "Перезапускаем только реально используемые движки и проверяем слой маршрутизации..."
  );

  const params = new URLSearchParams();
  if (state.status && state.status.xrayInstalled && hasEnabledProfileForEngine("xray")) {
    params.set("xray", "1");
  }
  if (
    state.status &&
    state.status.singboxInstalled &&
    state.status.singboxService &&
    hasEnabledProfileForEngine("sing-box")
  ) {
    params.set("singbox", "1");
  }

  return Promise.resolve()
    .then(() =>
      fetchJson(`/cgi-bin/vpn-route-refresh.cgi?${params.toString()}`, {
        method: "POST",
        cache: "no-store",
      })
    )
    .then((data) =>
      init(
        (data && data.message ? data.message : "VPN-слой перезапущен.") +
          (data && data.runtime ? " " + data.runtime : "") +
          (data && data.backupPath ? " Бэкап: " + data.backupPath : "")
      )
    )
    .finally(() => {
      state.vpnRefreshInFlight = false;
      updateBusyControls();
      renderSummary();
      renderClientPolicies();
    });
}

function runStatusRefresh() {
  if (
    state.vpnRefreshInFlight ||
    state.dnsRefreshInFlight ||
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.clientPolicyBusyMac ||
    state.systemHealthLoading ||
    state.routerRuntimeLoading
  ) {
    return Promise.reject(new Error("Сначала дождись завершения текущей операции."));
  }

  state.statusSnapshotLoaded = false;
  state.systemHealthLoading = true;
  state.systemHealthError = "";
  state.routerRuntimeLoading = true;
  state.routerRuntimeError = "";
  updateBusyControls();
  renderSummary();
  renderProxyRuntimeTable();
  renderClientPolicies();
  showBanner("warn", "Считываем живой статус роутера и ProxyN только по явному запросу...");

  return loadSystemHealth()
    .then((healthData) => {
      state.systemHealth = normalizeSystemHealth(healthData);
      state.systemHealthLoading = false;
      state.systemHealthError = "";
      renderSummary();
      renderProxyRuntimeTable();
      return loadRouterRuntime();
    })
    .then((runtimeData) => {
      state.routerProxies = mergeRouterProxyRuntime(state.routerProxies, runtimeData && runtimeData.proxies);
      state.routerRuntime = normalizeRouterProxyList(runtimeData && runtimeData.proxies);
      state.routerRuntimeLoading = false;
      state.routerRuntimeError = "";
      state.statusSnapshotLoaded = true;
      renderSummary();
      renderDnsRoutesTable();
      renderProxyRuntimeTable();
      showBanner("ok", "Живой статус роутера перечитан.");
    })
    .catch((error) => {
      state.systemHealthLoading = false;
      state.routerRuntimeLoading = false;
      if (!state.systemHealthError) {
        state.systemHealthError = error.message;
      }
      if (!state.routerRuntimeError) {
        state.routerRuntimeError = error.message;
      }
      renderSummary();
      renderProxyRuntimeTable();
      throw error;
    })
    .finally(() => {
      updateBusyControls();
      renderSummary();
      renderProxyRuntimeTable();
    });
}

function runProxyNamesSync() {
  if (
    state.vpnRefreshInFlight ||
    state.dnsRefreshInFlight ||
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.clientPolicyBusyMac ||
    state.routerRuntimeLoading
  ) {
    return Promise.reject(new Error("Сначала дождись завершения текущей операции."));
  }

  const payload = buildRouterSyncPayload(getProfiles());
  setSaveInFlight(true);
  showBanner("warn", "Синхронизируем названия ProxyN с именами профилей UI...");

  return fetchJson("/cgi-bin/router-proxy-sync.cgi?action=names", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: payload,
  })
    .then((data) => {
      state.profilesDoc = applyRouterSyncMappings(getProfiles(), data);
      const message =
        (data && data.message ? data.message : "Названия ProxyN синхронизированы.") +
        " Обновлено: " +
        (data && data.updated ? data.updated : 0) +
        (data && data.skipped ? ", пропущено: " + data.skipped : "") +
        (data && data.removed ? ", удалено старых: " + data.removed : "") +
        ".";
      return loadSupplementalRouterState().then(() => {
        if (!state.statusSnapshotLoaded) {
          showBanner("ok", message);
          return null;
        }
        state.routerRuntimeLoading = true;
        renderProxyRuntimeTable();
        return loadRouterRuntime().then((runtime) => {
          state.routerProxies = mergeRouterProxyRuntime(state.routerProxies, runtime && runtime.proxies);
          state.routerRuntime = normalizeRouterProxyList(runtime && runtime.proxies);
          state.routerRuntimeLoading = false;
          state.routerRuntimeError = "";
          renderProxyRuntimeTable();
          showBanner("ok", message);
          return null;
        });
      });
    })
    .finally(() => {
      setSaveInFlight(false);
      renderProfilesTable();
      renderSelectedOverview();
      renderProxyRuntimeTable();
    });
}

function runClientPoliciesRefresh() {
  if (
    state.vpnRefreshInFlight ||
    state.dnsRefreshInFlight ||
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.clientPolicyBusyMac ||
    state.clientPoliciesLoading
  ) {
    return Promise.reject(new Error("Сначала дождись завершения текущей операции."));
  }

  state.clientPoliciesLoading = true;
  state.clientPoliciesError = "";
  updateBusyControls();
  renderClientPolicies();
  showBanner("warn", "Считываем список клиентов и полные маршруты по явному запросу...");

  return loadClientPolicies()
    .then((clientData) => {
      state.clientHosts = normalizeClientHosts(clientData);
      state.clientPolicies = normalizeClientPolicyList(clientData);
      state.clientAssignments = normalizeClientAssignments(clientData);
      state.clientPoliciesLoading = false;
      state.clientPoliciesError = "";
      state.clientPoliciesLoaded = true;
      renderClientPolicies();
      showBanner("ok", "Список клиентов и полные маршруты перечитаны.");
    })
    .catch((error) => {
      state.clientPoliciesLoading = false;
      state.clientPoliciesError = error.message;
      renderClientPolicies();
      throw error;
    })
    .finally(() => {
      updateBusyControls();
      renderClientPolicies();
    });
}

function setFieldValue(id, value) {
  const node = $(id);
  if (node) {
    node.value = value == null ? "" : String(value);
  }
}

function safeJsonParse(text, title) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error((title || "JSON") + ": " + error.message);
  }
}

function boolPill(ok, yesText, noText) {
  return `<span class="status-pill ${ok ? "status-ok" : "status-bad"}">${ok ? yesText : noText}</span>`;
}

function protocolLabel(protocol) {
  return PROTOCOL_LABELS[String(protocol || "").toLowerCase()] || String(protocol || "unknown");
}

function protocolIdToken(protocol) {
  return PROTOCOL_ID_TOKENS[String(protocol || "").toLowerCase()] || String(protocol || "profile").toLowerCase();
}

function normalizeProfileEngine(engine) {
  const text = String(engine || "xray")
    .trim()
    .toLowerCase();
  return text === "sing-box" || text === "singbox" ? "sing-box" : "xray";
}

function isXrayEngine(engine) {
  return normalizeProfileEngine(engine) === "xray";
}

function isSingboxEngine(engine) {
  return normalizeProfileEngine(engine) === "sing-box";
}

function engineSystemToken(engine) {
  return isSingboxEngine(engine) ? "singbox" : "xray";
}

function cleanProfileId(rawId) {
  const text = String(rawId || "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("in-proxy-")) {
    return "proxy-" + text.slice("in-proxy-".length);
  }
  if (text.startsWith("out-proxy-")) {
    return "proxy-" + text.slice("out-proxy-".length);
  }
  if (text.startsWith("in-")) {
    return text.slice(3);
  }
  if (text.startsWith("out-")) {
    return text.slice(4);
  }
  return text;
}

function systemProfileName(profileOrId, protocol, engine) {
  const rawId =
    typeof profileOrId === "object" && profileOrId
      ? cleanProfileId(profileOrId.id)
      : cleanProfileId(profileOrId);
  const rawRouterProxyId =
    typeof profileOrId === "object" && profileOrId ? normalizeRouterProxyId(profileOrId.routerProxyId) : "";
  const rawProtocol =
    typeof profileOrId === "object" && profileOrId ? profileOrId.protocol : protocol;
  const rawEngine =
    typeof profileOrId === "object" && profileOrId ? profileOrId.engine : engine;
  const engineToken = engineSystemToken(rawEngine);
  const protocolToken = protocolIdToken(rawProtocol);

  if (rawRouterProxyId) {
    return engineToken + "-" + protocolToken + "-" + String(Number(rawRouterProxyId.replace("Proxy", "")));
  }

  if (rawId && rawId.startsWith("proxy-")) {
    const suffixMatch = rawId.match(/^proxy-[a-z0-9]+(-\d+)?$/i);
    const suffix = suffixMatch && suffixMatch[1] ? suffixMatch[1] : "";
    return engineToken + "-" + protocolToken + suffix;
  }

  return engineToken + "-" + protocolToken;
}

function normalizeRouterProxyId(value) {
  const text = String(value || "").trim();
  return /^Proxy\d+$/.test(text) ? text : "";
}

function normalizeDnsRouteTarget(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const proxyId = normalizeRouterProxyId(text);
  if (proxyId) {
    return proxyId;
  }
  return /^[A-Za-z][A-Za-z0-9_.\/-]*$/.test(text) ? text : "";
}

function isDirectDnsRouteTarget(value) {
  return normalizeDnsRouteTarget(value) === DIRECT_DNS_ROUTE_TARGET;
}

function displayDnsRouteDescription(route) {
  const description = String((route && route.description) || "").trim();
  return description || (route && route.groupId) || "";
}

function dnsRouteHostSummary(route) {
  const includes = Array.isArray(route && route.includes)
    ? route.includes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const includeCount = Math.max(0, toNumber(route && route.includeCount) || includes.length);
  if (!includeCount) {
    return null;
  }

  return {
    title: includes.length ? `В списке ${includeCount} include.` : "Подробный список доступен после перечитывания.",
    text: `${includeCount} include`,
  };
}

function isRouterProxyTarget(value) {
  return Boolean(normalizeRouterProxyId(value));
}

function isExternalDnsRouteTarget(value) {
  const target = normalizeDnsRouteTarget(value);
  return Boolean(target && !isRouterProxyTarget(target));
}

function formatExternalDnsRouteTarget(value) {
  const target = normalizeDnsRouteTarget(value);
  if (!target) {
    return "";
  }
  return target === DIRECT_DNS_ROUTE_TARGET ? "Прямое подключение" : "Прямое / " + target;
}

function parseRouterProxyInputValue(value) {
  const text = String(value || "").trim();
  if (!text) {
    return {
      valid: true,
      value: "",
      displayValue: "",
      message: "",
    };
  }

  if (/^\d+$/.test(text)) {
    const normalized = "Proxy" + String(Number(text));
    return {
      valid: true,
      value: normalized,
      displayValue: normalized,
      message: "",
    };
  }

  if (/^Proxy\d+$/i.test(text)) {
    const normalized = "Proxy" + String(Number(text.replace(/^Proxy/i, "")));
    return {
      valid: true,
      value: normalized,
      displayValue: normalized,
      message: "",
    };
  }

  return {
    valid: false,
    value: "",
    displayValue: text,
    message: "Используй только число или формат ProxyN, например 2 или Proxy2.",
  };
}

function nextFreeRouterProxyId(skipId) {
  const used = new Set();

  for (const profile of getProfiles()) {
    if (profile.id === skipId) {
      continue;
    }
    const proxyId = normalizeRouterProxyId(profile.routerProxyId);
    if (proxyId) {
      used.add(proxyId);
    }
  }

  for (const proxy of normalizeRouterProxyList(state.routerProxies)) {
    const proxyId = normalizeRouterProxyId(proxy.proxyId);
    if (proxyId) {
      used.add(proxyId);
    }
  }

  let index = 0;
  while (index <= 63) {
    const candidate = "Proxy" + index;
    if (!used.has(candidate)) {
      return candidate;
    }
    index += 1;
  }

  return "Proxy" + used.size;
}

function getEffectiveRouterProxyId(profile, skipId) {
  const explicit = normalizeRouterProxyId(profile && profile.routerProxyId);
  return explicit || nextFreeRouterProxyId(skipId);
}

function isSystemLikeProfileName(name, profileId, protocol, engine) {
  const text = String(name || "").trim();
  if (!text) {
    return true;
  }
  if (text === systemProfileName(profileId, protocol, engine)) {
    return true;
  }
  return /^(xray|singbox)-(ss|trojan|socks|vless|vmess)(-\d+)?$/i.test(text);
}

function normalizeDnsRuleId(value) {
  const text = String(value || "").trim();
  return /^domain-list\d+$/.test(text) ? text : "";
}

function dnsRuleOrder(groupId) {
  const match = String(groupId || "").match(/^domain-list(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function normalizeDnsRuleList(value) {
  const source = Array.isArray(value) ? value : [];
  const unique = new Set();
  for (const item of source) {
    const normalized = normalizeDnsRuleId(item);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((left, right) => dnsRuleOrder(left) - dnsRuleOrder(right));
}

function normalizeDnsRoutes(payload) {
  const rawRules =
    Array.isArray(payload && payload.rules) ? payload.rules : Array.isArray(payload) ? payload : [];

  return rawRules
    .map((item) => {
      const groupId = normalizeDnsRuleId(item && item.groupId);
      if (!groupId) {
        return null;
      }
      return {
        groupId,
        description: String((item && item.description) || "").trim(),
        proxyId: normalizeDnsRouteTarget(item && item.proxyId),
        includeCount: Math.max(0, toNumber(item && item.includeCount) || 0),
        includes: Array.isArray(item && item.includes)
          ? item.includes.map((include) => String(include || "").trim()).filter(Boolean)
          : [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftTarget = normalizeDnsRouteTarget(left.proxyId);
      const rightTarget = normalizeDnsRouteTarget(right.proxyId);
      const leftPriority = isExternalDnsRouteTarget(leftTarget) ? 1 : leftTarget ? 0 : 2;
      const rightPriority = isExternalDnsRouteTarget(rightTarget) ? 1 : rightTarget ? 0 : 2;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId);
    });
}

function normalizeRouterProxyList(payload) {
  const rawList =
    Array.isArray(payload && payload.proxies) ? payload.proxies : Array.isArray(payload) ? payload : [];

  return rawList
    .map((item) => {
      const proxyId = normalizeRouterProxyId(item && item.proxyId);
      if (!proxyId) {
        return null;
      }
      return {
        proxyId,
        name: String((item && item.name) || "").trim(),
        port: toNumber(item && item.port),
        enabled: Boolean(item && item.enabled),
        configuredUp:
          item && Object.prototype.hasOwnProperty.call(item, "configuredUp")
            ? Boolean(item.configuredUp)
            : Boolean(item && item.enabled),
        upstreamHost: String((item && item.upstreamHost) || "").trim(),
        upstreamPort: toNumber(item && (item.upstreamPort || item.port)),
        link: String((item && item.link) || "").trim(),
        connected: String((item && item.connected) || "").trim(),
        state: String((item && item.state) || "").trim(),
        ctrl: String((item && item.ctrl) || "").trim(),
        address: String((item && item.address) || "").trim(),
        uptime: String((item && item.uptime) || "").trim(),
        localEndpoint: String((item && item.localEndpoint) || "").trim(),
        remoteEndpoint: String((item && item.remoteEndpoint) || "").trim(),
        pid: String((item && item.pid) || "").trim(),
        loopbackConnections: toNumber(item && item.loopbackConnections),
        hasProcess: Boolean(item && item.hasProcess),
        healthy: Boolean(item && item.healthy),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftIndex = toNumber(String(left.proxyId).replace("Proxy", ""));
      const rightIndex = toNumber(String(right.proxyId).replace("Proxy", ""));
      return leftIndex - rightIndex;
    });
}

function mergeRouterProxyRuntime(baseList, runtimeList) {
  const merged = new Map();
  for (const item of normalizeRouterProxyList(baseList)) {
    merged.set(item.proxyId, { ...item });
  }
  for (const runtime of normalizeRouterProxyList(runtimeList)) {
    const previous = merged.get(runtime.proxyId) || {};
    merged.set(runtime.proxyId, { ...previous, ...runtime });
  }
  return Array.from(merged.values()).sort((left, right) => {
    const leftIndex = toNumber(String(left.proxyId).replace("Proxy", ""));
    const rightIndex = toNumber(String(right.proxyId).replace("Proxy", ""));
    return leftIndex - rightIndex;
  });
}

function getRouterProxyRuntimeMap() {
  return new Map(normalizeRouterProxyList(state.routerProxies).map((proxy) => [proxy.proxyId, proxy]));
}

function getRouterProxyRuntime(proxyId) {
  const normalized = normalizeRouterProxyId(proxyId);
  return normalized ? getRouterProxyRuntimeMap().get(normalized) || null : null;
}

function routerProxyNameMismatch(profile) {
  const proxyId = getEffectiveRouterProxyId(profile, profile && profile.id);
  const proxy = getRouterProxyRuntime(proxyId);
  const routerName = String((proxy && proxy.name) || "").trim();
  const profileName = String((profile && profile.name) || "").trim();
  if (!routerName || routerName === profileName) {
    return "";
  }
  return routerName;
}

function getProxyUsageSummary(proxyId) {
  const normalized = normalizeRouterProxyId(proxyId);
  if (!normalized) {
    return { dnsLabels: [], clientLabels: [] };
  }

  const dnsLabels = getDnsRoutes()
    .filter((route) => normalizeRouterProxyId(route.proxyId) === normalized)
    .map((route) => displayDnsRouteDescription(route));

  const clientLabels = [];
  const policyMap = getClientPolicyMap();
  const hostsByMac = new Map(getClientHosts().map((host) => [host.mac, host]));
  for (const assignment of getClientAssignments()) {
    const policy = policyMap.get(assignment.policyId);
    if (!policy || normalizeRouterProxyId(policy.proxyId) !== normalized) {
      continue;
    }
    const host = hostsByMac.get(assignment.mac);
    clientLabels.push(host ? host.displayName : assignment.mac);
  }

  return { dnsLabels, clientLabels };
}

function isRuntimeHealthy(proxyId) {
  const runtime = getRouterProxyRuntime(proxyId);
  return Boolean(runtime && runtime.healthy);
}

function makeUniqueProfileName(baseName, skipId) {
  const base = String(baseName || "").trim() || "Новый профиль";
  const reserved = new Set(
    getProfiles()
      .filter((profile) => profile.id !== skipId)
      .map((profile) => String(profile.name || "").trim().toLowerCase())
      .filter(Boolean)
  );

  if (!reserved.has(base.toLowerCase())) {
    return base;
  }

  let index = 2;
  while (reserved.has((base + " " + index).toLowerCase())) {
    index += 1;
  }
  return base + " " + index;
}

function suggestProfileId(protocol, currentId) {
  const base = "proxy-" + protocolIdToken(protocol);
  const cleanedCurrentId = cleanProfileId(currentId);
  const usedIds = new Set(
    getProfiles()
      .map((profile) => cleanProfileId(profile.id))
      .filter((id) => id && id !== cleanedCurrentId)
  );

  if (!usedIds.has(base)) {
    return base;
  }

  let index = 2;
  while (usedIds.has(base + "-" + index)) {
    index += 1;
  }
  return base + "-" + index;
}

function delayClass(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "delay-neutral";
  }
  if (ms <= 100) {
    return "delay-good";
  }
  if (ms <= 220) {
    return "delay-warn";
  }
  return "delay-bad";
}

function fetchJson(url, options) {
  return fetch(url, options).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    const errorMessage = data && (data.error || data.message);
    const errorDetails = data && data.details ? String(data.details) : "";
    const fullError =
      errorMessage && errorDetails && !String(errorMessage).includes(errorDetails)
        ? errorMessage + ": " + errorDetails
        : errorMessage;
    if (!response.ok) {
      throw new Error(fullError || "HTTP " + response.status);
    }
    if (data && data.ok === false) {
      throw new Error(fullError || "Операция на роутере не выполнена.");
    }
    return data;
  });
}

function loadStatus() {
  return fetchJson("/cgi-bin/status.cgi", { cache: "no-store" });
}

function loadProfilesDoc() {
  return fetchJson("/cgi-bin/xray-profiles.cgi", { cache: "no-store" });
}

function loadLiveConfig() {
  return fetchJson("/cgi-bin/xray-config.cgi", { cache: "no-store" });
}

function loadDnsRoutes() {
  return fetchJson("/cgi-bin/router-dns-routes.cgi", { cache: "no-store" });
}

function loadClientPolicies() {
  return fetchJson("/cgi-bin/router-client-policies.cgi", { cache: "no-store" });
}

function loadRouterRuntime() {
  return fetchJson("/cgi-bin/router-runtime-status.cgi", { cache: "no-store" });
}

function loadSystemHealth() {
  return fetchJson("/cgi-bin/router-system-health.cgi", { cache: "no-store" });
}

function normalizeClientHosts(payload) {
  const rawHosts =
    Array.isArray(payload && payload.hosts) ? payload.hosts : Array.isArray(payload) ? payload : [];

  return rawHosts
    .map((item) => {
      const mac = String((item && item.mac) || "")
        .trim()
        .toLowerCase();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac)) {
        return null;
      }

      const hostname = String((item && item.hostname) || "").trim();
      const name = String((item && item.name) || "").trim();
      const ip = String((item && item.ip) || "").trim();
      const interfaceDescription =
        String((item && item.interface && item.interface.description) || "").trim() ||
        String((item && item.interface && item.interface.name) || "").trim() ||
        String((item && item.interface && item.interface.id) || "").trim();

      return {
        mac,
        ip,
        hostname,
        name,
        displayName: name || hostname || ip || mac,
        active: Boolean(item && item.active),
        link: String((item && item.link) || "").trim(),
        interfaceDescription,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName, "ru");
    });
}

function normalizeClientPolicyList(payload) {
  const rawPolicies =
    Array.isArray(payload && payload.policies) ? payload.policies : Array.isArray(payload) ? payload : [];

  return rawPolicies
    .map((item) => {
      const id = String((item && item.id) || "").trim();
      if (!id) {
        return null;
      }
      return {
        id,
        description: String((item && item.description) || "").trim(),
        proxyId: normalizeRouterProxyId(item && item.proxyId),
        managed: Boolean(item && item.managed),
      };
    })
    .filter(Boolean);
}

function normalizeClientAssignments(payload) {
  const rawAssignments =
    Array.isArray(payload && payload.assignments)
      ? payload.assignments
      : Array.isArray(payload)
        ? payload
        : [];

  return rawAssignments
    .map((item) => {
      const mac = String((item && item.mac) || "")
        .trim()
        .toLowerCase();
      const policyId = String((item && item.policyId) || "").trim();
      if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || !policyId) {
        return null;
      }
      return { mac, policyId };
    })
    .filter(Boolean);
}

function runEngineAction(engine, action) {
  const endpoint =
    engine === "singbox" ? "/cgi-bin/singbox-service.cgi" : "/cgi-bin/xray-service.cgi";
  return fetchJson(endpoint + "?action=" + encodeURIComponent(action), {
    method: "POST",
    cache: "no-store",
  });
}

function hasExpectedLayout() {
  return Boolean(
    $("summaryGrid") &&
      $("profilesTableBody") &&
      $("dnsRoutesTableBody") &&
      $("selectedOverview") &&
      $("profileModal") &&
      $("openCreateBtn") &&
      $("profileNameInput") &&
      $("profileRouterBadge") &&
      $("profileRouterProxyId") &&
      $("profileDnsRules") &&
      $("modalTitle") &&
      $("modalSubtitle") &&
      $("selectedPingDetails") &&
      $("selectedProfileJsonPreview") &&
      $("generatedConfigPreview")
  );
}

function refreshLayoutFromServer() {
  return fetch("/profiles.html?v=" + UI_VERSION, { cache: "reload" })
    .then((response) => response.text())
    .then((html) => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const nextMain = doc.querySelector("main.page");
      const nextModal = doc.querySelector("#profileModal");
      const currentMain = document.querySelector("main.page");
      const currentModal = document.querySelector("#profileModal");
      if (!nextMain || !currentMain) {
        throw new Error("Не удалось обновить разметку страницы.");
      }
      currentMain.replaceWith(nextMain);
      if (nextModal) {
        if (currentModal) {
          currentModal.replaceWith(nextModal);
        } else {
          document.body.appendChild(nextModal);
        }
      }
    });
}

function decodeBase64Url(value) {
  let normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4) {
    normalized += "=";
  }
  return atob(normalized);
}

function splitHostAndPort(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  const queryIndex = input.indexOf("?");
  const clean = queryIndex >= 0 ? input.slice(0, queryIndex) : input;
  const splitAt = clean.lastIndexOf(":");
  if (splitAt === -1) {
    return { host: clean, port: 0 };
  }
  return {
    host: clean.slice(0, splitAt),
    port: Number(clean.slice(splitAt + 1) || 0),
  };
}

function makeId() {
  return "profile-" + Math.random().toString(36).slice(2, 10);
}

function defaultServer() {
  return {
    address: "",
    port: 0,
    method: "",
    password: "",
    user: "",
    pass: "",
    id: "",
    flow: "",
    alterId: 0,
    vmessSecurity: "auto",
  };
}

function defaultTransport() {
  return {
    network: "tcp",
    security: "none",
    serverName: "",
    fingerprint: "",
    alpn: [],
    host: "",
    path: "/",
    userAgent: "",
    allowInsecure: false,
    realityPublicKey: "",
    realityShortId: "",
    realitySpiderX: "",
  };
}

function normalizeProfile(profile) {
  const next = clone(profile && typeof profile === "object" ? profile : {});
  next.id = cleanProfileId(next.id) || makeId();
  next.enabled = next.enabled !== false;
  next.engine = normalizeProfileEngine(next.engine);
  next.protocol = next.protocol || "shadowsocks";
  next.routerProxyId = normalizeRouterProxyId(next.routerProxyId);
  next.dnsRules = normalizeDnsRuleList(next.dnsRules);
  next.localPort = toNumber(next.localPort);
  next.server = Object.assign(defaultServer(), next.server || {});
  next.server.port = toNumber(next.server.port);
  next.transport = Object.assign(defaultTransport(), next.transport || {});
  next.transport.alpn = Array.isArray(next.transport.alpn)
    ? next.transport.alpn.filter(Boolean)
    : String(next.transport.alpn || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!next.transport.path) {
    next.transport.path = "/";
  }

  const rawName = String(next.name || "").trim();
  next.name =
    !rawName || isSystemLikeProfileName(rawName, next.id, next.protocol, next.engine)
      ? systemProfileName(next)
      : rawName;

  return next;
}

function stripDnsRulesFromProfilesDoc(doc) {
  const next = normalizeProfilesDoc(doc);
  for (const profile of next.profiles) {
    profile.dnsRules = [];
  }
  return next;
}

function normalizeProfilesDoc(doc) {
  const next = clone(doc && typeof doc === "object" ? doc : {});
  next.version = 1;
  next.profiles = Array.isArray(next.profiles) ? next.profiles.map(normalizeProfile) : [];
  return next;
}

function createEmptyProfile(protocol, engine) {
  const id = suggestProfileId(protocol);
  return normalizeProfile({
    id,
    name: systemProfileName(id, protocol || "shadowsocks", engine || "xray"),
    enabled: true,
    engine: engine || "xray",
    protocol: protocol || "shadowsocks",
    dnsRules: [],
    localPort: 0,
    server: defaultServer(),
    transport: defaultTransport(),
  });
}

function getProfiles() {
  return normalizeProfilesDoc(state.profilesDoc).profiles;
}

function hasEnabledProfileForEngine(engineId) {
  const usedProxyIds = new Set();
  for (const route of getDnsRoutes()) {
    const proxyId = normalizeRouterProxyId(route.proxyId);
    if (proxyId) {
      usedProxyIds.add(proxyId);
    }
  }
  const policyMap = getClientPolicyMap();
  for (const assignment of getClientAssignments()) {
    const policy = policyMap.get(assignment.policyId);
    const proxyId = normalizeRouterProxyId(policy && policy.proxyId);
    if (proxyId) {
      usedProxyIds.add(proxyId);
    }
  }

  return getProfiles().some((profile) => {
    if (!(profile && profile.enabled && Number(profile.localPort || 0) > 0 && profile.engine === engineId)) {
      return false;
    }
    const proxyId = normalizeRouterProxyId(profile.routerProxyId);
    if (!usedProxyIds.size) {
      return true;
    }
    return Boolean(proxyId && usedProxyIds.has(proxyId));
  });
}

function getDnsRoutes() {
  return normalizeDnsRoutes(state.dnsRoutes);
}

function getClientHosts() {
  return normalizeClientHosts(state.clientHosts);
}

function getClientPolicyList() {
  return normalizeClientPolicyList(state.clientPolicies);
}

function getClientAssignments() {
  return normalizeClientAssignments(state.clientAssignments);
}

function getClientPolicyMap() {
  return new Map(getClientPolicyList().map((policy) => [policy.id, policy]));
}

function getClientAssignmentMap() {
  return new Map(getClientAssignments().map((assignment) => [assignment.mac, assignment.policyId]));
}

function setLocalDnsRouteTarget(groupId, target) {
  const normalizedGroupId = normalizeDnsRuleId(groupId);
  const normalizedTarget = normalizeDnsRouteTarget(target);
  state.dnsRoutes = normalizeDnsRoutes(
    getDnsRoutes().map((route) =>
      route.groupId === normalizedGroupId
        ? {
            groupId: route.groupId,
            description: route.description,
            proxyId: normalizedTarget,
          }
        : route
    )
  );
  state.profilesDoc = mergeDnsRulesFromRoutes(state.profilesDoc, state.dnsRoutes);
}

function mergeDnsRulesFromRoutes(doc, routes) {
  const next = normalizeProfilesDoc(doc);
  const routeList = normalizeDnsRoutes(routes);

  for (const profile of next.profiles) {
    profile.dnsRules = [];
  }

  for (const route of routeList) {
    if (!route.proxyId) {
      continue;
    }
    const owner = next.profiles.find((profile) => normalizeRouterProxyId(profile.routerProxyId) === route.proxyId);
    if (owner) {
      owner.dnsRules = normalizeDnsRuleList(owner.dnsRules.concat(route.groupId));
    }
  }

  return normalizeProfilesDoc(next);
}

function findProfileByRouterProxyId(profiles, proxyId) {
  const normalizedProxyId = normalizeRouterProxyId(proxyId);
  if (!normalizedProxyId) {
    return null;
  }
  return (
    normalizeProfilesDoc({ version: 1, profiles }).profiles.find(
      (profile) => normalizeRouterProxyId(profile.routerProxyId) === normalizedProxyId
    ) || null
  );
}

function mergeProfilesFromRouterProxies(doc, routerProxies, options) {
  const opts = options || {};
  const preferRouterState = Boolean(opts.preferRouterState);
  const next = normalizeProfilesDoc(doc);
  const proxies = normalizeRouterProxyList(routerProxies);

  for (const profile of next.profiles) {
    const directMatch = proxies.find(
      (item) => item.proxyId === normalizeRouterProxyId(profile.routerProxyId)
    );
    const nameMatch =
      directMatch ||
      proxies.find((item) => item.name && profile.name && item.name === profile.name);
    const portMatches = profile.localPort
      ? proxies.filter((item) => item.port === profile.localPort)
      : [];
    const uniquePortMatch = portMatches.length === 1 ? portMatches[0] : null;
    const fallbackMatch = directMatch || nameMatch || uniquePortMatch;

    if (!fallbackMatch) {
      continue;
    }

    profile.routerProxyId = fallbackMatch.proxyId;

    if (preferRouterState) {
      profile.enabled = Boolean(fallbackMatch.enabled);
      if (fallbackMatch.port) {
        profile.localPort = fallbackMatch.port;
      }
      if (fallbackMatch.name) {
        profile.name = fallbackMatch.name;
      }
    } else if (!profile.localPort && fallbackMatch.port) {
      profile.localPort = fallbackMatch.port;
    }
  }

  return normalizeProfilesDoc(next);
}

function buildDnsAssignmentsFromProfiles(profiles, options) {
  const opts = options || {};
  const includeDisabled = opts.includeDisabled !== false;
  const map = new Map();

  for (const profile of normalizeProfilesDoc({ version: 1, profiles }).profiles) {
    if (!includeDisabled && !profile.enabled) {
      continue;
    }
    for (const groupId of profile.dnsRules) {
      if (!map.has(groupId)) {
        map.set(groupId, {
          profile,
          proxyId: normalizeRouterProxyId(profile.routerProxyId),
          enabled: Boolean(profile.enabled),
        });
      }
    }
  }

  return map;
}

function buildDnsAssignmentsFromRoutes(routes, profiles) {
  const map = new Map();
  const normalizedProfiles = normalizeProfilesDoc({ version: 1, profiles }).profiles;

  for (const route of normalizeDnsRoutes(routes)) {
    const proxyId = normalizeRouterProxyId(route.proxyId);
    if (!proxyId) {
      continue;
    }
    const profile = findProfileByRouterProxyId(normalizedProfiles, proxyId);
    if (!profile || map.has(route.groupId)) {
      continue;
    }
    map.set(route.groupId, {
      profile,
      proxyId,
      enabled: Boolean(profile.enabled),
    });
  }

  return map;
}

function getCurrentDnsAssignments() {
  const profiles = getProfiles();
  if (state.dnsRoutesLoading || state.dnsRoutesError || !getDnsRoutes().length) {
    return buildDnsAssignmentsFromProfiles(profiles, { includeDisabled: true });
  }
  return buildDnsAssignmentsFromRoutes(getDnsRoutes(), profiles);
}

function getEffectiveDnsRulesForProfile(profile) {
  if (!profile) {
    return [];
  }
  if (state.dnsRoutesLoading || state.dnsRoutesError || !getDnsRoutes().length) {
    return normalizeDnsRuleList(profile.dnsRules);
  }
  return getDnsRoutes()
    .filter((route) => normalizeRouterProxyId(route.proxyId) === normalizeRouterProxyId(profile.routerProxyId))
    .map((route) => route.groupId)
    .sort((left, right) => dnsRuleOrder(left) - dnsRuleOrder(right));
}

function applyExclusiveDnsRules(doc, preferredProfileId) {
  const next = normalizeProfilesDoc(doc);
  const preferred = next.profiles.find((profile) => profile.id === preferredProfileId) || null;
  const preferredRules = new Set(preferred ? preferred.dnsRules : []);

  if (preferred && preferredRules.size) {
    for (const profile of next.profiles) {
      if (profile.id === preferred.id) {
        continue;
      }
      profile.dnsRules = profile.dnsRules.filter((groupId) => !preferredRules.has(groupId));
    }
  }

  const orderedProfiles = preferred
    ? [preferred].concat(next.profiles.filter((profile) => profile.id !== preferred.id))
    : next.profiles.slice();
  const seen = new Set();

  for (const profile of orderedProfiles) {
    profile.dnsRules = profile.dnsRules.filter((groupId) => {
      if (seen.has(groupId)) {
        return false;
      }
      seen.add(groupId);
      return true;
    });
  }

  return normalizeProfilesDoc(next);
}

function getSelectedProfile() {
  return getProfiles().find((profile) => profile.id === state.selectedId) || null;
}

function selectProfile(profileId) {
  if (!profileId) {
    return;
  }
  if (state.selectedId === profileId) {
    return;
  }
  state.selectedId = profileId;
  renderAll();
}

function ensureSelection() {
  const profiles = getProfiles();
  if (!profiles.length) {
    state.selectedId = null;
    return;
  }
  if (!state.selectedId || !profiles.some((profile) => profile.id === state.selectedId)) {
    state.selectedId = profiles[0].id;
  }
}

function nextFreePort(skipId) {
  const usedPorts = new Set(
    getProfiles()
      .filter((profile) => profile.id !== skipId && profile.enabled)
      .map((profile) => toNumber(profile.localPort))
      .filter(Boolean)
  );

  let candidate = 2086;
  while (usedPorts.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function isLocalPortUsedByActiveProfile(port, skipId) {
  const normalizedPort = toNumber(port);
  if (!normalizedPort) {
    return false;
  }
  return getProfiles().some(
    (profile) => profile.id !== skipId && profile.enabled && toNumber(profile.localPort) === normalizedPort
  );
}

function ensureFreePortForEnabledProfile(profile) {
  const next = normalizeProfile(profile);
  if (!next.enabled) {
    return next;
  }
  if (!next.localPort || isLocalPortUsedByActiveProfile(next.localPort, next.id)) {
    next.localPort = nextFreePort(next.id);
  }
  return next;
}

function assignMissingPorts(doc) {
  const next = normalizeProfilesDoc(doc);
  const used = new Set(
    next.profiles
      .filter((profile) => profile.enabled)
      .map((profile) => toNumber(profile.localPort))
      .filter(Boolean)
  );

  for (const profile of next.profiles) {
    if (!profile.enabled || profile.localPort) {
      continue;
    }
    let candidate = 2086;
    while (used.has(candidate)) {
      candidate += 1;
    }
    profile.localPort = candidate;
    used.add(candidate);
  }

  return next;
}

function applyRouterFixes(profile) {
  const next = normalizeProfile(profile);
  if (next.protocol !== "trojan") {
    return next;
  }
  if (next.transport.network !== "ws" || next.transport.security !== "tls") {
    return next;
  }
  if (!next.transport.fingerprint) {
    next.transport.fingerprint = "chrome";
  }
  if (!next.transport.alpn.length) {
    next.transport.alpn = ["http/1.1"];
  }
  if (!next.transport.userAgent) {
    next.transport.userAgent = BROWSER_UA;
  }
  return next;
}

function parseShadowsocksLink(link) {
  const id = suggestProfileId("shadowsocks");
  const withoutPrefix = link.replace(/^ss:\/\//, "");
  const parts = withoutPrefix.split("#");
  const mainPart = parts[0].replace(/\?+$/, "");
  let userInfo = "";
  let hostPart = "";

  if (mainPart.includes("@")) {
    const chunks = mainPart.split("@");
    userInfo = chunks[0];
    hostPart = chunks.slice(1).join("@");
    try {
      userInfo = decodeBase64Url(userInfo);
    } catch (error) {
      // Keep plain form.
    }
  } else {
    const decoded = decodeBase64Url(mainPart);
    const splitAt = decoded.lastIndexOf("@");
    userInfo = decoded.slice(0, splitAt);
    hostPart = decoded.slice(splitAt + 1);
  }

  const methodPassword = userInfo.split(":");
  const hostPort = splitHostAndPort(hostPart);

  return normalizeProfile({
    id,
    name: systemProfileName(id, "shadowsocks"),
    enabled: true,
    engine: "xray",
    protocol: "shadowsocks",
    server: {
      address: hostPort.host || "",
      port: hostPort.port || 0,
      method: methodPassword[0] || "",
      password: methodPassword.slice(1).join(":"),
    },
    transport: defaultTransport(),
  });
}

function parseTrojanLink(link) {
  const id = suggestProfileId("trojan");
  const url = new URL(link);
  const params = url.searchParams;
  return applyRouterFixes({
    id,
    name: systemProfileName(id, "trojan"),
    enabled: true,
    engine: "xray",
    protocol: "trojan",
    server: {
      address: url.hostname,
      port: Number(url.port || "443"),
      password: decodeURIComponent(url.username),
    },
    transport: {
      network: params.get("type") || "tcp",
      security: params.get("security") || "tls",
      serverName: params.get("sni") || url.hostname,
      fingerprint: "",
      alpn: [],
      host: params.get("host") || url.hostname,
      path: params.get("path") || "/",
      userAgent: "",
      allowInsecure: false,
    },
  });
}

function parseSocksLink(link) {
  const id = suggestProfileId("socks");
  const url = new URL(link);
  return normalizeProfile({
    id,
    name: systemProfileName(id, "socks"),
    enabled: true,
    engine: "xray",
    protocol: "socks",
    server: {
      address: url.hostname,
      port: Number(url.port || "1080"),
      user: decodeURIComponent(url.username || ""),
      pass: decodeURIComponent(url.password || ""),
    },
    transport: defaultTransport(),
  });
}

function parseVlessLink(link) {
  const id = suggestProfileId("vless");
  const url = new URL(link);
  const params = url.searchParams;
  return normalizeProfile({
    id,
    name: systemProfileName(id, "vless"),
    enabled: true,
    engine: "xray",
    protocol: "vless",
    server: {
      address: url.hostname,
      port: Number(url.port || "443"),
      id: decodeURIComponent(url.username || ""),
      flow: params.get("flow") || "",
    },
    transport: {
      network: params.get("type") || "tcp",
      security: params.get("security") || "none",
      serverName: params.get("sni") || url.hostname,
      fingerprint: params.get("fp") || "",
      alpn: [],
      host: params.get("host") || url.hostname,
      path: params.get("path") || "/",
      userAgent: "",
      allowInsecure: false,
      realityPublicKey: params.get("pbk") || "",
      realityShortId: params.get("sid") || "",
      realitySpiderX: params.get("spx") || params.get("spiderX") || "",
    },
  });
}

function parseVmessLink(link) {
  const id = suggestProfileId("vmess");
  const source = JSON.parse(decodeBase64Url(link.replace(/^vmess:\/\//, "")));
  const alpn = String(source.alpn || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalizeProfile({
    id,
    name: systemProfileName(id, "vmess"),
    enabled: true,
    engine: "xray",
    protocol: "vmess",
    server: {
      address: source.add || "",
      port: Number(source.port || 0),
      id: source.id || "",
      alterId: Number(source.aid || 0),
      vmessSecurity: source.scy || "auto",
    },
    transport: {
      network: source.net || "tcp",
      security: source.tls ? "tls" : "none",
      serverName: source.sni || source.host || source.add || "",
      fingerprint: source.fp || "",
      alpn,
      host: source.host || "",
      path: source.path || "/",
      userAgent: "",
      allowInsecure: false,
    },
  });
}

function parseLinkToProfile(link) {
  const trimmed = String(link || "").trim();
  if (!trimmed) {
    throw new Error("Сначала вставь ключ.");
  }
  if (trimmed.startsWith("ss://")) return parseShadowsocksLink(trimmed);
  if (trimmed.startsWith("trojan://")) return parseTrojanLink(trimmed);
  if (trimmed.startsWith("vless://")) return parseVlessLink(trimmed);
  if (trimmed.startsWith("vmess://")) return parseVmessLink(trimmed);
  if (trimmed.startsWith("socks://")) return parseSocksLink(trimmed);
  throw new Error("Этот тип ссылки пока не поддержан.");
}

function transportFromStreamSettings(streamSettings) {
  const stream = streamSettings || {};
  const tlsSettings = stream.tlsSettings || {};
  const realitySettings = stream.realitySettings || {};
  const wsSettings = stream.wsSettings || {};
  const headers = wsSettings.headers || {};
  return {
    network: stream.network || "tcp",
    security: stream.security || "none",
    serverName: realitySettings.serverName || tlsSettings.serverName || "",
    fingerprint: realitySettings.fingerprint || tlsSettings.fingerprint || "",
    alpn: Array.isArray(tlsSettings.alpn) ? tlsSettings.alpn : [],
    host: wsSettings.host || "",
    path: wsSettings.path || "/",
    userAgent: headers["User-Agent"] || "",
    allowInsecure: Boolean(tlsSettings.allowInsecure),
    realityPublicKey: realitySettings.publicKey || "",
    realityShortId: realitySettings.shortId || "",
    realitySpiderX: realitySettings.spiderX || "",
  };
}

function profileFromConfigParts(inbound, outbound) {
  const protocol = String((outbound || {}).protocol || "").toLowerCase();
  const next = createEmptyProfile(protocol || "shadowsocks");
  next.id = cleanProfileId((inbound || {}).tag || (outbound || {}).tag) || next.id;
  next.name = systemProfileName(next);
  next.protocol = protocol || next.protocol;
  next.localPort = toNumber((inbound || {}).port || (inbound || {}).listen_port);

  if (protocol === "shadowsocks") {
    const server = ((((outbound || {}).settings || {}).servers || [])[0] || {});
    next.server.address = server.address || "";
    next.server.port = toNumber(server.port);
    next.server.method = server.method || "";
    next.server.password = server.password || "";
  } else if (protocol === "trojan") {
    const server = ((((outbound || {}).settings || {}).servers || [])[0] || {});
    next.server.address = server.address || "";
    next.server.port = toNumber(server.port);
    next.server.password = server.password || "";
    next.transport = transportFromStreamSettings(outbound.streamSettings);
  } else if (protocol === "socks") {
    const server = ((((outbound || {}).settings || {}).servers || [])[0] || {});
    const user = ((server.users || [])[0] || {});
    next.server.address = server.address || "";
    next.server.port = toNumber(server.port);
    next.server.user = user.user || "";
    next.server.pass = user.pass || "";
  } else if (protocol === "vless" || protocol === "vmess") {
    const server = ((((outbound || {}).settings || {}).vnext || [])[0] || {});
    const user = ((server.users || [])[0] || {});
    next.server.address = server.address || "";
    next.server.port = toNumber(server.port);
    next.server.id = user.id || "";
    next.server.flow = user.flow || "";
    next.server.alterId = toNumber(user.alterId);
    next.server.vmessSecurity = user.security || "auto";
    next.transport = transportFromStreamSettings(outbound.streamSettings);
  }

  return normalizeProfile(next);
}

function migrateProfilesFromConfig(config) {
  const inbounds = Array.isArray((config || {}).inbounds) ? config.inbounds : [];
  const outbounds = Array.isArray((config || {}).outbounds) ? config.outbounds : [];
  const rules = Array.isArray(((config || {}).routing || {}).rules) ? config.routing.rules : [];
  const routeByInboundTag = new Map();

  for (const rule of rules) {
    if (!rule || rule.type !== "field" || !Array.isArray(rule.inboundTag) || !rule.outboundTag) {
      continue;
    }
    for (const inboundTag of rule.inboundTag) {
      routeByInboundTag.set(inboundTag, rule.outboundTag);
    }
  }

  const migrated = [];
  for (const inbound of inbounds) {
    if (!inbound || (inbound.protocol !== "socks" && inbound.protocol !== "mixed")) {
      continue;
    }
    if (inboundListenAddress(inbound) === LOCAL_SOCKS_INTERNAL_BIND) {
      continue;
    }
    const outboundTag = routeByInboundTag.get(inbound.tag);
    const outbound = outbounds.find((item) => item && item.tag === outboundTag);
    if (!outbound) {
      const profile = createEmptyProfile("shadowsocks");
      profile.id = cleanProfileId(inbound.tag) || profile.id;
      profile.name = systemProfileName(profile);
      profile.localPort = toNumber(inbound.port);
      migrated.push(profile);
      continue;
    }
    if (SYSTEM_OUTBOUND_TAGS.has(outbound.tag) || SYSTEM_OUTBOUND_PROTOCOLS.has(outbound.protocol)) {
      continue;
    }
    migrated.push(profileFromConfigParts(inbound, outbound));
  }

  migrated.sort((left, right) => left.localPort - right.localPort);
  return { version: 1, profiles: migrated };
}

function buildWsTlsSafeOutbound(outbound) {
  const next = clone(outbound);
  const stream = next.streamSettings;
  if (!stream || stream.network !== "ws" || stream.security !== "tls") {
    return next;
  }

  stream.tlsSettings = stream.tlsSettings || {};
  if (!stream.tlsSettings.fingerprint) {
    stream.tlsSettings.fingerprint = "chrome";
  }
  if (!Array.isArray(stream.tlsSettings.alpn) || !stream.tlsSettings.alpn.length) {
    stream.tlsSettings.alpn = ["http/1.1"];
  }

  stream.wsSettings = stream.wsSettings || {};
  stream.wsSettings.headers = stream.wsSettings.headers || {};
  if (!stream.wsSettings.headers["User-Agent"]) {
    stream.wsSettings.headers["User-Agent"] = BROWSER_UA;
  }

  return next;
}

function buildOutboundForProfile(profile) {
  const next = normalizeProfile(profile);
  const tag = "out-" + next.id;

  if (next.protocol === "shadowsocks") {
    return {
      protocol: "shadowsocks",
      tag,
      settings: {
        servers: [
          {
            address: next.server.address,
            port: next.server.port,
            method: next.server.method,
            password: next.server.password,
          },
        ],
      },
    };
  }

  if (next.protocol === "trojan") {
    const outbound = {
      protocol: "trojan",
      tag,
      settings: {
        servers: [
          {
            address: next.server.address,
            port: next.server.port,
            password: next.server.password,
          },
        ],
      },
      mux: {
        enabled: false,
        concurrency: -1,
      },
    };

    if (next.transport.network !== "tcp" || next.transport.security !== "none") {
      outbound.streamSettings = {
        network: next.transport.network,
        security: next.transport.security,
      };
    }

    if (next.transport.security === "tls") {
      outbound.streamSettings = outbound.streamSettings || {
        network: next.transport.network,
        security: next.transport.security,
      };
      outbound.streamSettings.tlsSettings = {
        serverName: next.transport.serverName,
        allowInsecure: Boolean(next.transport.allowInsecure),
      };
      if (next.transport.fingerprint) {
        outbound.streamSettings.tlsSettings.fingerprint = next.transport.fingerprint;
      }
      if (next.transport.alpn.length) {
        outbound.streamSettings.tlsSettings.alpn = next.transport.alpn;
      }
    }

    if (next.transport.network === "ws") {
      outbound.streamSettings = outbound.streamSettings || {
        network: next.transport.network,
        security: next.transport.security,
      };
      outbound.streamSettings.wsSettings = {
        host: next.transport.host,
        path: next.transport.path || "/",
        headers: {},
      };
      if (next.transport.userAgent) {
        outbound.streamSettings.wsSettings.headers["User-Agent"] = next.transport.userAgent;
      }
    }

    return buildWsTlsSafeOutbound(outbound);
  }

  if (next.protocol === "socks") {
    return {
      protocol: "socks",
      tag,
      settings: {
        servers: [
          {
            address: next.server.address,
            port: next.server.port,
            users: next.server.user
              ? [
                  {
                    user: next.server.user,
                    pass: next.server.pass,
                  },
                ]
              : [],
          },
        ],
      },
    };
  }

  if (next.protocol === "vless" || next.protocol === "vmess") {
    const user =
      next.protocol === "vless"
        ? {
            id: next.server.id,
            encryption: "none",
            flow: next.server.flow || undefined,
          }
        : {
            id: next.server.id,
            alterId: toNumber(next.server.alterId),
            security: next.server.vmessSecurity || "auto",
            flow: next.server.flow || undefined,
          };

    const outbound = {
      protocol: next.protocol,
      tag,
      settings: {
        vnext: [
          {
            address: next.server.address,
            port: next.server.port,
            users: [Object.fromEntries(Object.entries(user).filter((entry) => entry[1] !== undefined && entry[1] !== ""))],
          },
        ],
      },
      streamSettings: {
        network: next.transport.network,
        security: next.transport.security,
      },
    };

    if (next.transport.security === "tls") {
      outbound.streamSettings.tlsSettings = {
        serverName: next.transport.serverName,
        allowInsecure: Boolean(next.transport.allowInsecure),
      };
    } else if (next.transport.security === "reality") {
      outbound.streamSettings.realitySettings = {
        show: false,
        serverName: next.transport.serverName,
        fingerprint: next.transport.fingerprint || "chrome",
        publicKey: next.transport.realityPublicKey,
        shortId: next.transport.realityShortId || "",
        spiderX: next.transport.realitySpiderX || "",
      };
    }

    if (next.transport.network === "ws") {
      outbound.streamSettings.wsSettings = {
        host: next.transport.host,
        path: next.transport.path || "/",
        headers: {},
      };
    }

    return buildWsTlsSafeOutbound(outbound);
  }

  throw new Error("Неизвестный протокол профиля: " + next.protocol);
}

function buildXrayConfigFromProfiles(doc) {
  const prepared = assignMissingPorts(doc);
  const activeProfiles = prepared.profiles.filter((profile) => profile.enabled && isXrayEngine(profile.engine));
  const portOwner = new Map();

  for (const profile of activeProfiles) {
    if (!profile.localPort) {
      throw new Error('У профиля "' + profile.name + '" не указан локальный socks-порт.');
    }
    if (portOwner.has(profile.localPort)) {
      throw new Error(
        "Локальный порт :" +
          profile.localPort +
          ' используется сразу профилями "' +
          portOwner.get(profile.localPort) +
          '" и "' +
          profile.name +
          '".'
      );
    }
    portOwner.set(profile.localPort, profile.name);
  }

  const inbounds = [];
  const outbounds = [];
  const rules = [];

  for (const profile of activeProfiles.slice().sort((left, right) => left.localPort - right.localPort)) {
    const publicInboundTag = "in-" + profile.id;
    const internalInboundTag = "in-loop-" + profile.id;
    inbounds.push({
      protocol: "socks",
      listen: LOCAL_SOCKS_PUBLIC_BIND,
      port: profile.localPort,
      tag: publicInboundTag,
      settings: {
        auth: "noauth",
        udp: true,
      },
    });
    inbounds.push({
      protocol: "socks",
      listen: LOCAL_SOCKS_INTERNAL_BIND,
      port: profile.localPort,
      tag: internalInboundTag,
      settings: {
        auth: "noauth",
        udp: true,
      },
    });
    outbounds.push(buildOutboundForProfile(profile));
    rules.push({
      type: "field",
      inboundTag: [publicInboundTag, internalInboundTag],
      outboundTag: "out-" + profile.id,
    });
  }

  outbounds.push({ protocol: "freedom", tag: "direct" });
  outbounds.push({ protocol: "blackhole", tag: "blocked" });

  return {
    log: {
      loglevel: "warning",
    },
    inbounds,
    outbounds,
    routing: {
      rules,
    },
  };
}

function buildSingboxTls(profile) {
  const next = normalizeProfile(profile);
  if (next.transport.security === "none") {
    return null;
  }

  const tls = {
    enabled: true,
  };

  if (next.transport.serverName) {
    tls.server_name = next.transport.serverName;
  }
  if (next.transport.allowInsecure) {
    tls.insecure = true;
  }

  const fingerprint = next.transport.fingerprint || (next.transport.security === "reality" ? "chrome" : "");
  if (fingerprint) {
    tls.utls = {
      enabled: true,
      fingerprint,
    };
  }
  if (next.transport.alpn.length) {
    tls.alpn = next.transport.alpn;
  }
  if (next.transport.security === "reality") {
    tls.reality = {
      enabled: true,
      public_key: next.transport.realityPublicKey,
      short_id: next.transport.realityShortId || "",
    };
  }

  return tls;
}

function buildSingboxTransport(profile) {
  const next = normalizeProfile(profile);
  if (next.transport.network !== "ws") {
    return null;
  }

  const transport = {
    type: "ws",
    path: next.transport.path || "/",
  };
  const headers = {};

  if (next.transport.host) {
    headers.Host = next.transport.host;
  }
  if (next.transport.userAgent) {
    headers["User-Agent"] = next.transport.userAgent;
  }
  if (Object.keys(headers).length) {
    transport.headers = headers;
  }

  return transport;
}

function buildSingboxOutboundForProfile(profile) {
  const next = normalizeProfile(profile);
  const tag = "out-" + next.id;

  if (next.protocol === "shadowsocks") {
    return {
      type: "shadowsocks",
      tag,
      server: next.server.address,
      server_port: next.server.port,
      method: next.server.method,
      password: next.server.password,
    };
  }

  if (next.protocol === "trojan") {
    const outbound = {
      type: "trojan",
      tag,
      server: next.server.address,
      server_port: next.server.port,
      password: next.server.password,
    };
    const tls = buildSingboxTls(next);
    const transport = buildSingboxTransport(next);
    if (tls) {
      outbound.tls = tls;
    }
    if (transport) {
      outbound.transport = transport;
    }
    return outbound;
  }

  if (next.protocol === "socks") {
    const outbound = {
      type: "socks",
      tag,
      server: next.server.address,
      server_port: next.server.port,
      version: "5",
    };
    if (next.server.user) {
      outbound.username = next.server.user;
      outbound.password = next.server.pass || "";
    }
    return outbound;
  }

  if (next.protocol === "vless") {
    const outbound = {
      type: "vless",
      tag,
      server: next.server.address,
      server_port: next.server.port,
      uuid: next.server.id,
    };
    if (next.server.flow) {
      outbound.flow = next.server.flow;
    }
    const tls = buildSingboxTls(next);
    const transport = buildSingboxTransport(next);
    if (tls) {
      outbound.tls = tls;
    }
    if (transport) {
      outbound.transport = transport;
    }
    return outbound;
  }

  if (next.protocol === "vmess") {
    const outbound = {
      type: "vmess",
      tag,
      server: next.server.address,
      server_port: next.server.port,
      uuid: next.server.id,
      security: next.server.vmessSecurity || "auto",
      alter_id: toNumber(next.server.alterId),
    };
    const tls = buildSingboxTls(next);
    const transport = buildSingboxTransport(next);
    if (tls) {
      outbound.tls = tls;
    }
    if (transport) {
      outbound.transport = transport;
    }
    return outbound;
  }

  throw new Error("Неизвестный протокол профиля для sing-box: " + next.protocol);
}

function buildSingboxConfigFromProfiles(doc) {
  const prepared = assignMissingPorts(doc);
  const activeProfiles = prepared.profiles.filter((profile) => profile.enabled && isSingboxEngine(profile.engine));
  const portOwner = new Map();

  for (const profile of activeProfiles) {
    if (!profile.localPort) {
      throw new Error('У профиля "' + profile.name + '" не указан локальный socks-порт.');
    }
    if (portOwner.has(profile.localPort)) {
      throw new Error(
        "Локальный порт :" +
          profile.localPort +
          ' используется сразу профилями "' +
          portOwner.get(profile.localPort) +
          '" и "' +
          profile.name +
          '".'
      );
    }
    portOwner.set(profile.localPort, profile.name);
  }

  const inbounds = [];
  const outbounds = [];
  const rules = [];

  for (const profile of activeProfiles.slice().sort((left, right) => left.localPort - right.localPort)) {
    const publicInboundTag = "in-" + profile.id;
    const internalInboundTag = "in-loop-" + profile.id;
    inbounds.push({
      type: "socks",
      tag: publicInboundTag,
      listen: LOCAL_SOCKS_PUBLIC_BIND,
      listen_port: profile.localPort,
    });
    inbounds.push({
      type: "socks",
      tag: internalInboundTag,
      listen: LOCAL_SOCKS_INTERNAL_BIND,
      listen_port: profile.localPort,
    });
    outbounds.push(buildSingboxOutboundForProfile(profile));
    rules.push({
      inbound: [publicInboundTag],
      outbound: "out-" + profile.id,
    });
    rules.push({
      inbound: [internalInboundTag],
      outbound: "out-" + profile.id,
    });
  }

  outbounds.push({
    type: "direct",
    tag: "direct",
  });

  return {
    log: {
      level: "warn",
      timestamp: true,
    },
    inbounds,
    outbounds,
    route: {
      rules,
      final: "direct",
    },
  };
}

function buildEngineConfigsFromProfiles(doc) {
  const preparedProfiles = assignMissingPorts(doc);
  return {
    preparedProfiles,
    xrayConfig: buildXrayConfigFromProfiles(preparedProfiles),
    singboxConfig: buildSingboxConfigFromProfiles(preparedProfiles),
  };
}

function replaceProfile(nextProfile) {
  state.profilesDoc = normalizeProfilesDoc({
    version: 1,
    profiles: getProfiles().map((profile) => (profile.id === nextProfile.id ? normalizeProfile(nextProfile) : profile)),
  });
}

function pushProfile(profile) {
  state.profilesDoc = normalizeProfilesDoc({
    version: 1,
    profiles: getProfiles().concat(normalizeProfile(profile)),
  });
}

function renderProtocolGroups(protocol) {
  $("groupShadowsocks").hidden = protocol !== "shadowsocks";
  $("groupTrojan").hidden = protocol !== "trojan";
  $("groupSocks").hidden = protocol !== "socks";
  $("groupVx").hidden = protocol !== "vless" && protocol !== "vmess";
}

function removeProfileById(profileId) {
  state.profilesDoc = normalizeProfilesDoc({
    version: 1,
    profiles: getProfiles().filter((profile) => profile.id !== profileId),
  });
  delete state.egressResults[profileId];
  delete state.probeResults[profileId];
  ensureSelection();
}

function setManualPortEdit(enabled) {
  $("unlockPortEdit").checked = Boolean(enabled);
  $("localPort").disabled = !enabled;
}

function buildRouterSocksSummary(profile) {
  const portText = profile.localPort ? ":" + profile.localPort : "авто";
  return (
    "Менеджер создаст локальный socks " +
    portText +
    " для LAN на " +
    LOCAL_SOCKS_PUBLIC_BIND +
    " и отдельный внутренний loopback на " +
    LOCAL_SOCKS_INTERNAL_BIND +
    " с auth=noauth и UDP=on. Внутренний inbound будет привязан к " +
    profile.engine +
    " / " +
    protocolLabel(profile.protocol) +
    ". При сохранении есть проверка на дубликаты и ломающие значения."
  );
}

function buildDnsRulesSummary(profile) {
  const rules = getEffectiveDnsRulesForProfile(profile);
  const count = rules.length;
  if (!count) {
    return "Маршруты DNS не выбраны.";
  }
  const routeMap = new Map(getDnsRoutes().map((route) => [route.groupId, route]));
  return rules
    .map((groupId) => {
      const route = routeMap.get(groupId);
      return route ? displayDnsRouteDescription(route) : groupId;
    })
    .join(", ");
}

function setDnsRouteAssignment(groupId, profileId) {
  const normalizedGroupId = normalizeDnsRuleId(groupId);
  if (!normalizedGroupId) {
    throw new Error("Некорректный domain-list.");
  }

  const normalizedProfileId = String(profileId || "").trim();

  if (normalizedProfileId === DIRECT_DNS_SELECT_VALUE) {
    setLocalDnsRouteTarget(normalizedGroupId, DIRECT_DNS_ROUTE_TARGET);
  } else if (normalizedProfileId) {
    const target = getProfiles().find((profile) => profile.id === normalizedProfileId);
    if (!target) {
      throw new Error("Профиль для DNS-маршрута не найден.");
    }
    setLocalDnsRouteTarget(normalizedGroupId, normalizeRouterProxyId(target.routerProxyId));
  } else {
    setLocalDnsRouteTarget(normalizedGroupId, "");
  }

  renderAll();

  const route = getDnsRoutes().find((item) => item.groupId === normalizedGroupId);
  const routeName = route ? displayDnsRouteDescription(route) : normalizedGroupId;
  showBanner("ok", 'DNS-маршрут "' + routeName + '" изменён локально.');
}

function renderDnsBulkControls() {
  const select = $("dnsBulkProfileSelect");
  const button = $("dnsBulkApplyBtn");
  if (!select || !button) {
    return;
  }

  const previousValue = select.value;
  const profiles = getProfiles()
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  const assignedCount = getCurrentDnsAssignments().size;

  select.innerHTML =
    '<option value="">Выбери профиль</option>' +
    `<option value="${DIRECT_DNS_SELECT_VALUE}">Прямое подключение</option>` +
    profiles
      .map((profile) => {
        const suffix = profile.enabled ? "" : " [выкл]";
        return `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name + suffix)}</option>`;
      })
      .join("");

  if (previousValue === DIRECT_DNS_SELECT_VALUE || profiles.some((profile) => profile.id === previousValue)) {
    select.value = previousValue;
  }

  const disabled =
    state.dnsRoutesLoading ||
    Boolean(state.dnsRoutesError) ||
    !profiles.length ||
    assignedCount === 0;

  select.disabled = disabled;
  button.disabled = disabled || !String(select.value || "").trim();

  if (state.dnsRoutesLoading) {
    select.title = "Сначала дождись загрузки DNS-маршрутов.";
    button.title = "Сначала дождись загрузки DNS-маршрутов.";
    return;
  }

  if (state.dnsRoutesError) {
    select.title = "Пока не удалось прочитать DNS-маршруты с роутера.";
    button.title = "Пока не удалось прочитать DNS-маршруты с роутера.";
    return;
  }

  if (!assignedCount) {
    select.title = "Сейчас ни один DNS-маршрут не назначен.";
    button.title = "Сейчас ни один DNS-маршрут не назначен.";
    return;
  }

  select.title = "Выбери профиль или прямое подключение для массового переназначения уже выбранных DNS-маршрутов.";
  button.title = "Переназначить все уже выбранные DNS-маршруты на выбранный вариант.";
}

function bulkAssignAssignedDnsRoutes(profileId) {
  const normalizedTargetId = String(profileId || "").trim();
  if (!normalizedTargetId) {
    throw new Error("Сначала выбери профиль для массового назначения.");
  }

  const isDirect = normalizedTargetId === DIRECT_DNS_SELECT_VALUE;
  const target = isDirect ? null : getProfiles().find((profile) => profile.id === normalizedTargetId);
  if (!isDirect && !target) {
    throw new Error("Выбранный профиль не найден.");
  }

  const assignedRules = Array.from(getCurrentDnsAssignments().keys()).sort(
    (left, right) => dnsRuleOrder(left) - dnsRuleOrder(right)
  );

  if (!assignedRules.length) {
    showBanner("warn", "Сейчас нет ни одного назначенного DNS-маршрута для массовой замены.");
    return;
  }

  if (isDirect) {
    for (const groupId of assignedRules) {
      setLocalDnsRouteTarget(groupId, DIRECT_DNS_ROUTE_TARGET);
    }
  } else {
    for (const groupId of assignedRules) {
      setLocalDnsRouteTarget(groupId, normalizeRouterProxyId(target.routerProxyId));
    }
  }
  renderAll();
  showBanner(
    "ok",
    isDirect
      ? "Все уже назначенные DNS-маршруты локально переведены на прямое подключение."
      : 'Все уже назначенные DNS-маршруты (' +
          assignedRules.length +
          ') локально переназначены на профиль "' +
          target.name +
          '".'
  );
}

function resetEditorFields() {
  const defaults = {
    profileNameInput: "",
    profileRouterProxyId: "",
    profileEnabled: "true",
    profileEngine: "xray",
    profileProtocol: "shadowsocks",
    localPort: "",
    serverAddress: "",
    serverPort: "",
    ssMethod: "",
    ssPassword: "",
    trojanPassword: "",
    streamNetwork: "tcp",
    streamSecurity: "none",
    tlsServerName: "",
    tlsFingerprint: "",
    tlsAlpn: "",
    wsHost: "",
    wsPath: "/",
    wsUserAgent: "",
    tlsAllowInsecure: "false",
    socksUser: "",
    socksPass: "",
    vxId: "",
    vxSecurity: "none",
    vxNetwork: "tcp",
    vxServerName: "",
    vxFingerprint: "",
    vxFlow: "",
    vxWsHost: "",
    vxWsPath: "/",
    vxRealityPublicKey: "",
    vxRealityShortId: "",
    vxRealitySpiderX: "",
    replaceLinkInput: "",
    profileJson: "",
  };

  for (const [id, value] of Object.entries(defaults)) {
    setFieldValue(id, value);
  }
  if ($("profileRouterProxyId")) {
    $("profileRouterProxyId").setCustomValidity("");
  }
  setManualPortEdit(false);
  if ($("profileRouterBadge")) {
    $("profileRouterBadge").textContent = "авто";
  }
  if ($("modalMetaChips")) {
    $("modalMetaChips").innerHTML = "";
  }
  if ($("routerSocksStatic")) {
    $("routerSocksStatic").textContent = buildRouterSocksSummary(createEmptyProfile("shadowsocks"));
  }
  if ($("profileDnsRules")) {
    $("profileDnsRules").innerHTML = "";
  }
  if ($("selectedPingStatus")) {
    $("selectedPingStatus").innerHTML = '<span class="status-pill status-neutral">Не проверялся</span>';
  }
  if ($("selectedPingDetails")) {
    $("selectedPingDetails").textContent = "Пинг идёт прямо с роутера.";
  }
  renderProtocolGroups("shadowsocks");
}

function transportLabel(profile) {
  if (profile.protocol === "shadowsocks" || profile.protocol === "socks") {
    return "-";
  }
  return profile.transport.network || "tcp";
}

function securityLabel(profile) {
  if (profile.protocol === "shadowsocks" || profile.protocol === "socks") {
    return "-";
  }
  if (profile.protocol === "vless" && profile.transport.security === "reality") {
    return "reality";
  }
  if (profile.server.flow) {
    return profile.server.flow;
  }
  return profile.transport.security || "-";
}

function probeSummary(profile) {
  const probe = state.probeResults[profile.id];
  if (!probe) {
    return '<span class="delay-neutral">-</span>';
  }
  if (probe.kind === "pending") {
    return '<span class="delay-neutral">...</span>';
  }
  if (Number.isFinite(probe.avgMs)) {
    return `<span class="${delayClass(probe.avgMs)}">${Math.round(probe.avgMs)}</span>`;
  }
  return `<span class="${probe.kind === "ok" ? "delay-good" : "delay-bad"}">${escapeHtml(probe.text)}</span>`;
}

function enabledPill(profile) {
  return profile.enabled
    ? '<span class="status-pill status-ok tiny-status">Включён</span>'
    : '<span class="status-pill status-neutral tiny-status">Выключен</span>';
}

function renderSummary() {
  if (!$("summaryGrid")) {
    return;
  }
  const status = state.status || {};
  const profiles = getProfiles();
  const activeProfiles = profiles.filter((profile) => profile.enabled);
  const xrayInstalled = Boolean(status.xrayInstalled);
  const xrayRunning = Boolean(status.xrayRunning);
  const singboxInstalled = Boolean(status.singboxInstalled);
  const singboxRunning = Boolean(status.singboxRunning);
  const singboxService = Boolean(status.singboxService);
  const actionBusy = Boolean(
    state.saveInFlight ||
      state.dnsRefreshInFlight ||
      state.vpnRefreshInFlight ||
      state.clientPolicyBusyMac
  );
  const xrayDisabled = xrayInstalled && !actionBusy ? "" : " disabled";
  const singboxDisabled = singboxInstalled && singboxService && !actionBusy ? "" : " disabled";
  const dnsRefreshDisabled = actionBusy ? " disabled" : "";
  const dnsRefreshLabel = state.dnsRefreshInFlight ? "DNS reset..." : "DNS reset";
  const vpnRefreshDisabled = actionBusy ? " disabled" : "";
  const vpnRefreshLabel = state.vpnRefreshInFlight ? "VPN reset..." : "VPN reset";
  const xrayConfigPath = status.xrayConfigPath || "/opt/etc/xray/config.json";
  const singboxConfigPath = status.singboxConfigPath || "/opt/etc/sing-box/config.json";

  $("summaryGrid").innerHTML = `
    <section class="engine-row summary-row">
      <div class="summary-row-main">
        <div class="engine-row-title">Xray</div>
        <div class="engine-row-bubbles summary-row-bubbles">
          ${boolPill(xrayRunning, "Запущен", xrayInstalled ? "Остановлен" : "Не установлен")}
          <div class="engine-inline-chip">
            <span class="label">Ядро</span>
            <span class="value">${xrayInstalled ? "установлен" : "не установлен"}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Версия</span>
            <span class="value">${renderVersionValue("xray", status.xrayVersion)}</span>
          </div>
          <div class="engine-inline-chip" title="${escapeHtml(xrayConfigPath)}">
            <span class="label">Config</span>
            <span class="value mono">${escapeHtml(compactPath(xrayConfigPath))}</span>
          </div>
        </div>
      </div>
      <div class="engine-row-actions summary-row-actions">
        <button type="button" class="secondary" data-engine="xray" data-engine-action="start"${xrayDisabled}>Старт</button>
        <button type="button" class="danger" data-engine="xray" data-engine-action="stop"${xrayDisabled}>Стоп</button>
        <button type="button" class="warning" data-engine="xray" data-engine-action="restart"${xrayDisabled}>Рестарт</button>
      </div>
    </section>
    <section class="engine-row summary-row">
      <div class="summary-row-main">
        <div class="engine-row-title">sing-box</div>
        <div class="engine-row-bubbles summary-row-bubbles">
          ${boolPill(singboxRunning, "Запущен", singboxInstalled ? "Остановлен" : "Не установлен")}
          <div class="engine-inline-chip">
            <span class="label">Ядро</span>
            <span class="value">${singboxInstalled ? "есть в системе" : "не установлен"}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Версия</span>
            <span class="value">${renderVersionValue("singbox", status.singboxVersion)}</span>
          </div>
          <div class="engine-inline-chip" title="${escapeHtml(singboxConfigPath)}">
            <span class="label">Config</span>
            <span class="value mono">${escapeHtml(compactPath(singboxConfigPath))}</span>
          </div>
        </div>
      </div>
      <div class="engine-row-actions summary-row-actions">
        <button type="button" class="secondary" data-engine="singbox" data-engine-action="start"${singboxDisabled}>Старт</button>
        <button type="button" class="danger" data-engine="singbox" data-engine-action="stop"${singboxDisabled}>Стоп</button>
        <button type="button" class="warning" data-engine="singbox" data-engine-action="restart"${singboxDisabled}>Рестарт</button>
      </div>
    </section>
    <section class="engine-row summary-row">
      <div class="summary-row-main">
        <div class="engine-row-title">Профили</div>
        <div class="engine-row-bubbles summary-row-bubbles">
          <div class="engine-inline-chip">
            <span class="label">Всего</span>
            <span class="value">${profiles.length}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Активных</span>
            <span class="value">${activeProfiles.length}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">Следующий socks</span>
            <span class="value mono">:${nextFreePort()}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">DNS-правил</span>
            <span class="value">${getDnsRoutes().length}</span>
          </div>
          <div class="engine-inline-chip">
            <span class="label">UI</span>
            <span class="value mono">/profiles.html</span>
          </div>
        </div>
      </div>
      <div class="engine-row-actions summary-row-actions">
        <button type="button" class="info" data-router-action="dns-refresh"${dnsRefreshDisabled} title="Пересобрать live DNS-маршруты и перезапустить dns-proxy intercept">${dnsRefreshLabel}</button>
        <button type="button" class="warning" data-router-action="vpn-refresh"${vpnRefreshDisabled} title="Перезапустить только реально используемые движки и обновить VPN-слой без полной пересборки DNS">${vpnRefreshLabel}</button>
      </div>
    </section>
  `;
}

function renderProfilesTable() {
  if (!$("profilesTableBody")) {
    return;
  }
  const rows = getProfiles()
    .slice()
    .sort((left, right) => {
      if (left.localPort && right.localPort) {
        return left.localPort - right.localPort;
      }
      return left.name.localeCompare(right.name, "ru");
    })
    .map((profile, index) => {
      const selected = profile.id === state.selectedId ? " selected" : "";
      const muted = profile.enabled ? "" : " muted-row";
      const toggleClass = profile.enabled ? "warning" : "secondary";
      const toggleText = profile.enabled ? "Выкл" : "Вкл";
      const toggleTitle = profile.enabled ? "Выключить профиль на роутере" : "Включить профиль на роутере";
      const disabledAttr = state.saveInFlight ? " disabled" : "";
      return `
        <tr class="${selected}${muted}" data-select-profile="${escapeHtml(profile.id)}">
          <td class="mono col-num">${index + 1}</td>
          <td>${escapeHtml(protocolLabel(profile.protocol))}</td>
          <td class="profile-cell">
            <div class="profile-cell-name">${escapeHtml(profile.name)}</div>
            <div class="profile-cell-meta">${enabledPill(profile)}</div>
          </td>
          <td class="mono">${escapeHtml(profile.server.address || "-")}</td>
          <td class="mono">${profile.server.port ? escapeHtml(profile.server.port) : "-"}</td>
          <td>${escapeHtml(transportLabel(profile))}</td>
          <td>${escapeHtml(securityLabel(profile))}</td>
          <td class="mono">${escapeHtml(profile.engine)}</td>
          <td class="mono">${escapeHtml(getEffectiveRouterProxyId(profile, profile.id) || "auto")}</td>
          <td class="mono">${profile.localPort ? ":" + escapeHtml(profile.localPort) : "auto"}</td>
          <td class="delay-cell">${probeSummary(profile)}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="${toggleClass} compact-action-btn" data-toggle-profile="${escapeHtml(profile.id)}" title="${toggleTitle}" aria-label="${toggleTitle}"${disabledAttr}>${toggleText}</button>
              <button type="button" class="secondary icon-btn" data-edit-profile="${escapeHtml(profile.id)}" title="Редактировать профиль" aria-label="Редактировать профиль"${disabledAttr}>&#9998;</button>
              <button type="button" class="danger icon-btn" data-delete-profile="${escapeHtml(profile.id)}" title="Удалить профиль" aria-label="Удалить профиль"${disabledAttr}>&times;</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  $("profilesTableBody").innerHTML =
    rows ||
    `
      <tr>
        <td colspan="12" class="table-empty">Пока нет ни одного профиля. Нажми «Добавить ключ» и открой первый профиль в отдельном окне.</td>
      </tr>
    `;
}

function renderDnsRoutesTable() {
  const body = $("dnsRoutesTableBody");
  if (!body) {
    return;
  }

  const routes = getDnsRoutes();
  if (state.dnsRoutesLoading) {
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">
          <span class="status-pill status-pending">Загружаем DNS-маршруты...</span>
        </td>
      </tr>
    `;
    return;
  }

  if (state.dnsRoutesError) {
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">Не удалось загрузить DNS-маршруты: ${escapeHtml(state.dnsRoutesError)}</td>
      </tr>
    `;
    return;
  }

  const profiles = getProfiles();
  const assignments = getCurrentDnsAssignments();
  const profileOptions = getProfiles()
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "ru"))
    .map((profile) => {
      const suffix = profile.enabled ? "" : " [выкл]";
      return `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name + suffix)}</option>`;
    })
    .join("");

  body.innerHTML =
    routes
      .map((route, index) => {
        const assignment =
          assignments.get(route.groupId) ||
          (() => {
            const fallbackProfile = findProfileByRouterProxyId(profiles, route.proxyId);
            if (!fallbackProfile) {
              return null;
            }
            return {
              profile: fallbackProfile,
              proxyId: normalizeRouterProxyId(fallbackProfile.routerProxyId),
              enabled: Boolean(fallbackProfile.enabled),
            };
          })();
        const externalRoute = !assignment && isExternalDnsRouteTarget(route.proxyId) ? route.proxyId : "";
        const proxyId = assignment && assignment.enabled && assignment.proxyId ? assignment.proxyId : externalRoute || "-";
        const directRoute = Boolean(externalRoute);
        const runtime = assignment ? getRouterProxyRuntime(assignment.proxyId) : null;
        const proxyProblem = Boolean(
          runtime &&
            (runtime.configuredUp || runtime.enabled) &&
            (!runtime.healthy || runtime.link !== "up" || runtime.ctrl !== "running")
        );
        const statusHtml = assignment
          ? assignment.enabled
            ? '<span class="status-pill status-ok tiny-status">Активен</span>' +
              (proxyProblem
                ? ' <span class="status-pill status-bad tiny-status">Proxy требует внимания</span>'
                : "")
            : '<span class="status-pill status-neutral tiny-status">Профиль выключен</span>'
          : externalRoute
            ? '<span class="status-pill status-direct-first tiny-status">Прямое подключение</span>'
            : '<span class="status-pill status-neutral tiny-status status-unassigned">Нет маршрута</span>';
        const selectClass = assignment || externalRoute ? "dns-route-select" : "dns-route-select is-unassigned";
        const currentProfileId = assignment ? assignment.profile.id : directRoute ? DIRECT_DNS_SELECT_VALUE : "";
        const disabledAttr = state.saveInFlight ? " disabled" : "";
        const baseOptions =
          `<option value="">Не назначен</option>` +
          `<option value="${DIRECT_DNS_SELECT_VALUE}">Прямое подключение</option>` +
          profileOptions;
        const optionSelectedNeedle = `value="${escapeHtml(currentProfileId)}"`;
        const renderedOptions = currentProfileId
          ? baseOptions.replace(optionSelectedNeedle, optionSelectedNeedle + " selected")
          : baseOptions;
        const hostSummary = dnsRouteHostSummary(route);
        const hostSummaryHtml = hostSummary
          ? `<div class="dns-route-hosts" title="${escapeHtml(hostSummary.title)}">${escapeHtml(hostSummary.text)}</div>`
          : "";
        const descriptionLineHtml = directRoute
          ? `${escapeHtml(displayDnsRouteDescription(route))} <span class="status-pill status-direct-first tiny-status direct-first-pill">прямое подключение</span>`
          : escapeHtml(displayDnsRouteDescription(route));
        const descriptionHtml = `<div class="dns-route-description">${descriptionLineHtml}</div>${hostSummaryHtml}`;
        const rowClasses = [];
        if (!assignment && !externalRoute) {
          rowClasses.push("muted-row", "dns-route-row-unassigned");
        }
        if (directRoute) {
          rowClasses.push("dns-route-row-direct-first");
        }
        if (proxyProblem) {
          rowClasses.push("dns-route-row-problem");
        }

          return `
          <tr class="${rowClasses.join(" ")}">
            <td class="mono col-num">${index + 1}</td>
            <td class="mono">${escapeHtml(route.groupId)}</td>
            <td>${descriptionHtml}</td>
            <td>
              <select class="${selectClass}" data-dns-route-select="${escapeHtml(route.groupId)}" title="Выбери профиль или прямое подключение для этого DNS-списка"${disabledAttr}>
                ${renderedOptions}
              </select>
            </td>
            <td class="mono ${assignment || externalRoute ? "" : "muted-text"}">${escapeHtml(proxyId)}</td>
            <td>${statusHtml}</td>
          </tr>
        `;
      })
      .join("") ||
    `
      <tr>
        <td colspan="6" class="table-empty">На роутере пока нет ни одного списка domain-list для маршрутизации.</td>
      </tr>
    `;
}

function renderProxyRuntimeTable() {
  const body = $("proxyRuntimeTableBody");
  const note = $("proxyRuntimeNotice");
  if (!body) {
    return;
  }

  const runtimeList = normalizeRouterProxyList(state.routerProxies).filter(
    (proxy) => proxy.configuredUp || proxy.enabled || proxy.upstreamPort
  );
  const activeProblems = runtimeList.filter(
    (proxy) => (proxy.configuredUp || proxy.enabled) && (!proxy.healthy || proxy.ctrl !== "running" || proxy.link !== "up")
  );
  const busyLoopback = runtimeList.filter((proxy) => proxy.loopbackConnections >= 200);
  const systemBusy = Boolean(
    state.systemHealth &&
      (state.systemHealth.cpu.idle <= 10 ||
        state.systemHealth.processes.ndmCpu >= 35 ||
        state.systemHealth.processes.singboxCpu >= 60)
  );

  if (note) {
    if (!state.statusSnapshotLoaded && !state.routerRuntimeLoading && !state.systemHealthLoading) {
      note.className = "runtime-health-note";
      note.textContent =
        "Живой статус ProxyN не считывается автоматически. Нажми ♻️, когда нужен снимок.";
      note.hidden = false;
    } else if (systemBusy) {
      note.className = "runtime-health-note is-bad";
      note.textContent =
        "Роутер сейчас перегружен: CPU idle " +
        formatPercent(state.systemHealth.cpu.idle) +
        ", ndm " +
        formatPercent(state.systemHealth.processes.ndmCpu, 1) +
        ", sing-box " +
        formatPercent(state.systemHealth.processes.singboxCpu, 1) +
        ". В такие минуты compact и длинные запросы могут рваться даже при живых ProxyN.";
      note.hidden = false;
    } else if (state.routerRuntimeLoading) {
      note.className = "runtime-health-note";
      note.textContent = "Считываем живое состояние ProxyN с роутера...";
      note.hidden = false;
    } else if (state.routerRuntimeError) {
      note.className = "runtime-health-note is-bad";
      note.textContent = "Не удалось прочитать live-состояние ProxyN: " + state.routerRuntimeError;
      note.hidden = false;
    } else if (activeProblems.length) {
      note.className = "runtime-health-note is-bad";
      note.textContent =
        "Сейчас есть проблемные ProxyN: " +
        activeProblems.map((proxy) => proxy.proxyId).join(", ") +
        ". Если DNS-группы смотрят на них, трафик может залипать или отваливаться.";
      note.hidden = false;
    } else if (busyLoopback.length) {
      note.className = "runtime-health-note is-bad";
      note.textContent =
        "Есть всплеск локальных SOCKS-сессий: " +
        busyLoopback.map((proxy) => proxy.proxyId + " " + proxy.loopbackConnections).join(", ") +
        ". Это может временно перегружать слабый роутер.";
      note.hidden = false;
    } else {
      note.className = "runtime-health-note is-ok";
      note.textContent = runtimeList.length
        ? "Все поднятые ProxyN сейчас выглядят живыми по данным Keenetic control-plane."
        : "Пока нет ни одного активного ProxyN для live-проверки.";
      note.hidden = false;
    }
  }

  if (!state.statusSnapshotLoaded && !state.routerRuntimeLoading) {
    body.innerHTML = `
      <tr>
        <td colspan="8" class="table-empty">Снимок runtime ещё не загружен.</td>
      </tr>
    `;
    return;
  }

  if (state.routerRuntimeLoading && !runtimeList.length) {
    body.innerHTML = `
      <tr>
        <td colspan="8" class="table-empty">
          <span class="status-pill status-pending">Считываем live-состояние ProxyN...</span>
        </td>
      </tr>
    `;
    return;
  }

  if (state.routerRuntimeError && !runtimeList.length) {
    body.innerHTML = `
      <tr>
        <td colspan="8" class="table-empty">Не удалось прочитать ProxyN runtime: ${escapeHtml(state.routerRuntimeError)}</td>
      </tr>
    `;
    return;
  }

  body.innerHTML =
    runtimeList
      .map((proxy, index) => {
        const usage = getProxyUsageSummary(proxy.proxyId);
        const usageParts = [];
        if (usage.dnsLabels.length) {
          usageParts.push("DNS: " + usage.dnsLabels.join(", "));
        }
        if (usage.clientLabels.length) {
          usageParts.push("Клиенты: " + usage.clientLabels.join(", "));
        }
        const usageText = usageParts.length ? usageParts.join(" | ") : "Пока не используется правилами.";
        const canRestart = Boolean(proxy.configuredUp);
        const busy = Boolean(
          state.proxyRuntimeBusyId ||
            state.saveInFlight ||
            state.dnsRefreshInFlight ||
            state.vpnRefreshInFlight ||
            state.clientPolicyBusyMac ||
            !canRestart
        );
        const thisBusy = state.proxyRuntimeBusyId === proxy.proxyId;
        const thisAction = thisBusy ? state.proxyRuntimeBusyAction : "";
        const healthHtml = proxy.healthy
          ? '<span class="status-pill status-ok tiny-status">Работает</span>'
          : '<span class="status-pill status-bad tiny-status">Нужна проверка</span>';
        const loopbackClass =
          proxy.loopbackConnections >= 200
            ? "status-bad"
            : proxy.loopbackConnections >= 80
              ? "status-warn"
              : "status-neutral";
        const controlHtml =
          '<div class="proxy-runtime-meta">' +
          '<span class="status-pill ' +
          (proxy.link === "up" ? "status-ok" : "status-bad") +
          ' tiny-status">link: ' +
          escapeHtml(proxy.link || "-") +
          "</span>" +
          '<span class="status-pill ' +
          (proxy.connected === "yes" ? "status-ok" : "status-neutral") +
          ' tiny-status">connected: ' +
          escapeHtml(proxy.connected || "-") +
          "</span>" +
          '<span class="status-pill ' +
          (proxy.ctrl === "running" ? "status-ok" : "status-warn") +
          ' tiny-status">ctrl: ' +
          escapeHtml(proxy.ctrl || "-") +
          "</span>" +
          (proxy.hasProcess
            ? '<span class="status-pill status-neutral tiny-status mono">pid ' + escapeHtml(proxy.pid || "?") + "</span>"
            : '<span class="status-pill status-bad tiny-status">процесс не найден</span>') +
          "</div>";

        return `
          <tr class="${proxy.healthy && proxy.loopbackConnections < 200 ? "" : "dns-route-row-problem"}">
            <td class="mono col-num">${index + 1}</td>
            <td>
              <div class="client-device-name">${escapeHtml(proxy.proxyId)}</div>
              <div class="client-device-meta">на роутере: ${escapeHtml(proxy.name || "без описания")}</div>
            </td>
            <td class="mono">${escapeHtml(proxy.upstreamHost || "-")}:${proxy.upstreamPort || "-"}</td>
            <td>
              <span class="status-pill ${loopbackClass} tiny-status mono">${proxy.loopbackConnections || 0}</span>
            </td>
            <td>
              ${healthHtml}
              ${controlHtml}
            </td>
            <td class="mono">${escapeHtml(proxy.address || "-")}</td>
            <td>${escapeHtml(usageText)}</td>
            <td>
              <div class="row-actions">
                <button type="button" class="warning compact-action-btn" data-proxy-runtime-action="restart" data-proxy-id="${escapeHtml(proxy.proxyId)}"${busy ? " disabled" : ""} title="${escapeHtml(canRestart ? "Мягко переподнять именно этот ProxyN." : "Кнопка доступна только для активных ProxyN.")}">${thisBusy && thisAction === "restart" ? "Перезапускаем..." : canRestart ? "Переподнять" : "Не активен"}</button>
                <button type="button" class="danger compact-action-btn" data-proxy-runtime-action="storm-reset" data-proxy-id="${escapeHtml(proxy.proxyId)}"${busy ? " disabled" : ""} title="${escapeHtml(canRestart ? "Сбросить только выбранный ProxyN: кратко опустить интерфейс, погасить его hev-socks5-tunnel и поднять обратно. Это легче, чем общий VPN reset." : "Кнопка доступна только для активных ProxyN.")}">${thisBusy && thisAction === "storm-reset" ? "Сбрасываем..." : "Сброс шторма"}</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("") ||
    `
      <tr>
        <td colspan="8" class="table-empty">На роутере пока нет ни одного ProxyN интерфейса.</td>
      </tr>
    `;
}

function renderClientPolicies() {
  const body = $("clientPoliciesTableBody");
  const note = $("clientPoliciesNotice");
  if (!body) {
    return;
  }

  if (note) {
    note.className = "runtime-health-note";
    note.textContent = "";
    note.hidden = true;
  }

  if (!state.clientPoliciesLoaded && !state.clientPoliciesLoading) {
    if (note) {
      note.className = "runtime-health-note";
      note.textContent =
        "Список клиентов не считывается автоматически. Нажми ♻️, когда нужен снимок.";
      note.hidden = false;
    }
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">Снимок клиентов ещё не загружен.</td>
      </tr>
    `;
    return;
  }

  if (state.clientPoliciesLoading) {
    if (note) {
      note.className = "runtime-health-note";
      note.textContent = "Считываем список клиентов и полные маршруты с роутера...";
      note.hidden = false;
    }
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">
          <span class="status-pill status-pending">Загружаем клиентов роутера...</span>
        </td>
      </tr>
    `;
    return;
  }

  if (state.clientPoliciesError) {
    if (note) {
      note.className = "runtime-health-note is-bad";
      note.textContent = "Не удалось прочитать режимы клиентов: " + state.clientPoliciesError;
      note.hidden = false;
    }
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">Не удалось прочитать клиентов.</td>
      </tr>
    `;
    return;
  }

  const hosts = getClientHosts();
  if (!hosts.length) {
    if (note) {
      note.className = "runtime-health-note is-bad";
      note.textContent = "Keenetic не отдал ни одного клиента из ip hotspot host.";
      note.hidden = false;
    }
    body.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">Список клиентов пуст.</td>
      </tr>
    `;
    return;
  }

  const policyMap = getClientPolicyMap();
  const assignmentMap = getClientAssignmentMap();
  const proxyOptionMap = new Map();
  const profileNameByProxyId = new Map();

  for (const item of normalizeRouterProxyList(state.routerProxies)) {
    if (!(item.enabled || item.configuredUp || item.upstreamPort)) {
      continue;
    }
    proxyOptionMap.set(item.proxyId, {
      value: item.proxyId,
      title: item.name ? item.name + " (" + item.proxyId + ")" : item.proxyId,
    });
  }

  for (const profile of getProfiles()) {
    const proxyId = normalizeRouterProxyId(profile && profile.routerProxyId);
    if (!proxyId || !(profile && profile.enabled) || !toNumber(profile && profile.localPort)) {
      continue;
    }
    const profileName = String(profile.name || "").trim();
    if (profileName) {
      profileNameByProxyId.set(proxyId, profileName);
    }
    proxyOptionMap.set(proxyId, {
      value: proxyId,
      title: profileName ? profileName + " (" + proxyId + ")" : proxyId,
    });
  }

  const proxyOptions = Array.from(proxyOptionMap.values()).sort((left, right) =>
    String(left.title).localeCompare(String(right.title), "ru")
  );

  const optionsHtml =
    `<option value="">Обычный режим по DNS-правилам</option>` +
    proxyOptions
      .map(
        (item) =>
          `<option value="${escapeHtml(item.value)}">${escapeHtml(item.title)}</option>`
      )
      .join("");

  body.innerHTML = hosts
    .map((host) => {
      const assignmentPolicyId = assignmentMap.get(host.mac) || "";
      const policy = assignmentPolicyId ? policyMap.get(assignmentPolicyId) : null;
      const currentProxyId = policy && policy.proxyId ? policy.proxyId : "";
      const isManaged = Boolean(policy && policy.managed && currentProxyId);
      const isForeign = Boolean(assignmentPolicyId && !isManaged);
      const rowKey = host.mac.replaceAll(":", "-");
      const controlBusy = Boolean(
        state.saveInFlight ||
          state.dnsRefreshInFlight ||
          state.vpnRefreshInFlight ||
          state.clientPolicyBusyMac === host.mac
      );
      const selectedNeedle = `value="${escapeHtml(currentProxyId)}"`;
      const renderedOptions = currentProxyId
        ? optionsHtml.replace(selectedNeedle, selectedNeedle + " selected")
        : optionsHtml.replace('value=""', 'value="" selected');

      let statusHtml = '<span class="status-pill status-neutral tiny-status">Обычный режим</span>';
      let note = "DNS-таблица продолжает управлять этим клиентом как обычно.";
      if (isManaged) {
        const optionTitle = String((proxyOptionMap.get(currentProxyId) && proxyOptionMap.get(currentProxyId).title) || "");
        const currentProxyName =
          profileNameByProxyId.get(currentProxyId) || optionTitle.replace(/\s+\([^)]*\)$/, "") || currentProxyId;
        statusHtml = '<span class="status-pill status-direct-first tiny-status">Полный маршрут активен</span>';
        note = "Весь трафик идёт через " + currentProxyName + ".";
      } else if (isForeign) {
        statusHtml = '<span class="status-pill status-warn tiny-status">Сторонняя policy</span>';
        note =
          "Сейчас на клиенте висит сторонняя policy " +
          assignmentPolicyId +
          ". Применение отсюда заменит её нашим режимом.";
      }

      return `
        <tr>
          <td class="client-device-cell">
            <div class="client-device-name">${escapeHtml(host.displayName)}</div>
            <div class="client-device-meta">${escapeHtml(host.interfaceDescription || "Keenetic hotspot")}</div>
          </td>
          <td class="mono">${escapeHtml(host.ip || "-")}</td>
          <td class="mono">${escapeHtml(host.mac)}</td>
          <td>${host.active ? '<span class="status-pill status-ok tiny-status">Онлайн</span>' : '<span class="status-pill status-neutral tiny-status">Неактивен</span>'}</td>
          <td>
            <div class="client-policy-controls">
              <select id="clientPolicySelect-${escapeHtml(rowKey)}" data-client-policy-select="${escapeHtml(host.mac)}"${controlBusy ? " disabled" : ""}>
                ${renderedOptions}
              </select>
              <button type="button" class="secondary" data-client-policy-apply="${escapeHtml(host.mac)}"${controlBusy ? " disabled" : ""}>${state.clientPolicyBusyMac === host.mac ? "Применяем..." : "Применить"}</button>
            </div>
          </td>
          <td>
            <div class="client-policy-status">
              ${statusHtml}
              <div class="client-policy-note">${escapeHtml(note)}</div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function applyClientPolicy(mac) {
  const normalizedMac = String(mac || "")
    .trim()
    .toLowerCase();
  if (!normalizedMac) {
    return Promise.reject(new Error("Не удалось определить MAC-адрес клиента."));
  }

  const select = $("clientPolicySelect-" + normalizedMac.replaceAll(":", "-"));
  if (!select) {
    return Promise.reject(new Error("Не удалось найти селектор полного маршрута для клиента."));
  }

  const proxyId = normalizeRouterProxyId(select.value);
  const proxyMeta = normalizeRouterProxyList(state.routerProxies).find((item) => item.proxyId === proxyId);
  const profileMeta = getProfiles().find(
    (profile) =>
      profile &&
      profile.enabled &&
      toNumber(profile.localPort) &&
      normalizeRouterProxyId(profile.routerProxyId) === proxyId
  );
  const proxyName =
    (profileMeta && String(profileMeta.name || "").trim()) ||
    (proxyMeta && String(proxyMeta.name || "").trim()) ||
    proxyId;
  const payload = ["H", normalizedMac, proxyId, utf8ToBase64(proxyName || "")].join("|");

  state.clientPolicyBusyMac = normalizedMac;
  updateBusyControls();
  renderClientPolicies();
  showBanner(
    "warn",
    proxyId
      ? "Включаем полный маршрут для клиента через " + proxyName + "..."
      : "Возвращаем клиенту обычный режим по DNS-правилам..."
  );

  return fetchJson("/cgi-bin/router-client-policies.cgi", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: payload,
  })
    .then((data) =>
      loadClientPolicies().then((fresh) => {
        state.clientHosts = normalizeClientHosts(fresh);
        state.clientPolicies = normalizeClientPolicyList(fresh);
        state.clientAssignments = normalizeClientAssignments(fresh);
        state.clientPoliciesLoading = false;
        state.clientPoliciesError = "";
        state.clientPoliciesLoaded = true;
        renderClientPolicies();
        showBanner(
          "ok",
          (data && data.message ? data.message : "Режим клиента обновлён.") +
            (data && data.backupPath ? " Бэкап: " + data.backupPath : "")
        );
      })
    )
    .finally(() => {
      state.clientPolicyBusyMac = "";
      updateBusyControls();
      renderClientPolicies();
    });
}

function runProxyRuntimeAction(proxyId, action) {
  const normalized = normalizeRouterProxyId(proxyId);
  if (!normalized) {
    return Promise.reject(new Error("Не удалось определить ProxyN для действия."));
  }
  if (
    state.proxyRuntimeBusyId ||
    state.saveInFlight ||
    state.dnsRefreshInFlight ||
    state.vpnRefreshInFlight ||
    state.clientPolicyBusyMac
  ) {
    return Promise.reject(new Error("Сначала дождись завершения текущей операции."));
  }

  state.proxyRuntimeBusyId = normalized;
  state.proxyRuntimeBusyAction = action || "restart";
  updateBusyControls();
  renderSummary();
  renderDnsRoutesTable();
  renderClientPolicies();
  renderProxyRuntimeTable();
  showBanner(
    "warn",
    (action === "storm-reset" ? "Сбрасываем локальный SOCKS-шторм на " : "Переподнимаем ") +
      normalized +
      " и заново проверяем его состояние..."
  );

  return fetchJson(
    "/cgi-bin/router-proxy-control.cgi?action=" +
      encodeURIComponent(action || "restart") +
      "&proxy=" +
      encodeURIComponent(normalized),
    {
      method: "POST",
      cache: "no-store",
    }
  )
    .then((data) =>
      loadRouterRuntime().then((runtime) => {
        state.routerProxies = mergeRouterProxyRuntime(state.routerProxies, runtime && runtime.proxies);
        state.routerRuntime = normalizeRouterProxyList(runtime && runtime.proxies);
        state.routerRuntimeLoading = false;
        state.routerRuntimeError = "";
        state.statusSnapshotLoaded = true;
        renderSummary();
        renderDnsRoutesTable();
        renderProxyRuntimeTable();
        showBanner("ok", (data && data.message) || (normalized + " переподнят."));
      })
    )
    .finally(() => {
      state.proxyRuntimeBusyId = "";
      state.proxyRuntimeBusyAction = "";
      updateBusyControls();
      renderSummary();
      renderDnsRoutesTable();
      renderClientPolicies();
      renderProxyRuntimeTable();
    });
}

function probePill(profileId) {
  const probe = state.probeResults[profileId];
  if (!probe) {
    return '<span class="status-pill status-neutral">Не проверялся</span>';
  }
  return `<span class="status-pill ${probe.kindClass}">${escapeHtml(probe.text)}</span>`;
}

function renderSelectedOverview() {
  ensureSelection();
  const profile = getSelectedProfile();
  const container = $("selectedOverview");
  if (!container) {
    return;
  }

  if (!profile) {
    container.className = "empty";
    container.innerHTML = "Пока нет выбранного профиля.";
    return;
  }

  const egress = state.egressResults[profile.id]
    ? `<span class="status-pill status-ok">IP ${escapeHtml(state.egressResults[profile.id])}</span>`
    : '<span class="status-pill status-neutral">Не проверялся</span>';
  const probe = state.probeResults[profile.id];
  const probeDetails = probe ? escapeHtml(probe.details || "") : "Пока без проверки.";
  const routerName = routerProxyNameMismatch(profile);
  const routerNameCard = routerName
    ? `
      <div class="selected-overview-card">
        <div class="label">На роутере</div>
        <div class="value">${escapeHtml(routerName)}</div>
        <div class="field-note">Будет приведено к имени профиля кнопкой «Имена ProxyN».</div>
      </div>
    `
    : "";

  container.className = "";
  container.innerHTML = `
    <div class="selected-overview-grid">
      <div class="selected-overview-card">
        <div class="label">Профиль</div>
        <div class="value">${escapeHtml(profile.name)}</div>
      </div>
      ${routerNameCard}
      <div class="selected-overview-card">
        <div class="label">Подключение</div>
        <div class="value mono">${escapeHtml(profile.server.address || "-")}:${profile.server.port || "-"}</div>
      </div>
      <div class="selected-overview-card">
        <div class="label">Локальный socks</div>
        <div class="value mono">${profile.localPort ? ":" + escapeHtml(profile.localPort) : "авто"}</div>
      </div>
      <div class="selected-overview-card">
        <div class="label">DNS-маршруты</div>
        <div class="value">${escapeHtml(buildDnsRulesSummary(profile))}</div>
      </div>
      <div class="selected-overview-card">
        <div class="label">Пинг сервера</div>
        <div class="value">${probePill(profile.id)}<div class="field-note">${probeDetails}</div></div>
      </div>
      <div class="selected-overview-card">
        <div class="label">Внешний IP</div>
        <div class="value">${egress}</div>
      </div>
    </div>
    <div class="selected-overview-actions">
      <button type="button" class="secondary" data-selected-action="edit">Открыть редактор</button>
      <button type="button" class="ghost" data-selected-action="ping"${state.saveInFlight ? " disabled" : ""}>Пинг сервера</button>
      <button type="button" class="ghost" data-selected-action="egress"${state.saveInFlight ? " disabled" : ""}>Внешний IP</button>
    </div>
  `;
}

function renderTechnicalPreview(force) {
  const details = $("techPreviewDetails");
  if (details && !details.open && !force) {
    return;
  }
  const selected = getSelectedProfile();
  if ($("selectedProfileJsonPreview")) {
    $("selectedProfileJsonPreview").value = selected ? pretty(selected) : "";
  }

  try {
    const built = buildEngineConfigsFromProfiles(state.profilesDoc);
    if ($("generatedConfigPreview")) {
      $("generatedConfigPreview").value = pretty({
        xray: built.xrayConfig,
        singBox: built.singboxConfig,
      });
    }
  } catch (error) {
    if ($("generatedConfigPreview")) {
      $("generatedConfigPreview").value = "// " + error.message;
    }
  }
}

function renderAll() {
  renderDirtyNotice();
  renderSummary();
  renderProfilesTable();
  renderDnsBulkControls();
  renderDnsRoutesTable();
  renderProxyRuntimeTable();
  renderClientPolicies();
  renderSelectedOverview();
  renderTechnicalPreview();
}

function getModalDraft() {
  return state.modalDraft ? normalizeProfile(state.modalDraft) : null;
}

function setModalOpen(open) {
  if ($("profileModal")) {
    $("profileModal").hidden = !open;
  }
  document.body.classList.toggle("modal-open", open);
}

function renderModalStatus(profile) {
  const probe = state.probeResults[profile.id];
  if ($("selectedPingStatus")) {
    $("selectedPingStatus").innerHTML = probe
      ? `<span class="status-pill ${probe.kindClass}">${escapeHtml(probe.text)}</span>`
      : '<span class="status-pill status-neutral">Не проверялся</span>';
  }
  if ($("selectedPingDetails")) {
    $("selectedPingDetails").textContent = probe ? probe.details : "Пинг идёт прямо с роутера.";
  }
}

function renderModalDnsRules(profile) {
  const container = $("profileDnsRules");
  if (!container) {
    return;
  }

  if (state.dnsRoutesLoading) {
    container.innerHTML = '<span class="status-pill status-pending">Загружаем DNS-маршруты...</span>';
    return;
  }

  if (state.dnsRoutesError) {
    container.textContent = "Не удалось загрузить DNS-маршруты: " + state.dnsRoutesError;
    return;
  }

  const rules = getEffectiveDnsRulesForProfile(profile);
  if (!rules.length) {
    container.textContent = "Маршруты для этого профиля пока не выбраны. Назначение делается в общей таблице DNS-маршрутов.";
    return;
  }

  const routeMap = new Map(getDnsRoutes().map((route) => [route.groupId, route]));
  container.innerHTML = rules
    .map((groupId) => {
      const route = routeMap.get(groupId);
      return `
        <div class="dns-rule-copy">
          <span class="dns-rule-name">${escapeHtml(route ? displayDnsRouteDescription(route) : groupId)}</span>
          <span class="dns-rule-meta mono">${escapeHtml(groupId)}</span>
        </div>
      `;
    })
    .join("");
}

function updateProfileJsonArea(profile) {
  const area = $("profileJson");
  if (document.activeElement !== area) {
    area.value = pretty(profile);
  }
}

function renderModalMeta(profile) {
  if ($("modalTitle")) {
    $("modalTitle").textContent = state.modalMode === "create" ? "Новый профиль" : "Профиль: " + profile.name;
  }
  if ($("modalSubtitle")) {
    $("modalSubtitle").textContent =
      "Основные параметры подключения и локального socks на роутере собраны в одном окне.";
  }
  if ($("modalMetaChips")) {
    $("modalMetaChips").innerHTML = `
      <div class="engine-inline-chip">
        <span class="label">Протокол</span>
        <span class="value">${escapeHtml(protocolLabel(profile.protocol))}</span>
      </div>
      <div class="engine-inline-chip">
        <span class="label">Локальный socks</span>
        <span class="value mono">${profile.localPort ? ":" + escapeHtml(profile.localPort) : "auto"}</span>
      </div>
    `;
  }
  if ($("profileRouterBadge")) {
    $("profileRouterBadge").textContent = getEffectiveRouterProxyId(
      profile,
      state.modalMode === "edit" ? profile.id : null
    );
  }
  if ($("routerSocksStatic")) {
    $("routerSocksStatic").textContent = buildRouterSocksSummary(profile);
  }
  renderModalDnsRules(profile);
  if ($("duplicateBtn")) {
    $("duplicateBtn").hidden = state.modalMode !== "edit";
  }
  if ($("deleteBtn")) {
    $("deleteBtn").hidden = state.modalMode !== "edit";
  }
  renderProtocolGroups(profile.protocol);
  renderModalStatus(profile);
  updateProfileJsonArea(profile);
}

function fillModalFields(profile) {
  resetEditorFields();

  setFieldValue("profileNameInput", profile.name || "");
  setFieldValue("profileRouterProxyId", getEffectiveRouterProxyId(profile, state.modalMode === "edit" ? profile.id : null));
  setFieldValue("profileEnabled", profile.enabled ? "true" : "false");
  setFieldValue("profileEngine", profile.engine);
  setFieldValue("profileProtocol", profile.protocol);
  setFieldValue("localPort", profile.localPort || "");
  setFieldValue("serverAddress", profile.server.address || "");
  setFieldValue("serverPort", profile.server.port || "");
  setFieldValue("ssMethod", profile.server.method || "");
  setFieldValue("ssPassword", profile.server.password || "");
  setFieldValue("trojanPassword", profile.server.password || "");
  setFieldValue("streamNetwork", profile.transport.network || "tcp");
  setFieldValue("streamSecurity", profile.transport.security || "none");
  setFieldValue("tlsServerName", profile.transport.serverName || "");
  setFieldValue("tlsFingerprint", profile.transport.fingerprint || "");
  setFieldValue("tlsAlpn", (profile.transport.alpn || []).join(", "));
  setFieldValue("wsHost", profile.transport.host || "");
  setFieldValue("wsPath", profile.transport.path || "/");
  setFieldValue("wsUserAgent", profile.transport.userAgent || "");
  setFieldValue("tlsAllowInsecure", profile.transport.allowInsecure ? "true" : "false");
  setFieldValue("socksUser", profile.server.user || "");
  setFieldValue("socksPass", profile.server.pass || "");
  setFieldValue("vxId", profile.server.id || "");
  setFieldValue("vxSecurity", profile.transport.security || "none");
  setFieldValue("vxNetwork", profile.transport.network || "tcp");
  setFieldValue("vxServerName", profile.transport.serverName || "");
  setFieldValue("vxFingerprint", profile.transport.fingerprint || "");
  setFieldValue("vxFlow", profile.server.flow || "");
  setFieldValue("vxWsHost", profile.transport.host || "");
  setFieldValue("vxWsPath", profile.transport.path || "/");
  setFieldValue("vxRealityPublicKey", profile.transport.realityPublicKey || "");
  setFieldValue("vxRealityShortId", profile.transport.realityShortId || "");
  setFieldValue("vxRealitySpiderX", profile.transport.realitySpiderX || "");

  renderModalMeta(profile);
}

function openProfileModal(mode, profile) {
  const draft = normalizeProfile(clone(profile));
  if (!draft.localPort) {
    draft.localPort = nextFreePort(mode === "edit" ? draft.id : null);
  }
  if (!draft.routerProxyId) {
    draft.routerProxyId = getEffectiveRouterProxyId(draft, mode === "edit" ? draft.id : null);
  }
  if (isSystemLikeProfileName(draft.name, draft.id, draft.protocol, draft.engine)) {
    draft.name = systemProfileName(draft);
  }

  state.modalMode = mode;
  state.modalProfileId = mode === "edit" ? draft.id : null;
  state.modalDraft = draft;
  state.selectedId = draft.id;
  fillModalFields(draft);
  setModalOpen(true);
}

function openCreateModal() {
  const profile = createEmptyProfile("shadowsocks");
  profile.localPort = nextFreePort();
  openProfileModal("create", profile);
}

function openEditModal(profileId) {
  const profile = getProfiles().find((item) => item.id === profileId);
  if (!profile) {
    throw new Error("Профиль не найден.");
  }
  openProfileModal("edit", profile);
}

function closeProfileModal() {
  setModalOpen(false);
  state.modalMode = null;
  state.modalProfileId = null;
  state.modalDraft = null;
  resetEditorFields();
}

function validateProfile(profile) {
  if (!profile.name.trim()) {
    throw new Error("Заполни название профиля.");
  }
  if ($("profileRouterProxyId")) {
    const parsedProxy = parseRouterProxyInputValue($("profileRouterProxyId").value);
    if (!parsedProxy.valid) {
      throw new Error(parsedProxy.message);
    }
  }
  if (!profile.server.address.trim()) {
    throw new Error("Заполни адрес сервера.");
  }
  if (!profile.server.port) {
    throw new Error("Заполни порт сервера.");
  }

  if (profile.protocol === "shadowsocks") {
    if (!profile.server.method.trim()) {
      throw new Error("Для Shadowsocks нужен метод шифрования.");
    }
    if (!profile.server.password) {
      throw new Error("Для Shadowsocks нужен пароль.");
    }
  }

  if (profile.protocol === "trojan" && !profile.server.password) {
    throw new Error("Для Trojan нужен пароль.");
  }

  if ((profile.protocol === "vless" || profile.protocol === "vmess") && !profile.server.id.trim()) {
    throw new Error("Для " + protocolLabel(profile.protocol) + " нужен UUID / ID.");
  }

  if ((profile.protocol === "vless" || profile.protocol === "vmess") && profile.transport.security === "reality") {
    if (!profile.transport.serverName.trim()) {
      throw new Error("Для REALITY нужен SNI / serverName.");
    }
    if (!profile.transport.fingerprint.trim()) {
      throw new Error("Для REALITY нужен fingerprint.");
    }
    if (!profile.transport.realityPublicKey.trim()) {
      throw new Error("Для REALITY нужен publicKey.");
    }
  }

  return profile;
}

function validateRouterProxyAssignments(doc) {
  const seen = new Map();
  const prepared = normalizeProfilesDoc(doc);

  for (const profile of prepared.profiles) {
    const proxyId = normalizeRouterProxyId(profile.routerProxyId);
    if (!proxyId) {
      continue;
    }
    if (seen.has(proxyId)) {
      throw new Error(
        'Proxy "' +
          proxyId +
          '" указан сразу у профилей "' +
          seen.get(proxyId) +
          '" и "' +
          profile.name +
          '".'
      );
    }
    seen.set(proxyId, profile.name);
  }

  return prepared;
}

function validateLocalPortAssignments(doc) {
  const seen = new Map();
  const prepared = normalizeProfilesDoc(doc);

  for (const profile of prepared.profiles) {
    if (!profile.enabled) {
      continue;
    }
    const port = Number(profile.localPort || 0);
    if (!port) {
      continue;
    }
    if (seen.has(port)) {
      throw new Error(
        'Локальный socks-порт "' +
          port +
          '" одновременно указан у активных профилей "' +
          seen.get(port) +
          '" и "' +
          profile.name +
          '".'
      );
    }
    seen.set(port, profile.name);
  }

  return prepared;
}

function syncModalDraftFromFields(options) {
  const current = getModalDraft();
  if (!current) {
    return null;
  }

  const next = clone(current);
  const opts = options || {};
  const rawNameInput = ($("profileNameInput") ? $("profileNameInput").value : next.name).trim();
  const autoName = isSystemLikeProfileName(rawNameInput || current.name, current.id, current.protocol, current.engine);

  const proxyControl = $("profileRouterProxyId");
  const parsedProxy = parseRouterProxyInputValue(proxyControl ? proxyControl.value : next.routerProxyId);
  const effectiveProxy = parsedProxy.valid
    ? parsedProxy.value || getEffectiveRouterProxyId(next, state.modalMode === "edit" ? next.id : null)
    : normalizeRouterProxyId(current.routerProxyId) || getEffectiveRouterProxyId(next, state.modalMode === "edit" ? next.id : null);
  if (proxyControl) {
    proxyControl.setCustomValidity(parsedProxy.valid ? "" : parsedProxy.message);
    if (parsedProxy.valid && proxyControl.value.trim() !== effectiveProxy) {
      proxyControl.value = effectiveProxy;
    }
  }
  next.routerProxyId = effectiveProxy;
  next.enabled = $("profileEnabled").value === "true";
  next.engine = $("profileEngine").value;
  next.protocol = $("profileProtocol").value;
  next.name = autoName ? systemProfileName(Object.assign({}, next, { routerProxyId: effectiveProxy })) : rawNameInput;
  next.localPort = toNumber($("localPort").value);
  next.server.address = $("serverAddress").value.trim();
  next.server.port = toNumber($("serverPort").value);

  if (next.protocol === "shadowsocks") {
    next.server.method = $("ssMethod").value.trim();
    next.server.password = $("ssPassword").value;
    next.server.user = "";
    next.server.pass = "";
    next.server.id = "";
    next.server.flow = "";
    next.transport = defaultTransport();
  } else if (next.protocol === "trojan") {
    next.server.method = "";
    next.server.password = $("trojanPassword").value;
    next.server.user = "";
    next.server.pass = "";
    next.server.id = "";
    next.server.flow = "";
    next.transport = {
      network: $("streamNetwork").value,
      security: $("streamSecurity").value,
      serverName: $("tlsServerName").value.trim(),
      fingerprint: $("tlsFingerprint").value.trim(),
      alpn: $("tlsAlpn")
        .value.split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      host: $("wsHost").value.trim(),
      path: $("wsPath").value.trim() || "/",
      userAgent: $("wsUserAgent").value.trim(),
      allowInsecure: $("tlsAllowInsecure").value === "true",
    };
  } else if (next.protocol === "socks") {
    next.server.method = "";
    next.server.password = "";
    next.server.user = $("socksUser").value.trim();
    next.server.pass = $("socksPass").value;
    next.server.id = "";
    next.server.flow = "";
    next.transport = defaultTransport();
  } else {
    next.server.method = "";
    next.server.password = "";
    next.server.user = "";
    next.server.pass = "";
    next.server.id = $("vxId").value.trim();
    next.server.flow = $("vxFlow").value.trim();
    next.server.alterId = toNumber(next.server.alterId);
    next.server.vmessSecurity = next.server.vmessSecurity || "auto";
    next.transport = {
      network: $("vxNetwork").value,
      security: $("vxSecurity").value,
      serverName: $("vxServerName").value.trim(),
      fingerprint: $("vxFingerprint").value.trim(),
      alpn: [],
      host: $("vxWsHost").value.trim(),
      path: $("vxWsPath").value.trim() || "/",
      userAgent: "",
      allowInsecure: false,
      realityPublicKey: $("vxRealityPublicKey").value.trim(),
      realityShortId: $("vxRealityShortId").value.trim(),
      realitySpiderX: $("vxRealitySpiderX").value.trim(),
    };
  }

  const normalized = next.protocol === "trojan" ? applyRouterFixes(next) : normalizeProfile(next);
  state.modalDraft = normalized;

  if (!opts.silent) {
    renderModalMeta(normalized);
  }

  return normalized;
}

function buildCandidateProfiles(nextProfile) {
  const normalized = normalizeProfile(nextProfile);
  return normalizeProfilesDoc({
    version: 1,
    profiles:
      state.modalMode === "edit"
        ? getProfiles().map((profile) => (profile.id === normalized.id ? normalized : profile))
        : getProfiles().concat(normalized),
  });
}

function commitModalDraft() {
  let next = syncModalDraftFromFields({ silent: true });
  if (!next) {
    throw new Error("Нет открытого профиля.");
  }

  if (!next.localPort) {
    next.localPort = nextFreePort(state.modalMode === "edit" ? next.id : null);
  }

  next = validateProfile(next.protocol === "trojan" ? applyRouterFixes(next) : normalizeProfile(next));
  const duplicateName = getProfiles().find(
    (profile) => profile.id !== next.id && String(profile.name || "").trim().toLowerCase() === next.name.trim().toLowerCase()
  );
  if (duplicateName) {
    throw new Error('Название профиля "' + next.name + '" уже используется.');
  }
  const candidateProfiles = applyExclusiveDnsRules(
    validateRouterProxyAssignments(buildCandidateProfiles(next)),
    next.id
  );
  buildEngineConfigsFromProfiles(candidateProfiles);

  if (state.modalMode === "edit") {
    replaceProfile(next);
  } else {
    pushProfile(next);
  }

  state.profilesDoc = applyExclusiveDnsRules(state.profilesDoc, next.id);

  state.selectedId = next.id;
  const wasEdit = state.modalMode === "edit";
  closeProfileModal();
  renderAll();
  showBanner("ok", wasEdit ? "Профиль обновлён локально." : "Новый профиль добавлен локально.");
}

function applyLinkToModal(link) {
  const source = String(link || "").trim();
  if (!source) {
    throw new Error("Сначала вставь ключ.");
  }

  const current = getModalDraft() || createEmptyProfile("shadowsocks");
  const parsed = parseLinkToProfile(source);
  parsed.id = current.id || parsed.id;
  parsed.enabled = current.enabled;
  parsed.engine = current.engine;
  parsed.localPort = current.localPort || nextFreePort(state.modalMode === "edit" ? current.id : null);
  parsed.routerProxyId = current.routerProxyId || getEffectiveRouterProxyId(parsed, state.modalMode === "edit" ? current.id : null);
  parsed.name = isSystemLikeProfileName(current.name, current.id, current.protocol, current.engine)
    ? systemProfileName(parsed)
    : (current.name || parsed.name);

  state.modalDraft = parsed.protocol === "trojan" ? applyRouterFixes(parsed) : normalizeProfile(parsed);
  fillModalFields(state.modalDraft);
  showBanner("ok", "Ключ разобран. Проверь поля и сохрани изменения.");
}

function duplicateModalDraft() {
  const current = syncModalDraftFromFields({ silent: true });
  if (!current) {
    throw new Error("Нет открытого профиля.");
  }

  const duplicated = normalizeProfile(clone(current));
  duplicated.id = suggestProfileId(duplicated.protocol, current.id);
  duplicated.name = makeUniqueProfileName(current.name, current.id);
  duplicated.routerProxyId = "";
  duplicated.localPort = nextFreePort();
  pushProfile(duplicated);
  state.selectedId = duplicated.id;
  renderAll();
  openProfileModal("edit", duplicated);
  showBanner("ok", "Профиль продублирован.");
}

function deleteProfile(profileId) {
  const profile = getProfiles().find((item) => item.id === profileId);
  if (!profile) {
    return;
  }
  if (!window.confirm('Удалить профиль "' + profile.name + '"?')) {
    return;
  }

  removeProfileById(profileId);
  if (state.modalProfileId === profileId) {
    closeProfileModal();
  }
  renderAll();
  showBanner("ok", "Профиль удалён.");
}

function toggleProfileEnabled(profileId) {
  const current = getProfiles().find((item) => item.id === profileId);
  if (!current) {
    return Promise.resolve();
  }

  const snapshot = clone(state.profilesDoc);
  const next = normalizeProfile(current);
  next.enabled = !next.enabled;

  replaceProfile(ensureFreePortForEnabledProfile(next));
  ensureSelection();
  renderAll();

  return saveEverything()
    .then(() =>
      init(next.enabled ? 'Профиль "' + next.name + '" включён и применён на роутере.' : 'Профиль "' + next.name + '" выключен на роутере.')
    )
    .catch((error) => {
      state.profilesDoc = snapshot;
      ensureSelection();
      renderAll();
      throw error;
    });
}

function applyModalProfileJson() {
  const current = getModalDraft();
  if (!current) {
    throw new Error("Нет открытого профиля.");
  }

  const parsed = normalizeProfile(safeJsonParse($("profileJson").value, "JSON профиля"));
  parsed.id = current.id;
  if (!parsed.localPort) {
    parsed.localPort = current.localPort || nextFreePort(state.modalMode === "edit" ? current.id : null);
  }

  state.modalDraft = parsed.protocol === "trojan" ? applyRouterFixes(parsed) : parsed;
  fillModalFields(state.modalDraft);
  showBanner("ok", "JSON профиля применён внутри окна редактирования.");
}

function setAutoPortForModal() {
  const current = getModalDraft();
  if (!current) {
    return;
  }
  setFieldValue("localPort", nextFreePort(state.modalMode === "edit" ? current.id : null));
  syncModalDraftFromFields();
  showBanner("ok", "Свободный socks-порт подобран автоматически.");
}

function setProbeResult(profileId, kind, text, details, avgMs) {
  const kindClassMap = {
    neutral: "status-neutral",
    pending: "status-pending",
    ok: "status-ok",
    warn: "status-warn",
    bad: "status-bad",
  };
  state.probeResults[profileId] = {
    kind,
    kindClass: kindClassMap[kind] || "status-neutral",
    text,
    details,
    avgMs: Number.isFinite(avgMs) ? avgMs : null,
  };
}

function testSelectedProfileEgress() {
  let profile = getSelectedProfile();
  if (!profile) {
    return Promise.reject(new Error("Сначала выбери профиль."));
  }
  if (!profile.localPort) {
    profile = normalizeProfile(clone(profile));
    profile.localPort = nextFreePort(profile.id);
    replaceProfile(profile);
    renderAll();
  }
  return fetchJson("/cgi-bin/xray-egress.cgi?port=" + encodeURIComponent(String(profile.localPort)), {
    cache: "no-store",
  }).then((data) => {
    if (!data.ok) {
      throw new Error(data.error || "Не удалось получить внешний IP");
    }
    state.egressResults[profile.id] = data.ip;
    renderSelectedOverview();
    renderProfilesTable();
  });
}

function refreshProbeDependentViews(profileId) {
  renderProfilesTable();
  renderSelectedOverview();
  if (state.modalDraft && state.modalDraft.id === profileId) {
    renderModalStatus(state.modalDraft);
  }
}

function pingProfile(profile) {
  setProbeResult(
    profile.id,
    "pending",
    "Идёт проверка",
    "Проверяем " + profile.server.address + ":" + (profile.server.port || "") + " с роутера..."
  );
  refreshProbeDependentViews(profile.id);

  return fetchJson(
    "/cgi-bin/xray-ping.cgi?host=" +
      encodeURIComponent(profile.server.address) +
      "&port=" +
      encodeURIComponent(String(profile.server.port || "")),
    { cache: "no-store" }
  ).then((data) => {
    const details = [];
    if (data.ip) details.push("IP " + data.ip);
    if (data.avgMs) details.push("avg " + data.avgMs + " мс");
    if (data.loss) details.push("loss " + data.loss);
    if (data.tcpMessage) details.push(data.tcpMessage);
    if (data.message) details.push(data.message);

    if (data.ok) {
      setProbeResult(profile.id, "ok", "Сервер отвечает", details.join(" | "), Number(data.avgMs || 0));
    } else {
      setProbeResult(
        profile.id,
        data.ip ? "warn" : "bad",
        data.ip ? "ICMP не отвечает" : "Ошибка проверки",
        details.join(" | "),
        Number(data.avgMs || 0)
      );
    }

    refreshProbeDependentViews(profile.id);
  });
}

function pingSelectedProfile() {
  const profile = getSelectedProfile();
  if (!profile) {
    return Promise.reject(new Error("Сначала выбери профиль."));
  }
  if (!profile.server.address) {
    return Promise.reject(new Error("У выбранного профиля не заполнен адрес сервера."));
  }
  return pingProfile(profile);
}

function pingModalDraft() {
  const profile = syncModalDraftFromFields({ silent: true });
  if (!profile) {
    return Promise.reject(new Error("Нет открытого профиля."));
  }
  if (!profile.server.address) {
    return Promise.reject(new Error("Заполни адрес сервера перед проверкой."));
  }
  return pingProfile(profile).then(() => {
    renderModalMeta(profile);
  });
}

async function pingAllProfiles() {
  if (state.pingAllInFlight) {
    return;
  }
  state.pingAllInFlight = true;
  clearBanner();
  let okCount = 0;
  let issueCount = 0;

  try {
    for (const profile of getProfiles()) {
      if (!profile.enabled || !profile.server.address) {
        continue;
      }
      try {
        await pingProfile(profile);
        const probe = state.probeResults[profile.id];
        if (probe && probe.kind === "ok") {
          okCount += 1;
        } else {
          issueCount += 1;
        }
      } catch (error) {
        issueCount += 1;
        setProbeResult(profile.id, "bad", "Ошибка проверки", error.message, null);
        refreshProbeDependentViews(profile.id);
      }
    }
    showBanner(
      issueCount ? "warn" : "ok",
      "Проверка серверов завершена: отвечают " + okCount + ", проблемы у " + issueCount + "."
    );
  } finally {
    state.pingAllInFlight = false;
  }
}

function changeModalProtocol(protocol) {
  const current = getModalDraft();
  if (!current) {
    return;
  }

  const replacement = createEmptyProfile(protocol);
  replacement.id = current.id;
  replacement.routerProxyId = current.routerProxyId || getEffectiveRouterProxyId(current, current.id);
  replacement.name = isSystemLikeProfileName(current.name, current.id, current.protocol, current.engine)
    ? systemProfileName(replacement)
    : current.name;
  replacement.enabled = current.enabled;
  replacement.engine = current.engine;
  replacement.localPort = current.localPort || nextFreePort(state.modalMode === "edit" ? current.id : null);
  replacement.server.address = current.server.address;
  replacement.server.port = current.server.port;
  state.modalDraft = replacement;
  fillModalFields(replacement);
}

function renameProfileForEngineSwitch(rawName, currentEngine, nextEngine, profileId, protocol, routerProxyId) {
  const currentName = String(rawName || "").trim();
  const nextSystemName = systemProfileName({
    id: profileId,
    protocol,
    engine: nextEngine,
    routerProxyId,
  });

  if (isSystemLikeProfileName(currentName, profileId, protocol, currentEngine)) {
    return nextSystemName;
  }

  return currentName;
}

function changeModalEngine(engine) {
  const current = getModalDraft();
  if (!current) {
    return;
  }

  const nextEngine = normalizeProfileEngine(engine);
  const replacement = normalizeProfile(clone(current));
  const currentName = $("profileNameInput") ? $("profileNameInput").value.trim() : current.name;

  replacement.engine = nextEngine;
  replacement.name = renameProfileForEngineSwitch(
    currentName,
    current.engine,
    nextEngine,
    current.id,
    current.protocol,
    current.routerProxyId
  );

  state.modalDraft = replacement;
  fillModalFields(replacement);
}

function utf8ToBase64(value) {
  return btoa(unescape(encodeURIComponent(String(value || ""))));
}

function buildRouterSyncPayload(profiles) {
  return profiles
    .map((profile) => {
      return [
        "P",
        String(profile.id || ""),
        utf8ToBase64(profile.name || ""),
        profile.enabled ? "1" : "0",
        String(profile.localPort || 0),
        String(profile.routerProxyId || ""),
      ].join("|");
    })
    .join("\n");
}

function buildDnsRouteSyncPayload(routes) {
  return normalizeDnsRoutes(routes)
    .sort((left, right) => {
      const leftTarget = normalizeDnsRouteTarget(left.proxyId);
      const rightTarget = normalizeDnsRouteTarget(right.proxyId);
      const leftPriority = isExternalDnsRouteTarget(leftTarget) ? 1 : leftTarget ? 0 : 2;
      const rightPriority = isExternalDnsRouteTarget(rightTarget) ? 1 : rightTarget ? 0 : 2;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId);
    })
    .map((route) => ["R", route.groupId, normalizeDnsRouteTarget(route.proxyId)].join("|"))
    .join("\n");
}

function summarizeDnsRoutePayload(payload) {
  const counts = new Map();
  const lines = String(payload || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parts = line.split("|");
    if (parts[0] !== "R") {
      continue;
    }
    const target = normalizeDnsRouteTarget(parts[2] || "") || "не назначен";
    counts.set(target, (counts.get(target) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map((item) => item[0] + ": " + item[1])
    .join(", ");
}

function verifySavedDnsRoutePayload(expectedPayload) {
  const expected = String(expectedPayload || "").trim();
  return loadDnsRoutes().then((dnsData) => {
    const verifiedRoutes = normalizeDnsRoutes(dnsData);
    const actual = buildDnsRouteSyncPayload(verifiedRoutes).trim();
    if (actual !== expected) {
      const expectedSummary = summarizeDnsRoutePayload(expected) || "пусто";
      const actualSummary = summarizeDnsRoutePayload(actual) || "пусто";
      throw new Error(
        "Роутер вернул DNS-маршруты, отличающиеся от отправленных. Сохранение не подтверждено. Ожидали: " +
          expectedSummary +
          ". Получили: " +
          actualSummary +
          "."
      );
    }

    state.routerProxies = normalizeRouterProxyList(dnsData && dnsData.proxies);
    state.dnsRoutes = verifiedRoutes;
    state.profilesDoc = mergeDnsRulesFromRoutes(state.profilesDoc, state.dnsRoutes);
    markDnsRoutesApplied(state.dnsRoutes, state.profilesDoc.profiles);
    renderAll();
    return dnsData;
  });
}

function buildVpnRefreshParamsFromProfiles(profiles) {
  const params = new URLSearchParams();
  const activeProfiles = normalizeProfilesDoc({ version: 1, profiles }).profiles.filter(
    (profile) => profile.enabled && toNumber(profile.localPort)
  );

  if (activeProfiles.some((profile) => isXrayEngine(profile.engine))) {
    params.set("xray", "1");
  }
  if (activeProfiles.some((profile) => isSingboxEngine(profile.engine))) {
    params.set("singbox", "1");
  }

  return params;
}

function shouldSaveEngineConfig(profiles, engineId) {
  const activeProfiles = normalizeProfilesDoc({ version: 1, profiles }).profiles.filter(
    (profile) => profile.enabled && toNumber(profile.localPort)
  );

  if (engineId === "xray") {
    return (
      activeProfiles.some((profile) => isXrayEngine(profile.engine)) ||
      Boolean(state.status && state.status.xrayRunning)
    );
  }

  if (engineId === "sing-box") {
    return (
      activeProfiles.some((profile) => isSingboxEngine(profile.engine)) ||
      Boolean(state.status && state.status.singboxRunning)
    );
  }

  return false;
}

function saveEngineConfigIfNeeded(engineId, config) {
  if (engineId === "xray" && !shouldSaveEngineConfig(getProfiles(), "xray")) {
    return Promise.resolve({
      ok: true,
      skipped: true,
      message: "Xray не используется активными профилями, сохранение Xray пропущено.",
    });
  }

  if (engineId === "sing-box" && !shouldSaveEngineConfig(getProfiles(), "sing-box")) {
    return Promise.resolve({
      ok: true,
      skipped: true,
      message: "sing-box не используется активными профилями, сохранение sing-box пропущено.",
    });
  }

  const url = engineId === "xray" ? "/cgi-bin/xray-save.cgi" : "/cgi-bin/singbox-save.cgi";
  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: pretty(config),
  });
}

function runPostSaveVpnRefresh(profiles) {
  const params = buildVpnRefreshParamsFromProfiles(profiles);
  return fetchJson(`/cgi-bin/vpn-route-refresh.cgi?${params.toString()}`, {
    method: "POST",
    cache: "no-store",
  });
}

function runPostSaveDnsRefresh(hasDnsRoutes) {
  if (!hasDnsRoutes) {
    return Promise.resolve(null);
  }

  return fetchJson("/cgi-bin/dns-route-refresh.cgi", {
    method: "POST",
    cache: "no-store",
  });
}

function runPostSaveStormResetIfNeeded() {
  return loadRouterRuntime()
    .then((runtime) => {
      const runtimeList = normalizeRouterProxyList(runtime && runtime.proxies);
      state.routerProxies = mergeRouterProxyRuntime(state.routerProxies, runtimeList);
      state.routerRuntime = runtimeList;
      state.routerRuntimeLoading = false;
      state.routerRuntimeError = "";

      const stormyProxies = runtimeList.filter(
        (proxy) =>
          proxy.configuredUp &&
          proxy.healthy &&
          toNumber(proxy.loopbackConnections) >= AUTO_STORM_LOOPBACK_THRESHOLD
      );

      let chain = Promise.resolve([]);
      for (const proxy of stormyProxies) {
        chain = chain.then((results) => {
          state.proxyRuntimeBusyId = proxy.proxyId;
          state.proxyRuntimeBusyAction = "storm-reset";
          renderProxyRuntimeTable();
          return fetchJson(
            "/cgi-bin/router-proxy-control.cgi?action=storm-reset&proxy=" +
              encodeURIComponent(proxy.proxyId),
            {
              method: "POST",
              cache: "no-store",
            }
          ).then((result) => results.concat(result));
        });
      }

      return chain.then((results) => {
        state.proxyRuntimeBusyId = "";
        state.proxyRuntimeBusyAction = "";
        if (!results.length) {
          return { resetCount: 0, results };
        }
        return loadRouterRuntime().then((freshRuntime) => {
          state.routerProxies = mergeRouterProxyRuntime(state.routerProxies, freshRuntime && freshRuntime.proxies);
          state.routerRuntime = normalizeRouterProxyList(freshRuntime && freshRuntime.proxies);
          state.routerRuntimeLoading = false;
          state.routerRuntimeError = "";
          return { resetCount: results.length, results };
        });
      });
    })
    .finally(() => {
      state.proxyRuntimeBusyId = "";
      state.proxyRuntimeBusyAction = "";
      renderProxyRuntimeTable();
    });
}

function runPostSaveMaintenance(profiles, hasDnsRoutes) {
  showBanner("warn", "Профили сохранены. Автоматически делаем VPN reset, DNS reset и проверяем SOCKS-шторм...");

  const summary = {
    vpn: null,
    dns: null,
    storm: null,
  };

  return runPostSaveVpnRefresh(profiles)
    .then((vpnResult) => {
      summary.vpn = vpnResult || null;
      return runPostSaveDnsRefresh(hasDnsRoutes);
    })
    .then((dnsResult) => {
      summary.dns = dnsResult || null;
      return runPostSaveStormResetIfNeeded();
    })
    .then((stormResult) => {
      summary.storm = stormResult || { resetCount: 0, results: [] };
      return summary;
    });
}

function applyRouterSyncMappings(profiles, syncResult) {
  const mapping = new Map(
    Array.isArray(syncResult && syncResult.mappings)
      ? syncResult.mappings.map((item) => [String(item.id || ""), normalizeRouterProxyId(item.routerProxyId)])
      : []
  );

  return normalizeProfilesDoc({
    version: 1,
    profiles: profiles.map((profile) => {
      const next = normalizeProfile(profile);
      next.routerProxyId = mapping.get(next.id) || next.routerProxyId || "";
      return next;
    }),
  });
}

function saveEverything() {
  if (state.saveInFlight || state.dnsRefreshInFlight) {
    return Promise.reject(
      new Error("Сейчас уже идёт сохранение или DNS reset. Дождись завершения текущей операции.")
    );
  }

  let preparedProfiles = null;
  let built = null;
  let routerSyncPayload = "";
  let hasDnsRoutes = false;
  let dnsRouteSyncPayload = "";
  setSaveInFlight(true);

  return Promise.resolve().then(() => {
    state.profilesDoc = validateLocalPortAssignments(validateRouterProxyAssignments(state.profilesDoc));
    state.profilesDoc = mergeDnsRulesFromRoutes(state.profilesDoc, getDnsRoutes());
    built = buildEngineConfigsFromProfiles(state.profilesDoc);
    state.profilesDoc = built.preparedProfiles;
    preparedProfiles = normalizeProfilesDoc(state.profilesDoc);
    routerSyncPayload = buildRouterSyncPayload(preparedProfiles.profiles);
    hasDnsRoutes = getDnsRoutes().length > 0;
    dnsRouteSyncPayload = hasDnsRoutes ? buildDnsRouteSyncPayload(getDnsRoutes()) : "";
    if (hasDnsRoutes) {
      preparedProfiles = mergeDnsRulesFromRoutes(preparedProfiles, getDnsRoutes());
      state.profilesDoc = preparedProfiles;
    }
    return saveEngineConfigIfNeeded("sing-box", built.singboxConfig);
  }).then(() => {
    return saveEngineConfigIfNeeded("xray", built.xrayConfig);
  }).then(() => {
    return fetchJson("/cgi-bin/router-proxy-sync.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: routerSyncPayload,
    });
  }).then((syncResult) => {
    preparedProfiles = applyRouterSyncMappings(preparedProfiles.profiles, syncResult);
    state.profilesDoc = preparedProfiles;
    if (!hasDnsRoutes) {
      return null;
    }
    return fetchJson("/cgi-bin/router-dns-routes-sync.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: dnsRouteSyncPayload,
    }).then(() => verifySavedDnsRoutePayload(dnsRouteSyncPayload));
  }).then(() => {
    if (hasDnsRoutes) {
      preparedProfiles = mergeDnsRulesFromRoutes(preparedProfiles, state.dnsRoutes);
      state.profilesDoc = preparedProfiles;
    }
    const persistedProfiles = stripDnsRulesFromProfilesDoc(preparedProfiles);
    return fetchJson("/cgi-bin/xray-profiles-save.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: pretty(persistedProfiles),
    });
  }).then(() => {
    return runPostSaveMaintenance(preparedProfiles.profiles, hasDnsRoutes);
  }).catch((error) => {
    return init().catch(() => null).then(() => {
      throw error;
    });
  }).finally(() => {
    setSaveInFlight(false);
  });
}

function wireEvents() {
  $("reloadBtn").addEventListener("click", function () {
    init("Список профилей и живой конфиг перечитаны с роутера.").catch((error) => showBanner("error", error.message));
  });

  if ($("saveAllBtn")) {
    $("saveAllBtn").addEventListener("click", function () {
      saveEverything()
        .then((summary) =>
          init(
            "Профили сохранены, DNS-маршруты подтверждены роутером, VPN/DNS reset выполнены" +
              (summary && summary.storm && summary.storm.resetCount
                ? ", SOCKS-шторм сброшен на " + summary.storm.resetCount + " ProxyN."
                : ".")
          )
        )
        .catch((error) => showBanner("error", error.message));
    });
  }

  if ($("dirtySaveBtn")) {
    $("dirtySaveBtn").addEventListener("click", function () {
      saveEverything()
        .then((summary) =>
          init(
            "Локальные изменения отправлены на роутер, DNS-маршруты подтверждены роутером, VPN/DNS reset выполнены" +
              (summary && summary.storm && summary.storm.resetCount
                ? ", SOCKS-шторм сброшен на " + summary.storm.resetCount + " ProxyN."
                : ".")
          )
        )
        .catch((error) => showBanner("error", error.message));
    });
  }

  if ($("dnsBulkApplyBtn")) {
    $("dnsBulkApplyBtn").addEventListener("click", function () {
      try {
        bulkAssignAssignedDnsRoutes($("dnsBulkProfileSelect") ? $("dnsBulkProfileSelect").value : "");
      } catch (error) {
        showBanner("error", error.message);
      }
    });
  }

  if ($("dnsBulkProfileSelect")) {
    $("dnsBulkProfileSelect").addEventListener("change", function () {
      renderDnsBulkControls();
    });
  }

  if ($("techPreviewDetails")) {
    $("techPreviewDetails").addEventListener("toggle", function () {
      if ($("techPreviewDetails").open) {
        renderTechnicalPreview(true);
      }
    });
  }

  $("pingAllBtn").addEventListener("click", function () {
    pingAllProfiles().catch((error) => showBanner("error", error.message));
  });

  $("openCreateBtn").addEventListener("click", function () {
    try {
      openCreateModal();
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("closeModalBtn").addEventListener("click", closeProfileModal);

  $("modalSaveBtn").addEventListener("click", function () {
    try {
      commitModalDraft();
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("replaceLinkBtn").addEventListener("click", function () {
    try {
      applyLinkToModal($("replaceLinkInput").value);
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("duplicateBtn").addEventListener("click", function () {
    try {
      duplicateModalDraft();
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("deleteBtn").addEventListener("click", function () {
    if (!state.modalProfileId) {
      return;
    }
    deleteProfile(state.modalProfileId);
  });

  $("applyProfileJsonBtn").addEventListener("click", function () {
    try {
      applyModalProfileJson();
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("autoPortBtn").addEventListener("click", function () {
    try {
      setAutoPortForModal();
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("pingSelectedBtn").addEventListener("click", function () {
    pingModalDraft()
      .then(() => showBanner("ok", "Проверка сервера завершена."))
      .catch((error) => showBanner("error", error.message));
  });

  $("unlockPortEdit").addEventListener("change", function () {
    setManualPortEdit($("unlockPortEdit").checked);
  });

  $("profileProtocol").addEventListener("change", function () {
    try {
      changeModalProtocol($("profileProtocol").value);
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  $("profileEngine").addEventListener("change", function () {
    try {
      changeModalEngine($("profileEngine").value);
    } catch (error) {
      showBanner("error", error.message);
    }
  });

  const syncIds = [
    "profileNameInput",
    "profileRouterProxyId",
    "profileEnabled",
    "profileEngine",
    "localPort",
    "serverAddress",
    "serverPort",
    "ssMethod",
    "ssPassword",
    "trojanPassword",
    "streamNetwork",
    "streamSecurity",
    "tlsServerName",
    "tlsFingerprint",
    "tlsAlpn",
    "wsHost",
    "wsPath",
    "wsUserAgent",
    "tlsAllowInsecure",
    "socksUser",
    "socksPass",
    "vxId",
    "vxSecurity",
    "vxNetwork",
    "vxServerName",
    "vxFingerprint",
    "vxFlow",
    "vxWsHost",
    "vxWsPath",
    "vxRealityPublicKey",
    "vxRealityShortId",
    "vxRealitySpiderX",
  ];

  for (const id of syncIds) {
    const node = $(id);
    if (!node) {
      continue;
    }
    node.addEventListener("input", function () {
      if (!state.modalDraft) {
        return;
      }
      try {
        syncModalDraftFromFields();
      } catch (error) {
        showBanner("error", error.message);
      }
    });
    node.addEventListener("change", function () {
      if (!state.modalDraft) {
        return;
      }
      try {
        syncModalDraftFromFields();
      } catch (error) {
        showBanner("error", error.message);
      }
    });
  }

  if ($("profileRouterProxyId")) {
    $("profileRouterProxyId").addEventListener("change", function () {
      const parsed = parseRouterProxyInputValue($("profileRouterProxyId").value);
      $("profileRouterProxyId").setCustomValidity(parsed.valid ? "" : parsed.message);
      if (!parsed.valid && $("profileRouterProxyId").value.trim()) {
        $("profileRouterProxyId").reportValidity();
      }
    });
  }

  document.addEventListener("click", function (event) {
    if (
      state.saveInFlight ||
      state.dnsRefreshInFlight ||
      state.vpnRefreshInFlight ||
      state.proxyRuntimeBusyId ||
      state.clientPolicyBusyMac
    ) {
      return;
    }
    const engineActionBtn = event.target.closest("[data-engine-action]");
    if (engineActionBtn) {
      const engine = engineActionBtn.getAttribute("data-engine");
      const action = engineActionBtn.getAttribute("data-engine-action");
      runEngineAction(engine, action)
        .then((data) => init(data.message || "Команда для движка выполнена."))
        .catch((error) => showBanner("error", error.message));
      return;
    }

    const routerActionBtn = event.target.closest("[data-router-action]");
    if (routerActionBtn) {
      if (routerActionBtn.getAttribute("data-router-action") === "dns-refresh") {
        runDnsRefresh().catch((error) => {
          state.dnsRefreshInFlight = false;
          updateBusyControls();
          renderSummary();
          showBanner("error", error.message);
        });
      } else if (routerActionBtn.getAttribute("data-router-action") === "status-refresh") {
        runStatusRefresh().catch((error) => {
          showBanner("error", error.message);
        });
      } else if (routerActionBtn.getAttribute("data-router-action") === "proxy-names-sync") {
        runProxyNamesSync().catch((error) => {
          setSaveInFlight(false);
          showBanner("error", error.message);
        });
      } else if (routerActionBtn.getAttribute("data-router-action") === "vpn-refresh") {
        runVpnRefresh().catch((error) => {
          state.vpnRefreshInFlight = false;
          updateBusyControls();
          renderSummary();
          showBanner("error", error.message);
        });
      } else if (routerActionBtn.getAttribute("data-router-action") === "clients-refresh") {
        runClientPoliciesRefresh().catch((error) => {
          showBanner("error", error.message);
        });
      }
      return;
    }

    const clientPolicyBtn = event.target.closest("[data-client-policy-apply]");
    if (clientPolicyBtn) {
      applyClientPolicy(clientPolicyBtn.getAttribute("data-client-policy-apply")).catch((error) => {
        state.clientPolicyBusyMac = "";
        updateBusyControls();
        renderClientPolicies();
        showBanner("error", error.message);
      });
      return;
    }

    const proxyRuntimeBtn = event.target.closest("[data-proxy-runtime-action]");
    if (proxyRuntimeBtn) {
      runProxyRuntimeAction(
        proxyRuntimeBtn.getAttribute("data-proxy-id"),
        proxyRuntimeBtn.getAttribute("data-proxy-runtime-action")
      ).catch((error) => {
        state.proxyRuntimeBusyId = "";
        state.proxyRuntimeBusyAction = "";
        updateBusyControls();
        renderSummary();
        renderDnsRoutesTable();
        renderProxyRuntimeTable();
        showBanner("error", error.message);
      });
      return;
    }

    const deleteBtn = event.target.closest("[data-delete-profile]");
    if (deleteBtn) {
      deleteProfile(deleteBtn.getAttribute("data-delete-profile"));
      return;
    }

    const toggleBtn = event.target.closest("[data-toggle-profile]");
    if (toggleBtn) {
      toggleProfileEnabled(toggleBtn.getAttribute("data-toggle-profile"))
        .catch((error) => showBanner("error", error.message));
      return;
    }

    const editBtn = event.target.closest("[data-edit-profile]");
    if (editBtn) {
      try {
        openEditModal(editBtn.getAttribute("data-edit-profile"));
      } catch (error) {
        showBanner("error", error.message);
      }
      return;
    }

    const selectedAction = event.target.closest("[data-selected-action]");
    if (selectedAction) {
      const action = selectedAction.getAttribute("data-selected-action");
      if (action === "edit") {
        const selected = getSelectedProfile();
        if (selected) {
          openEditModal(selected.id);
        }
      } else if (action === "ping") {
        pingSelectedProfile()
          .then(() => showBanner("ok", "Проверка сервера завершена."))
          .catch((error) => showBanner("error", error.message));
      } else if (action === "egress") {
        testSelectedProfileEgress()
          .then(() => showBanner("ok", "Внешний IP выбранного профиля обновлён."))
          .catch((error) => showBanner("error", error.message));
      }
      return;
    }

    const row = event.target.closest("[data-select-profile]");
    if (row && !event.target.closest("button")) {
      selectProfile(row.getAttribute("data-select-profile"));
      return;
    }

    if (event.target === $("profileModal")) {
      closeProfileModal();
    }
  });

  document.addEventListener("change", function (event) {
    if (state.saveInFlight) {
      return;
    }
    const dnsSelect = event.target.closest("[data-dns-route-select]");
    if (dnsSelect) {
      try {
        setDnsRouteAssignment(
          dnsSelect.getAttribute("data-dns-route-select"),
          dnsSelect.value
        );
      } catch (error) {
        showBanner("error", error.message);
      }
    }
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.modalDraft) {
      closeProfileModal();
    }
  });

  document.addEventListener("dblclick", function (event) {
    const row = event.target.closest("[data-select-profile]");
    if (row && !event.target.closest("button")) {
      try {
        openEditModal(row.getAttribute("data-select-profile"));
      } catch (error) {
        showBanner("error", error.message);
      }
    }
  });
}

function loadSupplementalRouterState(options) {
  const opts = options || {};
  return loadDnsRoutes()
    .then((dnsData) => {
      state.routerProxies = normalizeRouterProxyList(dnsData && dnsData.proxies);
      state.routerRuntime = [];
      state.routerRuntimeLoading = false;
      state.routerRuntimeError = "";
      state.profilesDoc = mergeProfilesFromRouterProxies(state.profilesDoc, state.routerProxies, {
        preferRouterState: Boolean(opts.preferRouterState),
      });
      state.dnsRoutes = normalizeDnsRoutes(dnsData);
      state.profilesDoc = mergeDnsRulesFromRoutes(state.profilesDoc, state.dnsRoutes);
      state.dnsRoutesLoading = false;
      state.dnsRoutesError = "";
      markProfilesApplied(state.profilesDoc);
      markDnsRoutesApplied(state.dnsRoutes, state.profilesDoc.profiles);
      renderAll();
    })
    .catch((error) => {
      state.dnsRoutesLoading = false;
      state.dnsRoutesError = error.message;
      markProfilesApplied(state.profilesDoc);
      state.appliedDnsRoutesSignature = "";
      renderAll();
      showBanner("warn", "Основной интерфейс загружен, но DNS-маршруты пока не прочитались: " + error.message);
    });
}

function init(message) {
  clearBanner();
  setStartupLoading(true, "Загружаем состояние роутера и список профилей...");
  state.dnsRoutesLoading = true;
  state.dnsRoutesError = "";
  state.dnsRoutes = [];
  state.routerProxies = [];
  state.routerRuntime = [];
  state.routerRuntimeLoading = false;
  state.routerRuntimeError = "";
  state.statusSnapshotLoaded = false;
  state.systemHealth = null;
  state.systemHealthLoading = false;
  state.systemHealthError = "";
  state.appliedDnsRoutesSignature = "";
  state.clientPoliciesLoading = false;
  state.clientPoliciesError = "";
  state.clientPoliciesLoaded = false;
  state.proxyRuntimeBusyId = "";
  state.proxyRuntimeBusyAction = "";
  state.clientPolicyBusyMac = "";
  state.clientHosts = [];
  state.clientPolicies = [];
  state.clientAssignments = [];

  return Promise.all([loadStatus(), loadProfilesDoc()]).then((items) => {
    const status = items[0];
    const rawProfilesDoc = items[1];
    const storedProfiles = normalizeProfilesDoc(rawProfilesDoc);
    const hasStoredDnsRules =
      Array.isArray(rawProfilesDoc && rawProfilesDoc.profiles) &&
      rawProfilesDoc.profiles.some((profile) => Array.isArray(profile && profile.dnsRules));

    state.status = status;

    if (storedProfiles.profiles.length) {
      state.profilesDoc = stripDnsRulesFromProfilesDoc(storedProfiles);
      state.appliedProfilesSignature = "";
      ensureSelection();
      closeProfileModal();
      renderAll();
      setStartupLoading(false);

      if (message) {
        showBanner("ok", message);
      }

      return loadSupplementalRouterState();
    }

    return loadLiveConfig().then((liveConfig) => {
      state.profilesDoc = migrateProfilesFromConfig(liveConfig);
      state.appliedProfilesSignature = "";
      ensureSelection();
      closeProfileModal();
      renderAll();
      setStartupLoading(false);

      if (message) {
        showBanner("ok", message);
      }

      return loadSupplementalRouterState({ preferRouterState: true });
    });
  });
}

function bootstrap() {
  setStartupLoading(true, "Подготавливаем интерфейс и читаем данные роутера...");
  const prepare = hasExpectedLayout() ? Promise.resolve() : refreshLayoutFromServer();
  return prepare.then(() => {
    if (state.layoutReady) {
      return;
    }
    state.layoutReady = true;
    wireEvents();
    return init();
  });
}

bootstrap().catch((error) => {
  setStartupLoading(false);
  showBanner("error", error.message);
});
