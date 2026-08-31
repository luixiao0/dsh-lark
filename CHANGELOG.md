# Changelog

## Unreleased

- Deliver downloaded Feishu images to Harness as durable native image blocks
  in the same turn instead of exposing only a local filesystem path.
- Preserve historical messages from other applications when Feishu exposes
  them, while continuing to filter this application's own writes.
- Add Agent tools for paginated chat history, current message reads, editing,
  and recall, and deliver Feishu recall events into the conversation.
- Expose `feishu_send_message` to Agents for proactive direct messages using
  explicit identity-map resolution, with main-group mention fallback.
- Let `feishu_send_message` target an exact inbound `chat_id`, allowing DSH
  background subagents to return progress and results to the originating chat.
- Convert exact, unique identity-map references in group output to native
  Feishu mentions instead of displaying inert `@name` text.
- Resolve unmapped mention targets from exact unique current-group member names,
  including members observed from inbound messages when directory lookup fails.
- Remove resolved mention tokens and legacy fallback placeholders from the
  visible body because the SDK already prepends native Feishu mentions.
- Register the proactive tool directly with the host tool registry so the local
  plugin does not load a second, version-mismatched Harness runtime dependency.

## 0.2.2-squady.1

- Persist accepted Feishu messages and completed message IDs under `DSH_HOME`
  so restart recovery does not depend on the SDK's in-memory dedup cache.
- Batch ordinary group messages by chat or topic while preserving sender,
  mention, message, and timestamp metadata for the Agent.
- Flush a pending group batch immediately when the bot is explicitly mentioned.
- Suppress an exact configurable `NO_REPLY` response for ambient group turns.
- Keep ambient failures quiet while retaining the safe fallback for direct
  messages and explicit mentions.
- Provide an internal `larkDelivery` Service for proactive messages, restricted
  to `groupAllowlist`; no periodic scheduler is included.

## 0.2.2

- Restore npm 12 lockfile entries required for clean Linux CI installs.

## 0.2.1

- Mark Harness-provided peer dependencies as optional for package-manager resolution, avoiding misleading missing-peer warnings in DSH Profiles.
- Keep the supported Harness range starting at `0.1.0-rc.6` while validating development and release builds against `0.1.0-rc.7`.
- Add continuous compatibility checks against the latest published Harness packages.

## 0.2.0

- Contribute an embedded **Feishu & Lark** section to Harness Settings through the plugin web client.
- Require same-origin browser requests for settings and credential mutations.
- Store App Secret through Harness Credentials using `DSH_LARK_APP_SECRET` by default.
- Apply Settings and credential changes by replacing the Lark channel without restarting Harness.
- Keep the plugin active but idle until required application credentials are configured.
- Show explicit configured and missing App Secret states without returning the secret to the browser.
- Populate linked Provider and Model selectors from the current Harness model catalog.
- Resume persisted Lark sessions after restart and reuse an already-live Agent when available.
- Print initial connection, channel, and message-handling failures to the terminal as well as the Harness logger, with App Secret redaction.
- Remove the generic configuration-file action from the Lark-focused Settings experience.

## 0.1.1

- Mount the Harness default or configured Agent Preset for Lark sessions.
- Associate Lark sessions with an explicit Workspace or the first registered Workspace.
- Start corrected sessions with a v2 identity so legacy uncomposed sessions are not reused.

## 0.1.0

- Initial Feishu/Lark WebSocket Channel integration for DeepSeek Harness.
- Stable chat/thread to Harness Session mapping.
- Official SDK policy, deduplication, stale-event filtering, and per-chat queue reuse.
