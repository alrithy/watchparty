/**
 * Fullscreen that keeps the player and the subtitle layer together.
 *
 * Desktop browsers and iPad take the whole player box fullscreen with the
 * Fullscreen API. iPhone Safari only offers `video.webkitEnterFullscreen()`,
 * which shows the bare <video> in Apple's own player, without our subtitle
 * overlay, so there the app pins the player box over the page instead
 * ("immersive" mode) and the video keeps playing inline.
 */

export type FullscreenMode = "standard" | "webkit" | "immersive";

type FullscreenElement = {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
};

type FullscreenDocument = {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
};

/** Which fullscreen the browser can give the player box. Never the <video>-only iOS player. */
export function pickFullscreenMode(el: FullscreenElement, doc: FullscreenDocument): FullscreenMode {
  if (doc.fullscreenEnabled && typeof el.requestFullscreen === "function") return "standard";
  if (doc.webkitFullscreenEnabled && typeof el.webkitRequestFullscreen === "function") return "webkit";
  return "immersive";
}

type ScrollDocument = {
  documentElement: { style: CSSStyleDeclaration | Record<string, string> };
  body: { style: CSSStyleDeclaration | Record<string, string> };
};

type ScrollWindow = { scrollX: number; scrollY: number; scrollTo(x: number, y: number): void };

const LOCKED_STYLES = ["overflow", "position", "top", "left", "right", "width", "overscrollBehavior"] as const;

/**
 * Stops the page behind the immersive player from scrolling. iOS Safari ignores
 * `overflow: hidden` on <body> for touch scrolling, so the body is pinned with
 * `position: fixed` at the current offset and the scroll position is restored
 * on unlock. Returns the unlock function.
 */
export function lockScroll(doc: ScrollDocument, win: ScrollWindow): () => void {
  const html = doc.documentElement.style as Record<string, string>;
  const body = doc.body.style as Record<string, string>;
  const { scrollX, scrollY } = win;
  const saved = {
    html: html.overflow,
    body: Object.fromEntries(LOCKED_STYLES.map((k) => [k, body[k]])) as Record<string, string>,
  };
  html.overflow = "hidden";
  Object.assign(body, {
    overflow: "hidden",
    position: "fixed",
    top: `${-scrollY}px`,
    left: "0",
    right: "0",
    width: "100%",
    overscrollBehavior: "none",
  });
  let locked = true;
  return () => {
    if (!locked) return;
    locked = false;
    html.overflow = saved.html;
    Object.assign(body, saved.body);
    win.scrollTo(scrollX, scrollY);
  };
}
