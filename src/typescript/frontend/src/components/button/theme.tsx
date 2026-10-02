import Svg from "components/svg/Svg";
import { css, type DefaultTheme } from "styled-components";

import { type ButtonProps, scales } from "./types";

interface ThemedProps extends ButtonProps {
  theme: DefaultTheme;
}

export const variantStyles = ({ theme, color, variant, isLoading }: ThemedProps) => {
  return {
    /**
     * The default control: the style reference's outlined ghost pill.
     *
     * Transparent fill, a hairline border, a 100px radius and cream text. The reference is
     * emphatic that controls are never filled — the weightlessness of an outlined pill against the
     * dark stage is the whole point of the system — so the previous white-surface pill with a soft
     * shadow becomes a stroke and nothing else. Hover raises the border from the hairline to full
     * cream rather than adding a fill, which is the only emphasis the system allows.
     */
    outline: css`
      background-color: transparent;
      color: ${color ? theme.colors[color] : theme.colors.white};
      border: 1px solid var(--line);
      border-radius: 100px;

      &:not([disabled]):hover {
        color: ${theme.colors.white};
        border-color: var(--ink);
        /* Lifts by a hair rather than changing size — the row of pills stays on its baseline. */
        transform: translateY(-1px);

        ${Svg} {
          fill: ${theme.colors.white};
        }
      }

      &:not([disabled]):active {
        transform: translateY(0);
      }

      ${Svg} {
        fill: ${color ? theme.colors[color] : theme.colors.white};
      }

      &:disabled {
        color: ${!isLoading && theme.colors.lightGray};
        background-color: transparent;
        border-color: var(--line);
        cursor: not-allowed;

        ${Svg} {
          fill: ${!isLoading && theme.colors.lightGray};
        }
      }
    `,

    /**
     * The primary action. Exactly one per surface — on the market page that's Swap.
     *
     * The reference allows no filled CTA at all; its maximum chromatic escalation is a gradient
     * *stroke*, brand green into light green along 114.41deg, on an otherwise transparent pill. So
     * the primary is still unmistakably the primary — it is the only coloured edge on the page —
     * without breaking the outlined-only rule.
     *
     * The gradient is a masked pseudo-element rather than `border-image`, which ignores
     * `border-radius` and would square the pill off.
     */
    primary: css`
      position: relative;
      background-color: transparent;
      color: ${theme.colors.white};
      border: none;
      border-radius: 100px;

      &::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        padding: 1.5px;
        background: linear-gradient(114.41deg, var(--doku) 20.74%, var(--doku-ink) 65.5%);
        -webkit-mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        mask-composite: exclude;
        pointer-events: none;
      }

      ${Svg} {
        fill: ${theme.colors.white};
      }

      &:not([disabled]):hover {
        transform: translateY(-1px);
        /* A wash of the brand green at low alpha — enough to register as pressed-into, not a fill. */
        background-color: rgb(var(--doku-rgb) / 0.12);
      }

      &:not([disabled]):active {
        transform: translateY(0);
      }

      &:disabled {
        color: ${theme.colors.lightGray};
        cursor: not-allowed;

        &::before {
          background: var(--line);
        }

        ${Svg} {
          fill: ${theme.colors.lightGray};
        }
      }
    `,
  }[variant!];
};

export const scaleVariants = {
  [scales.SMALL]: {
    padding: "9px 18px",
    minWidth: 74,
    fontSize: 20,
    lineHeight: "125%",
  },
  [scales.LARGE]: {
    padding: "11px 22px",
    minWidth: 100,
    fontSize: 24,
    lineHeight: "125%",
  },
};
