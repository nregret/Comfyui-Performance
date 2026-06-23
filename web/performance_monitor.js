import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { t } from "./i18n.js";

const EXTENSION_NAME = "ComfyUI.PerformanceMonitor";
const API_PATH = "/comfyui-performance/metrics";
const STORAGE_KEY = "comfyui-performance-monitor";
const MAX_HISTORY = 64;

const state = {
  panel: null,
  trigger: null,
  dockedBar: null,
  dockObserver: null,
  dockRetryTimer: null,
  dockPlacementQueued: false,
  dockDrag: null,
  themeObserver: null,
  themeSyncQueued: false,
  toggleButtons: new Set(),
  dockToggleInputs: new Set(),
  timer: null,
  inFlight: false,
  freeingVram: false,
  paused: false,
  intervalMs: 2000,
  history: {
    cpu: [],
    memory: [],
    gpu: [],
    disk: [],
  },
  previousDiskIo: null,
  latest: null,
};

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function savePrefs(nextPrefs) {
  const prefs = { ...loadPrefs(), ...nextPrefs };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function formatBytes(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return t("n/a");
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = Number(value);
  let unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : digits)} ${units[unit]}`;
}

function formatBytesPerSecond(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return t("n/a");
  }
  return `${formatBytes(value)}/s`;
}

function formatCompactBytesPerSecond(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return t("n/a");
  }
  const units = ["B", "K", "M", "G", "T"];
  let size = Number(value);
  let unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)}${units[unit]}/s`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return t("n/a");
  }
  return `${Number(value).toFixed(0)}%`;
}

function formatNumber(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return t("n/a");
  }
  return `${Number(value).toFixed(0)}${suffix}`;
}

function clampPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 0;
  }
  return Math.max(0, Math.min(100, Number(value)));
}

function levelClass(value) {
  const number = clampPercent(value);
  if (number >= 88) {
    return "is-bad";
  }
  if (number >= 70) {
    return "is-warn";
  }
  return "";
}

function pushHistory(key, value) {
  const list = state.history[key];
  list.push(clampPercent(value));
  if (list.length > MAX_HISTORY) {
    list.shift();
  }
}

function installStyle() {
  if (document.getElementById("comfy-performance-style")) {
    return;
  }
  const link = document.createElement("link");
  link.id = "comfy-performance-style";
  link.rel = "stylesheet";
  link.href = new URL("./performance_monitor.css", import.meta.url).href;
  document.head.appendChild(link);
}

function isUsefulThemeColor(value) {
  const color = String(value || "").trim();
  return color
    && color !== "transparent"
    && color !== "none"
    && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(color)
    && !/^rgba?\([^)]*,\s*0\s*\)$/i.test(color);
}

function readCssColor(style, names) {
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (isUsefulThemeColor(value)) {
      return value;
    }
  }
  return "";
}

function readElementColor(element, properties) {
  if (!(element instanceof HTMLElement) || !isVisibleElement(element)) {
    return "";
  }
  const style = getComputedStyle(element);
  for (const property of properties) {
    const value = style[property];
    if (isUsefulThemeColor(value)) {
      return value;
    }
  }
  return "";
}

function readElementBorderColor(element) {
  if (!(element instanceof HTMLElement) || !isVisibleElement(element)) {
    return "";
  }
  const style = getComputedStyle(element);
  const sides = ["Top", "Right", "Bottom", "Left"];
  for (const side of sides) {
    const width = Number.parseFloat(style[`border${side}Width`] || "0");
    const borderStyle = style[`border${side}Style`];
    const color = style[`border${side}Color`];
    if (width > 0 && borderStyle !== "none" && borderStyle !== "hidden" && isUsefulThemeColor(color)) {
      return color;
    }
  }
  return "";
}

function setThemeSample(name, value) {
  const current = document.documentElement.style.getPropertyValue(name).trim();
  if (isUsefulThemeColor(value)) {
    if (current !== value) {
      document.documentElement.style.setProperty(name, value);
    }
  } else if (current) {
    document.documentElement.style.removeProperty(name);
  }
}

function syncThemeTokens() {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle;
  const menu = findMenuContainer();
  const runControl = findRunControl(document);
  const dockShell = runControl ? findRunModuleShell(runControl) : null;
  const dockInsertion = runControl ? findToolbarInsertion(runControl) : null;
  const dockTarget = dockShell || dockInsertion?.reference || dockInsertion?.container;

  const panelBg = readElementColor(menu, ["backgroundColor"])
    || readCssColor(rootStyle, ["--comfy-menu-bg", "--p-content-background", "--bg-color"])
    || readElementColor(document.body, ["backgroundColor"]);
  const cardBg = readCssColor(rootStyle, [
    "--comfy-input-bg",
    "--p-form-field-background",
    "--component-node-widget-background",
    "--secondary-background",
  ]) || readElementColor(menu, ["backgroundColor"]) || panelBg;
  const dockBg = readElementColor(dockTarget, ["backgroundColor"])
    || readCssColor(rootStyle, ["--p-button-secondary-background", "--secondary-background"])
    || cardBg;
  const dockCardBg = readCssColor(rootStyle, [
    "--p-button-secondary-background",
    "--secondary-background",
    "--comfy-input-bg",
  ]) || readElementColor(dockTarget, ["backgroundColor"]) || cardBg;
  const borderColor = readElementBorderColor(dockTarget)
    || readElementBorderColor(menu)
    || readCssColor(rootStyle, ["--border-color", "--p-content-border-color", "--p-button-secondary-border-color"]);
  const textColor = readElementColor(menu, ["color"])
    || readCssColor(rootStyle, ["--fg-color", "--input-text", "--p-text-color"])
    || bodyStyle.color;
  const dockTextColor = readElementColor(dockTarget, ["color"])
    || readCssColor(rootStyle, ["--p-button-secondary-color", "--fg-color", "--p-text-color"])
    || textColor;
  const mutedColor = readCssColor(rootStyle, ["--descrip-text", "--p-text-muted-color", "--muted-foreground"]);

  setThemeSample("--cp-sampled-panel-bg", panelBg);
  setThemeSample("--cp-sampled-card-bg", cardBg);
  setThemeSample("--cp-sampled-docked-bg", dockBg);
  setThemeSample("--cp-sampled-docked-card-bg", dockCardBg);
  setThemeSample("--cp-sampled-docked-text-color", dockTextColor);
  setThemeSample("--cp-sampled-control-bg", cardBg);
  setThemeSample("--cp-sampled-border-color", borderColor);
  setThemeSample("--cp-sampled-text-color", textColor);
  setThemeSample("--cp-sampled-muted-color", mutedColor);
}

