(function () {
  const API_URL = "/cgi-bin/router-system-health.cgi";
  const REQUEST_TIMEOUT_MS = 15000;

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

  function formatPercent(value, digits) {
    return toNumber(value).toFixed(typeof digits === "number" ? digits : 0) + "%";
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(999, toNumber(value)));
  }

  function normalize(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    const cpu = source.cpu && typeof source.cpu === "object" ? source.cpu : {};
    const load = source.load && typeof source.load === "object" ? source.load : {};
    const memory = source.memory && typeof source.memory === "object" ? source.memory : {};
    const processes = source.processes && typeof source.processes === "object" ? source.processes : {};
    const cores = Math.max(1, toNumber(load.cores) || 1);
    const loadOnePercent =
      load.onePercent == null ? (toNumber(load.one) * 100) / cores : toNumber(load.onePercent);
    const cpuBusy = cpu.busy == null ? 100 - toNumber(cpu.idle) : toNumber(cpu.busy);
    const processesMeasured = processes.measured !== false;
    return {
      cpuBusy: clampPercent(cpuBusy),
      loadOne: toNumber(load.one),
      loadOnePercent: clampPercent(loadOnePercent),
      memoryUsed: toNumber(memory.usedPercent),
      ndmCpu: toNumber(processes.ndmCpu),
      vpnCpu: toNumber(processes.singboxCpu) + toNumber(processes.xrayCpu),
      proxyCpu: toNumber(processes.proxyCpu),
      processesMeasured,
      sampledAt: String(source.sampledAt || "").trim(),
    };
  }

  function loadLevel(value) {
    const percent = toNumber(value);
    if (percent >= 90) return "is-critical";
    if (percent >= 75) return "is-hot";
    if (percent >= 60) return "is-warm";
    if (percent >= 50) return "is-watch";
    return "";
  }

  function row(icon, label, value, title, level) {
    const levelClass = level ? " " + level : "";
    return `
      <div class="system-health-widget-row${levelClass}" title="${escapeHtml(title || "")}">
        <div class="system-health-widget-label">
          <span aria-hidden="true">${icon}</span>
          <span>${escapeHtml(label)}</span>
        </div>
        <div class="system-health-widget-value">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function statePanel(title, hint, kind) {
    const kindClass = kind ? " " + kind : "";
    return `
      <div class="system-health-widget-state${kindClass}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(hint)}</span>
      </div>
    `;
  }

  function sampledAtLabel(value) {
    const date = new Date(String(value || ""));
    if (!Number.isFinite(date.getTime())) {
      return "Данные обновлены только что";
    }
    return "Данные обновлены в " + date.toLocaleTimeString("ru-RU");
  }

  function render(widget, state) {
    const button = widget.querySelector("[data-health-refresh]");
    const buttonText = widget.querySelector("[data-health-refresh-text]");
    const body = widget.querySelector("[data-health-body]");
    if (!body || !button) return;

    button.disabled = Boolean(state.loading);
    button.classList.toggle("is-loading", Boolean(state.loading));
    button.setAttribute("aria-busy", state.loading ? "true" : "false");
    button.title = state.loading ? "Считываем здоровье роутера" : "Обновить здоровье роутера";
    if (buttonText) {
      buttonText.textContent = state.loading
        ? "Проверяем..."
        : state.error
          ? "Повторить"
          : state.health
            ? "Обновить"
            : "Проверить";
    }

    if (state.loading) {
      body.innerHTML = statePanel(
        "Считываем нагрузку роутера...",
        "Обычно это занимает несколько секунд."
      );
      return;
    }

    if (state.error) {
      body.innerHTML = statePanel("Не удалось получить данные", state.error, "is-error");
      return;
    }

    if (!state.health) {
      body.innerHTML = statePanel(
        "Нагрузка ещё не проверена",
        "Проверка запускается только по кнопке."
      );
      return;
    }

    const health = state.health;
    let html =
      row("🧠", "CPU", formatPercent(health.cpuBusy), "Занятый CPU роутера. Чем меньше, тем спокойнее.", loadLevel(health.cpuBusy)) +
      row("📈", "Load 1м", formatPercent(health.loadOnePercent, 1), "Load average за 1 минуту в процентах от числа CPU-ядер.", loadLevel(health.loadOnePercent)) +
      row("💾", "RAM", formatPercent(health.memoryUsed, 1), "Занятая оперативная память.", loadLevel(health.memoryUsed));
    if (health.processesMeasured) {
      html +=
        row("⚙️", "NDM", formatPercent(health.ndmCpu, 1), "CPU процесса ndm/KeeneticOS.", loadLevel(health.ndmCpu)) +
        row("🚇", "VPN", formatPercent(health.vpnCpu, 1), "Суммарный CPU xray и sing-box.", loadLevel(health.vpnCpu)) +
        row("🔀", "ProxyN", formatPercent(health.proxyCpu, 1), "CPU процессов ProxyN.", loadLevel(health.proxyCpu));
    }
    html += `<div class="system-health-widget-updated">${escapeHtml(sampledAtLabel(health.sampledAt))}</div>`;
    body.innerHTML = html;
  }

  async function load(widget, state) {
    if (state.loading) return;
    state.loading = true;
    state.error = "";
    render(widget, state);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_URL, {
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.message || "HTTP " + response.status);
      }
      state.health = normalize(data);
    } catch (error) {
      state.error =
        error && error.name === "AbortError"
          ? "Роутер не ответил за 15 секунд. Повтори попытку."
          : error.message || String(error);
    } finally {
      window.clearTimeout(timeoutId);
      state.loading = false;
      render(widget, state);
    }
  }

  function init() {
    if (document.querySelector(".system-health-widget")) return;
    document.body.classList.add("has-health-widget");
    const widget = document.createElement("aside");
    widget.className = "system-health-widget";
    widget.setAttribute("aria-label", "Здоровье роутера");
    widget.innerHTML = `
      <div class="system-health-widget-head">
        <div class="system-health-widget-title">
          <span aria-hidden="true">🩺</span>
          <span>Роутер</span>
        </div>
        <button class="refresh-button refresh-button-labeled system-health-widget-refresh" type="button" data-health-refresh aria-label="Проверить здоровье роутера" title="Проверить здоровье роутера" aria-busy="false">
          <span class="refresh-button-icon" aria-hidden="true">↻</span>
          <span data-health-refresh-text>Проверить</span>
        </button>
      </div>
      <div class="system-health-widget-grid" data-health-body></div>
    `;
    const hero = document.querySelector(".hero");
    if (hero) {
      const copy = document.createElement("div");
      copy.className = "hero-copy";
      while (hero.firstChild) {
        copy.appendChild(hero.firstChild);
      }
      hero.classList.add("hero-with-health");
      hero.appendChild(copy);
      hero.appendChild(widget);
    } else {
      document.body.insertBefore(widget, document.body.firstChild);
    }
    const state = { loading: false, error: "", health: null };
    widget.querySelector("[data-health-refresh]").addEventListener("click", () => load(widget, state));
    render(widget, state);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
