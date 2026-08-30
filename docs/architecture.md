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

Other Harness plugin → allowlisted `larkDelivery.send()` → Channel.send()
```

The plugin runs inside the Harness Host. It does not launch another Harness process and does not expose an HTTP endpoint. A lazy Agent is created for each conversation key and reused for later messages. Before creation, the plugin resolves the configured Agent Preset (or the Harness default), selects the configured Workspace (or the first registered Workspace), records both in session metadata, mounts the preset in the Agent scope, and attaches the Session to the matching Workspace. `agent.whenIdle()` brackets each submitted prompt; only assistant events at or after the captured starting sequence are eligible for the reply.

The official Channel owns transport, policy, in-process deduplication, and stale-event filtering. Its chat-level text batching is set to zero because it cannot distinguish topic threads. The plugin persists each accepted normalized message without the raw event, then batches by the same chat/thread key used for Harness Session identity. Every model-facing batch carries bounded channel metadata for each source message.

Direct messages and explicit mentions flush immediately. Ordinary group messages wait for the configured short batching window. An exact ambient `silentReplyToken` produces no outbound message, and ambient failures remain log-only. Completed inbox IDs remain durable for twelve hours across process restarts.

The plugin provides `larkDelivery` only inside the Cordis Host. Delivery targets must be in `groupAllowlist`, including the optional `homeChatId`. The Service is an event-driven outbound boundary; this package intentionally contains no cron or periodic review scheduler.
