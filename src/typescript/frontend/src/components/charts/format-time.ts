/**
 * Labels for the chart's time axis.
 *
 * Takes **seconds**, because that is the unit a candle carries — the convention every charting
 * library uses, and what the indexer's `bucket_start` is converted to on the way in.
 *
 * It used to take milliseconds while being handed seconds, and neither threw nor looked wrong: a
 * 2026 timestamp read as milliseconds lands in January 1970, and January 1970 formats as a
 * perfectly ordinary "21:56". Hourly candles came out an apparent minute apart, so a chart
 * spanning two days was labelled as spanning three. The unit is named in the parameter now, since
 * the two are indistinguishable once they are both just numbers.
 */
export function formatCandleTime(seconds: number, periodSeconds: number): string {
  const d = new Date(seconds * 1000);
  if (periodSeconds >= 86_400) {
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
