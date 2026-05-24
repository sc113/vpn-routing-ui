const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const UI_VERSION = "20260512-0108";

const SYSTEM_OUTBOUND_TAGS = new Set(["direct", "blocked"]);
const SYSTEM_OUTBOUND_PROTOCOLS = new Set(["freedom", "blackhole"]);

const PROTOCOL_LABELS = {
  shadowsocks: "Shadowsocks",
  trojan: "Trojan",
  socks: "Socks",
  vless: "VLESS",
  vmess: "VMess",
};

const state = {
  status: null,
  profilesDoc: { version: 1, profiles: [] },
  selectedId: null,
  egressResults: {},
  probeResults: {},
  pingAllInFlight: false,
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

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function showBanner(kind, text) {
  const banner = $("banner");
  banner.className = "banner show " + kind;
  banner.textContent = text;
}

function clearBanner() {
  const banner = $("banner");
  banner.className = "banner";
  banner.textContent = "";
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
    if (!response.ok) {
      throw new Error(data.error || data.message || "HTTP " + response.status);
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
      $("selectedOverview") &&
      $("profileModal") &&
      $("saveAllBtn") &&
      $("openCreateBtn")
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
  next.id = next.id || makeId();
  next.name = next.name || "Без названия";
  next.enabled = next.enabled !== false;
  next.engine = next.engine || "xray";
  next.protocol = next.protocol || "shadowsocks";
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

  return next;
}

function normalizeProfilesDoc(doc) {
  const next = clone(doc && typeof doc === "object" ? doc : {});
  next.version = 1;
  next.profiles = Array.isArray(next.profiles) ? next.profiles.map(normalizeProfile) : [];
  return next;
}

function createEmptyProfile(protocol) {
  return normalizeProfile({
    id: makeId(),
    name: protocolLabel(protocol || "shadowsocks"),
    enabled: true,
    engine: "xray",
    protocol: protocol || "shadowsocks",
    localPort: 0,
    server: defaultServer(),
    transport: defaultTransport(),
  });
}

function getProfiles() {
  return normalizeProfilesDoc(state.profilesDoc).profiles;
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
      .filter((profile) => profile.id !== skipId && profile.enabled && profile.engine === "xray")
      .map((profile) => toNumber(profile.localPort))
      .filter(Boolean)
  );

  let candidate = 2086;
  while (usedPorts.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function assignMissingPorts(doc) {
  const next = normalizeProfilesDoc(doc);
  const used = new Set(
    next.profiles
      .filter((profile) => profile.enabled && profile.engine === "xray")
      .map((profile) => toNumber(profile.localPort))
      .filter(Boolean)
  );

  for (const profile of next.profiles) {
    if (profile.engine !== "xray" || !profile.enabled || profile.localPort) {
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
  const withoutPrefix = link.replace(/^ss:\/\//, "");
  const parts = withoutPrefix.split("#");
  const mainPart = parts[0].replace(/\?+$/, "");
  const tag = decodeURIComponent(parts[1] || "") || "Shadowsocks";
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
    id: makeId(),
    name: tag,
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
  const url = new URL(link);
  const params = url.searchParams;
  return applyRouterFixes({
    id: makeId(),
    name: decodeURIComponent(url.hash.replace(/^#/, "")) || "Trojan",
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
  const url = new URL(link);
  return normalizeProfile({
    id: makeId(),
    name: decodeURIComponent(url.hash.replace(/^#/, "")) || "Socks",
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
  const url = new URL(link);
  const params = url.searchParams;
  return normalizeProfile({
    id: makeId(),
    name: decodeURIComponent(url.hash.replace(/^#/, "")) || "VLESS",
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
  const source = JSON.parse(decodeBase64Url(link.replace(/^vmess:\/\//, "")));
  return normalizeProfile({
    id: makeId(),
    name: source.ps || "VMess",
    enabled: true,
    engine: "xray",
    protocol: "vmess",
    server: {
      address: source.add || "",
      port: Number(source.port || 0),
      id: source.id || "",
    },
    transport: {
      network: source.net || "tcp",
      security: source.tls ? "tls" : "none",
      serverName: source.sni || source.host || source.add || "",
      fingerprint: "",
      alpn: [],
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
  next.id = (inbound || {}).tag || makeId();
  next.name = (outbound && outbound.tag) || protocolLabel(protocol);
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
    const outboundTag = routeByInboundTag.get(inbound.tag);
    const outbound = outbounds.find((item) => item && item.tag === outboundTag);
    if (!outbound) {
      const profile = createEmptyProfile("shadowsocks");
      profile.id = inbound.tag || makeId();
      profile.name = "Порт :" + toNumber(inbound.port);
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
            alterId: 0,
            security: "auto",
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
  const activeProfiles = prepared.profiles.filter((profile) => profile.enabled);
  const portOwner = new Map();

  for (const profile of activeProfiles) {
    if (profile.engine !== "xray") {
      throw new Error(
        'Профиль "' +
          profile.name +
          '" помечен как ' +
          profile.engine +
          ", но сейчас генерация включена только для xray."
      );
    }
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
    inbounds.push({
      protocol: "socks",
      port: profile.localPort,
      tag: "in-" + profile.id,
      settings: {
        auth: "noauth",
        udp: true,
      },
    });
    outbounds.push(buildOutboundForProfile(profile));
    rules.push({
      type: "field",
      inboundTag: ["in-" + profile.id],
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
    " с auth=noauth и UDP=on. Внутренний inbound будет привязан к " +
    profile.engine +
    " / " +
    protocolLabel(profile.protocol) +
    ". При сохранении есть проверка на дубликаты и ломающие значения."
  );
}

function resetEditorFields() {
  const defaults = {
    profileName: "",
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
    vxFlow: "",
    vxWsHost: "",
    vxWsPath: "/",
    replaceLinkInput: "",
    profileJson: "",
  };

  for (const [id, value] of Object.entries(defaults)) {
    setFieldValue(id, value);
  }
  setManualPortEdit(false);
  $("routerSocksStatic").textContent = buildRouterSocksSummary(createEmptyProfile("shadowsocks"));
  $("selectedPingStatus").innerHTML = '<span class="status-pill status-neutral">Не проверялся</span>';
  $("selectedPingDetails").textContent = "Пинг идёт прямо с роутера.";
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

function renderSummary() {
  const status = state.status || {};
  const profiles = getProfiles();
  const activeProfiles = profiles.filter((profile) => profile.enabled);
  const xrayInstalled = Boolean(status.xrayInstalled);
  const xrayRunning = Boolean(status.xrayRunning);
  const singboxInstalled = Boolean(status.singboxInstalled);
  const singboxRunning = Boolean(status.singboxRunning);
  const singboxService = Boolean(status.singboxService);
  const xrayDisabled = xrayInstalled ? "" : " disabled";
  const singboxDisabled = singboxInstalled && singboxService ? "" : " disabled";
  const xrayVersion = compactVersion(status.xrayVersion);
  const singboxVersion = compactVersion(status.singboxVersion);
  const xrayConfigPath = status.xrayConfigPath || "/opt/etc/xray/config.json";

  $("summaryGrid").innerHTML = `
    <section class="engine-row">
      <div class="engine-row-title">Xray</div>
      <div class="engine-row-bubbles">
        ${boolPill(xrayRunning, "Запущен", xrayInstalled ? "Остановлен" : "Не установлен")}
        <div class="engine-inline-chip">
          <span class="label">Ядро</span>
          <span class="value">${xrayInstalled ? "установлен" : "не установлен"}</span>
        </div>
        <div class="engine-inline-chip">
          <span class="label">Версия</span>
          <span class="value mono">${escapeHtml(xrayVersion)}</span>
        </div>
        <div class="engine-inline-chip" title="${escapeHtml(xrayConfigPath)}">
          <span class="label">Config</span>
          <span class="value mono">${escapeHtml(compactPath(xrayConfigPath))}</span>
        </div>
      </div>
      <div class="engine-row-actions">
        <button type="button" class="secondary" data-engine="xray" data-engine-action="start"${xrayDisabled}>Старт</button>
        <button type="button" class="danger" data-engine="xray" data-engine-action="stop"${xrayDisabled}>Стоп</button>
        <button type="button" class="warning" data-engine="xray" data-engine-action="restart"${xrayDisabled}>Рестарт</button>
      </div>
    </section>
    <section class="engine-row">
      <div class="engine-row-title">sing-box</div>
      <div class="engine-row-bubbles">
        ${boolPill(singboxRunning, "Запущен", singboxInstalled ? "Остановлен" : "Не установлен")}
        <div class="engine-inline-chip">
          <span class="label">Ядро</span>
          <span class="value">${singboxInstalled ? "есть в системе" : "не установлен"}</span>
        </div>
        <div class="engine-inline-chip">
          <span class="label">Версия</span>
          <span class="value mono">${escapeHtml(singboxVersion)}</span>
        </div>
        <div class="engine-inline-chip">
          <span class="label">Сервис</span>
          <span class="value">${singboxService ? "готов отдельно" : "не найден"}</span>
        </div>
      </div>
      <div class="engine-row-actions">
        <button type="button" class="secondary" data-engine="singbox" data-engine-action="start"${singboxDisabled}>Старт</button>
        <button type="button" class="danger" data-engine="singbox" data-engine-action="stop"${singboxDisabled}>Стоп</button>
        <button type="button" class="warning" data-engine="singbox" data-engine-action="restart"${singboxDisabled}>Рестарт</button>
      </div>
    </section>
    <section class="engine-row">
      <div class="engine-row-title">Профили</div>
      <div class="engine-row-bubbles">
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
          <span class="label">UI</span>
          <span class="value mono">/profiles.html</span>
        </div>
      </div>
    </section>
  `;
}

function renderProfilesTable() {
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
      return `
        <tr class="${selected}${muted}" data-select-profile="${escapeHtml(profile.id)}" title="Один клик выбирает профиль, двойной клик открывает редактор.">
          <td class="mono col-num">${index + 1}</td>
          <td>${escapeHtml(protocolLabel(profile.protocol))}</td>
          <td>${escapeHtml(profile.name)}</td>
          <td class="mono">${escapeHtml(profile.server.address || "-")}</td>
          <td class="mono">${profile.server.port ? escapeHtml(profile.server.port) : "-"}</td>
          <td>${escapeHtml(transportLabel(profile))}</td>
          <td>${escapeHtml(securityLabel(profile))}</td>
          <td class="mono">${escapeHtml(profile.engine)}</td>
          <td class="mono">${profile.localPort ? ":" + escapeHtml(profile.localPort) : "auto"}</td>
          <td class="delay-cell">${probeSummary(profile)}</td>
          <td>
            <div class="row-actions">
              <button type="button" class="secondary icon-btn" data-edit-profile="${escapeHtml(profile.id)}" title="Редактировать" aria-label="Редактировать">&#9998;</button>
              <button type="button" class="danger icon-btn" data-delete-profile="${escapeHtml(profile.id)}">&times;</button>
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
        <td colspan="11" class="table-empty">Пока нет ни одного профиля. Нажми «Добавить ключ» и открой первый профиль в отдельном окне.</td>
      </tr>
    `;
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

  container.className = "";
  container.innerHTML = `
    <div class="selected-overview-grid">
      <div class="selected-overview-card">
        <div class="label">Профиль</div>
        <div class="value">${escapeHtml(profile.name)}</div>
      </div>
      <div class="selected-overview-card">
        <div class="label">Подключение</div>
        <div class="value mono">${escapeHtml(profile.server.address || "-")}:${profile.server.port || "-"}</div>
      </div>
      <div class="selected-overview-card">
        <div class="label">Локальный socks</div>
        <div class="value mono">${profile.localPort ? ":" + escapeHtml(profile.localPort) : "авто"}</div>
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
      <button type="button" class="ghost" data-selected-action="ping">Пинг сервера</button>
      <button type="button" class="ghost" data-selected-action="egress">Внешний IP</button>
    </div>
  `;
}

function renderTechnicalPreview() {
  const selected = getSelectedProfile();
  $("selectedProfileJsonPreview").value = selected ? pretty(selected) : "";

  try {
    const previewDoc = assignMissingPorts(state.profilesDoc);
    $("generatedConfigPreview").value = pretty(buildXrayConfigFromProfiles(previewDoc));
  } catch (error) {
    $("generatedConfigPreview").value = "// " + error.message;
  }
}

function renderAll() {
  renderSummary();
  renderProfilesTable();
  renderSelectedOverview();
  renderTechnicalPreview();
}

function getModalDraft() {
  return state.modalDraft ? normalizeProfile(state.modalDraft) : null;
}

function setModalOpen(open) {
  $("profileModal").hidden = !open;
  document.body.classList.toggle("modal-open", open);
}

function renderModalStatus(profile) {
  const probe = state.probeResults[profile.id];
  $("selectedPingStatus").innerHTML = probe
    ? `<span class="status-pill ${probe.kindClass}">${escapeHtml(probe.text)}</span>`
    : '<span class="status-pill status-neutral">Не проверялся</span>';
  $("selectedPingDetails").textContent = probe ? probe.details : "Пинг идёт прямо с роутера.";
}

function updateProfileJsonArea(profile) {
  const area = $("profileJson");
  if (document.activeElement !== area) {
    area.value = pretty(profile);
  }
}

function renderModalMeta(profile) {
  $("modalTitle").textContent =
    state.modalMode === "create" ? "Новый профиль" : "Редактирование: " + profile.name;
  $("modalSubtitle").textContent =
    "Движок " +
    profile.engine +
    ", протокол " +
    protocolLabel(profile.protocol) +
    ", локальный socks " +
    (profile.localPort ? ":" + profile.localPort : "auto");
  $("routerSocksStatic").textContent = buildRouterSocksSummary(profile);
  $("duplicateBtn").hidden = state.modalMode !== "edit";
  $("deleteBtn").hidden = state.modalMode !== "edit";
  renderProtocolGroups(profile.protocol);
  renderModalStatus(profile);
  updateProfileJsonArea(profile);
}

function fillModalFields(profile) {
  resetEditorFields();

  setFieldValue("profileName", profile.name);
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

function syncModalDraftFromFields(options) {
  const current = getModalDraft();
  if (!current) {
    return null;
  }

  const next = clone(current);
  const opts = options || {};

  next.name = $("profileName").value.trim() || protocolLabel($("profileProtocol").value);
  next.enabled = $("profileEnabled").value === "true";
  next.engine = $("profileEngine").value;
  next.protocol = $("profileProtocol").value;
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
  buildXrayConfigFromProfiles(buildCandidateProfiles(next));

  if (state.modalMode === "edit") {
    replaceProfile(next);
  } else {
    pushProfile(next);
  }

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
  if (state.modalMode === "edit" && current.name) {
    parsed.name = current.name;
  }

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
  duplicated.id = makeId();
  duplicated.name = current.name + " copy";
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
    "Идёт ping",
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
  replacement.name = current.name;
  replacement.enabled = current.enabled;
  replacement.engine = current.engine;
  replacement.localPort = current.localPort || nextFreePort(state.modalMode === "edit" ? current.id : null);
  replacement.server.address = current.server.address;
  replacement.server.port = current.server.port;
  state.modalDraft = replacement;
  fillModalFields(replacement);
}

function saveEverything() {
  state.profilesDoc = assignMissingPorts(state.profilesDoc);
  const preparedProfiles = normalizeProfilesDoc(state.profilesDoc);
  const generatedConfig = buildXrayConfigFromProfiles(preparedProfiles);

  return fetchJson("/cgi-bin/xray-save.cgi", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: pretty(generatedConfig),
  }).then(() => {
    return fetchJson("/cgi-bin/xray-profiles-save.cgi", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: pretty(preparedProfiles),
    });
  });
}

function wireEvents() {
  $("reloadBtn").addEventListener("click", function () {
    init("Список профилей и живой конфиг перечитаны с роутера.").catch((error) => showBanner("error", error.message));
  });

  $("saveAllBtn").addEventListener("click", function () {
    saveEverything()
      .then(() => init("Профили сохранены, конфиг движка собран и применён."))
      .catch((error) => showBanner("error", error.message));
  });

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
  $("cancelModalBtn").addEventListener("click", closeProfileModal);

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

  const syncIds = [
    "profileName",
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

  document.addEventListener("click", function (event) {
    const engineActionBtn = event.target.closest("[data-engine-action]");
    if (engineActionBtn) {
      const engine = engineActionBtn.getAttribute("data-engine");
      const action = engineActionBtn.getAttribute("data-engine-action");
      runEngineAction(engine, action)
        .then((data) => init(data.message || "Команда для движка выполнена."))
        .catch((error) => showBanner("error", error.message));
      return;
    }

    const deleteBtn = event.target.closest("[data-delete-profile]");
    if (deleteBtn) {
      deleteProfile(deleteBtn.getAttribute("data-delete-profile"));
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

function init(message) {
  clearBanner();
  return Promise.all([loadStatus(), loadProfilesDoc(), loadLiveConfig()]).then((items) => {
    const status = items[0];
    const storedProfiles = normalizeProfilesDoc(items[1]);
    const liveConfig = items[2];

    state.status = status;
    state.profilesDoc = storedProfiles.profiles.length ? storedProfiles : migrateProfilesFromConfig(liveConfig);
    ensureSelection();
    closeProfileModal();
    renderAll();

    if (message) {
      showBanner("ok", message);
    }
  });
}

function bootstrap() {
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

bootstrap().catch((error) => showBanner("error", error.message));
