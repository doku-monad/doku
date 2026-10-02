/**
 * A message with every URL taken out.
 *
 * viem's `HttpRequestError` writes `URL: <the full endpoint>` into its message, and an RPC endpoint
 * is where a provider's API key lives. Error messages are kept as `lastError` and served on
 * `/status`, which is public — so anything stored there goes through this first.
 */
export function redactUrls(message: string): string {
  return message.replace(/(?:https?|wss?):\/\/[^\s"'<>)]+/gi, "<url>");
}
