import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from "@headlessui/react";
import { Arrow } from "components/svg";
import React, { Fragment, type PropsWithChildren } from "react";

import ClosePixelated from "@/icons/ClosePixelated";

export const BaseModal: React.FC<
  PropsWithChildren<{
    showCloseButton?: boolean;
    showBackButton?: boolean;
    onBack?: () => void;
    isOpen: boolean;
    onClose: () => void;
    className?: string;
  }>
> = ({ showCloseButton, showBackButton, onBack, isOpen, onClose, children, className }) => {
  return (
    /*
      The `Transition` drives this; the `Dialog` is deliberately NOT also given `open`.

      In HeadlessUI 2 passing both is not redundant, it is destructive. `dialog.js` branches on
      `open !== undefined` and wraps itself in a SECOND, nested `<Transition>` — one that receives
      no `appear`. Every `TransitionChild` below then registers against that inner context instead
      of this one, reads `appear: false`, and never applies `enterFrom`/`enterTo`; on the way out
      the outer transition's own child is the Dialog's bare wrapper div, which carries no CSS
      transition, resolves within a frame and unmounts the subtree before the inner 100ms leave can
      run. So the scrim and the panel snapped in and out at full opacity and the `appear` on the
      next line was dead code.

      With `open` dropped the Dialog reads its state from this Transition's OpenClosed context,
      which is the arrangement both of these were written for. Checked in the browser against the
      installed 2.1.9 with real pointer input: the close key, Escape and a backdrop click all still
      dismiss the dialog.
    */
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1000]" onClose={onClose}>
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          {/*
            The scrim, on the veil ladder rather than on `bg-black`.

            `tailwind.config.js` remaps the legacy name `black` onto the *canvas* role — the page
            ground — so `bg-black bg-opacity-60` did not paint 60% black, it painted 60% of
            whatever the page ground is. On the dark theme that is near-black and looks right; on
            Lite it is `rgb(237 240 238)`, so the dialog covered the page in a 60% off-white haze:
            no dimming, nothing separating the dialog from the page behind it, and no error
            anywhere. `--veil-3` is the token for a scrim that sits over content, and it is stated
            per theme (65% black on the stage, 38% ink on paper) so this dims in both.
          */}
          <div className="fixed inset-0 bg-[var(--veil-3)] backdrop-blur-sm" />
        </TransitionChild>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center">
            {/*
              The panel transitions WITH the scrim, and it did not used to.

              Only the scrim was wrapped, which was harmless for as long as the scrim's transition
              was also dead — both simply appeared, together, in one frame. The moment the scrim
              started fading properly the two came apart: the panel still mounted at full opacity
              in the first frame, so a finished dialog landed on an undimmed page and the dim
              arrived 150ms later. Closing was the same in reverse — the panel vanished instantly
              and left the dim behind it. That reads as a flash, and it is the whole of the
              flicker.

              Same curve and the same durations as the scrim above, so they move as one object.
              The scale is deliberately tiny: this is a dialog somebody opened to press a button,
              not an entrance. Reduced motion is covered globally — `prefers-reduced-motion` in
              `global.css` cuts every `transition-duration` in the app to 0.001ms.
            */}
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-[0.98]"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-[0.98]"
            >
              <DialogPanel
                className={`${className} max-w-4xl transform border bg-transparent align-middle shadow-xl`}
              >
                {showBackButton ? (
                  <DialogTitle as="div">
                    <div
                      className="absolute group left-0 top-0 !z-50 flex h-[70px] w-[70px] cursor-pointer items-center"
                      onClick={() => (onBack ? onBack() : null)}
                    >
                      <div className="flex m-auto rotate-180">
                        <Arrow
                          width={17}
                          height={18}
                          className="transition-all group-hover:w-[18px] group-hover:h-[19px] fill-white"
                        />
                      </div>
                    </div>
                  </DialogTitle>
                ) : null}
                {showCloseButton ? (
                  <DialogTitle as="div">
                    <div
                      className="absolute group right-0 top-0 !z-50 flex h-[70px] w-[70px] cursor-pointer items-center justify-center"
                      onClick={onClose}
                    >
                      <ClosePixelated className="w-[15px] h-[16px] transition-all group-hover:w-[18px] group-hover:h-[19px] text-ink" />
                    </div>
                  </DialogTitle>
                ) : null}
                {children}
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};