function queueThemeSync() {
  if (state.themeSyncQueued) {
    return;
  }
  state.themeSyncQueued = true;
  requestAnimationFrame(() => {
    state.themeSyncQueued = false;
    syncThemeTokens();
  });
}

function startThemeObserver() {
  if (state.themeObserver) {
    queueThemeSync();
    return;
  }

  state.themeObserver = new MutationObserver(() => queueThemeSync());
  state.themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme", "data-color-mode"],
  });
  if (document.body) {
    state.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-color-mode"],
    });
  }
  if (document.head) {
    state.themeObserver.observe(document.head, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "href"],
    });
  }

  window.addEventListener("focus", queueThemeSync);
  queueThemeSync();
}

function createTriggerIcon() {
  const icon = document.createElement("span");
  icon.className = "cp-trigger-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  return icon;
}

function createButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "comfy-btn cp-trigger";
  button.title = title;
  const labelEl = document.createElement("span");
  labelEl.dataset.role = "button-label";
  labelEl.textContent = label;
  button.append(createTriggerIcon(), labelEl);
  button.addEventListener("click", onClick);
  return button;
}

function setButtonLabel(button, label) {
  const labelEl = button.querySelector('[data-role="button-label"]');
  if (labelEl) {
    labelEl.textContent = label;
  } else {
    button.textContent = label;
  }
}

function installTrigger() {
  if (state.trigger?.isConnected) {
    return;
  }

  const trigger = createButton(t("Performance"), t("Open performance monitor"), () => showPanel());
  const menu = app?.ui?.menuContainer || document.querySelector(".comfy-menu") || document.querySelector("#comfy-menu");

  if (menu) {
    menu.appendChild(trigger);
  } else {
    trigger.classList.add("cp-floating-trigger");
    document.body.appendChild(trigger);
  }

  state.trigger = trigger;
  applyDockedBarPreference();
}

function isPanelOpen() {
  return Boolean(state.panel && !state.panel.classList.contains("is-hidden"));
}

function updatePanelToggleButtons() {
  const open = isPanelOpen();
  for (const button of [...state.toggleButtons]) {
    if (!button.isConnected) {
      state.toggleButtons.delete(button);
      continue;
    }
    setButtonLabel(button, open ? t("Close Monitor") : t("Open Monitor"));
    button.title = open ? t("Close performance monitor") : t("Open performance monitor");
  }
}

function togglePanel() {
  if (isPanelOpen()) {
    hidePanel();
  } else {
    showPanel();
  }
}

function createPanelToggleButton() {
  const button = createButton(t("Open Monitor"), t("Open performance monitor"), togglePanel);
  state.toggleButtons.add(button);
  updatePanelToggleButtons();
  return button;
}

function isDockedBarEnabled() {
  const prefs = loadPrefs();
  return prefs.dockInMenuBar !== false;
}

function getFloatingDockPosition() {
  const position = loadPrefs().dockFloatingPosition;
  if (!position || typeof position.left !== "number" || typeof position.top !== "number") {
    return null;
  }
  return position;
}

function setFloatingDockPosition(left, top) {
  savePrefs({
    dockFloatingPosition: {
      left: Math.round(left),
      top: Math.round(top),
    },
  });
}

