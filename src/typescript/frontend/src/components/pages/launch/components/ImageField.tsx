"use client";

/*
 * eslint-disable @next/next/no-img-element — the preview is either a blob URL for the file the
 * launcher just chose from their own disk, or a gateway URL for a cid. Neither is a host that can
 * be allow-listed in `next.config`, and neither wants Next's optimiser in front of it.
 */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { CDN_URL } from "@/lib/env";

import { LABEL_CLASS } from "./Field";

/**
 * An image the launcher supplies, by choosing a file or dropping one on it.
 *
 * ## The drop target *is* the preview
 *
 * The first version was a dashed box containing a 64px thumbnail, a button and two lines of help —
 * four objects arranged around the thing you actually care about, with the image itself the
 * smallest of them. It read as a file input with a preview bolted on, because that is what it was.
 *
 * This is the shape every tool that does this well uses: one surface, at the aspect ratio the
 * image will actually be used at, which is empty-and-inviting before you drop and *is the image*
 * afterwards. Filled, the controls become a scrim that appears on hover — so at rest you are
 * looking at your artwork at the size it will be seen, and nothing else.
 *
 * ## Why the caller sets the height
 *
 * Because a logo and a banner sitting side by side have to be the same height or the row they are
 * in has a rectangle of nothing under the shorter one — which is precisely the dead space the
 * identity step was full of. The shape decides the *width* (square, or take the row); the caller
 * decides the height, once, for the whole row.
 *
 * ## The file is uploaded, and the value is a URI
 *
 * It used to be read into a `data:` URL and handed straight to React state. That renders perfectly
 * and cannot be launched: `LaunchParams.meta.logoURI` is capped at **128 bytes** on chain, and the
 * smallest useful data URL is four orders of magnitude past that. A launcher could fill in the
 * whole form, choose artwork, watch the preview draw it, and have the transaction refused for a
 * field nothing had mentioned.
 *
 * So choosing a file uploads it. `POST /api/uploads/image` sniffs, re-encodes, pins and registers
 * it, and `value` becomes the `ipfs://<cid>` the launch will carry — about fifty bytes.
 *
 * ## Two pictures, and only one of them is the value
 *
 * The preview is a **blob URL for the local file**, shown the instant it is chosen and kept while
 * the upload runs, so the control answers immediately over a slow connection. `value` is set only
 * when the route answers. They are separate state on purpose: a preview that was also the value is
 * exactly the bug above.
 *
 * A `value` arriving without a local file — a restored draft, a preview fixture — is drawn through
 * a gateway instead. `data:` and `http(s):` values pass through untouched, so nothing that already
 * holds one breaks.
 *
 * ## The size cap is not a formality
 *
 * The route refuses anything over 2MB before it decodes a byte, so a file rejected here is one the
 * launcher never waits on. Checking it in both places means the message arrives instantly instead
 * of after the upload.
 */

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * What the picker offers.
 *
 * All five reach the route, and all five come back as WebP: GIF is reduced to its first frame and
 * SVG is rasterised, because the upload ledger accepts only WebP, PNG and JPEG and because an SVG
 * served as an SVG is a document with script in it. Offering a format and refusing it after the
 * form is filled in is the failure this list is checked against.
 */
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

/**
 * A URI the browser can draw.
 *
 * `ipfs://` is not a scheme a browser resolves, so a cid is pointed at the configured CDN — or at a
 * public gateway where a deployment has not configured one, which is slower and still an image.
 * Anything else is already drawable and is returned unchanged.
 */
const displayable = (uri: string): string => {
  if (!uri.startsWith("ipfs://")) return uri;
  const base = (CDN_URL || "https://ipfs.io/ipfs").replace(/\/+$/, "");
  return `${base}/${uri.slice("ipfs://".length)}`;
};

