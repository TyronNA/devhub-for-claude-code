# Changelog

## 0.29.76 — first public release

- Published from the private development repo as a single squashed commit; the earlier history
  is not carried over.
- Shipped icons are original; the Anthropic brand marks the private build borrowed are gone.
- `devHub.planner.endpoint` now defaults to empty, so a fresh install polls no loopback daemon
  until an agent with `kind: "http"` is configured.
- Covered by the unit test suite only; this exact build has not been opened in a real window yet.
