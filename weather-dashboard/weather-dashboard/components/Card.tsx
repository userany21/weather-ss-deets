import type { ReactNode } from "react";

export default function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-[#151c2b] bg-[#0a0f1a] ${className}`}>
      {children}
    </div>
  );
}
