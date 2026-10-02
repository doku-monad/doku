import { POSITIONS_EARN_FEES, quoteFees } from "../../src/lib/chain/position-fees";

/**
 * Positions in a DOKU pool earn nothing, on the hook a market graduates under now.
 *
 * The pool's own fee is zero and always will be — the levy depends on it. For a while that was not
 * the whole story: `DokuHook.LP_LEVY_BPS` donated part of every levy to in-range positions, which
 * credited fee growth while `PoolKey.fee` stayed zero, and this module said positions earned.
 * Generation 4 removed the donation — the same share now goes straight to the market's sink ledger
 * — so `PoolKey.fee` and the swap levy are both, once again, nothing for a position.
 *
 * So the contract now is: say that positions earn nothing, and it is an exact answer, not a
 * placeholder for one not yet measured.
 */
describe("position fees", () => {
  it("reports that positions earn nothing, now that the hook no longer donates", () => {
    expect(POSITIONS_EARN_FEES).toBe(false);
  });

  /** Always empty — genuinely nothing accrues, not merely "not known yet". */
  it("quotes no amount, because none accrues", () => {
    expect(quoteFees([1n, 2n]).size).toBe(0);
    expect(quoteFees([]).size).toBe(0);
  });
});
