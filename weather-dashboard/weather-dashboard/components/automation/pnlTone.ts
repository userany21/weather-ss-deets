export function pnlTone(n: number | null): string {
  if (n === null) return "";
  if (n > 0) return "text-emerald-300";
  if (n < 0) return "text-rose-300";
  return "";
}
