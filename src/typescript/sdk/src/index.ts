/**
 * What survives of the SDK.
 *
 * It was a full Aptos client — Move module bindings, a websocket broker, a PostgREST query layer,
 * a mini event processor. All of that described a chain this project no longer runs on. Emoji data
 * is the part that never did: it is a table of which emoji are valid symbols, and it is the same
 * table the contracts' merkle allowlist is generated from.
 */
export * from "./const";
export * from "./emoji_data";
export * from "./utils";
