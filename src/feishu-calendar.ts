import type { Client } from '@larksuiteoapi/node-sdk'
import type { SettingsConfig } from './config.ts'
import type { FeishuRequesterIdentity, RequesterContextStore } from './harness.ts'
import type { FeishuHrToolRegistry, FeishuToolExecutionContext } from './feishu-hr.ts'
import { feishuCall } from './feishu-api.ts'

interface RecordLike {
  [key: string]: unknown
}

interface CalendarTimeRange {
  start: string
  end: string
  startSeconds: string
  endSeconds: string
}

export interface FeishuCalendarServiceOptions {
  settings(): SettingsConfig
  client(): Promise<Client>
  requesterContext: RequesterContextStore
}

const MAX_CALENDAR_USERS = 50
const MAX_CALENDAR_PAGE_SIZE = 50
const MAX_CALENDAR_RANGE_DAYS = 31
const ISO_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/u
const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export class FeishuCalendarService {
  constructor(private readonly options: FeishuCalendarServiceOptions) {}

  async listCalendars(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    this.requireRequester(exec)
    const input = asRecord(args)
    const pageSize = optionalInteger(input.pageSize, 'pageSize', 1, MAX_CALENDAR_PAGE_SIZE) ?? MAX_CALENDAR_PAGE_SIZE
    const pageToken = optionalString(input.pageToken, 'pageToken')
    const syncToken = optionalString(input.syncToken, 'syncToken')
    if (pageToken !== undefined && syncToken !== undefined) throw new TypeError('pageToken and syncToken cannot be used together')
    const data = await feishuCall('查询日历列表', () => this.options.client().then(client => client.calendar.calendar.list({
      params: {
        page_size: pageSize,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
        ...(syncToken === undefined ? {} : { sync_token: syncToken }),
      },
    })))
    return {
      calendars: (data.calendar_list ?? []).map(normalizeCalendar),
      hasMore: data.has_more ?? false,
      ...(data.page_token === undefined ? {} : { nextPageToken: data.page_token }),
      ...(data.sync_token === undefined ? {} : { syncToken: data.sync_token }),
    }
  }

  async searchCalendars(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    this.requireRequester(exec)
    const input = asRecord(args)
    const query = requiredString(input, 'query')
    const pageSize = optionalInteger(input.pageSize, 'pageSize', 1, MAX_CALENDAR_PAGE_SIZE) ?? MAX_CALENDAR_PAGE_SIZE
    const pageToken = optionalString(input.pageToken, 'pageToken')
    const data = await feishuCall('搜索日历', () => this.options.client().then(client => client.calendar.calendar.search({
      data: { query },
      params: {
        page_size: pageSize,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    })))
    return {
      query,
      calendars: (data.items ?? []).map(normalizeCalendar),
      ...(data.page_token === undefined ? {} : { nextPageToken: data.page_token }),
    }
  }

  async getCalendarEvents(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const requester = this.requireRequester(exec)
    const input = asRecord(args)
    const range = readCalendarTimeRange(input)
    const calendarId = optionalString(input.calendarId, 'calendarId')
    const targetUserOpenId = optionalString(input.userOpenId, 'userOpenId') ?? requester.openId
    this.assertUserVisible(requester, targetUserOpenId)
    const client = await this.options.client()
    const resolvedCalendarId = calendarId ?? await this.resolvePrimaryCalendarId(client, targetUserOpenId)
    const calendarData = await feishuCall('读取日历信息', () => client.calendar.calendar.get({ path: { calendar_id: resolvedCalendarId } }))
    if (calendarData.calendar_id === undefined) throw new Error(`飞书没有返回日历 ${resolvedCalendarId} 的信息`)
    const pageToken = optionalString(input.pageToken, 'pageToken')
    const data = await feishuCall('查询日程列表', () => client.calendar.calendarEvent.list({
      path: { calendar_id: resolvedCalendarId },
      params: {
        page_size: optionalInteger(input.pageSize, 'pageSize', 1, MAX_CALENDAR_PAGE_SIZE) ?? MAX_CALENDAR_PAGE_SIZE,
        start_time: range.startSeconds,
        end_time: range.endSeconds,
        user_id_type: 'open_id',
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    }))
    return {
      calendar: normalizeCalendar(calendarData),
      targetUserOpenId,
      startTime: range.start,
      endTime: range.end,
      events: (data.items ?? []).map(normalizeCalendarEvent),
      hasMore: data.has_more ?? false,
      ...(data.page_token === undefined ? {} : { nextPageToken: data.page_token }),
    }
  }

  async getFreeBusy(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const requester = this.requireRequester(exec)
    const input = asRecord(args)
    const range = readCalendarTimeRange(input)
    const requested = optionalStringArray(input.userOpenIds, 'userOpenIds')
    const userOpenIds = requested === undefined || requested.length === 0 ? [requester.openId] : requested
    if (userOpenIds.some(userOpenId => userOpenId !== requester.openId) && !this.isCalendarAdmin(requester.openId)) {
      throw new Error('只能查询自己的日历忙闲；跨员工查询需要配置 adminOpenId 或 hrAdminOpenIds')
    }
    const includeExternalCalendar = optionalBoolean(input.includeExternalCalendar, 'includeExternalCalendar')
    const needRsvpStatus = optionalBoolean(input.needRsvpStatus, 'needRsvpStatus')
    const data = await feishuCall('查询日历忙闲', () => this.options.client().then(client => client.calendar.freebusy.batch({
      data: {
        time_min: range.start,
        time_max: range.end,
        user_ids: userOpenIds,
        ...(includeExternalCalendar === undefined ? {} : { include_external_calendar: includeExternalCalendar }),
        only_busy: optionalBoolean(input.onlyBusy, 'onlyBusy') ?? true,
        ...(needRsvpStatus === undefined ? {} : { need_rsvp_status: needRsvpStatus }),
      },
      params: { user_id_type: 'open_id' },
    })))
    return {
      userOpenIds,
      startTime: range.start,
      endTime: range.end,
      users: (data.freebusy_lists ?? []).map(item => {
        const record = asRecord(item)
        const busy = Array.isArray(record.freebusy_items) ? record.freebusy_items.filter(isRecord).map(interval => ({
          startTime: stringOrUndefined(interval.start_time),
          endTime: stringOrUndefined(interval.end_time),
          ...(typeof interval.rsvp_status === 'string' ? { rsvpStatus: interval.rsvp_status } : {}),
        })) : []
        return {
          ...(typeof record.user_id === 'string' ? { userOpenId: record.user_id } : {}),
          busy,
        }
      }),
    }
  }

  async createSharedCalendar(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const requester = this.requireRequester(exec)
    if (!this.isCalendarAdmin(requester.openId)) {
      throw new Error('只有配置在 adminOpenId 或 hrAdminOpenIds 中的管理员可以创建共享日历')
    }
    const input = asRecord(args)
    const summary = requiredString(input, 'summary')
    if (summary.length > 100) throw new TypeError('summary must not exceed 100 characters')
    const description = optionalString(input.description, 'description')
    if (description !== undefined && description.length > 2_000) throw new TypeError('description must not exceed 2000 characters')
    const permissions = optionalString(input.permissions, 'permissions') ?? 'show_only_free_busy'
    if (!['private', 'show_only_free_busy', 'public'].includes(permissions)) {
      throw new TypeError('permissions must be private, show_only_free_busy, or public')
    }
    const data = await feishuCall('创建共享日历', () => this.options.client().then(client => client.calendar.calendar.create({
      data: {
        summary,
        ...(description === undefined ? {} : { description }),
        permissions: permissions as 'private' | 'show_only_free_busy' | 'public',
      },
    })))
    if (data.calendar === undefined) throw new Error('飞书没有返回新建共享日历的信息')
    return { ok: true, calendar: normalizeCalendar(data.calendar) }
  }

  private async resolvePrimaryCalendarId(client: Client, userOpenId: string): Promise<string> {
    const data = await feishuCall('读取主日历', () => client.calendar.calendar.primarys({
      data: { user_ids: [userOpenId] },
      params: { user_id_type: 'open_id' },
    }))
    const calendar = data.calendars?.find(item => item.user_id === userOpenId)?.calendar ?? data.calendars?.[0]?.calendar
    const calendarId = calendar?.calendar_id
    if (calendarId === undefined || calendarId.trim() === '') {
      throw new Error('无法读取该 Feishu 用户的主日历；请把日历共享给应用，或直接提供共享日历 calendarId')
    }
    return calendarId
  }

  private assertUserVisible(requester: FeishuRequesterIdentity, targetUserOpenId: string): void {
    if (targetUserOpenId !== requester.openId && !this.isCalendarAdmin(requester.openId)) {
      throw new Error('只能查看自己的日历；跨员工查看需要配置 adminOpenId 或 hrAdminOpenIds')
    }
  }

  private isCalendarAdmin(openId: string): boolean {
    const settings = this.options.settings()
    return openId === settings.adminOpenId || settings.hrAdminOpenIds.includes(openId)
  }

  private requireRequester(exec?: FeishuToolExecutionContext): FeishuRequesterIdentity {
    const sessionId = exec?.agent?.session?.id
    if (sessionId === undefined) throw new Error('日历工具只能从 Feishu 会话中调用')
    const requester = this.options.requesterContext.get(String(sessionId))
    if (requester === undefined) throw new Error('无法确认当前 Feishu 用户身份，请从 Feishu 会话重新发起请求')
    return requester
  }
}

export function registerFeishuCalendarTools(tools: FeishuHrToolRegistry, service: FeishuCalendarService): () => void {
  const disposers = [
    tools.register({
      name: 'feishu_list_calendars',
      description: '列出当前 Feishu 应用身份可见的日历。优先用于发现已公开或已共享给机器人的团队日历；不会因为用户在同一租户就自动获得其私人日历。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          pageSize: { type: 'integer', minimum: 1, maximum: MAX_CALENDAR_PAGE_SIZE, default: MAX_CALENDAR_PAGE_SIZE },
          pageToken: { type: 'string' },
          syncToken: { type: 'string' },
        },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.listCalendars(args, exec),
    }),
    tools.register({
      name: 'feishu_search_calendars',
      description: '按关键词搜索 Feishu 公共或已可见日历，例如团队周会、请假外出。应用身份不支持搜索用户私人主日历。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: '日历标题或描述中的关键词。' },
          pageSize: { type: 'integer', minimum: 1, maximum: MAX_CALENDAR_PAGE_SIZE, default: MAX_CALENDAR_PAGE_SIZE },
          pageToken: { type: 'string' },
        },
        required: ['query'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.searchCalendars(args, exec),
    }),
    tools.register({
      name: 'feishu_get_calendar_events',
      description: '读取一个可见日历在时间范围内的日程。calendarId 省略时读取当前 Feishu 用户的主日历；共享日历需要先列出或搜索得到 calendarId。时间必须带时区，最多 31 天。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          calendarId: { type: 'string', description: '可选。共享日历或主日历的 calendar_id。' },
          userOpenId: { type: 'string', description: '可选。管理员读取指定用户的主日历；普通用户只能省略或填写自己。' },
          startTime: { type: 'string', description: '开始时间，RFC3339，例如 2026-09-03T00:00:00+08:00。' },
          endTime: { type: 'string', description: '结束时间，RFC3339，例如 2026-09-04T00:00:00+08:00。' },
          pageSize: { type: 'integer', minimum: 1, maximum: MAX_CALENDAR_PAGE_SIZE, default: MAX_CALENDAR_PAGE_SIZE },
          pageToken: { type: 'string' },
        },
        required: ['startTime', 'endTime'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getCalendarEvents(args, exec),
    }),
    tools.register({
      name: 'feishu_get_calendar_freebusy',
      description: '查询 Feishu 用户主日历的忙闲时间段。默认查询当前用户；跨员工查询需要 adminOpenId 或 hrAdminOpenIds。不会返回私人日程标题，只返回忙闲区间。时间必须带时区，最多 31 天。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          startTime: { type: 'string', description: '开始时间，RFC3339。' },
          endTime: { type: 'string', description: '结束时间，RFC3339。' },
          userOpenIds: { type: 'array', maxItems: MAX_CALENDAR_USERS, items: { type: 'string' }, description: '可选。管理员要查询的 Feishu open_id 列表。' },
          includeExternalCalendar: { type: 'boolean' },
          onlyBusy: { type: 'boolean', default: true },
          needRsvpStatus: { type: 'boolean' },
        },
        required: ['startTime', 'endTime'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getFreeBusy(args, exec),
    }),
    tools.register({
      name: 'feishu_create_shared_calendar',
      description: '创建 Feishu 共享日历。仅配置在 adminOpenId 或 hrAdminOpenIds 中的管理员可以调用；这是实际写操作，必须先向用户展示名称、可见范围和用途并获得明确确认。permissions 默认 show_only_free_busy，只有用户明确要求公开日程详情时才使用 public。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          summary: { type: 'string', description: '共享日历名称。' },
          description: { type: 'string', description: '可选。共享日历说明。' },
          permissions: { type: 'string', enum: ['private', 'show_only_free_busy', 'public'], default: 'show_only_free_busy', description: 'private 仅所有者，show_only_free_busy 只公开忙闲，public 公开日程详情。' },
        },
        required: ['summary'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.createSharedCalendar(args, exec),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function asRecord(value: unknown): RecordLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('tool arguments must be an object')
  return value as RecordLike
}

function requiredString(input: RecordLike, key: string): string {
  const value = optionalString(input[key], key)
  if (value === undefined) throw new TypeError(`${key} is required`)
  return value
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  const result = value.trim()
  if (result === '') throw new TypeError(`${key} must not be empty`)
  return result
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError(`${key} must be an array of strings`)
  const result = value.map(item => {
    if (typeof item !== 'string' || item.trim() === '') throw new TypeError(`${key} must contain non-empty strings`)
    return item.trim()
  })
  if (result.length > MAX_CALENDAR_USERS) throw new TypeError(`${key} must contain at most ${MAX_CALENDAR_USERS} users`)
  return [...new Set(result)]
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function optionalInteger(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function readCalendarTimeRange(input: RecordLike): CalendarTimeRange {
  const start = requiredCalendarTime(input, 'startTime')
  const end = requiredCalendarTime(input, 'endTime')
  if (end.time <= start.time) throw new TypeError('endTime must be later than startTime')
  const days = (end.time - start.time) / 86_400_000
  if (days > MAX_CALENDAR_RANGE_DAYS) throw new TypeError(`calendar time range must not exceed ${MAX_CALENDAR_RANGE_DAYS} days`)
  return {
    start: start.text,
    end: end.text,
    startSeconds: String(Math.floor(start.time / 1_000)),
    endSeconds: String(Math.floor(end.time / 1_000)),
  }
}

function requiredCalendarTime(input: RecordLike, key: string): { text: string; time: number } {
  const text = requiredString(input, key)
  if (!ISO_TIMEZONE_PATTERN.test(text)) throw new TypeError(`${key} must include an ISO-8601 timezone`)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new TypeError(`${key} must be a valid ISO-8601 time`)
  return { text, time }
}

function normalizeCalendar(value: unknown): RecordLike {
  const calendar = asRecord(value)
  return {
    calendarId: requiredString(calendar, 'calendar_id'),
    ...(stringOrUndefined(calendar.summary) === undefined ? {} : { summary: calendar.summary }),
    ...(stringOrUndefined(calendar.description) === undefined ? {} : { description: calendar.description }),
    ...(stringOrUndefined(calendar.permissions) === undefined ? {} : { permissions: calendar.permissions }),
    ...(stringOrUndefined(calendar.type) === undefined ? {} : { type: calendar.type }),
    ...(stringOrUndefined(calendar.role) === undefined ? {} : { role: calendar.role }),
    ...(stringOrUndefined(calendar.summary_alias) === undefined ? {} : { summaryAlias: calendar.summary_alias }),
    ...(typeof calendar.is_deleted === 'boolean' ? { isDeleted: calendar.is_deleted } : {}),
    ...(typeof calendar.is_third_party === 'boolean' ? { isThirdParty: calendar.is_third_party } : {}),
  }
}

function normalizeCalendarEvent(value: unknown): RecordLike {
  const event = asRecord(value)
  const result: RecordLike = {
    eventId: requiredString(event, 'event_id'),
  }
  copyString(result, 'summary', event.summary)
  copyString(result, 'description', event.description)
  copyString(result, 'status', event.status)
  copyString(result, 'visibility', event.visibility)
  copyString(result, 'freeBusyStatus', event.free_busy_status)
  copyString(result, 'appLink', event.app_link)
  copyString(result, 'recurringEventId', event.recurring_event_id)
  if (isRecord(event.start_time)) result.startTime = normalizeEventTime(event.start_time)
  if (isRecord(event.end_time)) result.endTime = normalizeEventTime(event.end_time)
  if (isRecord(event.location)) result.location = normalizeLocation(event.location)
  if (isRecord(event.event_organizer)) result.organizer = normalizePerson(event.event_organizer)
  if (Array.isArray(event.attendees)) {
    result.attendees = event.attendees.filter(isRecord).map(attendee => ({
      ...(stringOrUndefined(attendee.display_name) === undefined ? {} : { displayName: attendee.display_name }),
      ...(stringOrUndefined(attendee.user_id) === undefined ? {} : { userOpenId: attendee.user_id }),
      ...(stringOrUndefined(attendee.rsvp_status) === undefined ? {} : { rsvpStatus: attendee.rsvp_status }),
      ...(typeof attendee.is_optional === 'boolean' ? { optional: attendee.is_optional } : {}),
      ...(typeof attendee.is_organizer === 'boolean' ? { organizer: attendee.is_organizer } : {}),
    }))
  }
  return result
}

function normalizeEventTime(value: RecordLike): RecordLike {
  return {
    ...(stringOrUndefined(value.date) === undefined ? {} : { date: value.date }),
    ...(stringOrUndefined(value.timestamp) === undefined ? {} : { timestamp: value.timestamp }),
    ...(stringOrUndefined(value.timezone) === undefined ? {} : { timezone: value.timezone }),
  }
}

function normalizeLocation(value: RecordLike): RecordLike {
  return {
    ...(stringOrUndefined(value.name) === undefined ? {} : { name: value.name }),
    ...(stringOrUndefined(value.address) === undefined ? {} : { address: value.address }),
    ...(typeof value.latitude === 'number' ? { latitude: value.latitude } : {}),
    ...(typeof value.longitude === 'number' ? { longitude: value.longitude } : {}),
  }
}

function normalizePerson(value: RecordLike): RecordLike {
  return {
    ...(stringOrUndefined(value.user_id) === undefined ? {} : { userOpenId: value.user_id }),
    ...(stringOrUndefined(value.display_name) === undefined ? {} : { displayName: value.display_name }),
  }
}

function copyString(target: RecordLike, key: string, value: unknown): void {
  if (typeof value === 'string' && value !== '') target[key] = value
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
