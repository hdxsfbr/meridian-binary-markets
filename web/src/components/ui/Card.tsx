import type { ReactNode } from "react";

export type CardProps = {
  children: ReactNode;
  className?: string;
};

/** Shared card chrome: surface background, border, rounded corners (REVAMP_PLAN Wave R1). */
export function Card({ children, className = "" }: CardProps) {
  return <div className={`rounded-lg border border-border bg-surface ${className}`}>{children}</div>;
}
