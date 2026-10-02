// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * @title AdversarialTokens
 * @notice The quote assets `QuoteRegistry` would happily register and the protocol cannot survive.
 *
 * @dev These exist because `QuoteRegistry.register` asks an asset exactly one question — "do you
 *      answer `decimals()`?" — and then treats the answer as a certificate of good behaviour. Every
 *      token in this file answers `decimals()`. Each then breaks one specific assumption the
 *      accounting makes, so a test can say WHICH assumption a path actually depends on rather than
 *      "a weird token broke something".
 *
 *      They are deliberately minimal — no OpenZeppelin base, no permit, no hooks we did not put
 *      there — because inheriting a real ERC-20 would hide the one line each of them is about.
 *
 *      The one shape that needs assembly is `ReturnShapeToken`. `BondingCurve._tryPay` decides
 *      success with `ok && (ret.length == 0 || abi.decode(ret, (bool)))`, and the whole question in
 *      L-03 is what that expression DOES for return payloads that are not a clean 32-byte bool.
 *      Solidity cannot express "return 31 bytes" from a typed `returns (bool)`, so the state change
 *      happens in Solidity and the return is overridden with a raw `return(ptr, len)`. That is the
 *      only way to put the real byte string on the wire, and putting the real byte string on the
 *      wire is the entire experiment.
 */

