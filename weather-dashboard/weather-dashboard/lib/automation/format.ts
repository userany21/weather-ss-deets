export const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
export const cents = (n: number) => `${(n * 100).toFixed(1)}¢`;
