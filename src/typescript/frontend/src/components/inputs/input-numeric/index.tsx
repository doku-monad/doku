import React, { useEffect, useRef, useState } from "react";

import { amountToField, fieldToAmount } from "@/lib/chain/amount-field";
/* The leaf module rather than the barrel — see the note in `lib/utils/format-number-string`. All
   three of these are plain string checks; the barrel would bring zod along with them. */
import {
  countDigitsAfterDecimal,
  isNumberInConstruction,
  sanitizeNumber,
} from "@/sdk/utils/validation_";

/**
 * A numeric field that holds a `bigint`.
 *
 * The two conversions it makes live in `lib/chain/amount-field`, with the post-mortem of the render
 * crash that moved them there. They are pure and this file has no test harness; that one does.
 */
export const InputNumeric = ({
  onUserInput,
  decimals,
  value,
  onSubmit,
  ...props
}: {
  className?: string;
  onUserInput?: (value: bigint) => void;
  onSubmit?: (value: bigint) => void;
  decimals?: number;
  disabled?: boolean;
  value: bigint;
}) => {
  const [input, setInput] = useState(() => amountToField(value, decimals));

  /**
   * The scale the text in the box is currently written at.
   *
   * The effect below compared `fieldToAmount(input, decimals)` against `value` — with the NEW `decimals`
   * and the OLD `input`, on the render where the scale changed. That comparison is meaningless: it
   * re-reads a string written at eighteen decimals as though it were written at six, and asks
   * whether the answer happens to equal the new amount. It is also what fed the fractional value to
   * `BigInt`.
   *
   * The trade panel changes this prop in normal use — `inputDecimals` follows the direction and the
   * pay-with choice, so flipping Buy/Sell on a USDC market moves it between 18 and 6 — which is why
   * this was reachable by pressing a button rather than by holding the app wrong.
   *
   * When the scale moves, the box is restated from `value` unconditionally. There is nothing to
   * compare, because the same digits mean a different amount than they did a render ago.
   */
  const writtenAt = useRef(decimals);

  useEffect(() => {
    if (writtenAt.current !== decimals) {
      writtenAt.current = decimals;
      setInput(amountToField(value, decimals));
      return;
    }
    if (fieldToAmount(input, decimals) !== value) {
      setInput(amountToField(value, decimals));
    }
    /* `input` is deliberately absent: this exists to pull the box back in line when the amount is
       changed from OUTSIDE it, and depending on the box's own text would fight every keystroke. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [value, decimals]);

  const onChangeText = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = sanitizeNumber(e.target.value);

    if (!isNumberInConstruction(value)) {
      return;
    }

    const decimalsInValue = countDigitsAfterDecimal(value);
    if (typeof decimals === "number" && decimalsInValue > decimals) {
      return;
    }

    setInput(value);
    if (onUserInput) {
      onUserInput(fieldToAmount(value, decimals));
    }
  };

  return (
    <input
      type="text"
      /*
       * `inputMode="decimal"`, and a default name for anything that does not pass one.
       *
       * This is the field that decides how much money moves, and it was the only unlabelled control
       * on the market page: a screen reader announced "edit text, blank", and a phone opened the
       * alphabetic keyboard for a field that accepts digits and one dot. `type` stays `text` —
       * `number` brings spinners, a locale-dependent decimal separator and `valueAsNumber`
       * rounding, none of which this component's own parser wants — so `inputMode` is what carries
       * the keyboard hint.
       *
       * Both are spread-before-`props`, so a call site that passes its own `aria-label` or
       * `inputMode` still wins.
       */
      inputMode="decimal"
      aria-label="Amount"
      onChange={(e) => onChangeText(e)}
      value={input}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onSubmit) {
          onSubmit(fieldToAmount(input, decimals));
        }
      }}
      {...props}
    />
  );
};
