export type UsageTotals = {
  input: number;
  output: number;
  calls: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalInput?: number;
};
export function addUsage(
  total: UsageTotals,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
) {
  total.input += usage.input;
  total.output += usage.output;
  total.calls++;
  total.cacheRead = (total.cacheRead ?? 0) + (usage.cacheRead ?? 0);
  total.cacheWrite = (total.cacheWrite ?? 0) + (usage.cacheWrite ?? 0);
  total.totalInput = total.input + total.cacheRead + total.cacheWrite;
}