/**
 * The empty target's marks, as line art rather than as emoji.
 *
 * These were `🖼️`, `🏞️` and `📥`. An emoji in a control is somebody else's illustration: it arrives
 * at whatever weight, colour and corner radius the reader's OS decided, it cannot take `currentColor`
 * so it does not respond to the drag state or the theme, and at 22px on the paper canvas the Apple
 * set renders as a small colour photograph in the middle of a monochrome form. These are 1.6-weight
 * strokes on the same grid as every other icon in the product, and they inherit the colour of the
 * state they are in.
 */
const IconFrame = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

/** A picture in a frame — the square logo target. */
const ImageGlyph = () => (
  <IconFrame>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="8.75" cy="10" r="1.6" />
    <path d="M3.5 16.4l4.2-3.7a2 2 0 0 1 2.7.06L14 16m0 0l1.9-1.7a2 2 0 0 1 2.7.05l1.9 1.75" />
  </IconFrame>
);

/** A wide scene — the banner target. Deliberately a different silhouette from the logo's. */
const BannerGlyph = () => (
  <IconFrame>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2.5" />
    <circle cx="7.6" cy="10.6" r="1.35" />
    <path d="M3 15.2l3.6-3a1.9 1.9 0 0 1 2.5.05L12.6 15m0 0l2.3-2a1.9 1.9 0 0 1 2.5.05l3.5 2.9" />
  </IconFrame>
);

/** An arrow into a tray — shown only while a file is over the target. */
const DropGlyph = () => (
  <IconFrame>
    <path d="M12 3.5v10.5" />
    <path d="M8.2 10.3 12 14.1l3.8-3.8" />
    <path d="M4.5 16.5v1.6a2.4 2.4 0 0 0 2.4 2.4h10.2a2.4 2.4 0 0 0 2.4-2.4v-1.6" />
  </IconFrame>
);

