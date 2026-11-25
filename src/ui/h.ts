// Tiny DOM helpers. No framework: the app has a handful of screens.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string) {
  let t = document.getElementById("toast");
  if (!t) {
    t = h("div", { id: "toast", role: "status" });
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t!.classList.remove("show"), 2400);
}

const names = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
export function langName(code: string): string {
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const LANGS = ["es", "en", "ru", "uk", "de", "fr", "it", "pt", "pl", "nl", "tr", "ja", "zh", "ko", "ar", "he", "sv", "cs"];

export function langSelect(name: string, value: string): HTMLSelectElement {
  const s = h("select", { name });
  const codes = LANGS.includes(value) ? LANGS : [value, ...LANGS];
  for (const c of codes) s.appendChild(h("option", { value: c, selected: c === value }, langName(c)));
  return s;
}

/** The speak button's icon. */
export const ICON_PEN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 2.5l2.5 2.5L6 12.5 2.5 13.5 3.5 10z"/></svg>';
export const ICON_SPEAK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5c1.3 1 2 2.2 2 3.5s-.7 2.5-2 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