function clearFloatingDockPosition() {
  const prefs = loadPrefs();
  delete prefs.dockFloatingPosition;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function setDockedBarEnabled(enabled) {
  savePrefs({ dockInMenuBar: enabled });
  if (!enabled) {
    clearFloatingDockPosition();
  }
  updateDockToggleInputs();
  applyDockedBarPreference();
}

function updateDockToggleInputs() {
  const enabled = isDockedBarEnabled();
  for (const input of [...state.dockToggleInputs]) {
    if (!input.isConnected) {
      state.dockToggleInputs.delete(input);
      continue;
    }
    input.checked = enabled;
  }
}

function createDockedBarSetting() {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  const label = document.createElement("label");
  label.className = "cp-setting-toggle";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = isDockedBarEnabled();
  input.addEventListener("change", () => setDockedBarEnabled(input.checked));

  const text = document.createElement("span");
  text.textContent = t("Dock bar in ComfyUI toolbar");

  label.append(input, text);
  cell.appendChild(label);
  row.appendChild(cell);
  state.dockToggleInputs.add(input);
  updateDockToggleInputs();
  return row;
}

function createIconButton(text, title, onClick, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = options.className ? `cp-icon-button ${options.className}` : "cp-icon-button";
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function createDockedBar() {
  const bar = document.createElement("div");
  bar.className = "cp-docked-bar";
  bar.title = t("Performance monitor");

  const handle = createDockDragHandle();
  const preview = createCompactPreview();
  preview.addEventListener("click", togglePanel);

  const actions = document.createElement("div");
  actions.className = "cp-docked-actions";
  actions.appendChild(createIconButton(t("Unload VRAM"), t("Unload models and free VRAM"), unloadVram, { className: "is-wide" }));

  bar.append(handle, preview, actions);
  enableDockDrag(bar, handle);
  return bar;
}

function ensureDockedBar() {
  if (!state.dockedBar) {
    state.dockedBar = createDockedBar();
  }
  return state.dockedBar;
}

function clampDockPosition(left, top, bar) {
  return {
    left: Math.max(8, Math.min(window.innerWidth - bar.offsetWidth - 8, left)),
    top: Math.max(8, Math.min(window.innerHeight - bar.offsetHeight - 8, top)),
  };
}

function placeFloatingDockedBar(position = getFloatingDockPosition()) {
  if (!position) {
    return false;
  }

  const bar = ensureDockedBar();
  if (bar.parentElement !== document.body) {
    document.body.appendChild(bar);
  }
  bar.classList.add("is-floating");
  bar.style.position = "fixed";
  bar.style.zIndex = "10004";

  const next = clampDockPosition(position.left, position.top, bar);
  bar.style.left = `${next.left}px`;
  bar.style.top = `${next.top}px`;
  setFloatingDockPosition(next.left, next.top);
  return true;
}

function createDockDragHandle() {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "cp-dock-handle";
  handle.title = t("Drag performance monitor");
  handle.setAttribute("aria-label", t("Drag performance monitor"));
  for (let index = 0; index < 6; index += 1) {
    handle.appendChild(document.createElement("span"));
  }
  return handle;
}

function isDockPlaceholderTarget(drag, clientX, clientY) {
  if (!drag?.placeholder?.isConnected) {
    return false;
  }

  const rect = drag.placeholder.getBoundingClientRect();
  const padding = 8;
  return clientX >= rect.left - padding
    && clientX <= rect.right + padding
    && clientY >= rect.top - padding
    && clientY <= rect.bottom + padding;
}

function setDockPlaceholderTarget(drag, target, ready = false) {
  drag.canDock = Boolean(target && ready);
  drag.placeholder.classList.toggle("is-ready", drag.canDock);

  if (!target) {
    drag.placeholder.remove();
    return false;
  }

  drag.placeholder.style.width = `${drag.placeholderWidth}px`;
  drag.placeholder.style.height = `${drag.placeholderHeight}px`;

  if (target.reference && target.reference !== drag.placeholder && target.reference !== drag.bar) {
    if (drag.placeholder.parentElement !== target.container || drag.placeholder.nextSibling !== target.reference) {
      target.container.insertBefore(drag.placeholder, target.reference);
    }
  } else if (drag.placeholder.parentElement !== target.container || drag.placeholder.nextSibling) {
    target.container.appendChild(drag.placeholder);
  }

  return true;
}

function updateDockPlaceholderForPointer(drag, clientX, clientY) {
  const target = findDockInsertionPoint();
  setDockPlaceholderTarget(drag, target, false);
  const ready = Boolean(target && isDockPlaceholderTarget(drag, clientX, clientY));
  drag.canDock = ready;
  drag.placeholder.classList.toggle("is-ready", ready);
  return ready;
}

function endDockDrag(shouldDock) {
  const drag = state.dockDrag;
  if (!drag) {
    return;
  }
  const releasedRect = drag.bar.getBoundingClientRect();

  drag.cleanup?.();
  drag.bar.classList.remove("is-dragging");
  drag.bar.style.position = "";
  drag.bar.style.left = "";
  drag.bar.style.top = "";
  drag.bar.style.width = "";
  drag.bar.style.height = "";
  drag.bar.style.zIndex = "";
  document.body.classList.remove("cp-is-docking");
  state.dockDrag = null;

  if (shouldDock) {
    clearFloatingDockPosition();
    drag.placeholder.remove();
    placeDockedBar();
  } else {
    drag.placeholder.remove();
    document.body.appendChild(drag.bar);
    drag.bar.classList.add("is-floating");
    drag.bar.style.position = "fixed";
    drag.bar.style.zIndex = "10004";
    const next = clampDockPosition(releasedRect.left, releasedRect.top, drag.bar);
    drag.bar.style.left = `${next.left}px`;
    drag.bar.style.top = `${next.top}px`;
    setFloatingDockPosition(next.left, next.top);
  }

}

function enableDockDrag(bar, handle) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.dockDrag) {
      return;
    }

    event.preventDefault();
    const rect = bar.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "cp-dock-placeholder";
    placeholder.style.width = `${rect.width}px`;
    placeholder.style.height = `${rect.height}px`;

    document.body.appendChild(bar);

    bar.classList.add("is-dragging");
    bar.classList.remove("is-floating");
    bar.style.position = "fixed";
    bar.style.left = `${rect.left}px`;
    bar.style.top = `${rect.top}px`;
    bar.style.width = `${rect.width}px`;
    bar.style.height = `${rect.height}px`;
    bar.style.zIndex = "10005";
    document.body.classList.add("cp-is-docking");

    const moveDockDrag = (moveEvent) => {
      const drag = state.dockDrag;
      if (!drag || drag.pointerId !== moveEvent.pointerId) {
        return;
      }

      moveEvent.preventDefault();
      const left = Math.max(8, Math.min(window.innerWidth - drag.bar.offsetWidth - 8, moveEvent.clientX - drag.offsetX));
      const top = Math.max(8, Math.min(window.innerHeight - drag.bar.offsetHeight - 8, moveEvent.clientY - drag.offsetY));
      drag.bar.style.left = `${left}px`;
      drag.bar.style.top = `${top}px`;
      updateDockPlaceholderForPointer(drag, moveEvent.clientX, moveEvent.clientY);
    };

    const finishDockDrag = (upEvent) => {
      const drag = state.dockDrag;
      if (!drag || drag.pointerId !== upEvent.pointerId) {
        return;
      }
      upEvent.preventDefault();
      endDockDrag(updateDockPlaceholderForPointer(drag, upEvent.clientX, upEvent.clientY));
    };

    const cancelDockDrag = (cancelEvent) => {
      const drag = state.dockDrag;
      if (drag && drag.pointerId !== cancelEvent.pointerId) {
        return;
      }
      endDockDrag(false);
    };

    document.addEventListener("pointermove", moveDockDrag, true);
    document.addEventListener("pointerup", finishDockDrag, true);
    document.addEventListener("pointercancel", cancelDockDrag, true);

    state.dockDrag = {
      bar,
      handle,
      placeholder,
      placeholderWidth: rect.width,
      placeholderHeight: rect.height,
      canDock: false,
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      cleanup: () => {
        document.removeEventListener("pointermove", moveDockDrag, true);
        document.removeEventListener("pointerup", finishDockDrag, true);
        document.removeEventListener("pointercancel", cancelDockDrag, true);
      },
    };

    updateDockPlaceholderForPointer(state.dockDrag, event.clientX, event.clientY);
  });
}

