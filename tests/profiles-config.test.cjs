const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Run the production parsers/serializers without bootstrapping the browser UI.
const source = fs.readFileSync(path.join(__dirname, "../shell/www/profiles.js"), "utf8");
const startup = source.lastIndexOf("bootstrap().catch((error) => {");
assert.ok(startup > 0);
function loadUI() {
  const context = vm.createContext({
    URL, Uint8Array,
    atob: value => Buffer.from(value, "base64").toString("binary"),
    document: { getElementById: () => null },
  });
  vm.runInContext(source.slice(0, startup), context);
  return context;
}
const plain = value => JSON.parse(JSON.stringify(value));
const UUID = "11111111-2222-4333-8444-555555555555";
const KEY = Buffer.alloc(32, 1).toString("base64url");
const LEGACY_KEY = Buffer.alloc(32, 2).toString("base64url");
const PASSWORD = "test:password/@%";
const SID = "0123456789abcdef";

function profile(ui, protocol, network = "tcp", security = "tls", engine = "xray") {
  return ui.normalizeProfile({
    id: "test-profile", name: "Test profile", engine, enabled: true, protocol, localPort: 32001,
    server: { address: "127.0.0.1", port: 443, method: "aes-128-gcm", password: PASSWORD,
      user: "test-user", pass: PASSWORD, id: UUID, alterId: 0, vmessSecurity: "aes-128-gcm" },
    transport: { network, security, serverName: "example.com", fingerprint: "firefox",
      alpn: network === "ws" ? ["http/1.1"] : ["h2", "http/1.1"],
      host: "ws.example.com", path: "/test", userAgent: "custom-agent", allowInsecure: false,
      realityPublicKey: KEY, realityShortId: SID, realitySpiderX: "/test" },
  });
}

test("REALITY imports both names with the same precedence as Xray", () => {
  const ui = loadUI();
  for (const realitySettings of [{ password: KEY }, { publicKey: KEY }, { password: KEY, publicKey: LEGACY_KEY }]) {
    const outbound = ui.buildOutboundForProfile(profile(ui, "vless", "tcp", "reality"));
    outbound.streamSettings.realitySettings = { ...outbound.streamSettings.realitySettings, ...realitySettings };
    if (!realitySettings.password) delete outbound.streamSettings.realitySettings.password;
    assert.equal(ui.profileFromConfigParts({}, outbound).transport.realityPublicKey, KEY);
  }
});

