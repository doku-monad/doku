import { type AnyEmojiName, CHAT_EMOJI_DATA, SYMBOL_EMOJI_DATA } from "@/sdk/emoji_data";

/*
 * The JSON helpers live in `utils/json.ts` and are re-exported here.
 *
 * The line above is why: it evaluates the SDK's emoji tables at module scope, and anything that
 * imports this barrel pays for them. `configs/local-storage-keys.ts` did, and it is reached from
 * every route — see the note in `utils/json.ts`.
 */
export { BigIntTrailingNRegex, DateRegex, parseJSON, stringifyJSON } from "./json";

export const emoji = (name: AnyEmojiName) =>
  SYMBOL_EMOJI_DATA.hasName(name)
    ? SYMBOL_EMOJI_DATA.byStrictName(name).emoji
    : CHAT_EMOJI_DATA.byStrictName(name).emoji;