function findMenuContainer() {
  if (app?.ui?.menuContainer instanceof HTMLElement) {
    return app.ui.menuContainer;
  }
  return document.querySelector([
    "#comfy-menu",
    ".comfy-menu",
    ".comfyui-menu",
    ".comfyui-body-topbar",
    ".comfyui-workspace-bar",
    ".comfyui-topbar",
    ".comfyui-toolbar",
    ".comfyui-menu-right",
    "[data-testid='topbar']",
    "[role='toolbar']",
    ".p-toolbar",
    ".topbar",
    ".p-menubar",
  ].join(", "));
}

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
}

function getRunControlScore(element) {
  if (element.closest(".cp-docked-bar, .cp-trigger, .cp-panel")) {
    return 0;
  }
  const text = [
    element.textContent,
    element.getAttribute("title"),
    element.getAttribute("aria-label"),
    element.getAttribute("id"),
    String(element.className || ""),
    element.getAttribute("value"),
    element.dataset?.testid,
  ].filter(Boolean).join(" ").toLowerCase();

  let score = 0;
  if (text.includes("queue prompt")) score += 20;
  if (text.includes("queue")) score += 16;
  if (text.includes("运行")) score += 16;
  if (text.includes("队列")) score += 16;
  if (text.includes("run")) score += 12;
  if (text.includes("执行")) score += 10;
  if (text.includes("开始")) score += 8;
  if (text.includes("生成")) score += 8;
  if (text.includes("prompt")) score += 4;
  if (text.includes("settings")) score -= 12;
  if (text.includes("manager")) score -= 12;
  if (text.includes("history")) score -= 10;
  return score;
}

function findRunControl(root = document) {
  const controls = [...root.querySelectorAll([
    "button",
    "[role='button']",
    "input[type='button']",
    "input[type='submit']",
    ".p-button",
    "[data-pc-name='button']",
  ].join(", "))];
  let best = null;
  let bestScore = 0;
  for (const control of controls) {
    if (!isVisibleElement(control)) {
      continue;
    }
    const score = getRunControlScore(control);
    if (score > bestScore) {
      best = control;
      bestScore = score;
    }
  }
  return bestScore >= 12 ? best : null;
}

function getDirectChild(container, element) {
  let current = element;
  while (current?.parentElement && current.parentElement !== container) {
    current = current.parentElement;
  }
  return current?.parentElement === container ? current : element;
}

function isButtonCluster(element) {
  const text = [
    element.className,
    element.getAttribute("role"),
    element.getAttribute("data-pc-name"),
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("splitbutton")
    || text.includes("button-group")
    || text.includes("p-buttongroup")
    || text.includes("p-inputgroup");
}

function visibleDirectChildCount(element) {
  return [...element.children].filter((child) => child instanceof HTMLElement && isVisibleElement(child)).length;
}

function isGripLikeElement(element) {
  const text = [
    element.className,
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.getAttribute("role"),
  ].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("drag") || text.includes("grip") || text.includes("handle")) {
    return true;
  }

  const rect = element.getBoundingClientRect();
  const smallDots = [...element.querySelectorAll("span, i, svg, path, circle, rect, div")]
    .filter((child) => {
      if (!(child instanceof HTMLElement || child instanceof SVGElement)) {
        return false;
      }
      const childRect = child.getBoundingClientRect();
      return childRect.width > 0 && childRect.width <= 8 && childRect.height > 0 && childRect.height <= 8;
    }).length;
  return rect.width > 0 && rect.width <= 34 && smallDots >= 4;
}

function isRunModuleShell(element, runControl) {
  if (!element.contains(runControl) || element.classList.contains("cp-docked-bar")) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.width > 360 || rect.height <= 0 || rect.height > 96) {
    return false;
  }

  const directChildren = [...element.children].filter((child) => child instanceof HTMLElement && isVisibleElement(child));
  if (directChildren.length < 2 || directChildren.length > 6) {
    return false;
  }

  const runChild = directChildren.find((child) => child === runControl || child.contains(runControl));
  const gripChild = directChildren.find((child) => child !== runChild && isGripLikeElement(child));
  return Boolean(runChild && gripChild);
}

