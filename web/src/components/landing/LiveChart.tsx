/**
 * The hero's self-drawing price chart: two example price paths cross-fade
 * in and out on an infinite CSS loop. The first path draws upward and ends
 * above the dashed strike line, lighting a "Yes" pill; the second draws
 * ending below it, lighting "No". All motion is CSS keyframes
 * (`landing-chart-*` in globals.css) on `stroke-dashoffset` and `opacity`;
 * no timers. Under `prefers-reduced-motion` the global rule collapses
 * every animation to a single, near-instant iteration, which lands on each
 * keyframe's 100% state -- here that is the second path fully drawn and
 * its "No" pill lit, a clean static picture rather than a mid-draw frame.
 */
export function LiveChart() {
  return (
    <div
      className="landing-chart-frame relative aspect-[4/3] w-full max-w-xl overflow-hidden rounded-xl border border-border bg-surface/60 p-4"
      aria-hidden="true"
    >
      <svg viewBox="0 0 400 220" className="h-full w-full">
        <line
          x1="10"
          y1="130"
          x2="390"
          y2="130"
          stroke="var(--color-text-muted)"
          strokeDasharray="6 6"
          strokeWidth="1.5"
        />
        <text x="388" y="124" textAnchor="end" fontSize="11" fill="var(--color-text-muted)">
          Strike
        </text>

        <g className="landing-chart-group-a">
          <path
            d="M10,180 C60,160 90,150 120,140 C160,125 190,100 230,90 C270,80 310,75 390,55"
            fill="none"
            stroke="var(--color-cyan)"
            strokeWidth="3"
            strokeLinecap="round"
            className="landing-chart-draw-a"
          />
          <g transform="translate(300,32)">
            <rect width="50" height="26" rx="13" fill="var(--color-yes)" opacity="0.18" />
            <rect width="50" height="26" rx="13" fill="none" stroke="var(--color-yes)" strokeWidth="1.5" />
            <text x="25" y="18" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--color-yes)">
              Yes
            </text>
          </g>
        </g>

        <g className="landing-chart-group-b">
          <path
            d="M10,180 C50,172 90,176 130,166 C170,156 200,172 240,150 C280,165 330,160 390,168"
            fill="none"
            stroke="var(--color-cyan)"
            strokeWidth="3"
            strokeLinecap="round"
            className="landing-chart-draw-b"
          />
          <g transform="translate(300,178)">
            <rect width="50" height="26" rx="13" fill="var(--color-no)" opacity="0.18" />
            <rect width="50" height="26" rx="13" fill="none" stroke="var(--color-no)" strokeWidth="1.5" />
            <text x="25" y="18" textAnchor="middle" fontSize="13" fontWeight="600" fill="var(--color-no)">
              No
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
