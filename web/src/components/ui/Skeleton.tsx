export type SkeletonProps = {
  className?: string;
};

/** A pulsing surface-raised block for loading states; respects prefers-reduced-motion via globals.css. */
export function Skeleton({ className = "h-5 w-full" }: SkeletonProps) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className={`animate-pulse rounded-md bg-surface-raised ${className}`} aria-hidden="true" />
    </div>
  );
}
