# Architecture

```text
Feishu/Lark user
      │ im.message.receive_v1
      ▼
Official Lark Channel (WebSocket, reconnect, live policy, chat queue)
      │ reconnected → history list from persistent per-chat cursor
      │ NormalizedMessage
      ▼
Persistent inbox (`DSH_HOME/state/dsh-lark`, mode 0600)
      │ accepted message + durable dedup
      ▼
Conversation batcher
      │ chat/thread scope + sender/mention envelope
      ▼
dsh-lark conversation adapter → opaque SessionId
      ▼
Workspace selection + Agent Preset composition
      │ cwd + mounted tools/system prompt
      ▼
Harness Agent (selected model, tools, system prompt, session log)
      │ current turn assistant text
      ▼
Official Channel.send() → reply to original message/thread

Huly Kafka bridge → authenticated WebSocket → durable inbox → same user Session
Other Harness plugin → `larkDelivery.send()` → Channel.send()
```

The plugin runs inside the Harness Host. It does not launch another Harness process and does not expose an HTTP endpoint. A lazy Agent is created for each conversation key and reused for later messages. Before creation, the plugin resolves the configured Agent Preset (or the Harness default), selects the configured Workspace (or the first registered Workspace), records both in session metadata, mounts the preset in the Agent scope, and attaches the Session to the matching Workspace. `agent.whenIdle()` brackets each submitted prompt; only assistant events at or after the captured starting sequence are eligible for the reply.

The official Channel owns live transport, policy, in-process deduplication, and stale-event filtering. Its WebSocket reconnect resumes future events but does not replay events missed while disconnected, so the plugin also stores `message-sync.json` beside the inbox. On initial connection and every reconnection it lists each known chat from the last durable timestamp, overlaps the boundary by one second, filters only this application's own writes, reapplies channel policy, and feeds recovered messages through the same name/resource/inbox path. Group discovery seeds new groups with a bounded 30-minute lookback; direct chats become recoverable after the first live message because Feishu's bot chat-list API excludes P2P chats. Feishu may omit another app bot's message from incoming-message events, but the bot and its card remain available through message history/get. Those reads request `raw_card_content`, parse the nested `json_card`, and preserve Feishu's app sender name.

The channel's chat-level text batching is set to zero because it cannot distinguish topic threads. The plugin persists each accepted normalized message without the raw event, then batches by the same chat/thread key used for Harness Session identity. Every model-facing batch carries bounded channel metadata for each source message.

Direct messages and explicit mentions flush immediately. P2P identity uses the sender `open_id`, so proactive Huly delivery and later direct messages resume one Session even though Feishu uses a different `chat_id` for the direct chat. Incoming resources are downloaded to owner-only local state before the turn, using the message-scoped resource API first and the legacy image/file API only as fallback. One inaccessible resource is retained without a local path and logged; it does not discard the text or other attachments. When a message replies to another message, the current quoted sender, parsed text, and resources are fetched before inbox persistence and recorded as `quotedMessage`. Downloaded images from either the direct message or its quote are committed to Harness attachment storage and appended to that user message as native image blocks; their local paths remain available for tools. Completed inbox IDs remain durable for twelve hours across process restarts.

The plugin provides `larkDelivery` only inside the Cordis Host. User `open_id` targets are allowed; a non-empty `groupAllowlist` constrains group targets. Huly events use a shared-secret WebSocket, explicit identity mapping, persistent reply bindings, and DM-to-main-group fallback. The Service is event-driven and contains no cron or periodic review scheduler.

The Agent can page through currently visible chat history, re-read one message with current `updated`/`deleted` state and locally downloaded resources, and edit or recall messages through explicit tools. Feishu emits `im.message.recalled_v1`, which is delivered as a system entry to the same conversation. Feishu exposes no corresponding message-edited event, so edited content is observed only through a fresh message/history read. App-bot cards are readable through these explicit APIs even when their original event was not delivered.

Another Feishu app bot is not a reliable live event source: Feishu may retain
its card in history without delivering a bot-to-bot incoming-message event.
Notification producers that require real-time Agent handling must publish to
the authenticated event bridge (or an equivalent source webhook). Periodic
chat polling is intentionally not part of the runtime; history listing remains
bounded reconnect recovery and an explicit Agent tool.

Long-running work stays outside the chat's coordinator Session by using DSH's existing continuable subagent. For explicit mentions and direct messages, common operational verbs such as repair, install, deploy, configure, migrate, implement, investigate, and research trigger bridge-level delegation before the parent model runs. The parent receives a durable injected status record and immediately acknowledges, while ordinary questions and ambient group context remain on the parent. The child reports start, progress, blockers, and the final result through `feishu_send_message` with the exact inbound `chat_id`; if it fails to send a marked final update, the bridge delivers its assistant result. Its first prompt line carries a mechanical `DSH_FEISHU_BACKGROUND:` routing marker. After a process restart, the channel inspects subagent sessions and resumes only a child whose latest turn ended as `interrupted`; the resumed child is told to verify external state before repeating side effects, and the channel delivers the final result to the marked chat. The completed recovery turn prevents a second resume. This keeps new messages in the same group serviceable while the child continues independently.