function findRunModuleShell(runControl) {
  let parent = runControl?.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (isRunModuleShell(parent, runControl)) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function isToolbarLike(element) {
  const text = [
    element.className,
    element.id,
    element.getAttribute("role"),
    element.getAttribute("data-testid"),
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("toolbar")
    || text.includes("topbar")
    || text.includes("menubar")
    || text.includes("menu")
    || text.includes("queue")
    || text.includes("comfyui");
}

function findToolbarInsertion(element) {
  let referenceElement = element;
  let parent = element.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    if (isRunModuleShell(parent, element)) {
      referenceElement = parent;
      parent = parent.parentElement;
      continue;
    }

    const style = getComputedStyle(parent);
    const rect = parent.getBoundingClientRect();
    const isInlineLayout = style.display.includes("flex")
      || style.display.includes("grid")
      || parent.getAttribute("role") === "toolbar";
    const toolbarSized = rect.height > 0 && rect.height <= 110 && rect.width >= 160;
    const canContainModules = visibleDirectChildCount(parent) >= 2 || isToolbarLike(parent);
    const skipInternalButtonCluster = isButtonCluster(parent);

    if (isInlineLayout && toolbarSized && canContainModules && !skipInternalButtonCluster) {
      return {
        container: parent,
        reference: getDirectChild(parent, referenceElement),
      };
    }
    parent = parent.parentElement;
  }
  return null;
}

function findDockInsertionPoint() {
  const runControl = findRunControl(document);
  if (runControl) {
    const insertion = findToolbarInsertion(runControl);
    if (insertion) {
      return {
        anchored: true,
        container: insertion.container,
        reference: insertion.reference,
      };
    }
  }

  const fallback = findMenuContainer();
  if (fallback) {
    return {
      anchored: false,
      container: fallback,
      reference: null,
    };
  }

  return null;
}

function placeDockedBar() {
  if (state.dockDrag) {
    return true;
  }

  if (placeFloatingDockedBar()) {
    return true;
  }

  const insertion = findDockInsertionPoint();
  if (!insertion) {
    return false;
  }

  const bar = ensureDockedBar();
  bar.classList.remove("is-floating");
  bar.style.position = "";
  bar.style.left = "";
  bar.style.top = "";
  bar.style.zIndex = "";

  if (insertion.reference && insertion.reference !== bar) {
    if (bar.parentElement !== insertion.container || bar.nextElementSibling !== insertion.reference) {
      insertion.container.insertBefore(bar, insertion.reference);
    }
  } else if (bar.parentElement !== insertion.container) {
    insertion.container.appendChild(bar);
  }

  queueThemeSync();
  return insertion.anchored;
}

function queueDockedBarPlacement() {
  if (!isDockedBarEnabled() || state.dockPlacementQueued || state.dockDrag) {
    return;
  }
  state.dockPlacementQueued = true;
  requestAnimationFrame(() => {
    state.dockPlacementQueued = false;
    placeDockedBar();
  });
}

function startDockObserver() {
  if (state.dockObserver || !document.body) {
    return;
  }
  state.dockObserver = new MutationObserver(() => {
    queueDockedBarPlacement();
    queueThemeSync();
  });
  state.dockObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("resize", queueDockedBarPlacement);
}

function stopDockObserver() {
  state.dockObserver?.disconnect();
  state.dockObserver = null;
  window.removeEventListener("resize", queueDockedBarPlacement);
}

function removeDockedBar() {
  if (state.dockRetryTimer) {
    window.clearTimeout(state.dockRetryTimer);
    state.dockRetryTimer = null;
  }
  stopDockObserver();
  state.dockedBar?.remove();
}

function scheduleDockedBarPlacement(attempt = 0) {
  if (!isDockedBarEnabled()) {
    return;
  }
  if (placeDockedBar()) {
    return;
  }
  if (attempt >= 24) {
    return;
  }
  state.dockRetryTimer = window.setTimeout(() => scheduleDockedBarPlacement(attempt + 1), 250);
}

function applyDockedBarPreference() {
  const enabled = isDockedBarEnabled();
  if (state.trigger) {
    state.trigger.style.display = enabled ? "none" : "";
  }

  if (enabled) {
    startDockObserver();
    scheduleDockedBarPlacement();
    startPolling();
    refreshMetrics();
  } else {
    removeDockedBar();
  }
}

function createMetricCard(id, label) {
  const card = document.createElement("section");
  card.className = "cp-card";
  card.dataset.card = id;

  const head = document.createElement("div");
  head.className = "cp-card-head";

  const labelEl = document.createElement("div");
  labelEl.className = "cp-label";
  labelEl.textContent = label;

  const pill = document.createElement("div");
  pill.className = "cp-pill";
  pill.dataset.role = "pill";
  pill.textContent = t("live");

  head.append(labelEl, pill);

  const value = document.createElement("div");
  value.className = "cp-value";
  value.dataset.role = "value";
  value.textContent = t("n/a");

  const sub = document.createElement("div");
  sub.className = "cp-sub";
  sub.dataset.role = "sub";

  const meter = document.createElement("div");
  meter.className = "cp-meter";
  const meterBar = document.createElement("span");
  meterBar.dataset.role = "meter";
  meter.appendChild(meterBar);

  const canvas = document.createElement("canvas");
  canvas.className = "cp-sparkline";
  canvas.dataset.role = "sparkline";
  canvas.width = 280;
  canvas.height = 52;

  card.append(head, value, sub, meter, canvas);
  return card;
}

function createSection(id, title) {
  const section = document.createElement("section");
  section.className = "cp-section";
  section.dataset.section = id;

  const head = document.createElement("div");
  head.className = "cp-section-head";

  const label = document.createElement("div");
  label.className = "cp-label";
  label.textContent = title;

  const pill = document.createElement("div");
  pill.className = "cp-pill";
  pill.dataset.role = "count";
  pill.textContent = "0";

  const list = document.createElement("div");
  list.className = "cp-list";
  list.dataset.role = "list";

  head.append(label, pill);
  section.append(head, list);
  return section;
}

function createCompactPreview() {
  const preview = document.createElement("div");
  preview.className = "cp-compact-preview";
  preview.dataset.role = "compact-preview";

  [
    ["cpu", t("CPU")],
    ["memory", t("RAM")],
    ["gpu", t("VRAM")],
    ["disk", t("IO")],
  ].forEach(([id, label]) => {
    const item = document.createElement("div");
    item.className = "cp-mini-stat";
    item.dataset.mini = id;

    const top = document.createElement("div");
    top.className = "cp-mini-stat-top";

    const labelEl = document.createElement("span");
    labelEl.className = "cp-mini-label";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "cp-mini-value";
    valueEl.dataset.role = "value";
    valueEl.textContent = t("n/a");

    const meter = document.createElement("div");
    meter.className = "cp-mini-meter";
    const bar = document.createElement("span");
    bar.dataset.role = "meter";
    meter.appendChild(bar);

    top.append(labelEl, valueEl);
    item.append(top, meter);
    preview.appendChild(item);
  });

  return preview;
}

function createPanel() {
  if (state.panel) {
    return state.panel;
  }

  const prefs = loadPrefs();
  state.intervalMs = Number(prefs.intervalMs || state.intervalMs);
  state.paused = Boolean(prefs.paused);

  const panel = document.createElement("aside");
  panel.className = "cp-panel is-hidden";
  panel.setAttribute("aria-label", t("Performance monitor"));
  if (prefs.position) {
    panel.style.left = prefs.position.left;
    panel.style.top = prefs.position.top;
    panel.style.right = "auto";
  }

  const header = document.createElement("header");
  header.className = "cp-header";

  const title = document.createElement("div");
  title.className = "cp-title";
  const titleText = document.createElement("strong");
  titleText.textContent = t("Performance Monitor");
  const statusLine = document.createElement("div");
  statusLine.className = "cp-status-line";
  const statusDot = document.createElement("span");
  statusDot.className = "cp-status-dot";
  statusDot.dataset.role = "status-dot";
  const statusText = document.createElement("span");
  statusText.dataset.role = "status-text";
  statusText.textContent = t("Waiting for data");
  statusLine.append(statusDot, statusText);
  title.append(titleText, statusLine);

  const actions = document.createElement("div");
  actions.className = "cp-actions";
  actions.append(
    createIconButton(t("Unload VRAM"), t("Unload models and free VRAM"), unloadVram, { className: "is-wide" }),
    createIconButton("x", t("Close performance monitor"), hidePanel),
  );

  header.append(title, actions);

  const body = document.createElement("div");
  body.className = "cp-body";

  const grid = document.createElement("div");
  grid.className = "cp-grid";
  grid.append(
    createMetricCard("cpu", t("CPU")),
    createMetricCard("memory", t("Memory")),
    createMetricCard("gpu", t("VRAM")),
    createMetricCard("disk", t("Disk I/O")),
  );

  body.append(grid, createSection("gpus", t("GPU Detail")), createSection("disks", t("Storage")));

  const footer = document.createElement("footer");
  footer.className = "cp-footer";
  const footerLeft = document.createElement("div");
  footerLeft.className = "cp-footer-left";
  const pauseButton = document.createElement("button");
  pauseButton.type = "button";
  pauseButton.dataset.role = "pause";
  pauseButton.textContent = state.paused ? t("Resume") : t("Pause");
  pauseButton.addEventListener("click", () => {
    state.paused = !state.paused;
    pauseButton.textContent = state.paused ? t("Resume") : t("Pause");
    savePrefs({ paused: state.paused });
    if (!state.paused) {
      refreshMetrics();
    }
  });
  footerLeft.appendChild(pauseButton);

  const footerRight = document.createElement("div");
  footerRight.className = "cp-footer-right";
  const intervalSelect = document.createElement("select");
  intervalSelect.title = t("Refresh interval");
  [
    [1000, "1s"],
    [2000, "2s"],
    [5000, "5s"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = label;
    option.selected = Number(value) === state.intervalMs;
    intervalSelect.appendChild(option);
  });
  intervalSelect.addEventListener("change", () => {
    state.intervalMs = Number(intervalSelect.value);
    savePrefs({ intervalMs: state.intervalMs });
    startPolling();
  });
  footerRight.append(t("Refresh"), intervalSelect);

  footer.append(footerLeft, footerRight);
  panel.append(header, body, footer);
  document.body.appendChild(panel);
  enableDrag(panel, header);

  state.panel = panel;
  return panel;
}

function enableDrag(panel, handle) {
  let start = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    start = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.pointerId) {
      return;
    }
    const nextLeft = Math.max(8, Math.min(window.innerWidth - 80, start.left + event.clientX - start.x));
    const nextTop = Math.max(8, Math.min(window.innerHeight - 48, start.top + event.clientY - start.y));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
    panel.style.right = "auto";
  });

  handle.addEventListener("pointerup", (event) => {
    if (!start || event.pointerId !== start.pointerId) {
      return;
    }
    start = null;
    savePrefs({ position: { left: panel.style.left, top: panel.style.top } });
  });
}

