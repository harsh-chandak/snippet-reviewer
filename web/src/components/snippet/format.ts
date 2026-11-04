// Number formatting for times and costs, shared by the snippet page.

// 850 ms, 59.9 s, 1 min 2 s. The unit is picked after rounding, so 59,960 ms is
// '1 min 0 s', never '60.0 s', and 999.6 ms is '1.0 s', never '1000 ms'.
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`;
  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min ${rest} s`;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 4,
  notation: 'standard',
});

// $0.0089, $0.04213, $1.25, $1,235. At most 4 significant digits, never exponent notation,
// and a real but tiny cost is '<$0.0001', never '$0'.
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  return USD.format(usd);
}
