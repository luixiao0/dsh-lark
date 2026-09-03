export interface FeishuApiResponse<T> {
  code?: number | undefined
  msg?: string | undefined
  data?: T | undefined
}

export async function feishuCall<T>(operation: string, request: () => Promise<FeishuApiResponse<T>>): Promise<NonNullable<T>> {
  try {
    const response = await request()
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书${operation}失败（${response.code}）：${response.msg ?? '未知错误'}`)
    }
    if (response.data === undefined) throw new Error(`飞书${operation}没有返回数据`)
    return response.data as NonNullable<T>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`飞书${operation}`)) throw error
    const detail = feishuErrorDetail(error)
    throw new Error(`飞书${operation}失败${detail}`, { cause: error })
  }
}

function feishuErrorDetail(error: unknown): string {
  const queue: unknown[] = [error]
  const visited = new Set<object>()
  let fallback: string | undefined
  while (queue.length > 0) {
    const value = queue.shift()
    if (value === null || typeof value !== 'object') continue
    if (visited.has(value)) continue
    visited.add(value)
    if (Array.isArray(value)) {
      queue.push(...value)
      continue
    }
    const record = value as Record<string, unknown>
    const code = record.code
    const message = typeof record.msg === 'string'
      ? record.msg
      : typeof record.message === 'string' ? record.message : undefined
    if ((typeof code === 'number' || typeof code === 'string') && message !== undefined) {
      const detail = `（${code}）：${message}`
      if (typeof code === 'number' || /^\d+$/u.test(code)) return detail
      fallback ??= detail
    }
    for (const key of ['response', 'data', 'error', 'cause', 'errors']) {
      const child = record[key]
      if (child !== undefined) queue.push(child)
    }
  }
  if (fallback !== undefined) return fallback
  return error instanceof Error && error.message !== '' ? `：${error.message}` : '：未知错误'
}