function showPanel() {
  const panel = createPanel();
  panel.classList.remove("is-hidden", "is-compact");
  savePrefs({ open: true, compact: false });
  updatePanelToggleButtons();
  startPolling();
  refreshMetrics();
}

function hidePanel() {
  if (state.panel) {
    state.panel.classList.add("is-hidden");
  }
  savePrefs({ open: false });
  updatePanelToggleButtons();
}

function startPolling() {
  if (state.timer) {
    window.clearInterval(state.timer);
  }
  state.timer = window.setInterval(() => {
    if (!state.paused && (isPanelOpen() || isDockedBarEnabled())) {
      refreshMetrics();
    }
  }, state.intervalMs);
}

async function refreshMetrics() {
  if (state.inFlight) {
    return;
  }
  state.inFlight = true;
  try {
    const response = await api.fetchApi(`${API_PATH}?_=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const metrics = await response.json();
    if (!metrics.ok) {
      throw new Error(metrics.error || t("Metrics unavailable"));
    }
    state.latest = metrics;
    updatePanel(metrics);
    setOnline(true);
  } catch (error) {
    setOnline(false, error.message);
  } finally {
    state.inFlight = false;
  }
}

async function unloadVram(event) {
  const button = event.currentTarget;
  if (state.freeingVram) {
    return;
  }

  state.freeingVram = true;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "...";

  try {
    const response = await api.fetchApi("/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        unload_models: true,
        free_memory: true,
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    button.textContent = "OK";
    const statusText = state.panel?.querySelector('[data-role="status-text"]');
    if (statusText) {
      statusText.textContent = t("VRAM unload requested");
    }
    window.setTimeout(() => refreshMetrics(), 800);
  } catch (error) {
    button.textContent = "ERR";
    const statusText = state.panel?.querySelector('[data-role="status-text"]');
    if (statusText) {
      statusText.textContent = t("VRAM unload failed: {message}", { message: error.message });
    }
  } finally {
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
      state.freeingVram = false;
    }, 1200);
  }
}

function setOnline(isOnline, message = "") {
  const panel = state.panel;
  if (!panel) {
    return;
  }
  const dot = panel.querySelector('[data-role="status-dot"]');
  const text = panel.querySelector('[data-role="status-text"]');
  dot?.classList.toggle("is-offline", !isOnline);
  if (text) {
    text.textContent = isOnline
      ? t("Updated {time}", { time: new Date().toLocaleTimeString() })
      : t("Offline {message}", { message });
  }
}

function updatePanel(metrics) {
  const gpus = metrics.gpus || [];
  const gpuMemoryPeak = gpus.length
    ? Math.max(...gpus.map((gpu) => Number(getGpuMemoryPercent(gpu) ?? 0)))
    : null;
  const diskIoRate = getDiskIoRate(metrics.disks?.io, metrics.timestamp);
  const diskActivity = getDiskActivityPercent(diskIoRate?.totalBps);

  pushHistory("cpu", metrics.cpu?.percent);
  pushHistory("memory", metrics.memory?.percent);
  pushHistory("gpu", gpuMemoryPeak);
  pushHistory("disk", diskActivity);

  updateMetric("cpu", {
    value: formatPercent(metrics.cpu?.percent),
    percent: metrics.cpu?.percent,
    pill: t("{count} threads", { count: metrics.cpu?.logicalCores ?? "?" }),
    sub: [
      metrics.cpu?.physicalCores ? t("{count} physical cores", { count: metrics.cpu.physicalCores }) : null,
      metrics.cpu?.frequencyMhz ? `${Math.round(metrics.cpu.frequencyMhz)} MHz` : null,
      metrics.cpu?.temperatureC ? `${metrics.cpu.temperatureC} C` : null,
    ].filter(Boolean).join(" | ") || t("CPU provider unavailable"),
    history: state.history.cpu,
  });

  updateMetric("memory", {
    value: formatPercent(metrics.memory?.percent),
    percent: metrics.memory?.percent,
    pill: formatBytes(metrics.memory?.total, 0),
    sub: t("{used} used / {free} available", {
      used: formatBytes(metrics.memory?.used),
      free: formatBytes(metrics.memory?.free),
    }),
    history: state.history.memory,
  });

  updateMetric("gpu", {
    value: gpuMemoryPeak === null ? t("n/a") : formatPercent(gpuMemoryPeak),
    percent: gpuMemoryPeak,
    pill: t("{count} GPU", { count: gpus.length }),
    sub: summarizeGpu(gpus),
    history: state.history.gpu,
  });

  updateMetric("disk", {
    value: diskIoRate?.totalBps === null || diskIoRate?.totalBps === undefined
      ? t("n/a")
      : formatBytesPerSecond(diskIoRate.totalBps),
    percent: diskActivity,
    pill: t("Read / Write"),
    sub: summarizeDiskIo(diskIoRate),
    history: state.history.disk,
  });

  updateCompactPreview({
    cpuPercent: metrics.cpu?.percent,
    memoryPercent: metrics.memory?.percent,
    gpuMemoryPercent: gpuMemoryPeak,
    diskValue: diskIoRate?.totalBps === null || diskIoRate?.totalBps === undefined
      ? t("n/a")
      : formatCompactBytesPerSecond(diskIoRate.totalBps),
    diskPercent: diskActivity,
  });

  renderGpuList(gpus);
  renderDiskList(metrics.disks?.items || []);
}

function calculatePercent(used, total) {
  if (used === null || used === undefined || !total) {
    return null;
  }
  return (Number(used) / Number(total)) * 100;
}

function getGpuMemoryPercent(gpu) {
  return gpu.memoryUsedPercent ?? calculatePercent(gpu.memoryUsed, gpu.memoryTotal) ?? gpu.memoryUtilizationPercent;
}

function getGpuMemoryTotals(gpus) {
  return gpus.reduce((total, gpu) => {
    total.used += Number(gpu.memoryUsed || 0);
    total.size += Number(gpu.memoryTotal || 0);
    return total;
  }, { used: 0, size: 0 });
}

function summarizeGpu(gpus) {
  if (!gpus.length) {
    return t("No GPU telemetry detected");
  }
  const totals = getGpuMemoryTotals(gpus);
  const coreValues = gpus
    .map((gpu) => gpu.utilizationPercent)
    .filter((value) => value !== null && value !== undefined && !Number.isNaN(Number(value)));
  const corePeak = coreValues.length ? Math.max(...coreValues.map(Number)) : null;
  return t("VRAM {used} / {total} | Core {core}", {
    used: formatBytes(totals.used),
    total: formatBytes(totals.size),
    core: formatPercent(corePeak),
  });
}

function summarizeDiskIo(io) {
  if (!io) {
    return t("Disk I/O needs psutil");
  }
  if (io.warmingUp) {
    return t("Measuring read / write rate");
  }
  return t("Read {read} | Write {write}", {
    read: formatBytesPerSecond(io.readBps),
    write: formatBytesPerSecond(io.writeBps),
  });
}

function getDiskIoRate(io, timestamp) {
  if (!io) {
    state.previousDiskIo = null;
    return null;
  }

  const current = {
    readBytes: Number(io.readBytes || 0),
    writeBytes: Number(io.writeBytes || 0),
    timestamp: Number(timestamp || Date.now() / 1000),
  };
  const previous = state.previousDiskIo;
  state.previousDiskIo = current;

  if (!previous) {
    return {
      readBps: null,
      writeBps: null,
      totalBps: null,
      warmingUp: true,
    };
  }

  const seconds = Math.max(0.001, current.timestamp - previous.timestamp);
  const readDelta = current.readBytes - previous.readBytes;
  const writeDelta = current.writeBytes - previous.writeBytes;
  if (readDelta < 0 || writeDelta < 0) {
    return {
      readBps: null,
      writeBps: null,
      totalBps: null,
      warmingUp: true,
    };
  }

  const readBps = readDelta / seconds;
  const writeBps = writeDelta / seconds;
  return {
    readBps,
    writeBps,
    totalBps: readBps + writeBps,
    warmingUp: false,
  };
}

function getDiskActivityPercent(totalBps) {
  if (totalBps === null || totalBps === undefined || Number.isNaN(Number(totalBps))) {
    return null;
  }
  if (totalBps <= 0) {
    return 0;
  }
  const mbps = totalBps / (1024 * 1024);
  return Math.min(100, (Math.log2(mbps + 1) / Math.log2(1025)) * 100);
}

function updateCompactPreview(data) {
  updateMiniStat("cpu", formatPercent(data.cpuPercent), data.cpuPercent);
  updateMiniStat("memory", formatPercent(data.memoryPercent), data.memoryPercent);
  updateMiniStat("gpu", formatPercent(data.gpuMemoryPercent), data.gpuMemoryPercent);
  updateMiniStat("disk", data.diskValue, data.diskPercent);
}

function updateMiniStat(id, value, percent) {
  const items = document.querySelectorAll(`.cp-panel [data-mini="${id}"], .cp-docked-bar [data-mini="${id}"]`);
  items.forEach((item) => {
    const valueEl = item.querySelector('[data-role="value"]');
    const meter = item.querySelector('[data-role="meter"]');

    if (valueEl) {
      valueEl.textContent = value;
      valueEl.title = value;
    }
    if (meter) {
      meter.style.width = `${clampPercent(percent)}%`;
      meter.className = levelClass(percent);
    }
  });
}

function updateMetric(id, data) {
  const card = state.panel?.querySelector(`[data-card="${id}"]`);
  if (!card) {
    return;
  }
  const value = card.querySelector('[data-role="value"]');
  const pill = card.querySelector('[data-role="pill"]');
  const sub = card.querySelector('[data-role="sub"]');
  const meter = card.querySelector('[data-role="meter"]');
  const canvas = card.querySelector('[data-role="sparkline"]');

  if (value) {
    value.textContent = data.value;
  }
  if (pill) {
    pill.textContent = data.pill;
  }
  if (sub) {
    sub.textContent = data.sub;
  }
  if (meter) {
    meter.style.width = `${clampPercent(data.percent)}%`;
    meter.className = levelClass(data.percent);
  }
  if (canvas) {
    drawSparkline(canvas, data.history, data.percent);
  }
}

function drawSparkline(canvas, values, latest) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.moveTo(0, height - 1);
  ctx.lineTo(width, height - 1);
  ctx.stroke();

  if (!values.length) {
    return;
  }

  const stroke = clampPercent(latest) >= 88 ? "#ff6b6b" : clampPercent(latest) >= 70 ? "#f1b84b" : "#31d0aa";
  const step = values.length > 1 ? width / (values.length - 1) : width;

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = index * step;
    const y = height - (clampPercent(value) / 100) * (height - 4) - 2;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
}

function renderGpuList(gpus) {
  const section = state.panel?.querySelector('[data-section="gpus"]');
  const list = section?.querySelector('[data-role="list"]');
  const count = section?.querySelector('[data-role="count"]');
  if (!section || !list) {
    return;
  }
  count.textContent = String(gpus.length);
  list.innerHTML = "";

  if (!gpus.length) {
    const empty = document.createElement("div");
    empty.className = "cp-empty";
    empty.textContent = t("No NVIDIA GPU telemetry is currently available.");
    list.appendChild(empty);
    return;
  }

  gpus.forEach((gpu) => {
    const memoryPercent = getGpuMemoryPercent(gpu);
    list.appendChild(createUsageRow({
      title: `${gpu.index ?? 0}. ${gpu.name || "GPU"}`,
      pill: t("VRAM {percent}", { percent: formatPercent(memoryPercent) }),
      percent: memoryPercent,
      meta: [
        t("VRAM {used} / {total}", {
          used: formatBytes(gpu.memoryUsed),
          total: formatBytes(gpu.memoryTotal),
        }),
        t("Core {percent}", { percent: formatPercent(gpu.utilizationPercent) }),
        gpu.memoryControllerUtilizationPercent !== null && gpu.memoryControllerUtilizationPercent !== undefined
          ? t("Mem util {percent}", { percent: formatPercent(gpu.memoryControllerUtilizationPercent) })
          : null,
        gpu.temperatureC !== null && gpu.temperatureC !== undefined ? `${formatNumber(gpu.temperatureC, " C")}` : null,
        gpu.powerDrawW !== null && gpu.powerDrawW !== undefined ? `${Number(gpu.powerDrawW).toFixed(1)} W` : null,
        gpu.source ? gpu.source : null,
      ].filter(Boolean),
    }));
  });
}

function renderDiskList(disks) {
  const section = state.panel?.querySelector('[data-section="disks"]');
  const list = section?.querySelector('[data-role="list"]');
  const count = section?.querySelector('[data-role="count"]');
  if (!section || !list) {
    return;
  }
  count.textContent = String(disks.length);
  list.innerHTML = "";

  if (!disks.length) {
    const empty = document.createElement("div");
    empty.className = "cp-empty";
    empty.textContent = t("No storage telemetry is currently available.");
    list.appendChild(empty);
    return;
  }

  disks.forEach((disk) => {
    list.appendChild(createUsageRow({
      title: disk.mountpoint || disk.device || "Volume",
      pill: disk.filesystem || "disk",
      percent: disk.percent,
      meta: [
        t("{value} used", { value: formatBytes(disk.used) }),
        t("{value} free", { value: formatBytes(disk.free) }),
        t("{value} total", { value: formatBytes(disk.total) }),
      ],
    }));
  });
}

function createUsageRow({ title, pill, percent, meta }) {
  const row = document.createElement("div");
  row.className = "cp-row";

  const main = document.createElement("div");
  main.className = "cp-row-main";
  const name = document.createElement("div");
  name.className = "cp-row-title";
  name.title = title;
  name.textContent = title;
  const badge = document.createElement("div");
  badge.className = "cp-pill";
  badge.textContent = pill;
  main.append(name, badge);

  const meter = document.createElement("div");
  meter.className = "cp-meter";
  const bar = document.createElement("span");
  bar.className = levelClass(percent);
  bar.style.width = `${clampPercent(percent)}%`;
  meter.appendChild(bar);

  const metaEl = document.createElement("div");
  metaEl.className = "cp-row-meta";
  meta.forEach((item) => {
    const span = document.createElement("span");
    span.textContent = item;
    metaEl.appendChild(span);
  });

  row.append(main, meter, metaEl);
  return row;
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    installStyle();
    startThemeObserver();

    if (app?.ui?.settings?.addSetting) {
      app.ui.settings.addSetting({
        id: "ComfyPerformance.open",
        name: t("Performance Monitor"),
        type: () => {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          const button = createPanelToggleButton();
          cell.appendChild(button);
          row.appendChild(cell);
          return row;
        },
      });
      app.ui.settings.addSetting({
        id: "ComfyPerformance.dockInMenuBar",
        name: t("Performance Dock"),
        type: () => createDockedBarSetting(),
      });
    }

    installTrigger();
    createPanel();
    applyDockedBarPreference();

    if (loadPrefs().open) {
      showPanel();
    }
  },
});
