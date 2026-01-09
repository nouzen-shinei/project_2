export type RuntimeMetrics = Record<string, number>;

export function parsePromMetrics(metricsText?: string | null): RuntimeMetrics {
  if (!metricsText) return {};
  return metricsText.split('\n').reduce<RuntimeMetrics>((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return acc;
    }
    const [name, value] = trimmed.split(/\s+/);
    const numericValue = Number(value);
    if (!Number.isNaN(numericValue)) {
      acc[name] = numericValue;
    }
    return acc;
  }, {});
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(undefined, options).format(value);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
