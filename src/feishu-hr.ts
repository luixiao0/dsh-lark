import { Client, Domain } from '@larksuiteoapi/node-sdk'
import type { SettingsConfig } from './config.ts'
import type { FeishuRequesterIdentity, RequesterContextStore } from './harness.ts'
import { feishuCall } from './feishu-api.ts'

export interface FeishuToolExecutionContext {
  readonly agent?: {
    readonly session?: { readonly id?: unknown }
  }
}

export interface FeishuHrToolRegistry {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
    }
    execute(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown>
  }): () => void
}

export interface FeishuHrServiceOptions {
  settings(): SettingsConfig
  resolveSecret(ref: string): Promise<string | undefined>
  requesterContext: RequesterContextStore
}

interface RecordLike {
  [key: string]: unknown
}

interface DateValue {
  text: string
  day: number
  time: number
}

interface DateRange {
  start: DateValue
  end: DateValue
  days: number
}

interface ApprovalWidget extends RecordLike {
  id: string
  type: string
}

interface ApprovalDefinition {
  code: string
  name: string
  status: string
  form: unknown
  widgets: ApprovalWidget[]
  nodes: Array<RecordLike>
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u
const ISO_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:\d{2})$/u
const APPROVAL_STATUSES = new Set(['PENDING', 'RECALL', 'REJECT', 'DELETED', 'APPROVED', 'ALL'])
const APPROVAL_TOPICS = new Set(['1', '2', '3', '17', '18'])
const MAX_FEISHU_USERS = 50
const JSON_OUTPUT = {
  schema: { type: 'object' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

export class FeishuHrService {
  private cachedClient: { fingerprint: string; client: Client } | undefined

  constructor(private readonly options: FeishuHrServiceOptions) {}

  async getAttendance(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const range = readDateRange(input, 31)
    const userOpenIds = this.resolveTargets(input.userOpenIds, requester)
    const client = await this.getClient()
    const employeeIds = await this.resolveEmployeeIds(client, userOpenIds)
    const needOvertimeResult = optionalBoolean(input.needOvertimeResult, 'needOvertimeResult')
    const data = await feishuCall('查询考勤', () => client.attendance.userTask.query({
      data: {
        user_ids: employeeIds,
        check_date_from: range.start.day,
        check_date_to: range.end.day,
        ...(needOvertimeResult === undefined ? {} : { need_overtime_result: needOvertimeResult }),
      },
      params: {
        employee_type: 'employee_id',
        ignore_invalid_users: true,
      },
    }))
    const employeeToOpenId = new Map(employeeIds.map((employeeId, index) => [employeeId, userOpenIds[index]!]))
    const records = (data.user_task_results ?? []).map(task => {
      const userOpenId = employeeToOpenId.get(task.user_id)
      return {
        ...(userOpenId === undefined ? {} : { userOpenId }),
        employeeName: task.employee_name,
        day: formatDay(task.day),
        records: task.records.map(record => ({
          checkIn: record.check_in_record === undefined ? null : normalizeCheckRecord(record.check_in_record),
          checkOut: record.check_out_record === undefined ? null : normalizeCheckRecord(record.check_out_record),
          checkInResult: record.check_in_result,
          checkOutResult: record.check_out_result,
          checkInSupplement: record.check_in_result_supplement,
          checkOutSupplement: record.check_out_result_supplement,
          ...(record.check_in_shift_time === undefined ? {} : { checkInShiftTime: record.check_in_shift_time }),
          ...(record.check_out_shift_time === undefined ? {} : { checkOutShiftTime: record.check_out_shift_time }),
        })),
      }
    })
    return {
      startDate: range.start.text,
      endDate: range.end.text,
      userOpenIds,
      records,
      invalidUserCount: data.invalid_user_ids?.length ?? 0,
      unauthorizedUserCount: data.unauthorized_user_ids?.length ?? 0,
    }
  }

  async getLeaveRecords(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const range = readDateRange(input, 366)
    const userOpenIds = this.resolveTargets(input.userOpenIds, requester)
    const client = await this.getClient()
    const data = await feishuCall('查询假勤审批', () => client.attendance.userApproval.query({
      data: {
        user_ids: userOpenIds,
        check_date_from: range.start.day,
        check_date_to: range.end.day,
        check_date_type: 'PeriodTime',
      },
      params: { employee_type: 'open_id' },
    }))
    return {
      startDate: range.start.text,
      endDate: range.end.text,
      userOpenIds,
      records: (data.user_approvals ?? []).map(approval => ({
        userOpenId: approval.user_id,
        date: approval.date,
        leaves: (approval.leaves ?? []).map(leave => normalizeLeave(leave)),
        outs: (approval.outs ?? []).map(item => normalizeLeave(item)),
        overtimeWorks: (approval.overtime_works ?? []).map(item => ({
          approvalId: item.approval_id,
          duration: item.duration,
          unit: item.unit,
          category: item.category,
          type: item.type,
          startTime: item.start_time,
          endTime: item.end_time,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        })),
        trips: (approval.trips ?? []).map(item => ({
          approvalId: item.approval_id,
          startTime: item.start_time,
          endTime: item.end_time,
          reason: item.reason,
          approvePassTime: item.approve_pass_time,
          approveApplyTime: item.approve_apply_time,
        })),
      })),
    }
  }

  async getLeaveDefinition(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const definition = await this.loadApprovalDefinition(await this.getClient(), approvalCode(input, this.options.settings()), requester)
    return publicApprovalDefinition(definition)
  }

  async submitLeave(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const leaveType = requiredString(input, 'leaveType')
    const startTime = requiredDateTime(input.startTime, 'startTime')
    const endTime = requiredDateTime(input.endTime, 'endTime')
    if (endTime.time <= startTime.time) throw new TypeError('endTime must be later than startTime')
    const duration = requiredNumber({ duration: input.duration }, 'duration')
    if (duration <= 0 || duration > 366 || duration * 2 !== Math.round(duration * 2)) {
      throw new TypeError('duration must be a positive number in half-day increments and no greater than 366')
    }
    const reason = requiredString(input, 'reason')
    if (reason.length > 2_000) throw new TypeError('reason must not exceed 2000 characters')
    const formValues = optionalRecord(input.formValues, 'formValues')
    const settings = this.options.settings()
    const code = configuredLeaveApprovalCode(settings)
    const client = await this.getClient()
    const definition = await this.loadApprovalDefinition(client, code, requester)
    const form = buildLeaveForm(definition.widgets, {
      leaveType,
      startTime: startTime.text,
      endTime: endTime.text,
      duration,
      reason,
      formValues,
    })
    const data = await feishuCall('提交请假审批', () => client.approval.instance.create({
      data: {
        approval_code: code,
        open_id: requester.openId,
        form: JSON.stringify(form),
        title: `请假-${leaveType}`,
        with_link: true,
      },
    }))
    return {
      ok: true,
      approvalCode: code,
      instanceCode: data.instance_code,
      instanceLink: data.instance_link,
      applicantOpenId: requester.openId,
      summary: { leaveType, startTime: startTime.text, endTime: endTime.text, duration, reason },
    }
  }

  async getApprovals(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const instanceCode = optionalString(input.instanceCode, 'instanceCode')
    const client = await this.getClient()
    if (instanceCode !== undefined) {
      const detail = await this.getApprovalInstance(client, instanceCode)
      this.assertVisible(requester, detail.open_id)
      return { instance: normalizeApprovalInstance(detail) }
    }
    const target = this.resolveTargets(
      input.userOpenId === undefined ? undefined : [requiredString({ userOpenId: input.userOpenId }, 'userOpenId')],
      requester,
      false,
    )[0]!
    const code = optionalString(input.approvalCode, 'approvalCode') ?? (this.options.settings().leaveApprovalCode || undefined)
    const status = optionalString(input.status, 'status')
    if (status !== undefined && !APPROVAL_STATUSES.has(status)) throw new TypeError(`status must be one of ${[...APPROVAL_STATUSES].join(', ')}`)
    const startDate = optionalString(input.startDate, 'startDate')
    const endDate = optionalString(input.endDate, 'endDate')
    const range = startDate === undefined && endDate === undefined
      ? undefined
      : readDateRange(input, 366)
    const limit = optionalInteger(input.limit, 'limit', 1, 50) ?? 20
    const pageToken = optionalString(input.pageToken, 'pageToken')
    const data = await feishuCall('查询审批', () => client.approval.instance.query({
      data: {
        user_id: target,
        ...(code === undefined ? {} : { approval_code: code }),
        ...(status === undefined ? {} : { instance_status: status as 'PENDING' | 'RECALL' | 'REJECT' | 'DELETED' | 'APPROVED' | 'ALL' }),
        ...(range === undefined ? {} : {
          instance_start_time_from: apiTimestamp(range.start.text, false),
          instance_start_time_to: apiTimestamp(range.end.text, true),
        }),
      },
      params: {
        page_size: limit,
        user_id_type: 'open_id',
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    }))
    const instances = (data.instance_list ?? []).map(item => normalizeApprovalListItem(item, target))
    return {
      userOpenId: target,
      ...(code === undefined ? {} : { approvalCode: code }),
      count: data.count ?? instances.length,
      hasMore: data.has_more ?? false,
      ...(data.page_token === undefined ? {} : { nextPageToken: data.page_token }),
      instances,
    }
  }

  async getApprovalTasks(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const topic = optionalString(input.topic, 'topic') ?? '1'
    if (!APPROVAL_TOPICS.has(topic)) throw new TypeError('topic must be one of 1, 2, 3, 17, 18')
    const limit = optionalInteger(input.limit, 'limit', 1, 50) ?? 20
    const pageToken = optionalString(input.pageToken, 'pageToken')
    const data = await feishuCall('查询审批待办', () => this.getClient().then(client => client.approval.task.query({
      params: {
        user_id: requester.openId,
        topic: topic as '1' | '2' | '3' | '17' | '18',
        user_id_type: 'open_id',
        page_size: limit,
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    })))
    return {
      topic,
      tasks: data.tasks.map(task => ({
        taskId: task.task_id,
        instanceCode: task.process_code,
        approvalCode: task.definition_code,
        title: task.title,
        status: task.status,
        processStatus: task.process_status,
        ...(task.definition_name === undefined ? {} : { approvalName: task.definition_name }),
        ...(task.initiator_names === undefined ? {} : { initiatorNames: task.initiator_names }),
        ...(task.urls === undefined ? {} : { urls: task.urls }),
      })),
      hasMore: data.has_more ?? data.count?.has_more ?? false,
      ...(data.page_token === undefined ? {} : { nextPageToken: data.page_token }),
    }
  }

  async recallApproval(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const instanceCode = requiredString({ instanceCode: input.instanceCode }, 'instanceCode')
    const client = await this.getClient()
    const detail = await this.getApprovalInstance(client, instanceCode)
    if (detail.open_id !== requester.openId) throw new Error('只能撤回当前 Feishu 用户自己提交的审批')
    await feishuCall('撤回审批', () => client.approval.instance.recall({ data: { instance_code: instanceCode } }))
    return { ok: true, instanceCode }
  }

  async approveLeave(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    return this.processApprovalTask(args, exec, 'approve')
  }

  async rejectLeave(args: unknown, exec?: FeishuToolExecutionContext): Promise<unknown> {
    return this.processApprovalTask(args, exec, 'reject')
  }

  private async processApprovalTask(
    args: unknown,
    exec: FeishuToolExecutionContext | undefined,
    action: 'approve' | 'reject',
  ): Promise<unknown> {
    const input = asRecord(args)
    const requester = this.requireRequester(exec)
    const instanceCode = requiredString({ instanceCode: input.instanceCode }, 'instanceCode')
    const taskId = requiredString({ taskId: input.taskId }, 'taskId')
    const comment = optionalString(input.comment, 'comment')
    if (comment !== undefined && comment.length > 2_000) throw new TypeError('comment must not exceed 2000 characters')
    const client = await this.getClient()
    const task = await this.currentApprovalTask(client, requester, instanceCode, taskId)
    await feishuCall(action === 'approve' ? '同意审批' : '拒绝审批', () => action === 'approve'
      ? client.approval.task.approve({
        data: {
          approval_code: task.approvalCode,
          instance_code: instanceCode,
          user_id: requester.openId,
          task_id: taskId,
          ...(comment === undefined ? {} : { comment }),
        },
        params: { user_id_type: 'open_id' },
      })
      : client.approval.task.reject({
        data: {
          approval_code: task.approvalCode,
          instance_code: instanceCode,
          user_id: requester.openId,
          task_id: taskId,
          ...(comment === undefined ? {} : { comment }),
        },
        params: { user_id_type: 'open_id' },
      }))
    return { ok: true, action, instanceCode, taskId }
  }

  private async currentApprovalTask(client: Client, requester: FeishuRequesterIdentity, instanceCode: string, taskId: string): Promise<{ approvalCode: string }> {
    const detail = await this.getApprovalInstance(client, instanceCode)
    const detailTask = detail.task_list.find(task => task.id === taskId)
    if (detailTask?.status === 'PENDING' && (detailTask.open_id === requester.openId || detailTask.user_id === requester.openId)) {
      return { approvalCode: detail.approval_code }
    }
    const data = await feishuCall('校验审批待办', () => client.approval.task.search({
      data: {
        user_id: requester.openId,
        approval_code: detail.approval_code,
        instance_code: instanceCode,
        task_status: 'PENDING',
      },
      params: { user_id_type: 'open_id' },
    }))
    const found = (data.task_list ?? []).some(item => item.task?.task_id === taskId)
    if (!found) throw new Error('当前 Feishu 用户没有这条待处理审批，或审批已发生变化')
    return { approvalCode: detail.approval_code }
  }

  private async getApprovalInstance(client: Client, instanceCode: string) {
    return feishuCall('读取审批详情', () => client.approval.instance.get({
      path: { instance_id: instanceCode },
      params: { locale: 'zh-CN', user_id_type: 'open_id' },
    }))
  }

  private assertVisible(requester: FeishuRequesterIdentity, applicantOpenId: string): void {
    if (applicantOpenId !== requester.openId && !this.isHrAdmin(requester.openId)) {
      throw new Error('只能查看自己的假勤审批；跨员工查看需要配置 hrAdminOpenIds')
    }
  }

  private async loadApprovalDefinition(client: Client, code: string, requester: FeishuRequesterIdentity): Promise<ApprovalDefinition> {
    const data = await feishuCall('读取请假审批定义', () => client.approval.approval.get({
      path: { approval_code: code },
      params: {
        locale: 'zh-CN',
        user_id_type: 'open_id',
        user_id: requester.openId,
        with_option: true,
      },
    }))
    let form: unknown
    try {
      form = JSON.parse(data.form)
    } catch {
      throw new Error('飞书请假审批定义的表单不是有效 JSON')
    }
    return {
      code,
      name: data.approval_name,
      status: data.status,
      form,
      widgets: approvalWidgets(form),
      nodes: data.node_list as Array<RecordLike>,
    }
  }

  private async resolveEmployeeIds(client: Client, userOpenIds: string[]): Promise<string[]> {
    return Promise.all(userOpenIds.map(async openId => {
      const data = await feishuCall('读取员工信息', () => client.contact.v3.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: openId },
      }))
      const employeeId = data.user?.user_id
      if (employeeId === undefined || employeeId.trim() === '') {
        throw new Error(`Feishu 用户 ${openId} 没有返回 employee_id，无法查询考勤；请确认自建应用已开通 contact:user.employee_id:readonly，并确认员工已加入通讯录和考勤花名册`)
      }
      return employeeId
    }))
  }

  private resolveTargets(value: unknown, requester: FeishuRequesterIdentity, allowMultiple = true): string[] {
    const requested = optionalStringArray(value, 'userOpenIds')
    const targets = requested === undefined || requested.length === 0 ? [requester.openId] : requested
    if (!allowMultiple && targets.length > 1) throw new TypeError('一次只能指定一个 userOpenId')
    if (targets.length > MAX_FEISHU_USERS) throw new TypeError(`最多同时查询 ${MAX_FEISHU_USERS} 名员工`)
    if (!this.isHrAdmin(requester.openId) && targets.some(target => target !== requester.openId)) {
      throw new Error('只能查看自己的假勤信息；跨员工查看需要配置 hrAdminOpenIds')
    }
    return [...new Set(targets)]
  }

  private isHrAdmin(openId: string): boolean {
    return this.options.settings().hrAdminOpenIds.includes(openId)
  }

  private requireRequester(exec?: FeishuToolExecutionContext): FeishuRequesterIdentity {
    const sessionId = exec?.agent?.session?.id
    if (sessionId === undefined) throw new Error('假勤工具只能从 Feishu 会话中调用')
    const requester = this.options.requesterContext.get(String(sessionId))
    if (requester === undefined) throw new Error('无法确认当前 Feishu 用户身份，请从 Feishu 会话重新发起请求')
    return requester
  }

  async getClient(): Promise<Client> {
    const settings = this.options.settings()
    const appId = settings.appId.trim()
    if (appId === '') throw new Error('Feishu App ID 未配置，无法访问 Feishu API')
    const secret = (await this.options.resolveSecret(settings.appSecretRef))?.trim() || settings.appSecret?.trim() || ''
    if (secret === '') throw new Error('Feishu App Secret 未配置，无法访问 Feishu API')
    const fingerprint = `${appId}\0${settings.appSecretRef}\0${secret}\0${settings.domain}`
    if (this.cachedClient?.fingerprint === fingerprint) return this.cachedClient.client
    const client = new Client({
      appId,
      appSecret: secret,
      domain: settings.domain === 'lark' ? Domain.Lark : Domain.Feishu,
      source: 'dsh-lark',
    })
    this.cachedClient = { fingerprint, client }
    return client
  }
}

export function registerFeishuHrTools(tools: FeishuHrToolRegistry, service: FeishuHrService): () => void {
  const disposers = [
    tools.register({
      name: 'feishu_get_attendance',
      description: '查询当前 Feishu 用户或指定员工的每日打卡结果。当前用户由 Feishu 会话自动绑定，不要猜测或伪造 userOpenIds；跨员工查询只有配置在 hrAdminOpenIds 中的假勤管理员可以使用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '开始日期，YYYY-MM-DD。' },
          endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '结束日期，YYYY-MM-DD，最多查询 31 个自然日。' },
          userOpenIds: { type: 'array', maxItems: MAX_FEISHU_USERS, items: { type: 'string' }, description: '可选。假勤管理员查询的 Feishu open_id 列表；普通员工只能省略此参数。' },
          needOvertimeResult: { type: 'boolean', description: '可选，是否请求加班结果。' },
        },
        required: ['startDate', 'endDate'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getAttendance(args, exec),
    }),
    tools.register({
      name: 'feishu_get_leave_records',
      description: '查询当前 Feishu 用户或假勤管理员指定员工在日期范围内已通过或已撤回的请假、外出、出差、加班记录。当前用户由 Feishu 会话自动绑定。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '开始日期，YYYY-MM-DD。' },
          endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '结束日期，YYYY-MM-DD，最多查询 366 个自然日。' },
          userOpenIds: { type: 'array', maxItems: MAX_FEISHU_USERS, items: { type: 'string' }, description: '可选。假勤管理员查询的 Feishu open_id 列表。' },
        },
        required: ['startDate', 'endDate'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getLeaveRecords(args, exec),
    }),
    tools.register({
      name: 'feishu_get_leave_definition',
      description: '读取请假审批定义的表单字段和选项。提交请假前优先调用，用于确认 leaveType 和自定义 formValues 的字段 ID。approvalCode 省略时使用 lark-channel.leaveApprovalCode。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { approvalCode: { type: 'string', description: '可选的飞书 approval_code。' } },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getLeaveDefinition(args, exec),
    }),
    tools.register({
      name: 'feishu_submit_leave',
      description: '以当前 Feishu 用户身份创建真实的请假审批。必须先收集假期类型、开始时间、结束时间、时长和事由，并在会话中向员工展示摘要、得到确认后才能调用；不要使用 attendance.userApproval.create 回写普通飞书审批。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          leaveType: { type: 'string', description: '假期类型，例如年假、事假、病假，必须匹配请假审批表单选项。' },
          startTime: { type: 'string', description: '开始时间，带时区的 ISO-8601 时间。' },
          endTime: { type: 'string', description: '结束时间，带时区的 ISO-8601 时间。' },
          duration: { type: 'number', minimum: 0.5, maximum: 366, description: '请假时长，按天计算，使用 0.5 天的倍数。' },
          reason: { type: 'string', description: '请假事由。' },
          formValues: { type: 'object', description: '可选。表单定义中未能自动识别的字段值，键使用字段 id。', additionalProperties: true },
        },
        required: ['leaveType', 'startTime', 'endTime', 'duration', 'reason'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.submitLeave(args, exec),
    }),
    tools.register({
      name: 'feishu_get_approvals',
      description: '查询当前用户或假勤管理员指定员工的请假审批列表，也可以通过 instanceCode 读取单据详情。普通员工只能看自己的审批。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          instanceCode: { type: 'string', description: '可选。指定后读取单个审批实例详情。' },
          approvalCode: { type: 'string', description: '可选的审批定义 Code，省略时使用配置值或查询全部审批。' },
          userOpenId: { type: 'string', description: '可选。假勤管理员查询指定员工；普通员工只能使用自己的 open_id。' },
          startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          status: { type: 'string', enum: [...APPROVAL_STATUSES] },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          pageToken: { type: 'string' },
        },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getApprovals(args, exec),
    }),
    tools.register({
      name: 'feishu_get_approval_tasks',
      description: '查询当前 Feishu 用户的审批待办或已办任务。用于找到需要本人处理的请假审批 taskId；不能替别人审批。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          topic: { type: 'string', enum: ['1', '2', '3', '17', '18'], default: '1', description: '1 待办，2 已办，3 已发起，17 抄送，18 关注。' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          pageToken: { type: 'string' },
        },
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.getApprovalTasks(args, exec),
    }),
    tools.register({
      name: 'feishu_recall_approval',
      description: '撤回当前 Feishu 用户自己提交的请假审批。撤回是真实副作用，先展示 instanceCode 和影响并获得确认，再调用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { instanceCode: { type: 'string' } },
        required: ['instanceCode'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.recallApproval(args, exec),
    }),
    tools.register({
      name: 'feishu_approve_leave',
      description: '用当前 Feishu 用户的审批人身份同意一条待处理请假审批。必须先确认 taskId 属于当前用户，并在会话中获得确认后调用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { instanceCode: { type: 'string' }, taskId: { type: 'string' }, comment: { type: 'string' } },
        required: ['instanceCode', 'taskId'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.approveLeave(args, exec),
    }),
    tools.register({
      name: 'feishu_reject_leave',
      description: '用当前 Feishu 用户的审批人身份拒绝一条待处理请假审批。必须先确认 taskId 属于当前用户、说明拒绝原因并获得确认后调用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { instanceCode: { type: 'string' }, taskId: { type: 'string' }, comment: { type: 'string' } },
        required: ['instanceCode', 'taskId'],
      },
      output: JSON_OUTPUT,
      execute: (args, exec) => service.rejectLeave(args, exec),
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
  if (result.length > MAX_FEISHU_USERS) throw new TypeError(`${key} must contain at most ${MAX_FEISHU_USERS} users`)
  return [...new Set(result)]
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function requiredNumber(input: RecordLike, key: string): number {
  const value = input[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${key} must be a finite number`)
  return value
}

function optionalInteger(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function optionalRecord(value: unknown, key: string): RecordLike | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${key} must be an object`)
  return value as RecordLike
}

function requiredDateTime(value: unknown, key: string): { text: string; time: number } {
  const text = requiredString({ [key]: value }, key)
  if (!ISO_TIMEZONE_PATTERN.test(text)) throw new TypeError(`${key} must include an ISO-8601 timezone`)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new TypeError(`${key} must be a valid ISO-8601 time`)
  return { text, time }
}

function readDateRange(input: RecordLike, maxDays: number): DateRange {
  const start = parseDate(requiredString(input, 'startDate'), 'startDate')
  const end = parseDate(requiredString(input, 'endDate'), 'endDate')
  if (end.time < start.time) throw new TypeError('endDate must not be earlier than startDate')
  const days = Math.floor((end.time - start.time) / 86_400_000) + 1
  if (days > maxDays) throw new TypeError(`date range must not exceed ${maxDays} days`)
  return { start, end, days }
}

function parseDate(text: string, key: string): DateValue {
  const match = DATE_PATTERN.exec(text)
  if (match === null) throw new TypeError(`${key} must use YYYY-MM-DD`)
  const time = Date.parse(`${text}T00:00:00Z`)
  const date = new Date(time)
  if (!Number.isFinite(time) || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) {
    throw new TypeError(`${key} is not a valid calendar date`)
  }
  return { text, day: Number(`${match[1]}${match[2]}${match[3]}`), time }
}

function formatDay(day: number): string {
  const text = String(day)
  return text.length === 8 ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text
}

function apiTimestamp(date: string, end: boolean): string {
  return new Date(`${date}T${end ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString()
}

function approvalCode(input: RecordLike, settings: SettingsConfig): string {
  return optionalString(input.approvalCode, 'approvalCode') ?? (settings.leaveApprovalCode || (() => { throw new Error('未配置请假 approvalCode，请在 lark-channel 设置中填写 leaveApprovalCode') })())
}

function configuredLeaveApprovalCode(settings: SettingsConfig): string {
  const code = settings.leaveApprovalCode.trim()
  if (code === '') throw new Error('未配置请假 approvalCode，请在 lark-channel 设置中填写 leaveApprovalCode')
  return code
}

function normalizeCheckRecord(record: { check_time: string; location_name: string; comment: string; check_result?: string | undefined; record_id?: string | undefined }): RecordLike {
  return {
    checkTime: record.check_time,
    ...(record.location_name === '' ? {} : { location: record.location_name }),
    ...(record.check_result === undefined ? {} : { result: record.check_result }),
    ...(record.comment === '' ? {} : { comment: record.comment }),
  }
}

function normalizeLeave(item: {
  approval_id?: string | undefined
  uniq_id?: string | undefined
  unit: number
  interval: number
  start_time: string
  end_time: string
  i18n_names: { ch?: string | undefined; en?: string | undefined; ja?: string | undefined }
  default_locale: string
  reason: string
  approve_pass_time?: string | undefined
  approve_apply_time?: string | undefined
}): RecordLike {
  const leaveType = item.i18n_names.ch ?? item.i18n_names.en ?? item.i18n_names.ja ?? item.default_locale
  return {
    ...(item.approval_id === undefined ? {} : { approvalId: item.approval_id }),
    ...(item.uniq_id === undefined ? {} : { recordId: item.uniq_id }),
    leaveType,
    durationInterval: item.interval,
    durationUnit: item.unit,
    startTime: item.start_time,
    endTime: item.end_time,
    reason: item.reason,
    ...(item.approve_pass_time === undefined ? {} : { approvedAt: item.approve_pass_time }),
    ...(item.approve_apply_time === undefined ? {} : { appliedAt: item.approve_apply_time }),
  }
}

function approvalWidgets(value: unknown, output: ApprovalWidget[] = []): ApprovalWidget[] {
  if (Array.isArray(value)) {
    for (const item of value) approvalWidgets(item, output)
    return output
  }
  if (!isRecord(value)) return output
  const id = typeof value.id === 'string' ? value.id : undefined
  const type = typeof value.type === 'string' ? value.type : undefined
  if (id !== undefined && type !== undefined && !['section', 'fieldGroup', 'formGroup', 'layout'].includes(type)) {
    output.push(value as ApprovalWidget)
  }
  for (const child of Object.values(value)) approvalWidgets(child, output)
  return output
}

function publicApprovalDefinition(definition: ApprovalDefinition): RecordLike {
  return {
    approvalCode: definition.code,
    approvalName: definition.name,
    status: definition.status,
    form: definition.form,
    fields: definition.widgets.map(widget => ({
      id: widget.id,
      name: widgetName(widget),
      type: widget.type,
      required: widgetRequired(widget),
      ...(widgetOptions(widget).length === 0 ? {} : { options: widgetOptions(widget) }),
    })),
    nodes: definition.nodes.map(node => ({
      ...(typeof node.name === 'string' ? { name: node.name } : {}),
      ...(typeof node.node_id === 'string' ? { nodeId: node.node_id } : {}),
      ...(typeof node.node_type === 'string' ? { nodeType: node.node_type } : {}),
      ...(typeof node.need_approver === 'boolean' ? { needApprover: node.need_approver } : {}),
    })),
  }
}

function buildLeaveForm(widgets: ApprovalWidget[], values: {
  leaveType: string
  startTime: string
  endTime: string
  duration: number
  reason: string
  formValues: RecordLike | undefined
}): Array<{ id: string; type: string; value: unknown }> {
  const entries: Array<{ id: string; type: string; value: unknown }> = []
  const missing: string[] = []
  let simpleDateIndex = 0
  for (const widget of widgets) {
    const name = widgetName(widget)
    const explicit = values.formValues?.[widget.id] ?? (name === '' ? undefined : values.formValues?.[name])
    if (explicit === null) throw new TypeError(`formValues.${widget.id} cannot be null`)
    const simpleDate = isSimpleDateWidget(widget)
    const value = explicit ?? deriveFormValue(widget, name, values, simpleDateIndex)
    if (simpleDate) simpleDateIndex += 1
    if (value === undefined) {
      if (widgetRequired(widget)) missing.push(`${name || widget.id} (${widget.id})`)
      continue
    }
    entries.push({ id: widget.id, type: widget.type, value })
  }
  if (missing.length > 0) throw new Error(`请假表单还有必填字段，请通过 formValues 提供：${missing.join(', ')}`)
  return entries
}

function deriveFormValue(widget: ApprovalWidget, name: string, values: {
  leaveType: string
  startTime: string
  endTime: string
  duration: number
  reason: string
}, dateIndex: number): unknown {
  const type = normalizedType(widget.type)
  if (type === 'dateinterval' || type === 'daterange') {
    return { start: values.startTime, end: values.endTime, interval: values.duration }
  }
  if (type === 'leavegroup' || type === 'leavegroupv2') {
    return { name: values.leaveType, start: values.startTime, end: values.endTime, interval: values.duration }
  }
  if (isSimpleDateWidget(widget)) return dateIndex === 0 ? values.startTime : values.endTime
  if (isLeaveTypeWidget(type, name)) return formOptionValue(widget, values.leaveType)
  if (isDurationWidget(type, name)) return String(values.duration)
  if (isReasonWidget(type, name)) return values.reason
  return undefined
}

function isSimpleDateWidget(widget: ApprovalWidget): boolean {
  const type = normalizedType(widget.type)
  return type === 'date' || type === 'datetime' || type === 'time'
}

function isLeaveTypeWidget(type: string, name: string): boolean {
  return type.includes('leavetype') || /(?:请假|假期)\s*(?:类型|类别)|leave\s*type/iu.test(name) || (name.includes('类型') && (type.includes('radio') || type.includes('select') || type.includes('option')))
}

function isDurationWidget(type: string, name: string): boolean {
  return (type.includes('number') || type.includes('input') || type.includes('text')) && /时长|天数|小时|duration|days?|hours?/iu.test(name)
}

function isReasonWidget(type: string, name: string): boolean {
  return (type.includes('textarea') || type.includes('input') || type.includes('text')) && /事由|原因|理由|说明|备注|reason|remark/iu.test(name)
}

function formOptionValue(widget: ApprovalWidget, label: string): string {
  const options = widgetOptions(widget)
  const match = options.find(option => option.label === label || option.label.toLocaleLowerCase() === label.toLocaleLowerCase())
  if (match !== undefined) return match.id ?? match.label
  if (options.length > 0) throw new Error(`leaveType “${label}” 不在字段 ${widgetName(widget)} 的飞书选项中`)
  return label
}

function widgetOptions(widget: ApprovalWidget): Array<{ id?: string; label: string }> {
  const result: Array<{ id?: string; label: string }> = []
  for (const key of ['option', 'options', 'items']) {
    const value = widget[key]
    const candidates = Array.isArray(value) ? value : isRecord(value) ? Object.values(value).find(Array.isArray) : undefined
    if (!Array.isArray(candidates)) continue
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue
      const label = typeof candidate.text === 'string'
        ? candidate.text
        : typeof candidate.name === 'string' ? candidate.name
          : typeof candidate.label === 'string' ? candidate.label
            : typeof candidate.value === 'string' ? candidate.value : undefined
      if (label === undefined || result.some(item => item.label === label)) continue
      const id = typeof candidate.id === 'string'
        ? candidate.id
        : typeof candidate.key === 'string' ? candidate.key
          : typeof candidate.value === 'string' && candidate.value !== label ? candidate.value : undefined
      result.push({ label, ...(id === undefined ? {} : { id }) })
    }
  }
  return result
}

function widgetName(widget: ApprovalWidget): string {
  return typeof widget.name === 'string' ? widget.name.trim() : typeof widget.label === 'string' ? widget.label.trim() : ''
}

function widgetRequired(widget: ApprovalWidget): boolean {
  return widget.required === true || widget.required === 'true' || widget.is_required === true
}

function normalizedType(type: string): string {
  return type.replace(/[\s_-]/gu, '').toLocaleLowerCase()
}

function normalizeApprovalInstance(data: {
  approval_code: string
  approval_name: string
  start_time?: string | undefined
  end_time: string
  open_id: string
  status: string
  form: string
  task_list: Array<{ id: string; open_id?: string | undefined; status: string; node_name?: string | undefined; start_time: string; end_time?: string | undefined }>
  instance_code: string
}): RecordLike {
  return {
    instanceCode: data.instance_code,
    approvalCode: data.approval_code,
    approvalName: data.approval_name,
    applicantOpenId: data.open_id,
    status: data.status,
    ...(data.start_time === undefined ? {} : { startTime: data.start_time }),
    endTime: data.end_time,
    form: parseJsonOrText(data.form),
    tasks: data.task_list.map(task => ({
      taskId: task.id,
      ...(task.open_id === undefined ? {} : { approverOpenId: task.open_id }),
      status: task.status,
      ...(task.node_name === undefined ? {} : { nodeName: task.node_name }),
      startTime: task.start_time,
      ...(task.end_time === undefined ? {} : { endTime: task.end_time }),
    })),
  }
}

function normalizeApprovalListItem(item: {
  approval?: { code?: string | undefined; name?: string | undefined } | undefined
  instance?: {
    code?: string | undefined
    start_time?: string | undefined
    end_time?: string | undefined
    status?: string | undefined
    title?: string | undefined
    link?: { pc_link?: string | undefined; mobile_link?: string | undefined } | undefined
  } | undefined
}, applicantOpenId: string): RecordLike {
  const instance = item.instance
  return {
    ...(instance?.code === undefined ? {} : { instanceCode: instance.code }),
    ...(item.approval?.code === undefined ? {} : { approvalCode: item.approval.code }),
    ...(item.approval?.name === undefined ? {} : { approvalName: item.approval.name }),
    applicantOpenId,
    ...(instance?.status === undefined ? {} : { status: instance.status }),
    ...(instance?.title === undefined ? {} : { title: instance.title }),
    ...(instance?.start_time === undefined ? {} : { startTime: instance.start_time }),
    ...(instance?.end_time === undefined ? {} : { endTime: instance.end_time }),
    ...(instance?.link === undefined ? {} : { link: instance.link }),
  }
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
