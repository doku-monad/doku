"use client";

import { ROUTES } from "router/routes";

import { IntentLink } from "@/components/ui/intent-link";

/**
 * `+ Create` — the launch action, as the bar's one filled key.
 *
 * ## Why it left the nav row
 *
 * It was "Launch", the fourth of six labels in the middle of the dock, drawn exactly like the links
 * either side of it. So the single thing this product exists to let you do looked like a place to
 * visit, and it was competing for attention with `Assets` — a registry — on identical terms.
 *
 * It sits at the right-hand end of the bar now, in the cluster with search, the theme key and the
 * wallet, rather than among the links. That is the only slot where a control can be visibly primary
 * without shouting over the navigation it would otherwise be standing in.
 *
 * ## Why it is *before* the wallet and not after it
 *
 * It ran last for a while, past the wallet. Two things were wrong with that. Connect is the end of
 * the bar in the way a wallet is the end of every bar in this category — it is the control people
 * reach for by muscle memory, and putting something after it means the last object on the rail is
 * the one that changes size when an address appears, so the bar's right edge moved on connect while
 * a green key floated past it. And a solid brand key sitting *outside* the wallet's lit ring put
 * the chrome's two loudest objects in the wrong order: the halo is the wallet's way of being found,
 * and it was being read as a frame around the thing next to it.
 *
 * Create before Connect keeps the eye's order honest — act, then account — and leaves the wallet
 * where every product in this category has taught people to look for it.
 *
 * ## Why it is a different material from everything else in the dock
 *
 * The bar is machined: trays, bezels and wells, all of them shades of the page. Connect is the most
 * elaborate of them — a well with a turning ring in it — and it is *still* the same colour as the
 * bar it sits in. A second control in that language would be a second thing to decode.
 *
 * This is the one solid object in the chrome: a brand-filled key with a lit top lip, a contact
 * shadow under its foot and a sheen that sweeps once under the pointer. It reads as the button in a
 * bar of surfaces, which is exactly the hierarchy — everything else navigates, this one acts.
 *
 * The `+` is a drawn glyph rather than a typed plus: the label is set in the mono face with wide
 * tracking, and a text `+` at that size sits high and thin against the caps. Two strokes on the
 * same optical grid as the letters do not.
 *
 * ## The label
 *
 * 11.5px at 700, with a hair of light under it (`--mat-create-emboss`). Dark type on a saturated
 * colour is the one combination where weight matters more than size: at 400 the strokes are thin
 * enough that the green bleeds into them and the word goes soft, which is what made the only
 * *labelled* control in the bar the hardest one to read. White would be worse — on this fill it
 * runs about 1.8:1, where the near-black is above 10:1.
 */
export const CreateButton = () => (
  <IntentLink
    href={ROUTES.launch}
    aria-label="Create a coin"
    /* Icon-only until `lg`, where the wordmark also appears and the bar has the room. Between `md`
       and `lg` the dock is carrying four nav labels, a search field, a theme key and a 160px wallet
       inside 768px — and a control that is unmistakable as a plus in a green key does not need its
       label to be understood. */
    className="doku-create group relative inline-flex h-11 w-11 shrink-0 items-center justify-center gap-2 overflow-hidden rounded-[14px] font-numeric text-[11.5px] font-bold uppercase leading-none tracking-[0.1em] lg:w-auto lg:px-[18px]"
  >
    <span aria-hidden className="doku-create-sheen" />
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      aria-hidden
      className="relative z-10 shrink-0 transition-transform duration-300 ease-out group-hover:rotate-90 motion-reduce:transition-none motion-reduce:group-hover:rotate-0"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
    <span className="relative z-10 hidden lg:inline">Create</span>
  </IntentLink>
);

export default CreateButton;
