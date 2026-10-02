/**
 * Copy to the clipboard, without assuming there is one.
 *
 * ## Why every call site needed this
 *
 * `navigator.clipboard` is only defined in a **secure context**. Served over `http://` on a LAN
 * address — which is how a phone reaches a laptop's dev server, and how several in-app webviews
 * load a site — the property is `undefined`, so `navigator.clipboard.writeText(x)` throws a
 * `TypeError` *synchronously*.
 *
 * That is the part the six call sites got wrong in the same way. Each wrote
 *
 *     navigator.clipboard.writeText(text).then(ok, fail)
 *
 * where `fail` is a rejection handler — and a synchronous throw never reaches it. So the click
 * handler threw, no "copied" or "copy failed" state was ever set, the control sat there looking
 * broken, and the error surfaced as an unhandled exception rather than as feedback.
 *
 * ## What this does instead
 *
 * Resolves to `true` or `false` and never throws. When the async API is missing it falls back to
 * the `document.execCommand("copy")` dance, which still works in exactly the non-secure contexts
 * where the modern API does not — a hidden `<textarea>`, a selection, one command, cleaned up.
 *
 * The fallback's `readonly` and off-screen positioning are load-bearing on iOS: a visible or
 * editable node steals focus and pops the keyboard, and `execCommand` on an unfocused selection
 * copies nothing.
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Denied by permissions policy, or the document is not focused. Fall through. */
  }

  /*
   * `finally`, because the cleanup has to survive the throw.
   *
   * `execCommand` can throw (a sandboxed iframe without `allow-modals`, a document that is not
   * focused), and with `remove()` written after it in the `try` the off-screen `<textarea>` stayed
   * appended to `<body>` — one more node per failed attempt, on a control that people press again
   * when nothing happened the first time.
   */
  let area: HTMLTextAreaElement | null = null;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area?.remove();
  }
};
