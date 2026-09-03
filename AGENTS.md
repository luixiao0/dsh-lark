# Squady Local Fork

This is the local Squady fork of `@sugarforever/dsh-lark` on branch
`lux/local`. Keep source here and link it into `/Users/lux/huly-agent`; do not
copy it into that workspace.

## Product Invariants

- All direct messages are open. Any group may use the bot, but the inbound
  policy requires an explicit mention.
- P2P sessions are keyed by Feishu `open_id`. Proactive Huly notifications use
  one serial durable session per Feishu delivery target, so a notification
  backlog cannot fan out or block that person's direct-message conversation.
  Groups and topics remain isolated by chat/thread identity. Huly transport
  sessions are internal and must not be attached to the visible workspace.
  On startup, detach current and retired per-object Huly sessions only after
  their stored envelope deterministically reproduces the corresponding session
  ID; never classify by title or by the mere presence of a Huly event in mixed
  conversation history.
- Huly events arrive over an authenticated outbound WebSocket, enter the local
  persistent inbox, and are ACKed only after persistence.
- Local retry owns model/send failures after ACK. Do not replace this with a
  template fallback; errors remain Sentry/log only until retry succeeds.
- Identity and reply bindings are owner-only local JSON files. Identity is
  explicit and Agent-maintainable; never infer it from display names.
- Huly account, Person, notification-recipient, and Feishu routing identifiers
  are transport metadata. Do not expose them or the delivery route to the
  Agent: a notification owner is not evidence of the object's assignee or the
  human who should be notified. Expose actor names and business object data;
  the Agent must re-read the object to determine any useful recipient.
- Synthetic `huly:<notificationId>` inbox keys are internal deduplication
  metadata, not Feishu message IDs. Never expose them in the Agent envelope or
  pass them to Feishu message APIs.
- Before persistence, enrich inbound messages with the explicit identity-map
  name or the current Feishu group-member name. A lookup failure must not drop
  the message; retain the stable `open_id` and log the failure.
- Persist a per-chat Feishu history cursor after inbox persistence. Initial
  connection and every WebSocket reconnection must list history from that
  cursor and feed recovered messages through the same enrichment and inbox
  path; filter only this application's own writes, not every `app` sender.
  WebSocket reconnection alone does not recover missed events.
- Download inbound Feishu resources before the Agent turn. File delivery from
  ordinary and background final responses uses exact
  `DSH_FEISHU_FILE:/absolute/path` lines. Proactive/background work may call
  `feishu_send_file` with an exact envelope `chat_id` or mapped recipient.
  Feishu rejects empty files and files larger than 30 MB; expose that limit
  before upload.
- A reply must be hydrated from Feishu before persistence. Put the quoted
  sender, parsed current text, and local resources in `quotedMessage`, and also
  pass quoted images to Harness as native image blocks. This is how a reply can
  expose an app-bot card even when Feishu omitted the original message event.
- Request `raw_card_content` for message reads and history catch-up. App-bot
  interactive cards use a nested `json_card`; parse its textual `content`
  fields and retain Feishu's `sender_name` instead of emitting a generic card.
- Commit downloaded images to Harness attachment storage and include native
  image blocks in the same user turn. Keep the original local attachment, but
  constrain only the model-bound copy to a 4096-pixel long edge so tall
  screenshots cannot fail the entire turn. A local path is operational context,
  not a substitute for model image input.
- Download attachments from the message-scoped resource API first and retain
  the legacy image/file API only as fallback. A failed attachment must remain
  visible as unavailable metadata and must never drop the surrounding message.
- Expose explicit Agent tools for current message reads, paginated chat history,
  editing, and recall. Feishu publishes recall events but no message-edited
  event; re-read a message to observe its current `updated` content.
- A failed proactive DM falls back to the configured main group and mentions
  the target user.
- `feishu_send_message` and `feishu_send_file` are the Agent-facing proactive
  delivery tools. Resolve their
  recipient from a literal `open_id` or one exact identity-map key; never use
  fuzzy name matching, and fail when an explicit key matches multiple people.
  It also accepts an exact envelope `chat_id` so background work can report
  back to the originating group or direct chat without another delivery
  service.
- Attendance and leave remain in this same Feishu SDK client. The current
  message sender is bound to the Agent session by the bridge; never accept a
  model-supplied identity for self-service HR operations. Ordinary employees
  can read only their own attendance and approval data. `hrAdminOpenIds` may
  authorize cross-employee reads, but it never lets an administrator approve
  or reject another person's approval task. Leave submission reads the
  tenant's configured approval definition at call time because field IDs and
  options are tenant-specific. Do not use `attendance.userApproval.create`
  for normal Feishu leave requests: that endpoint writes external approval
  results back into attendance.
- Calendar tools use the same cached Feishu SDK client. The app may list and
  search only calendars visible to its application identity; a user's primary
  calendar is not public merely because the user belongs to the tenant. Omit a
  calendar ID only for the current sender's primary calendar. Cross-user
  primary-calendar or free/busy reads require `adminOpenId` or
  `hrAdminOpenIds`. Shared-calendar creation is an administrator-only write,
  defaults to `show_only_free_busy`, and requires conversational confirmation.
- Continuable Feishu subagents start with a `DSH_FEISHU_BACKGROUND:` routing
  marker. On startup, resume only children whose latest durable turn ended as
  `interrupted`; verify side effects before retrying and deliver their final
  result through the channel. A later completed turn makes recovery idempotent.
- Explicit execution requests with common repair/install/deploy/configure/
  migrate/implement/research verbs are mechanically delegated by the bridge
  before the parent model runs. The parent receives durable injected status,
  returns an immediate acknowledgement, and remains free for later messages;
  ordinary questions and ambient group context still use the parent directly.
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
- Treat another Feishu app bot as a display sink, not an event source: Feishu
  does not reliably emit bot-to-bot message events. Integrate the producing
  service through the authenticated event bridge/webhook instead of polling
  chat history for live notifications; history remains reconnect recovery.
- Keep credentials outside Git and resolve them through Harness Credentials.
- Feishu-hosted agents must not mount Harness interactive question tools unless
  the channel implements their answer lifecycle. Ask through ordinary final
  text so the question is delivered and the next chat message resumes work.

Review event filtering, session keys, persistence/ACK ordering, credentials,
and outbound routing deliberately when merging upstream.
