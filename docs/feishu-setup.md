# Feishu / Lark Console Setup

1. Create a custom app in the Feishu or Lark developer console.
2. Enable the Bot capability and choose a bot name/avatar.
3. Add the permissions required to receive messages and send replies. Also grant `im:chat:readonly` and `im:message:readonly` so reconnection recovery can call `im.v1.chat.list` and `im.v1.message.list`. Submit them for administrator approval when required by the tenant.
4. For attendance and leave tools, grant `attendance:task:readonly`, `approval:approval`, `approval:approval:readonly`, `approval:approval.list:readonly`, `contact:user.base:readonly`, `contact:user.employee:readonly`, `contact:user.employee_id:readonly`, and application-identity contact read permission. For calendar tools, grant `calendar:calendar:readonly`; creating shared calendars additionally needs `calendar:calendar`. Feishu occasionally merges or renames these scopes; use the permission names shown by the current developer console and publish the app after approval.
5. In **Events & Callbacks / Event Subscriptions**, choose **Use long connection to receive events** (WebSocket). Do not configure a webhook URL.
6. Add the event `im.message.receive_v1`.
7. Create and publish an app version, then install the app in the tenant or test tenant.
8. Copy App ID and App Secret into `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in the environment that starts DSH.
9. Enable the plugin entry and start the Harness profile. A successful startup logs `dsh-lark: WebSocket connected`.
10. In a direct chat, send a message to the bot. In a group, mention the bot unless `requireMention` is intentionally disabled and the broader group-message permission has been approved.

## Attendance and Leave

Set `lark-channel.leaveApprovalCode` to the approval definition Code of the
tenant's leave workflow. Set `lark-channel.hrAdminOpenIds` to one Feishu
`open_id` per line for people who may inspect another employee's records. The
current Feishu sender is automatically used for self-service operations and
cannot be replaced by a value supplied by the Agent.

The bot can query attendance and approved leave records, read the configured
approval form, submit a leave instance after conversational confirmation,
list approval status and tasks, recall the user's own instance, and process a
pending task only when the current user is its approver. The approval form is
read at submission time because field IDs and option IDs are tenant-specific.

It can also list and search calendars visible to the application, read events
from a shared calendar, query the current user's busy periods, and query other
users' busy periods when the sender is configured as an administrator. A
calendar ID is required for shared-calendar event reads; omitting it resolves
the current sender's primary calendar. Creating a shared calendar is limited
to `adminOpenId` or `hrAdminOpenIds` and requires conversational confirmation.

## Troubleshooting

- No events: confirm the app version is published, the bot is installed in the chat, `im.message.receive_v1` is subscribed, and long connection mode is selected.
- Direct messages rejected: check `dmMode` and `dmAllowlist`.
- Group messages ignored: mention the bot, or check `groupAllowlist` and tenant permission approval.
- Authentication failure during startup: rotate and re-copy App ID/App Secret; the SDK distinguishes permission errors from connection errors.
- Attendance cannot resolve a member: publish the app with `attendance:task:readonly` and `contact:user.employee_id:readonly`; this plugin resolves the contact `user_id` and calls the attendance result endpoint with `employee_type=employee_id`. The member must also be present in an attendance group.
- Calendar reads return no calendars or permission errors: enable `calendar:calendar:readonly`, enable the bot capability, and share the target calendar with the app. Tenant membership alone does not expose a private primary calendar.
- Repeated reconnects: check outbound TLS/WebSocket access and proxies. Only one consumer should use a given app's event stream when deterministic delivery is required because the platform load-balances across long connections.
- `missed-message recovery failed`: grant the app chat-list and message-history read permissions, publish a new app version, and have the tenant administrator approve it. WebSocket event permission alone cannot read historical messages.
