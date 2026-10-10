# Ticker marks

Small logo marks shown next to a ticker symbol across the app (market cards,
the trade header, the nav ticker tape, portfolio and history rows). These
identify the equity issuer only; they are not used as decoration or
branding for Meridian itself.

- AAPL, GOOGL, NVDA, META, TSLA, BTC: from [Simple Icons](https://simpleicons.org)
  (`simple-icons@16`, apple / google / nvidia / meta / tesla / bitcoin slugs),
  licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
  The `<title>` element and any hardcoded fill were stripped so the mark's
  color follows CSS (`currentColor`); the path data is unmodified. TSLA stays
  here even though BTC replaced it in the default listed set (DECISIONS.md
  §30) -- its markets and history are still shown by ticker.
- MSFT: drawn in-house as the standard four-square Microsoft mark
  (#F25022 / #7FBA00 / #00A4EF / #FFB900). Not sourced from Simple Icons.
- AMZN: Simple Icons does not ship an Amazon mark, so AMZN.svg is the
  "Amazon icon" from Wikimedia Commons (public domain, below the threshold of
  originality). Its black fills were changed to currentColor so the letter
  follows the theme text colour; the smile keeps Amazon's orange.
- QQQ, VOO, SPY: no file; these render as a plain text-initial fallback.

Brand colors applied via CSS (`TICKER_COLORS` in `web/src/lib/ticker-marks.ts`)
rather than baked into the SVG: GOOGL #4285F4, NVDA #76B900, META #0467DF,
TSLA #CC0000, BTC #F7931A (Bitcoin's own orange).

These marks are used solely to identify the equity each market tracks.

