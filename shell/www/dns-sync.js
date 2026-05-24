(function () {
  const API_URL = "/cgi-bin/router-dns-github-sync.cgi";
  const state = {
    loading: false,
    exportText: "",
    rawUrl: "",
    tokenSaved: false,
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

  function parseExportText(text) {
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
        if (parts[0] === "I" && groups.has(parts[1])) {
          groups.get(parts[1]).includeCount += 1;
        }
      });

    return Array.from(groups.values()).sort((left, right) => dnsRuleOrder(left.groupId) - dnsRuleOrder(right.groupId));
  }

  function normalizeGithubUrl(value) {
    const text = String(value || "").trim();
    const blobMatch = text.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
    if (blobMatch) {
      return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}/${blobMatch[4]}`;
    }
    const rawMatch = text.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/);
    if (rawMatch) {
      return `https://raw.githubusercontent.com/${rawMatch[1]}/${rawMatch[2]}/${rawMatch[3]}/${rawMatch[4]}`;
    }
    return text;
  }

  function currentUrl() {
    const normalized = normalizeGithubUrl($("rawUrlInput") ? $("rawUrlInput").value : "");
    if ($("rawUrlInput")) {
      $("rawUrlInput").value = normalized;
    }
    return normalized;
  }

  function setBusy(busy) {
    state.loading = busy;
    [
      "reloadBtn",
      "saveUrlBtn",
      "testFetchBtn",
      "applyBtn",
      "saveTokenBtn",
      "pushCurrentBtn",
      "copyExportBtn",
      "downloadExportBtn",
    ].forEach((id) => {
      const element = $(id);
      if (element) element.disabled = busy;
    });
  }

  function renderStats(payload) {
    const container = $("githubStats");
    if (!container) return;
    const groupCount = Number(payload && payload.groupCount) || 0;
    const includeCount = Number(payload && payload.includeCount) || 0;
    const routeCount = Number(payload && payload.routeCount) || 0;
    const rawUrl = String((payload && payload.rawUrl) || state.rawUrl || "").trim();
    const tokenSaved =
      typeof (payload && payload.tokenSaved) === "boolean" ? payload.tokenSaved : Boolean(state.tokenSaved);
    state.tokenSaved = tokenSaved;
    container.innerHTML = `
      <div class="engine-inline-chip ${groupCount ? "chip-ok" : "chip-muted"}">
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
      <div class="engine-inline-chip ${rawUrl ? "chip-muted" : "chip-warn"}" title="${escapeHtml(rawUrl || "URL не сохранён")}">
        <span class="label">GitHub</span>
        <span class="value">${escapeHtml(rawUrl ? "URL задан" : "URL не задан")}</span>
      </div>
      <div class="engine-inline-chip ${tokenSaved ? "chip-muted" : "chip-warn"}">
        <span class="label">Token</span>
        <span class="value">${escapeHtml(tokenSaved ? "сохранён" : "не задан")}</span>
      </div>
    `;
    renderPushHint(rawUrl, tokenSaved);
  }

  function renderPushHint(rawUrl, tokenSaved) {
    const hint = $("pushHint");
    if (!hint) return;
    const url = String(rawUrl || state.rawUrl || "").trim();
    const target = parseGithubTarget(url);
    const parts = [];
    if (target) {
      parts.push(`Цель: ${target.owner}/${target.repo}:${target.branch}/${target.path}`);
    } else {
      parts.push("Цель GitHub пока не распознана: укажи raw URL на файл в репозитории.");
    }
    parts.push(tokenSaved ? "Token сохранён на роутере." : "Token пока не сохранён.");
    hint.textContent = parts.join(" ");
  }

  function renderGroupsTable() {
    const body = $("groupsTableBody");
    if (!body) return;
    const groups = parseExportText(state.exportText);
    if (!groups.length) {
      body.innerHTML = '<tr><td colspan="5" class="table-empty">DNS-группы пока не прочитаны.</td></tr>';
      return;
    }
    body.innerHTML = groups
      .map((group, index) => {
        const routeClass = group.route ? "status-pill status-ok tiny-status" : "status-pill status-unassigned tiny-status";
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

  function currentExportMetrics() {
    const groups = parseExportText(state.exportText);
    return {
      groupCount: groups.length,
      includeCount: groups.reduce((sum, group) => sum + group.includeCount, 0),
      routeCount: groups.filter((group) => group.route).length,
    };
  }

  function renderExport(payload) {
    state.exportText = String((payload && payload.exportText) || "");
    state.rawUrl = String((payload && payload.rawUrl) || "").trim();
    state.tokenSaved = Boolean(payload && payload.tokenSaved);
    if ($("exportText")) {
      $("exportText").value = state.exportText;
    }
    if ($("rawUrlInput") && !$("rawUrlInput").value.trim()) {
      $("rawUrlInput").value = state.rawUrl;
    }
    renderStats(payload || {});
    renderGroupsTable();
  }

  function parseGithubTarget(url) {
    const raw = normalizeGithubUrl(url);
    const match = raw.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return {
      owner: match[1],
      repo: match[2],
      branch: match[3],
      path: match[4],
    };
  }

  async function loadStatus(message) {
    setBusy(true);
    if (!message) showBanner("warn", "Читаем DNS-группы с роутера...");
    try {
      const data = await fetchJson(API_URL, { cache: "no-store" });
      renderExport(data);
      if (message) {
        showBanner("ok", message);
      } else {
        clearBanner();
      }
    } catch (error) {
      showBanner("error", "Не удалось прочитать DNS-группы: " + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveUrl() {
    const url = currentUrl();
    setBusy(true);
    showBanner("warn", "Сохраняем GitHub URL...");
    try {
      const data = await fetchJson(API_URL + "?action=save-url", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: url,
      });
      state.rawUrl = data.rawUrl || url;
      renderStats(Object.assign({}, currentExportMetrics(), { rawUrl: state.rawUrl, tokenSaved: state.tokenSaved }));
      showBanner("ok", data.message || "GitHub URL сохранён.");
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveToken() {
    const token = $("githubTokenInput") ? $("githubTokenInput").value.trim() : "";
    if (!token) {
      showBanner("error", "Вставь GitHub token перед сохранением.");
      return;
    }
    setBusy(true);
    showBanner("warn", "Сохраняем GitHub token на роутере...");
    try {
      const data = await fetchJson(API_URL + "?action=save-token", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: token,
      });
      state.tokenSaved = true;
      if ($("githubTokenInput")) {
        $("githubTokenInput").value = "";
      }
      renderStats(Object.assign({}, currentExportMetrics(), { rawUrl: state.rawUrl, tokenSaved: true }));
      showBanner("ok", data.message || "GitHub token сохранён.");
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function pushCurrentToGithub() {
    const url = currentUrl();
    const token = $("githubTokenInput") ? $("githubTokenInput").value.trim() : "";
    const target = parseGithubTarget(url);
    if (!target) {
      showBanner("error", "Укажи raw.githubusercontent.com URL на файл в репозитории.");
      return;
    }
    if (!token && !state.tokenSaved) {
      showBanner("error", "Сначала вставь token или сохрани его на роутере.");
      return;
    }
    if (
      !window.confirm(
        `Отправить текущий снимок DNS-групп с роутера в ${target.owner}/${target.repo}:${target.branch}/${target.path}?`
      )
    ) {
      return;
    }

    setBusy(true);
    showBanner("warn", "Отправляем актуальные DNS-группы с роутера в GitHub...");
    try {
      const body = [url, token].join("\n");
      const data = await fetchJson(API_URL + "?action=push-current", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
      });
      state.rawUrl = data.rawUrl || url;
      state.tokenSaved = Boolean(data.tokenSaved || state.tokenSaved);
      if ($("githubTokenInput")) {
        $("githubTokenInput").value = "";
      }
      await loadStatus(
        `${data.message || "Снимок отправлен в GitHub."} Групп: ${data.groupCount || 0}, include: ${
          data.includeCount || 0
        }.`
      );
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function testFetch() {
    const url = currentUrl();
    setBusy(true);
    showBanner("warn", "Проверяем файл на GitHub...");
    try {
      const data = await fetchJson(API_URL + "?action=fetch", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: url,
      });
      renderStats(data);
      showBanner(
        "ok",
        `GitHub-файл корректен: ${data.groupCount || 0} групп, ${data.includeCount || 0} include, ${data.routeCount || 0} маршрутов.`
      );
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyGithubSync() {
    const url = currentUrl();
    if (!url) {
      showBanner("error", "Сначала укажи GitHub raw URL.");
      return;
    }
    const replace = $("replaceMissingInput") && $("replaceMissingInput").checked;
    const warning = replace
      ? "Синхронизировать DNS-группы с GitHub и удалить группы, которых нет в файле?"
      : "Синхронизировать DNS-группы из GitHub, не трогая отсутствующие в файле группы?";
    if (!window.confirm(warning)) {
      return;
    }

    setBusy(true);
    showBanner("warn", "Скачиваем GitHub-файл и применяем DNS-группы на роутер...");
    try {
      const data = await fetchJson(API_URL + "?action=apply&replace=" + (replace ? "1" : "0"), {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: url,
      });
      await loadStatus(
        `${data.message || "DNS-группы синхронизированы."} Обновлено групп: ${data.updatedGroups || 0}, include: ${
          data.includesApplied || 0
        }.`
      );
    } catch (error) {
      showBanner("error", error.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadExport() {
    const blob = new Blob([state.exportText || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "vpn-routing-ui-dns-groups.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(state.exportText || "");
      showBanner("ok", "Снимок DNS-групп скопирован.");
    } catch (error) {
      if ($("exportText")) {
        $("exportText").focus();
        $("exportText").select();
      }
      showBanner("warn", "Не удалось скопировать автоматически, текст выделен вручную.");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if ($("reloadBtn")) $("reloadBtn").addEventListener("click", () => loadStatus("DNS-группы перечитаны."));
    if ($("saveUrlBtn")) $("saveUrlBtn").addEventListener("click", saveUrl);
    if ($("saveTokenBtn")) $("saveTokenBtn").addEventListener("click", saveToken);
    if ($("testFetchBtn")) $("testFetchBtn").addEventListener("click", testFetch);
    if ($("applyBtn")) $("applyBtn").addEventListener("click", applyGithubSync);
    if ($("pushCurrentBtn")) $("pushCurrentBtn").addEventListener("click", pushCurrentToGithub);
    if ($("downloadExportBtn")) $("downloadExportBtn").addEventListener("click", downloadExport);
    if ($("copyExportBtn")) $("copyExportBtn").addEventListener("click", copyExport);
    loadStatus();
  });
})();
