/**
 * @jest-environment node
 */
import { formatCandleTime } from "../../src/components/charts/format-time";

/**
 * The chart's time axis.
 *
 * Candles carry `time` in **seconds**, which is the convention every charting library uses, and
 * the axis formatter took milliseconds. Passing one where the other is expected does not throw and
 * does not look wrong: a 2026 timestamp read as milliseconds lands in January 1970, and January
 * 1970 still formats as a perfectly ordinary "21:56". Consecutive hourly candles came out an
 * apparent minute apart, so a chart spanning two days was labelled as spanning three minutes.
 */
describe("chart time axis", () => {
  // 2026-08-21T11:00:00Z, in seconds, as a candle carries it.
  const bucketStart = Math.floor(Date.UTC(2026, 7, 21, 11, 0, 0) / 1000);

  it("labels an intraday candle with its own hour and minute", () => {
    const d = new Date(bucketStart * 1000);
    const expected = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(formatCandleTime(bucketStart, 3600)).toBe(expected);
  });

  /**
   * The symptom, stated directly: two candles an hour apart must be labelled an hour apart. Read
   * as milliseconds they were 3600ms — under four seconds — apart.
   */
  it("puts an hour between two candles an hour apart", () => {
    const first = formatCandleTime(bucketStart, 3600);
    const second = formatCandleTime(bucketStart + 3600, 3600);
    expect(second).not.toBe(first);

    const minutes = (label: string) => {
      const [h, m] = label.split(":").map(Number);
      return h! * 60 + m!;
    };
    expect((minutes(second) - minutes(first) + 1440) % 1440).toBe(60);
  });

  /// Daily candles are labelled by date, where a 1970 reading was even less obviously wrong.
  it("labels a daily candle with its own day and month", () => {
    const d = new Date(bucketStart * 1000);
    const expected = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
    expect(formatCandleTime(bucketStart, 86400)).toBe(expected);
  });

  /// And never 1970, whatever the period.
  it("never lands in 1970 for a present-day candle", () => {
    for (const period of [60, 300, 3600, 86400]) {
      expect(formatCandleTime(bucketStart, period)).not.toBe(
        formatCandleTime(Math.floor(bucketStart / 1000), period)
      );
    }
  });
});
