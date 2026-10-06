// Dates des commits : relative (« il y a 3 jours ») dans la langue de VS Code, complète, ou courte.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function relativeTime(epochSeconds: number, nowMs: number, locale: string): string {
  const diff = epochSeconds - nowMs / 1000; // négatif dans le passé
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(diff) >= seconds) return format.format(Math.round(diff / seconds), unit);
  }
  return format.format(0, 'second');
}

export function absoluteDate(epochSeconds: number, locale: string): string {
  return new Date(epochSeconds * 1000).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortDate(epochSeconds: number, locale: string): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}
