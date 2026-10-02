// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/*
 * The hook's creation-code hash, pinned once for the test suite and the deployment. The deploy
 * script asserts `keccak256(type(DokuHook).creationCode)` equals this before mining a salt, so a
 * binary that differs from the one the tests ran against cannot ship.
 *
 * Regenerate deliberately, and re-mine every recorded salt in the same commit:
 *   cast keccak $(jq -r '.bytecode.object' out/DokuHook.sol/DokuHook.json)
 * Salt, predicted address, this hash, the solc version and the v4-periphery pin are one record.
 *
 * When a generation turns over, the retired hash moves to its own constant below rather than
 * being overwritten: the previous hook is still live at an address mined against it.
 */
bytes32 constant DOKU_HOOK_CREATION_CODE_HASH =
    0x7d7601423c51cff373a85841dd69e1da6e2e48d5bf070e5e1df95ee1c6c2063b;

// Generation 4's hash: hook `0x1dbC72e822C73AC0bf91995A092A0151c57bAfcf`, salt 0x86d1.
bytes32 constant DOKU_GEN4_HOOK_CREATION_CODE_HASH =
    0x1a897208acbddb8c2de62852f1f8326fed95610f49e43514978906edcc1fbc93;

// Generation 3's hash: hook `0xb1A67a7c8000a86e0b1E5C019EBf859ce71C6Fcf`.
bytes32 constant DOKU_GEN3_HOOK_CREATION_CODE_HASH =
    0xf4ed2702f9d29921fc7fb0db245a545511488765af1765cc650bc662806e8db9;
