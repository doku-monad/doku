import styled from "styled-components";
import { border, layout, opacity, shadow, space, typography, variant } from "styled-system";

import { scaleVariants, variantStyles } from "./theme";
import type { ButtonProps } from "./types";

const StyledButton = styled.button<ButtonProps>`
  background-color: ${({ theme }) => theme.colors.transparent};
  border-radius: ${({ theme }) => theme.radii.semiMedium};
  font-weight: ${({ theme }) => theme.fontWeight.regular};
  font-family: ${({ theme }) => theme.fonts.pixelar};
  text-transform: uppercase;
  position: relative;
  align-items: center;
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  outline: 0;
  /* Was 'all 0.3s' — which animates layout properties too, so a pill's width tweened whenever its
   * label scrambled. Only the paint properties transition, and only for as long as a press feels. */
  transition:
    color 0.18s ease,
    background-color 0.18s ease,
    border-color 0.18s ease,
    box-shadow 0.18s ease,
    transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);

  &:focus-visible {
    outline: 2px solid var(--doku);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
    &:hover {
      transform: none;
    }
  }
  width: fit-content;
  border: 0;

  ${variant({
    prop: "scale",
    variants: scaleVariants,
  })};

  ${variantStyles};

  ${space}
  ${typography}
  ${layout}
  ${opacity}
  ${border}
  ${shadow}
`;

export default StyledButton;