/// @dev The common ledger. Everything below is this plus one deviation.
abstract contract BaseToken {
    string public name = "Adversarial";
    string public symbol = "ADV";
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 dec) {
        decimals = dec;
    }

    function balanceOf(address who) public view virtual returns (uint256) {
        return _bal[who];
    }

    function mint(address to, uint256 amount) external virtual {
        _bal[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _spendAllowance(address owner, uint256 amount) internal {
        uint256 a = allowance[owner][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[owner][msg.sender] = a - amount;
        }
    }

    /// @dev The honest move, before any deviation is applied.
    function _move(address from, address to, uint256 amount) internal virtual {
        require(_bal[from] >= amount, "balance");
        unchecked {
            _bal[from] -= amount;
        }
        _bal[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/**
 * @notice Charges `feeBps` on every move and burns it. The classic exact-transfer violation.
 * @dev `balanceAfter - balanceBefore != amount` for the RECIPIENT on every single transfer, in both
 *      directions — which is what makes it the right probe for both the inbound credit paths
 *      (`owedSink[id] += amount` after a pull) and the outbound ones (`minQuoteOut` checked before
 *      the send). A real one of these is usually reflexive or deflationary; the destination of the
 *      fee does not matter to the accounting, only that it never arrives.
 */
contract FeeOnTransferToken is BaseToken {
    uint256 public feeBps;

    constructor(uint8 dec, uint256 feeBps_) BaseToken(dec) {
        feeBps = feeBps_;
    }

    function setFeeBps(uint256 b) external {
        feeBps = b;
    }

    function _moveTaxed(address from, address to, uint256 amount) private {
        uint256 fee = (amount * feeBps) / 10_000;
        require(_bal[from] >= amount, "balance");
        unchecked {
            _bal[from] -= amount;
        }
        _bal[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _moveTaxed(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _moveTaxed(from, to, amount);
        return true;
    }
}

/**
 * @notice Fee only on the way IN to a nominated address, free everywhere else.
 * @dev Separated from `FeeOnTransferToken` because the two find different bugs. A blanket fee
 *      breaks the very first hop and the trace stops there; a fee charged only when the protocol is
 *      the RECIPIENT lets value flow normally right up to the credit that over-counts it, which is
 *      the shape that puts `owedSink` above the hook's backing balance while everything upstream
 *      still looks correct.
 */
contract InboundFeeToken is BaseToken {
    uint256 public feeBps;
    mapping(address => bool) public taxedRecipient;

    constructor(uint8 dec, uint256 feeBps_) BaseToken(dec) {
        feeBps = feeBps_;
    }

    function setTaxedRecipient(address who, bool on) external {
        taxedRecipient[who] = on;
    }

    function _moveMaybeTaxed(address from, address to, uint256 amount) private {
        uint256 fee = taxedRecipient[to] ? (amount * feeBps) / 10_000 : 0;
        require(_bal[from] >= amount, "balance");
        unchecked {
            _bal[from] -= amount;
        }
        _bal[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _moveMaybeTaxed(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _moveMaybeTaxed(from, to, amount);
        return true;
    }
}

/**
 * @notice Balances are shares times an index. Transfers are exact; the SHARED BALANCE moves anyway.
 * @dev The failure this probes is not a bad transfer — every transfer here delivers exactly what it
 *      says. It is that any code reading an ABSOLUTE balance at time T and acting on it at time
 *      T+1 is reading a number the token can change underneath it with nobody's permission but the
 *      rebaser's. `DokuGraduation._sweepDust` and `SeedLocker.collect` both do exactly that.
 */
contract RebasingToken is BaseToken {
    uint256 public index = 1e18;

    constructor(uint8 dec) BaseToken(dec) {}

    function setIndex(uint256 i) external {
        index = i;
    }

    function balanceOf(address who) public view override returns (uint256) {
        return (_bal[who] * index) / 1e18;
    }

    function _shares(uint256 amount) private view returns (uint256) {
        return (amount * 1e18) / index;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, _shares(amount));
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, _shares(amount));
        return true;
    }
}

/**
 * @notice Returns whatever byte string it is told to, from a transfer that otherwise succeeds.
 *
 * @dev The L-03 instrument. `retLen` is the number of bytes to put on the wire and `retWord` is the
 *      32-byte word they are taken from (left-aligned, so `retLen = 1` returns the word's TOP byte
 *      — which is how a real short-return token behaves, not a truncated integer).
 *
 *      Configurations that matter, and what each is a real-world stand-in for:
 *        len 0             — USDT-shaped: no return value at all. Must be read as SUCCESS.
 *        len 32, word 1    — the standard. Success.
 *        len 32, word 0    — an ERC-20 that returns false instead of reverting. Must be FAILURE.
 *        len 32, word 2    — a dirty bool: a token that writes a nonzero that is not 1.
 *        len 1 / len 31    — a truncated or hand-rolled return. Under-length for `abi.decode`.
 *        len 64            — an over-long return, e.g. a token that returns (bool, uint256).
 *
 *      `applyState` exists so a test can hold the state change constant while varying only the
 *      wire format. Without it a "did the decode revert?" result could always be explained away as
 *      the transfer itself having failed.
 */
contract ReturnShapeToken is BaseToken {
    uint256 public retLen = 32;
    bytes32 public retWord = bytes32(uint256(1));
    bool public applyState = true;

    constructor(uint8 dec) BaseToken(dec) {}

    /// @dev Shapes `transfer` ONLY, and that separation is load-bearing rather than tidiness.
    ///      `_tryPay` calls `transfer`; its fallback, `CreatorSink.credit`, calls `transferFrom`
    ///      through `SafeERC20`. If one setting shaped both, a revert could always be the FALLBACK
    ///      failing rather than the predicate, and the two are different findings with different
    ///      fixes. `transferFrom` therefore stays standards-compliant here, so anything this test
    ///      sees revert is attributable to the predicate alone.
    function setReturn(uint256 len, bytes32 word) external {
        require(len <= 64, "len");
        retLen = len;
        retWord = word;
    }

    function setApplyState(bool on) external {
        applyState = on;
    }

    /// @dev Declared `returns (bool)` so the ERC-20 interface still matches at the call site, then
    ///      overridden with a raw `return`. The typed return value is never produced.
    function transfer(address to, uint256 amount) external returns (bool) {
        if (applyState) _move(msg.sender, to, amount);
        _ret();
    }

    /// @dev Always the compliant 32-byte `true`. See `setReturn`.
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _move(from, to, amount);
        return true;
    }

    /// @dev The word is written twice so a 64-byte return is two full words rather than one word
    ///      followed by whatever memory happened to be next.
    function _ret() private view {
        uint256 len = retLen;
        bytes32 w = retWord;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, w)
            mstore(add(p, 0x20), w)
            return(p, len)
        }
    }
}

/**
 * @notice Calls the recipient back from inside `transfer`, before the call returns.
 * @dev The ERC-777 / ERC-1363 shape, reduced to the one property that matters: a transfer hands
 *      control to an address of the sender's choosing while the caller's own state is half-updated.
 *      Pointed at any contract that reads `balanceOf(address(this))` and acts on it, this is a
 *      reentrancy primitive that a plain ERC-20 quote asset does not provide.
 */
interface ITransferReceiver {
    function onTokenTransfer(address from, address to, uint256 amount) external;
}

contract CallbackToken is BaseToken {
    mapping(address => bool) public hooked;

    constructor(uint8 dec) BaseToken(dec) {}

    function setHooked(address who, bool on) external {
        hooked[who] = on;
    }

    function _moveAndCall(address from, address to, uint256 amount) private {
        _move(from, to, amount);
        if (hooked[to] && to.code.length != 0) {
            // Deliberately swallowed. A hook that reverts would make this token merely broken; the
            // interesting shape is one that succeeds and re-enters.
            // solhint-disable-next-line no-empty-blocks
            try ITransferReceiver(to).onTokenTransfer(from, to, amount) {} catch {}
        }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _moveAndCall(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _moveAndCall(from, to, amount);
        return true;
    }
}

/**
 * @notice Refuses to move value to or from an address the issuer names. USDC and USDT both do this.
 * @dev Not exotic and not hypothetical — it is the behaviour of the two largest quote assets any
 *      launchpad would want. The question it asks the protocol is what happens when the frozen
 *      address is a SHARED contract rather than a user: the hook, the graduation contract, or the
 *      creator sink. Everything downstream of that address stops for everybody.
 */
contract BlacklistToken is BaseToken {
    mapping(address => bool) public blacklisted;

    constructor(uint8 dec) BaseToken(dec) {}

    function setBlacklisted(address who, bool on) external {
        blacklisted[who] = on;
    }

    function _moveChecked(address from, address to, uint256 amount) private {
        require(!blacklisted[from] && !blacklisted[to], "blacklisted");
        _move(from, to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _moveChecked(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, amount);
        _moveChecked(from, to, amount);
        return true;
    }
}

/// @notice Every transfer reverts once paused. The global form of the blacklist.
contract PausableToken is BaseToken {
    bool public paused;

    constructor(uint8 dec) BaseToken(dec) {}

    function setPaused(bool on) external {
        paused = on;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!paused, "paused");
        _spendAllowance(from, amount);
        _move(from, to, amount);
        return true;
    }
}
