(function () {
  const API_URL = "/cgi-bin/router-dns-text-sync.cgi";
  const state = {
    loading: false,
    text: "",
    selectedGroupId: "",
  };

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
    String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .forEach((line) => {
        const parts = line.split("|");
        if (parts[0] === "G" && /^domain-list\d+$/.test(parts[1] || "")) {
          const group = ensureParsedGroup(groups, parts[1]);
          group.description = decodeBase64(parts[2] || "");
          group.route = parts[3] || "";
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
      "# vpn-routing-ui dns-groups v1",
      "# G|domain-listN|base64(name/description)|route-target",
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
        lines.push(["G", groupId, encodeBase64(group.description || ""), group.route || ""].join("|"));
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
        <span class="label">Include</span>
        <span class="value">${escapeHtml(includeCount)}</span>
      </div>
      <div class="engine-inline-chip ${routeCount ? "chip-ok" : "chip-muted"}">
        <span class="label">Маршруты</span>
        <span class="value">${escapeHtml(routeCount)}</span>
      </div>
      <div class="engine-inline-chip chip-muted">
        <span class="label">Формат</span>
        <span class="value">dns-groups v1</span>
      </div>
    `;
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
              <div class="client-device-name">${escapeHtml(group.includes.length)} include</div>
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
      <div class="field-stack">
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

    group.description = ($("groupNameInput") ? $("groupNameInput").value : "").trim() || group.groupId;
    group.includes = hostResult.hosts;
    state.selectedGroupId = group.groupId;
    renderText(serializeTransferText(groups));

    if (!applyRouter) {
      showBanner("ok", `Группа ${group.description || group.groupId} обновлена в тексте.`);
      return Promise.resolve();
    }

    return applyText();
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

  async function loadFromRouter(message) {
    setBusy(true);
    showBanner("warn", "Читаем DNS-файл с роутера...");
    try {
      const data = await fetchJson(API_URL, { cache: "no-store" });
      renderText(data.exportText || "", data);
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
        `Текст корректен: ${data.groupCount || 0} групп, ${data.includeCount || 0} include, ${data.routeCount || 0} маршрутов.`
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
        `Полностью заменить DNS-группы роутера содержимым поля? Будет применено групп: ${metrics.groupCount}, include: ${metrics.includeCount}. Перед изменением создаётся backup running-config.`
      )
    ) {
      return;
    }

    setBusy(true);
    showBanner("warn", "Применяем DNS-файл на роутер...");
    try {
      const data = await fetchJson(API_URL + "?action=apply", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: state.text,
      });
      await loadFromRouter(
        `${data.message || "DNS-файл сохранён на роутер."} Обновлено групп: ${data.updatedGroups || 0}, удалено: ${
          data.removedGroups || 0
        }, include: ${data.includesApplied || 0}.`
      );
    } catch (error) {
      showBanner("error", error.message);
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
    loadFromRouter();
  });
})();
