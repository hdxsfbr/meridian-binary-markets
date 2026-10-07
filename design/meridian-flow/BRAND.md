# Meridian / Flow — Brand guidelines

**Positioning:** A polished, dark-first interface for same-day binary stock outcome markets on-chain. The identity is a flowing dual-ribbon M, symbolizing motion and two complementary outcomes.

## Assets
- `logos/logo.svg`: light-surface full logo
- `logos/logo-dark.svg`: full logo on midnight background
- `logos/logo-white.svg`: one-color logo (transparent background)
- `logos/logo-mark.svg`: isolated mark
- `logos/favicon.svg`, `logos/app-icon.svg`: browser/product tile
- `tokens/design-tokens.css` and `.json`: named implementation values
- `references/trading-dashboard.png` and `.svg`: **conceptual** desktop UI reference, not product screenshot

The production SVG ribbons are **clean vector interpretations** of the chosen Flow illustration, not mathematically identical traces. Review the logo before release.

## Core colors
| Token | Value | Use |
| --- | --- | --- |
| Indigo | `#6366F1` | Primary CTA, focus accents |
| Violet | `#A855F7` | Brand gradient start |
| Cyan | `#22D3EE` | Gradient end, select highlights |
| Midnight | `#0B1026` | Main dark background |
| Yes (dark) | `#2DD4BF` | Yes-positive states |
| No (dark) | `#FB7185` | No-negative/opposing states |

Use the brand gradient on identity assets, selective hero treatments and maybe subtle active indicators—not on dense order-book cells or all buttons. `Yes` and `No` indicate **contract sides**, not necessarily financial gain/loss. Keep P&L status separate.

## Type
Inter or system UI for prose and controls. IBM Plex Mono or system monospace for prices, positions and counts; use tabular numerals. Large market numerics should not jump when updating.

## Layout
4/8/12/16/24/32 spacing scale. 8/12/18 px corner scale. Dark cards on midnight canvas. Keep order book compact, legible and information-first.

## Accessibility and governance
- Use Yes/No **text and icons**, not color alone.
- Validate foreground/background contrast in the actual UI to WCAG AA; lighten low-contrast text if needed.
- Maintain keyboard focus and reduced-motion options; avoid aggressive animated gradients.
- Preserve 4:00 PM ET settlement language and honest loading/stale/oracle states.
- Treat marketing text and mocked prices as examples only, never live data.

## Source interpretation
Inspired by the approved Flow brand board. Project brief states MAG7 stocks, same-day Yes/No outcomes, one order book underlying both sides, wallet connectivity, portfolio, settlement and redemption.
