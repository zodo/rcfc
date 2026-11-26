// The card editor's two sides when the keyboard leaves too little room for
// both (a phone): the side being typed on stays open with all its places, the
// other one is tucked under it, only its main line showing, like the card
// under the top one in a pile. A tap on the tucked side (or Enter moving to
// it) pulls it out on top, and the two change places. With the keyboard
// closed, or room enough, the card is laid out whole.
//
// The browser doesn't shrink the page for the keyboard, it covers it
// (visualViewport is what shows), so "room" is the visual viewport's height.

/** How many turns the pencil note under a tucked side is shown for, before it retires. */
const HINT_TURNS = 3;
const TURNS_KEY = "rcfc:fold-turns";
const SWAP = { duration: 280, easing: "cubic-bezier(.3,.75,.3,1)" };

function turns(): number {
  try {
    return Number(localStorage.getItem(TURNS_KEY)) || 0;
  } catch {
    return HINT_TURNS;
  }
}
function turned(): void {
  try {
    localStorage.setItem(TURNS_KEY, String(turns() + 1));
  } catch {
    /* private mode: the note just keeps showing */
  }
}

/**
 * Fold `sides` (white, cream) of `editor` while the keyboard is open and the
 * whole card doesn't fit above it. `main` are the places a tucked side shows
 * (word, translation); `bar` is the screen's top bar, kept where it shows;
 * `hint` is the pencil note on a tucked cream side. Stops by itself once
 * the editor leaves the page.
 */
export function foldWhenTight(editor: HTMLElement, sides: [HTMLElement, HTMLElement], main: [HTMLElement, HTMLElement], bar: HTMLElement, hint: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  let folded = false;
  let open = 0;
  /** The whole card's height with the bar, measured while it lies unfolded. */
  let full = 0;
  const sideOf = (el: EventTarget | null) => sides.findIndex((s) => el instanceof Node && s.contains(el));

  const apply = () => {
    editor.classList.toggle("folded", folded);
    sides.forEach((s, i) => {
      s.classList.toggle("open", folded && i === open);
      s.classList.toggle("tucked", folded && i !== open);
    });
    hint.hidden = !(folded && open === 0 && turns() < HINT_TURNS);
  };

  /** Pull side `i` out on top: both move from where they lay to where they lie now. */
  const swap = (i: number) => {
    const before = sides.map((s) => s.getBoundingClientRect().top);
    open = i;
    apply();
    turned();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    sides.forEach((s, k) => {
      const dy = before[k] - s.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) s.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], SWAP);
    });
    // What the opened side shows besides its main line comes in as it lands.
    for (const c of sides[i].children) if (!c.contains(main[i])) (c as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: 90, fill: "backwards" });
  };

  const check = () => {
    if (!editor.isConnected) return stop();
    const keyboard = window.innerHeight - vv.height > 150;
    if (!folded) full = bar.offsetHeight + editor.offsetHeight + 24;
    const want = keyboard && full > vv.height;
    const s = sideOf(document.activeElement);
    if (s >= 0 && !folded) open = s;
    if (want !== folded) {
      folded = want;
      apply();
      // Folded, the card fits: show it from the top, the field typed in stays in view.
      if (folded) requestAnimationFrame(() => window.scrollTo({ top: 0 }));
    }
    // The browser may shift the whole page up under the keyboard: the bar stays where it shows.
    bar.style.translate = vv.offsetTop > 0 ? `0 ${vv.offsetTop}px` : "";
  };

  const onFocus = (e: FocusEvent) => {
    const s = sideOf(e.target);
    if (s < 0) return;
    if (folded && s !== open) swap(s);
    else open = s;
    // Focusing may open the keyboard: check once it has (the resize comes then), and now.
    check();
  };
  // A tap anywhere on the tucked side, not just on its line, pulls it out.
  const onDown = (e: PointerEvent) => {
    const s = sideOf(e.target);
    if (!folded || s < 0 || s === open || e.target === main[s]) return;
    e.preventDefault();
    main[s].focus();
  };

  vv.addEventListener("resize", check);
  vv.addEventListener("scroll", check);
  editor.addEventListener("focusin", onFocus);
  editor.addEventListener("pointerdown", onDown);
  const stop = () => {
    vv.removeEventListener("resize", check);
    vv.removeEventListener("scroll", check);
  };
  check();
}
