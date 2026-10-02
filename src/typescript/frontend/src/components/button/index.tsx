"use client";

import { EXTERNAL_LINK_PROPS } from "components/link";
import SpinnerIcon from "components/svg/icons/Spinner";
import Text from "components/text";
import React from "react";
import { useScramble, type UseScrambleProps } from "use-scramble";

import { FlexGap } from "@/containers";

import { canScramble } from "./can-scramble";
import StyledButton from "./styled";
import type { ButtonProps } from "./types";

const Button = <E extends React.ElementType = "button">({
  startIcon,
  endIcon,
  children,
  isLoading = false,
  disabled = false,
  fakeDisabled = false,
  external,
  isScramble = true,
  scale = "sm",
  variant = "outline",
  scrambleProps = {},
  icon,
  ...rest
}: ButtonProps<E> & { scrambleProps?: UseScrambleProps } & {
  icon?: React.ReactNode;
  fakeDisabled?: boolean;
}): JSX.Element => {
  const isDisabled = isLoading || disabled;
  const internalProps = external ? EXTERNAL_LINK_PROPS : {};

  /**
   * Scrambling only when there is text to scramble.
   *
   * The effect writes into the DOM node, so a scrambling button renders an empty `<Text>` and lets
   * the library fill it. Handed a JSX label it stringifies it instead, and the button reads
   * "[object Object]" — which is what the live Buy button showed, in capitals, because the style
   * uppercases. A label the effect cannot handle is rendered plainly.
   */
  const scrambling = canScramble(isScramble, children);

  const { ref, replay } = useScramble({
    text: scrambling ? `${children}` : undefined,
    overdrive: false,
    speed: 0.5,
    ...scrambleProps,
  });

  const textProps = {
    textScale: "pixelHeading4" as const,
    // `darkGray` is a surface token in this palette, so a disabled label rendered in it vanished
    // against the canvas. `lightGray` is the muted *text* role and reads as properly disabled.
    //
    // The label colour also has to follow the variant: this was pinned to `dokuAccent` for every
    // button, which on the filled `primary` CTA put brand green on brand green — the launch page's
    // "Go to market" button rendered as a solid green bar with its label invisible
    // inside it. On a filled button the label takes the light ground instead.
    color:
      isDisabled || fakeDisabled
        ? ("lightGray" as const)
        : variant === "primary"
          ? ("black" as const)
          : ("dokuAccent" as const),
    textTransform: "uppercase" as const,
    fontSize:
      scale === "sm" ? ("13px" as const) : scale === "lg" ? ("14px" as const) : ("18px" as const),
  };

  return (
    <StyledButton
      {...internalProps}
      {...rest}
      variant={variant}
      type={rest.type || "button"}
      disabled={isDisabled}
      $isLoading={isLoading}
      scale={scale}
      onMouseOver={scrambling ? replay : undefined}
      onFocus={scrambling ? replay : undefined}
    >
      {isLoading ? (
        <SpinnerIcon />
      ) : (
        <>
          {React.isValidElement(startIcon) &&
            React.cloneElement(startIcon, {
              mr: "0.5rem",
            })}

          {!scrambling ? (
            <FlexGap
              gap="8px"
              onMouseOver={replay}
              justifyContent="space-between"
              className="h-[1em]"
            >
              {icon && (
                <Text {...textProps} className="flex flex-row">
                  {icon}
                </Text>
              )}
              <Text
                {...textProps}
                className="flex flex-row"
                style={
                  typeof children === "string"
                    ? { minWidth: `${children.length + 1}ch`, textAlign: "center" }
                    : {}
                }
              >
                {children}
              </Text>
            </FlexGap>
          ) : (
            <FlexGap
              gap="8px"
              onMouseOver={replay}
              className="h-[1em]"
              justifyContent="space-between"
            >
              {icon && (
                <Text {...textProps} className="flex flex-row">
                  {icon}
                </Text>
              )}
              <Text
                {...textProps}
                ref={ref}
                style={
                  typeof children === "string"
                    ? { minWidth: `${children.length + 1}ch`, textAlign: "center" }
                    : {}
                }
              />
            </FlexGap>
          )}

          {React.isValidElement(endIcon) &&
            React.cloneElement(endIcon, {
              ml: "0.5rem",
            })}
        </>
      )}
    </StyledButton>
  );
};

export default Button;
