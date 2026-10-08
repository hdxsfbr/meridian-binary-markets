import type { ReactNode } from "react";

export type EmptyStateProps = {
  children: ReactNode;
  action?: ReactNode;
};

/** Muted empty-state text, with an optional action (e.g. a link), for lists with nothing to show. */
export function EmptyState({ children, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-text-muted">{children}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}
