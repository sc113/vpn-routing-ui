(function () {
  const API_URL = "/cgi-bin/router-system-health.cgi";

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
    return {
      cpuBusy: clampPercent(100 - toNumber(cpu.idle)),
      loadOne: toNumber(load.one),
      loadOnePercent: clampPercent(loadOnePercent),
      memoryUsed: toNumber(memory.usedPercent),
      ndmCpu: toNumber(processes.ndmCpu),
      vpnCpu: toNumber(processes.singboxCpu) + toNumber(processes.xrayCpu),
      proxyCpu: toNumber(processes.proxyCpu),
      sampledAt: String(source.sampledAt || "").trim(),
    };
  }

  function row(icon, label, value, title) {
    return `
      <div class="system-health-widget-row" title="${escapeHtml(title || "")}">
        <div class="system-health-widget-label">
          <span aria-hidden="true">${icon}</span>
          <span>${escapeHtml(label)}</span>
        </div>
        <div class="system-health-widget-value">${escapeHtml(value)}</div>
      </div>
    `;
  }

  function render(widget, state) {
    const button = widget.querySelector("[data-health-refresh]");
    const body = widget.querySelector("[data-health-body]");
    if (!body || !button) return;

    button.disabled = Boolean(state.loading);
    button.classList.toggle("is-loading", Boolean(state.loading));
    button.title = state.loading ? "Считываем здоровье роутера" : "Обновить здоровье роутера";

    if (state.loading && !state.health) {
      body.innerHTML = row("⏳", "Статус", "читаем", "Считываем CPU, load, RAM и процессы.");
      return;
    }

    if (state.error && !state.health) {
      body.innerHTML = row("⚠️", "Health", "ошибка", state.error);
      return;
    }

    if (!state.health) {
      body.innerHTML = row("🩺", "Health", "нет данных", "Нажми refresh, чтобы считать состояние.");
      return;
    }

    const health = state.health;
    body.innerHTML =
      row("🧠", "CPU", formatPercent(health.cpuBusy), "Занятый CPU роутера. Чем меньше, тем спокойнее.") +
      row("📈", "Load 1м", formatPercent(health.loadOnePercent, 1), "Load average за 1 минуту в процентах от числа CPU-ядер.") +
      row("💾", "RAM", formatPercent(health.memoryUsed, 1), "Занятая оперативная память.") +
      row("⚙️", "NDM", formatPercent(health.ndmCpu, 1), "CPU процесса ndm/KeeneticOS.") +
      row("🚇", "VPN", formatPercent(health.vpnCpu, 1), "Суммарный CPU xray и sing-box.") +
      row("🔀", "ProxyN", formatPercent(health.proxyCpu, 1), "CPU процессов ProxyN.");
  }

  async function load(widget, state) {
    state.loading = true;
    state.error = "";
    render(widget, state);
    try {
      const response = await fetch(API_URL, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || data.message || "HTTP " + response.status);
      }
      state.health = normalize(data);
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
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
        <button class="refresh-button system-health-widget-refresh" type="button" data-health-refresh aria-label="Обновить здоровье роутера" title="Обновить здоровье роутера">♻️</button>
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
    load(widget, state);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
