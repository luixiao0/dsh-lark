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
  cursor and feed recovered messages through the same enrichment and inbox
  path; filter only this application's own writes, not every `app` sender.
  WebSocket reconnection alone does not recover missed events.
- Download inbound Feishu resources before the Agent turn. File delivery from
  the Agent uses exact `DSH_FEISHU_FILE:/absolute/path` response lines.
- A reply must be hydrated from Feishu before persistence. Put the quoted
  sender, parsed current text, and local resources in `quotedMessage`, and also
  pass quoted images to Harness as native image blocks. This is how a reply can
  expose an app-bot card even when Feishu omitted the original message event.
- Request `raw_card_content` for message reads and history catch-up. App-bot
  interactive cards use a nested `json_card`; parse its textual `content`
  fields and retain Feishu's `sender_name` instead of emitting a generic card.
- Commit downloaded images to Harness attachment storage and include native
  image blocks in the same user turn. A local path is operational context, not
  a substitute for model image input.
- Expose explicit Agent tools for current message reads, paginated chat history,
  editing, and recall. Feishu publishes recall events but no message-edited
  event; re-read a message to observe its current `updated` content.
- A failed proactive DM falls back to the configured main group and mentions
  the target user.
- `feishu_send_message` is the Agent-facing proactive DM tool. Resolve its
  recipient from a literal `open_id` or one exact identity-map key; never use
  fuzzy name matching, and fail when an explicit key matches multiple people.
  It also accepts an exact envelope `chat_id` so background work can report
  back to the originating group or direct chat without another delivery
  service.
- Continuable Feishu subagents start with a `DSH_FEISHU_BACKGROUND:` routing
  marker. On startup, resume only children whose latest durable turn ended as
  `interrupted`; verify side effects before retrying and deliver their final
  result through the channel. A later completed turn makes recovery idempotent.
- Register Agent tools against the Harness-provided `tools` service with a
  standard JSON Schema definition. Do not import another `dsh-tools` runtime
  into this locally linked plugin; its versioned peer graph belongs to the host.
- Group output converts `@<exact identity-map key>` or an exact unique current
  group-member name to a native Feishu mention. The identity map wins; ambiguous
  or unknown targets remain plain text so the bot never mentions the wrong person.
- The SDK prepends every outbound `mentions` entry. Remove resolved `@name`
  tokens from message text; never place SDK mention keys in the visible body.
- `larkDelivery` may send to any `open_id`; a non-empty `groupAllowlist` still
  constrains explicit group targets for deployments that choose one.
- Do not add cron or periodic monitoring. Proactive delivery is event-driven.
- Keep credentials outside Git and resolve them through Harness Credentials.
- Feishu-hosted agents must not mount Harness interactive question tools unless
  the channel implements their answer lifecycle. Ask through ordinary final
  text so the question is delivered and the next chat message resumes work.

Review event filtering, session keys, persistence/ACK ordering, credentials,
and outbound routing deliberately when merging upstream.
