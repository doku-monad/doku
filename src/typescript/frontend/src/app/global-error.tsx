"use client";

import { useEffect } from "react";

/**
 * The last-resort boundary: the root layout itself failed, so this replaces the whole document.
 *
 * Deliberately self-contained. Nothing here imports a component, a font or a stylesheet, because
 * whatever the root layout was doing when it threw may be exactly what a shared import would try
 * again — and a crashing error page leaves a blank white screen with no explanation at all. The
 * brand values are inlined for the same reason; they're duplicated from `global.css` on purpose.
 */
const CANVAS = "var(--canvas)";
const INK = "var(--ink)";
const MUTE = "var(--mute)";
const FAINT = "var(--faint)";
const LINE = "var(--line)";
const DOKU = "var(--doku)";
const SANS =
  '"Inter Tight", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: CANVAS }}>
        <main
          style={{
            minHeight: "100dvh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
            padding: "80px 16px",
            textAlign: "center",
            fontFamily: SANS,
            color: INK,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: 9999,
              background: DOKU,
              display: "grid",
              placeItems: "center",
              color: CANVAS,
              fontSize: 15,
              fontWeight: 800,
              fontStyle: "italic",
              letterSpacing: "-0.05em",
              boxShadow: "0 0 28px -6px rgba(10,228,72,0.8)",
            }}
          >
            DOKU
          </span>

          <p
            style={{
              margin: "24px 0 0",
              fontSize: 10,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              color: FAINT,
            }}
          >
            Something broke
          </p>

          <h1
            style={{
              margin: "12px 0 0",
              fontSize: 30,
              lineHeight: 1.15,
              letterSpacing: "-0.03em",
              fontWeight: 700,
              maxWidth: "18ch",
            }}
          >
            DOKU failed to load
          </h1>

          <p
            style={{
              margin: "12px 0 0",
              maxWidth: "42ch",
              fontSize: 14,
              lineHeight: 1.6,
              color: MUTE,
            }}
          >
            The app couldn&apos;t start. Reloading usually clears it; if it doesn&apos;t, the site
            is having a bad minute and it isn&apos;t you.
          </p>

          <div
            style={{
              marginTop: 28,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={reset}
              style={{
                height: 40,
                padding: "0 20px",
                borderRadius: 9999,
                border: `1px solid ${DOKU}`,
                background: "transparent",
                color: INK,
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                height: 40,
                padding: "0 20px",
                borderRadius: 9999,
                border: `1px solid ${LINE}`,
                background: "transparent",
                color: MUTE,
                fontFamily: SANS,
                fontSize: 13,
                fontWeight: 500,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              Back to markets
            </a>
          </div>

          {error.digest && (
            <p style={{ marginTop: 24, fontSize: 11, color: FAINT }}>Reference {error.digest}</p>
          )}
        </main>
      </body>
    </html>
  );
}
