/**
 * Slow-drifting aurora backdrop for the hero: three large blurred radial
 * blobs in the brand colours, looping on CSS keyframes (globals.css). Pure
 * markup, no state -- safe to render from a server component even though
 * it ends up inside the client hero tree. `aria-hidden` and
 * `pointer-events: none` (via `.landing-aurora`) keep it out of the
 * accessibility tree and out of the way of clicks.
 */
export function AuroraBackground() {
  return (
    <div className="landing-aurora" aria-hidden="true">
      <div className="landing-aurora-blob landing-aurora-blob-1" />
      <div className="landing-aurora-blob landing-aurora-blob-2" />
      <div className="landing-aurora-blob landing-aurora-blob-3" />
    </div>
  );
}
