# Squady Local Fork

This repository is the local Squady fork of `@sugarforever/dsh-lark`.

## Repository Operations

- `upstream` is `https://github.com/sugarforever/dsh-lark.git`.
- Squady changes live on branch `lux/local`.
- Keep the plugin source in `/Users/lux/dsh-lark`; do not copy it into the
  `/Users/lux/huly-agent` repository.
- Rebase or merge upstream deliberately. Review changes to event filtering,
  session keys, credentials, tool exposure, and message sending before update.

## Product Boundaries

- Support only the Squady main group and product/design group through an
  explicit `groupAllowlist`.
- Keep mention gating enabled until the Squady speaking policy is installed and
  the full-group-message permission is approved. After that, ordinary group
  messages may use conversation batching and exact `NO_REPLY` suppression.
- Direct messages use `dmMode: allowlist` and initially allow only the operator.
- Keep one-to-one chats, group chats, and topic threads in separate persistent
  DSH sessions according to their Feishu conversation identity.
- Keep Feishu credentials outside Git. Huly access must be provided by a narrow
  MCP server, never by kubectl, direct database access, or unrestricted shell.
- Do not add cron or periodic review behavior. Proactive delivery is
  event-driven through the allowlisted `larkDelivery` Service.
