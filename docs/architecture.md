# Architecture

```text
Feishu/Lark user
      │ im.message.receive_v1
      ▼
Official Lark Channel (WebSocket, reconnect, dedup, policy, chat queue)
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

The official Channel owns transport, policy, in-process deduplication, and stale-event filtering. Its chat-level text batching is set to zero because it cannot distinguish topic threads. The plugin persists each accepted normalized message without the raw event, then batches by the same chat/thread key used for Harness Session identity. Every model-facing batch carries bounded channel metadata for each source message.

Direct messages and explicit mentions flush immediately. P2P identity uses the sender `open_id`, so proactive Huly delivery and later direct messages resume one Session even though Feishu uses a different `chat_id` for the direct chat. Incoming resources are downloaded to owner-only local state before the turn. Completed inbox IDs remain durable for twelve hours across process restarts.

The plugin provides `larkDelivery` only inside the Cordis Host. User `open_id` targets are allowed; a non-empty `groupAllowlist` constrains group targets. Huly events use a shared-secret WebSocket, explicit identity mapping, persistent reply bindings, and DM-to-main-group fallback. The Service is event-driven and contains no cron or periodic review scheduler.
