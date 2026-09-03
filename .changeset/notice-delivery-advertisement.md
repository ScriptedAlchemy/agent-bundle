---
"agent-bundle": patch
---

Advertise #99 notice-delivery routes per pinned host in a new `noticeDelivery` capability-table section consumed by the runtime's delivery-route selector: `mcp-inbox` and `mcp-resource-updated` are supported on every target, `next-event` and `current-response` on the three hook-bearing hosts (honestly unavailable on hookless portable), and `directed-push`/`host-toast` carry dated unavailable rows because no pinned host documents a plugin-initiated directed message or toast API (2026-09-02 survey on #99). A pin test enforces the route set, dated reasons, and the per-host truths.
