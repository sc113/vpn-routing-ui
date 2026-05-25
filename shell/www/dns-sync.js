(function () {
  const API_URL = "/cgi-bin/router-dns-text-sync.cgi";
  const state = {
    loading: false,
    text: "",
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

  function dnsRuleOrder(groupId) {
    const match = String(groupId || "").match(/^domain-list(\d+)$/);
    return match ? Number(match[1]) : 999999;
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
          groups.set(parts[1], {
            groupId: parts[1],
            description: decodeBase64(parts[2] || ""),
            route: parts[3] || "",
            includeCount: 0,
          });
          return;
        }
        if (parts[0] === "I" && /^domain-list\d+$/.test(parts[1] || "")) {
          const group =
            groups.get(parts[1]) ||
            {
              groupId: parts[1],
              description: "",
              route: "",
              includeCount: 0,
            };
          group.includeCount += 1;
          groups.set(parts[1], group);
        }
      });

    return Array.from(groups.values()).sort((left, right) => dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId));
  }

  function currentMetrics() {
    const groups = parseTransferText(state.text);
    return {
      groupCount: groups.length,
      includeCount: groups.reduce((sum, group) => sum + group.includeCount, 0),
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
    if (!groups.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">Вставь DNS-файл или получи снимок с роутера.</td></tr>';
      return;
    }
    body.innerHTML = groups
      .map((group, index) => {
        const routeClass = group.route ? "status-pill status-ok tiny-status" : "status-pill status-neutral tiny-status";
        return `
          <tr>
            <td class="mono">${index + 1}</td>
            <td class="mono">${escapeHtml(group.groupId)}</td>
            <td>${escapeHtml(group.description || group.groupId)}</td>
            <td>${escapeHtml(group.includeCount)}</td>
            <td><span class="${routeClass}">${escapeHtml(group.route || "не назначен")}</span></td>
          </tr>
        `;
      })
      .join("");
  }

  function renderText(text, payload) {
    state.text = String(text || "");
    if ($("dnsText")) {
      $("dnsText").value = state.text;
    }
    renderStats(payload);
    renderGroupsTable();
  }

  function readTextArea() {
    state.text = $("dnsText") ? $("dnsText").value : "";
    renderStats();
    renderGroupsTable();
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
    loadFromRouter();
  });
})();