export const ImageField = ({
  label,
  emoji,
  required,
  optional,
  value,
  onChange,
  /** The target's shape: a square logo, or a wide banner that takes the row. */
  shape = "square",
  /**
   * Which shape the route re-encodes to — 512x512 for a logo, 1536x512 for a banner.
   *
   * Defaulted from `shape`, because on this form they are the same decision and a caller should
   * not have to say it twice. Overridable so a future wide field that is not a banner can say so
   * rather than silently getting a banner's crop.
   */
  kind,
  /** The drop surface's height in pixels. Set it the same for every field in a row. */
  height = 112,
  /** One line under the control, shown at rest. Omit where the group's hint already covers it. */
  hint,
}: {
  label: string;
  /** A leading glyph. Makes a column of controls scannable by shape before it is read. */
  emoji?: string;
  required?: boolean;
  /** Says so beside the label, in the same words and weight `Field` uses for its optional fields. */
  optional?: boolean;
  value: string;
  onChange: (next: string) => void;
  shape?: "square" | "wide";
  kind?: "logo" | "banner";
  height?: number;
  hint?: string;
}) => {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  /** A blob URL for the local file, shown while the upload runs. Never the submitted value. */
  const [preview, setPreview] = useState<string | null>(null);

  /* A blob URL is a document-scoped allocation, so every one that is replaced or unmounted has to
     be released or the page holds the bytes of every image the launcher tried. */
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  const shown = preview ?? (value ? displayable(value) : null);

  const take = useCallback(
    async (file: File | undefined) => {
      setError(null);
      if (!file) return;
      /* Checked here as well as in the route, so an obviously wrong file is refused instantly
         rather than after a round trip. The route's copy is the one that is authoritative — it
         reads the bytes, and this reads the browser's guess from the extension. */
      if (file.size > MAX_BYTES) {
        setError(`Too large — ${(file.size / 1024 / 1024).toFixed(1)}MB, the limit is 2MB.`);
        return;
      }

      const local = URL.createObjectURL(file);
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return local;
      });
      setUploading(true);

      try {
        const body = new FormData();
        body.set("image", file);
        body.set("kind", kind ?? (shape === "wide" ? "banner" : "logo"));

        const response = await fetch("/api/uploads/image", { method: "POST", body });
        const json = (await response.json().catch(() => ({}))) as { uri?: string; error?: string };

        if (!response.ok || !json.uri) {
          /* The preview is dropped along with the value. Leaving the picture on screen after a
             failed upload is the cruellest version of this control: it looks finished, and the
             launch reverts on an empty URI. */
          setPreview((old) => {
            if (old) URL.revokeObjectURL(old);
            return null;
          });
          onChange("");
          setError(json.error ?? "That image could not be uploaded.");
          return;
        }

        // The `ipfs://` URI, which is what the launch transaction carries.
        onChange(json.uri);
      } catch {
        setPreview((old) => {
          if (old) URL.revokeObjectURL(old);
          return null;
        });
        onChange("");
        setError("The upload could not be reached. Check your connection and try again.");
      } finally {
        setUploading(false);
      }
    },
    [onChange, kind, shape]
  );

  const open = () => input.current?.click();

  /**
   * Paste, as a third way in.
   *
   * Most artwork for a coin arrives on the clipboard — cropped in a screenshot tool, copied out of
   * a chat, generated and copied from a browser tab — and every one of those currently had to be
   * saved to disk first so it could be picked back off it. `ClipboardEvent.clipboardData.files`
   * carries the bitmap directly, so the round trip is unnecessary.
   *
   * Bound to the control rather than to the document. A window-level paste listener would swallow
   * ⌘V anywhere on a form whose other fields are a name, a ticker, a description and three URLs —
   * pasting a link into the website field would put it into the banner instead. The target is a
   * `button`, so clicking or tabbing to it focuses it and the paste lands here; the hint says so.
   */
  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      if (uploading) return;
      const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/")
      );
      if (!file) return;
      /* Only once we know there is an image: a paste with no image in it belongs to whatever the
         browser would have done with it. */
      event.preventDefault();
      void take(file);
    },
    [take, uploading]
  );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className={LABEL_CLASS}>
          {emoji && <span aria-hidden>{emoji}</span>}
          <span className="truncate">{label}</span>
          {required && (
            <span className="text-doku-ink" title="Required">
              *
            </span>
          )}
          {optional && (
            <span className="font-normal normal-case tracking-normal text-mute">optional</span>
          )}
        </span>

        {shown && !uploading && (
          <button
            type="button"
            onClick={() => {
              onChange("");
              setError(null);
              setPreview((old) => {
                if (old) URL.revokeObjectURL(old);
                return null;
              });
              if (input.current) input.current.value = "";
            }}
            className="shrink-0 font-numeric text-[12px] leading-none text-mute transition-colors hover:text-loss-ink"
          >
            Remove
          </button>
        )}
      </div>

      {/*
        One surface, at the size the row gives it.

        A `button` rather than a `div` with a click handler: this is the control, so it has to be
        reachable and operable from the keyboard without anything extra, and the file input it
        opens stays visually hidden but focusable-by-proxy through it.
      */}
      <button
        type="button"
        // Locked while an upload is in flight. A second pick would start a second request whose
        // answer could land first, so the value would be the file the launcher did not choose.
        disabled={uploading}
        onClick={open}
        onPaste={onPaste}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) void take(e.dataTransfer.files?.[0]);
        }}
        aria-label={value ? `Replace ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}
        style={{
          height,
          width: shape === "square" ? height : undefined,
          ...(shown ? undefined : { background: "var(--mat-well-bg)" }),
        }}
        /*
         * Three states, and the dragging one is unmistakable.
         *
         * It used to be a border-colour swap and a 10% wash — a change most people do not notice
         * while a file is under the cursor and their attention is on the file. Dragging now lifts
         * the whole target: a solid brand rim, a 3px brand ring standing off it, the brand wash and
         * a shadow in the brand hue. It is the only element on the page that looks like that, which
         * is what a drop target has to be at the moment it will accept something.
         *
         * `ring` rather than a thicker border, because a border participates in layout and swapping
         * 1px for 3px on hover makes the control — and the row it sits in — jump by two pixels.
         */
        className={[
          "group/drop relative overflow-hidden rounded-doku-2xl border",
          "transition-[border-color,background-color,box-shadow,transform] duration-200 ease-out",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
          shape === "square" ? "shrink-0" : "w-full",
          dragging
            ? "scale-[1.015] border-solid border-doku bg-doku/12 shadow-[0_0_0_3px_rgb(var(--doku-rgb)/0.18),0_12px_28px_-14px_rgb(var(--doku-rgb)/0.55)]"
            : shown
              ? "border-line hover:border-line-2"
              : "border-dashed border-line-2 hover:border-doku/70 hover:bg-[var(--film-1)]",
        ].join(" ")}
      >
        {shown ? (
          <>
            <img src={shown} alt="" className="h-full w-full object-cover" />
            {/* While the upload runs the scrim is permanent rather than hover-only, because the
                one thing this control must never look like is finished before it is. */}
            <span
              className={[
                "absolute inset-0 grid place-items-center bg-[var(--veil-3)] transition-opacity duration-200",
                uploading
                  ? "opacity-100"
                  : "opacity-0 group-hover/drop:opacity-100 group-focus-visible/drop:opacity-100",
              ].join(" ")}
            >
              <span className="rounded-doku-lg border border-[var(--film-4)] bg-[var(--veil-2)] px-2.5 py-1.5 font-numeric text-[12px] font-semibold uppercase tracking-[0.06em] text-pure-white backdrop-blur-sm">
                {uploading ? "Uploading…" : "Replace"}
              </span>
            </span>
          </>
        ) : (
          <span
            className={[
              "flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center transition-colors duration-200",
              dragging ? "text-doku-ink" : "text-mute group-hover/drop:text-ash",
            ].join(" ")}
          >
            <span aria-hidden className="leading-none">
              {dragging ? <DropGlyph /> : shape === "square" ? <ImageGlyph /> : <BannerGlyph />}
            </span>
            <span
              className={[
                "font-numeric text-[12px] font-semibold leading-none",
                dragging ? "text-doku-ink" : "text-ash",
              ].join(" ")}
            >
              {/* Three verbs, because there are now three ways in and the third is the one nobody
                  guesses. `Drop to upload` rather than `Drop it`: at the moment a file is over the
                  target the label should say what will happen, not cheer. */}
              {dragging ? "Drop to upload" : "Click, drop or paste"}
            </span>
            {hint && !dragging && (
              <span className="font-ui text-[12px] leading-none text-mute">{hint}</span>
            )}
          </span>
        )}

        {/* `aria-label` on the input, not only on the button that covers it. The input is
            `sr-only` but still focusable, so Tab reaches it — and without a name it announces as an
            unlabelled file picker, on the two assets a launch needs. */}
        <input
          ref={input}
          id={id}
          type="file"
          accept={ACCEPT}
          aria-label={`Choose ${label.toLowerCase()} image`}
          className="sr-only"
          onChange={(e) => void take(e.target.files?.[0])}
        />
      </button>

      {/* The hint only earns its line when something is wrong. At rest it is inside the empty
          target, where it is instruction rather than footnote.

          A container rather than a bare red sentence with an emoji in front of it. Tinted ground,
          a hairline in the same hue and the severity mark as line art: the message reads as a
          designed part of the form that is telling you something, instead of as raw output that
          escaped onto the page. Coral is used at `loss-ink` for the text (which is the AA-safe step
          in both themes) and at 10%/30% for the ground and rim, which is the same recipe the sell
          side of the trade widget and the card's negative delta chip use — one language for
          "something is wrong", everywhere. */}
      {error && (
        <Notice tone="error" alert>
          {error}
        </Notice>
      )}
    </div>
  );
};

export default ImageField;
