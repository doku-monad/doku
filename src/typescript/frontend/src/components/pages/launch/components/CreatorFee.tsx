"use client";

import { useId } from "react";

import { Switch } from "@/components/ui/switch";
import {
  clampCreatorFee,
  isAddress,
  MAX_CREATOR_FEE_PCT,
  PROTOCOL_FEE_PCT,
} from "@/lib/launch/submit";

import { Field, FIELD_CLASS, FIELD_CLASS_ERROR } from "./Field";

/**
 * An additional creator tax, and where it is paid.
 *
 * Distinct from fee routing, which decides where the creator's share of the protocol's own 1%
 * lands. This is a *second* charge, on top of that 1%, paid to a wallet the creator names — which
 * is why it is the last step and an optional one. Most launches will leave it at zero.
 *
 * ## Why the number on screen is the total, not the tax
 *
 * A launcher setting 10% is not choosing "10%" — they are choosing "every buyer pays 11% per
 * trade", and that is the number a buyer will judge the coin on. Showing only the creator's half
 * of it is how somebody ships a market at 11% round-trip cost and finds out from the first person
 * who complains. So the control states both, with the total given the weight.
 *
 * ## Why there is a cap
 *
 * The fee is permanent. A market launched at 40% is a market nobody can rescue, including its
 * creator. Ten percent is high enough to be a real revenue decision and low enough that the pair
 * still trades — see `MAX_CREATOR_FEE_PCT`.
 *
 * ## Why a slider *and* a number
 *
 * The slider is for the decision — the range is small, the resolution is coarse, and dragging it
 * shows the total moving, which is the whole point. The number is for somebody who already knows
 * they want 2.5% and should not have to hunt for it with a mouse. They edit one value.
 */
const PRESETS = [0, 1, 2.5, 5, 10] as const;

/** Where a rate stops being a fee and starts being a toll, in the copy's opinion. */
const STEEP_PCT = 5;

export const CreatorFee = ({
  value,
  onChange,
  recipient,
  onRecipientChange,
  enabled,
  onEnabledChange,
}: {
  value: number;
  onChange: (next: number) => void;
  /** Where the tax is paid. Empty means the wallet that signs the launch. */
  recipient: string;
  onRecipientChange: (next: string) => void;
  /**
   * Whether the tax exists at all.
   *
   * Separate from `value === 0` on purpose: a rate of zero reached by dragging the slider down and
   * a tax that was never switched on are the same *number* and different intentions, and only the
   * second should hide the controls. Turning the switch off resets the rate, so the draft can
   * never carry a tax the form is not showing.
   */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
}) => {
  const id = useId();
  const total = PROTOCOL_FEE_PCT + value;
  const steep = value >= STEEP_PCT;
  const recipientInvalid = recipient.trim().length > 0 && !isAddress(recipient);

  return (
    <div className="flex flex-col gap-4">
      <Switch
        checked={enabled}
        onChange={(next) => {
          onEnabledChange(next);
          if (!next) {
            onChange(0);
            onRecipientChange("");
          }
        }}
        label="Charge a creator tax"
      />

      {enabled && (
        <>
          {/* The readout. The total leads because it is what a trader pays; the split under it is what
          the launcher is actually setting. */}
          <div className="doku-edge flex items-end justify-between gap-3 rounded-doku-2xl bg-[var(--film-1)] px-4 py-3.5">
            <div className="flex flex-col gap-1.5">
              <span className="font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.07em] text-ash">
                Every trade pays
              </span>
              <span
                className={`font-numeric text-[32px] font-medium leading-none tracking-[-0.015em] ${
                  steep ? "text-warn-ink" : "text-ink"
                }`}
              >
                {total % 1 === 0 ? total : total.toFixed(1)}%
              </span>
            </div>

            <div className="flex flex-col items-end gap-1.5 text-right">
              <span className="font-numeric text-[12px] leading-none text-mute">
                {PROTOCOL_FEE_PCT}% protocol
              </span>
              <span className="font-numeric text-[14px] font-semibold leading-none text-doku-ink">
                + {value % 1 === 0 ? value : value.toFixed(1)}% your tax
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <input
              id={id}
              type="range"
              min={0}
              max={MAX_CREATOR_FEE_PCT}
              step={0.1}
              value={value}
              onChange={(e) => onChange(clampCreatorFee(Number(e.target.value)))}
              aria-label="Creator fee, percent of every trade"
              aria-valuetext={`${value}% creator fee, ${total}% total per trade`}
              className="doku-range h-2 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
              style={{
                background: `linear-gradient(to right, var(--doku) ${(value / MAX_CREATOR_FEE_PCT) * 100}%, var(--film-3) ${(value / MAX_CREATOR_FEE_PCT) * 100}%)`,
              }}
            />

            {/* The same recess the dev-buy amount sits in, so the two numbers a launcher types on this
                form are made of one material. It was `border-line bg-well` — a flat hairline box
                whose focus state swapped a border colour. */}
            <div className="doku-swap-field relative w-[104px] shrink-0 rounded-doku-xl">
              <input
                type="number"
                min={0}
                max={MAX_CREATOR_FEE_PCT}
                step={0.1}
                value={value}
                onChange={(e) => onChange(clampCreatorFee(Number(e.target.value)))}
                onWheel={(e) => e.currentTarget.blur()}
                aria-label="Creator tax percentage"
                className="w-full border-transparent bg-transparent py-3 pl-3.5 pr-8 font-numeric text-[15px] font-semibold leading-tight text-ink outline-none"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 font-numeric text-[14px] text-mute"
              >
                %
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onChange(preset)}
                aria-pressed={value === preset}
                data-selected={value === preset}
                className={[
                  "doku-pair-key h-9 rounded-doku-lg px-3.5 font-numeric text-[13px] font-semibold leading-none",
                  value === preset ? "text-doku-ink" : "text-ash hover:text-ink",
                ].join(" ")}
              >
                {preset === 0 ? "None" : `${preset}%`}
              </button>
            ))}
          </div>

          {/*
        Where it goes.

        Optional, and blank is a real answer rather than an unfinished one: with no address the tax
        is paid to whichever wallet signs the launch. The field exists because those are frequently
        not the same wallet — nobody wants a permanent revenue stream paid into the hot wallet they
        happened to deploy from — and the recipient is as unchangeable as the rate, so this is the
        only chance to set it.
      */}
          {value > 0 && (
            <Field
              id={`${id}-recipient`}
              label="🏦 Paid to"
              optional
              error={recipientInvalid ? "That is not a valid address." : null}
            >
              <input
                id={`${id}-recipient`}
                value={recipient}
                onChange={(e) => onRecipientChange(e.target.value.trim())}
                placeholder="0x… — or leave empty for your deployer wallet"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={recipientInvalid}
                className={`${recipientInvalid ? FIELD_CLASS_ERROR : FIELD_CLASS} font-numeric text-[13px]`}
              />
            </Field>
          )}
        </>
      )}
    </div>
  );
};

export default CreatorFee;
