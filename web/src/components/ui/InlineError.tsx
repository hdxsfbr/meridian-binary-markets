export type InlineErrorProps = {
  children: string;
  onRetry?: () => void;
};

/** Warning-coloured inline error text, with an optional retry action. */
export function InlineError({ children, onRetry }: InlineErrorProps) {
  return (
    <p role="alert" className="flex items-center gap-2 text-warning">
      <span>{children}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="underline">
          Retry
        </button>
      ) : null}
    </p>
  );
}
