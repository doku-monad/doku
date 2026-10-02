/**
 * One call inside an EIP-5792 batch: where it goes, what it says, and what native it carries.
 *
 * A leaf module, importing nothing, and that is the whole reason it is a file rather than a
 * declaration beside the first thing that needed it. It was declared in `zap.ts`, which imports
 * `writes.ts` — so the moment `writes.ts` named this type in the `LaunchChain` port, the two closed
 * a cycle. `import/no-cycle` is an error in this repo, and the hazard it is guarding is real: a
 * module graph with a loop in it initialises in an order nobody chose, and the symptom is a
 * `const` that reads as `undefined` at load on one bundler and not on another.
 *
 * `zap.ts` still exports the name, so every existing import of it keeps working untouched.
 */
export interface EncodedCall {
  to: `0x${string}`;
  data: `0x${string}`;
  /**
   * Native currency this call carries, in wei. **Absent, not zero, where the call moves none.**
   *
   * Absent for both calls of a batched SELL — an ERC-20 approval never moved native, and a zapped
   * sell is the mirror of the buy in exactly this respect: MON comes out of it. Present on exactly
   * two calls in this app, both in a MON-funded launch: the swap, whose input currency IS native
   * and which settles it as `msg.value`, and the launch itself, which owes the factory its fee.
   *
   * Optional rather than defaulted to `0n` so that a call which must not carry value cannot get
   * one from a spread or a copy-paste, and so that the sell path's shape is unchanged: the two
   * calls it builds have exactly the keys they had before this field existed.
   */
  value?: bigint;
}
