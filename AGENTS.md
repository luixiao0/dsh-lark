# Squady Local Fork

This is the local Squady fork of `@sugarforever/dsh-lark` on branch
`lux/local`. Keep source here and link it into `/Users/lux/huly-agent`; do not
copy it into that workspace.

## Product Invariants

- All direct messages are open. Any group may use the bot, but the inbound
  policy requires an explicit mention.
- P2P sessions are keyed by Feishu `open_id`, so a user's direct messages and
  proactive Huly notifications share one durable session. Groups and topics
  remain isolated by chat/thread identity.
- Huly events arrive over an authenticated outbound WebSocket, enter the local
  persistent inbox, and are ACKed only after persistence.
- Local retry owns model/send failures after ACK. Do not replace this with a
  template fallback; errors remain Sentry/log only until retry succeeds.
- Identity and reply bindings are owner-only local JSON files. Identity is
  explicit and Agent-maintainable; never infer it from display names.
- Before persistence, enrich inbound messages with the explicit identity-map
  name or the current Feishu group-member name. A lookup failure must not drop
  the message; retain the stable `open_id` and log the failure.
- Persist a per-chat Feishu history cursor after inbox persistence. Initial
  connection and every WebSocket reconnection must list history from that
  cursor and feed recovered user messages through the same enrichment and
  inbox path; WebSocket reconnection alone does not recover missed events.
- Download inbound Feishu resources before the Agent turn. File delivery from
  the Agent uses exact `DSH_FEISHU_FILE:/absolute/path` response lines.
- A failed proactive DM falls back to the configured main group and mentions
  the target user.
- `larkDelivery` may send to any `open_id`; a non-empty `groupAllowlist` still
  constrains explicit group targets for deployments that choose one.
- Do not add cron or periodic monitoring. Proactive delivery is event-driven.
- Keep credentials outside Git and resolve them through Harness Credentials.
- Feishu-hosted agents must not mount Harness interactive question tools unless
  the channel implements their answer lifecycle. Ask through ordinary final
  text so the question is delivered and the next chat message resumes work.

Review event filtering, session keys, persistence/ACK ordering, credentials,
and outbound routing deliberately when merging upstream.
