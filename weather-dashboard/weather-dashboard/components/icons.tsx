import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function Svg(p: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    />
  );
}

export const CloudIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </Svg>
);

export const PinIcon = (p: P) => (
  <Svg {...p}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </Svg>
);

export const InfoIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
);

export const BarChartIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3" />
  </Svg>
);

export const LineChartIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18M19 9l-5 5-4-4-3 3" />
  </Svg>
);

export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Svg>
);

export const ClipboardIcon = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01" />
  </Svg>
);

export function ChevronIcon({
  dir = "down",
  ...p
}: P & { dir?: "up" | "down" | "right" }) {
  const d =
    dir === "up" ? "m18 15-6-6-6 6" : dir === "down" ? "m6 9 6 6 6-6" : "m9 18 6-6-6-6";
  return (
    <Svg {...p}>
      <path d={d} />
    </Svg>
  );
}