test("REALITY exports engine-specific fields without renaming stored profile data", () => {
  const ui = loadUI();
  const p = ui.parseVlessLink(`vless://${UUID}@127.0.0.1:443?security=reality&sni=example.com&fp=firefox&pbk=${KEY}&sid=${SID}&spx=%2Ftest&flow=xtls-rprx-vision`);
  const before = plain(p);
  const x = ui.buildOutboundForProfile(p), s = ui.buildSingboxOutboundForProfile(p);
  assert.equal(x.streamSettings.realitySettings.password, KEY);
  assert.equal(Object.hasOwn(x.streamSettings.realitySettings, "publicKey"), false);
  assert.equal(x.streamSettings.realitySettings.shortId, SID);
  assert.equal(x.settings.vnext[0].users[0].id, UUID);
  assert.equal(x.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  assert.equal(s.tls.reality.public_key, KEY);
  assert.equal(s.tls.reality.short_id, SID);
  assert.equal(s.uuid, UUID);
  assert.equal(s.flow, "xtls-rprx-vision");
  assert.deepEqual(plain(p), before);
  assert.equal(ui.profileFromConfigParts({}, x).transport.realityPublicKey, KEY);
});

for (const protocol of ["vless", "vmess", "trojan"]) {
  for (const network of ["tcp", "ws"]) {
    test(`${protocol}/${network} retains TLS settings and custom WebSocket headers`, () => {
      const ui = loadUI(), p = profile(ui, protocol, network);
      const x = ui.buildOutboundForProfile(p), s = ui.buildSingboxOutboundForProfile(p);
      const restored = ui.profileFromConfigParts({}, x);
      assert.deepEqual(plain(x.streamSettings.tlsSettings.alpn), plain(p.transport.alpn));
      assert.equal(x.streamSettings.tlsSettings.fingerprint, "firefox");
      assert.equal(Object.hasOwn(x.streamSettings.tlsSettings, "allowInsecure"), false);
      assert.deepEqual(plain(s.tls.alpn), plain(p.transport.alpn));
      assert.equal(s.tls.utls.fingerprint, "firefox");
      assert.deepEqual(plain(restored.transport.alpn), plain(p.transport.alpn));
      assert.equal(restored.transport.fingerprint, "firefox");
      if (network === "ws") {
        assert.equal(x.streamSettings.wsSettings.headers["User-Agent"], "custom-agent");
        assert.equal(s.transport.headers["User-Agent"], "custom-agent");
        assert.equal(restored.transport.host, p.transport.host);
        assert.equal(restored.transport.userAgent, "custom-agent");
      }
    });
  }
}

test("VLESS and Trojan URI TLS parameters survive import and serialization", () => {
  const ui = loadUI();
  for (const link of [
    `vless://${UUID}@127.0.0.1:443?security=tls&fp=firefox&alpn=h2%2C%20http%2F1.1`,
    "trojan://test@127.0.0.1:443?security=tls&fp=firefox&alpn=h2%2C%20http%2F1.1",
  ]) {
    const p = ui.parseLinkToProfile(link);
    assert.equal(p.transport.fingerprint, "firefox");
    assert.deepEqual(plain(p.transport.alpn), ["h2", "http/1.1"]);
    assert.deepEqual(plain(ui.buildOutboundForProfile(p).streamSettings.tlsSettings.alpn), ["h2", "http/1.1"]);
  }
});

test("Xray config imports legacy Host and case-insensitive User-Agent headers", () => {
  const ui = loadUI();
  const transport = ui.transportFromStreamSettings({
    tlsSettings: { alpn: "http/1.1" }, wsSettings: { headers: { hOsT: "legacy.example.com", "user-agent": "custom-agent" } },
  });
  assert.equal(transport.host, "legacy.example.com");
  assert.equal(transport.userAgent, "custom-agent");
  assert.deepEqual(plain(transport.alpn), ["http/1.1"]);
  assert.equal(ui.transportFromStreamSettings({ wsSettings: { host: "current.example.com", headers: { Host: "old.example.com" } } }).host, "current.example.com");
});

for (const protocol of ["vless", "vmess"]) {
  for (const engine of ["xray", "sing-box"]) {
    test(`${protocol}/${engine} editing preserves imported settings while changing the server`, () => {
      const ui = loadUI(), p = profile(ui, protocol, "ws", "tls", engine);
      p.transport.allowInsecure = true;
      const values = {
        profileNameInput: p.name, profileEnabled: "true", profileEngine: engine, profileProtocol: protocol,
        localPort: String(p.localPort), serverAddress: "new.example.com", serverPort: "8443",
        vxId: p.server.id, vxFlow: p.server.flow, vxNetwork: p.transport.network,
        vxSecurity: p.transport.security, vxServerName: p.transport.serverName, vxFingerprint: p.transport.fingerprint,
        vxWsHost: p.transport.host, vxWsPath: p.transport.path, vxRealityPublicKey: p.transport.realityPublicKey,
        vxRealityShortId: p.transport.realityShortId, vxRealitySpiderX: p.transport.realitySpiderX,
      };
      ui.document = { getElementById: id => id in values ? { value: values[id] } : null };
      ui.draft = p;
      vm.runInContext('state.modalDraft = draft; state.modalMode = "edit"; state.profilesDoc = { profiles: [draft] };', ui);
      const saved = ui.syncModalDraftFromFields({ silent: true });
      assert.equal(saved.server.address, "new.example.com");
      assert.equal(saved.server.port, 8443);
      assert.equal(saved.server.id, UUID);
      assert.deepEqual(plain(saved.transport), plain(p.transport));
      if (engine === "xray") {
        assert.throws(() => ui.buildOutboundForProfile(saved), /allowInsecure/);
      } else {
        const outbound = ui.buildSingboxOutboundForProfile(saved);
        assert.equal(outbound.transport.headers["User-Agent"], "custom-agent");
        assert.equal(outbound.tls.insecure, true);
      }
    });
  }
}

test("VMess unsupported fields fail explicitly while sing-box keeps legacy alter_id", () => {
  const ui = loadUI(), p = profile(ui, "vmess");
  const account = ui.buildOutboundForProfile(p).settings.vnext[0].users[0];
  assert.equal(Object.hasOwn(account, "alterId"), false);
  assert.equal(Object.hasOwn(account, "flow"), false);
  p.server.alterId = 64;
  assert.throws(() => ui.buildOutboundForProfile(p), /alterId=0/);
  assert.throws(() => ui.validateProfile(p), /alterId=0/);
  p.engine = "sing-box";
  assert.equal(ui.buildSingboxOutboundForProfile(p).alter_id, 64);
  assert.doesNotThrow(() => ui.validateProfile(p));
  p.server.alterId = 0;
  p.server.flow = "xtls-rprx-vision";
  assert.throws(() => ui.buildOutboundForProfile(p), /Flow/);
  assert.throws(() => ui.buildSingboxOutboundForProfile(p), /Flow/);
});

test("legacy allowInsecure survives import but cannot be silently ignored by current Xray", () => {
  const ui = loadUI(), p = profile(ui, "trojan");
  const outbound = ui.buildOutboundForProfile(p);
  outbound.streamSettings.tlsSettings.allowInsecure = true;
  const restored = ui.profileFromConfigParts({}, outbound);
  assert.equal(restored.transport.allowInsecure, true);
  assert.throws(() => ui.buildOutboundForProfile(restored), /allowInsecure/);
  assert.throws(() => ui.validateProfile(restored), /allowInsecure/);
  restored.engine = "sing-box";
  assert.doesNotThrow(() => ui.validateProfile(restored));
  assert.equal(ui.buildSingboxOutboundForProfile(restored).tls.insecure, true);
});

test("unsupported VLESS encryption and REALITY verification are rejected before losing keys", () => {
  const ui = loadUI();
  assert.throws(() => ui.parseVlessLink(`vless://${UUID}@127.0.0.1:443?encryption=unsupported`), /VLESS Encryption/);
  assert.throws(() => ui.parseVlessLink(`vless://${UUID}@127.0.0.1:443?security=reality&pqv=unsupported`), /pqv/);
  const outbound = ui.buildOutboundForProfile(profile(ui, "vless", "tcp", "reality"));
  outbound.streamSettings.realitySettings.mldsa65Verify = "unsupported";
  assert.throws(() => ui.profileFromConfigParts({}, outbound), /mldsa65Verify/);
  delete outbound.streamSettings.realitySettings.mldsa65Verify;
  outbound.settings.vnext[0].users[0].encryption = "unsupported";
  assert.throws(() => ui.profileFromConfigParts({}, outbound), /VLESS Encryption/);
});

test("passwords with URI separators roundtrip for Shadowsocks, Trojan and SOCKS", () => {
  const ui = loadUI();
  for (const link of [
    `ss://${Buffer.from("aes-128-gcm:" + PASSWORD).toString("base64url")}@127.0.0.1:443`,
    `trojan://${encodeURIComponent(PASSWORD)}@127.0.0.1:443`,
    `socks://test-user:${encodeURIComponent(PASSWORD)}@127.0.0.1:443`,
  ]) {
    const p = ui.parseLinkToProfile(link), x = ui.buildOutboundForProfile(p), s = ui.buildSingboxOutboundForProfile(p);
    const restored = ui.profileFromConfigParts({}, x);
    assert.equal(s.password, PASSWORD);
    assert.equal(p.protocol === "socks" ? restored.server.pass : restored.server.password, PASSWORD);
    if (p.protocol === "socks") assert.equal(restored.server.user, "test-user");
  }
});

test("empty WebSocket TLS options still receive existing router defaults", () => {
  const ui = loadUI(), p = profile(ui, "vless", "ws");
  p.transport.fingerprint = "";
  p.transport.alpn = [];
  p.transport.userAgent = "";
  const x = ui.buildOutboundForProfile(p);
  assert.equal(x.streamSettings.tlsSettings.fingerprint, "chrome");
  assert.deepEqual(plain(x.streamSettings.tlsSettings.alpn), ["http/1.1"]);
  assert.ok(x.streamSettings.wsSettings.headers["User-Agent"]);
});
