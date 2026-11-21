export interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket: { remoteAddress?: string }
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this
  on(event: 'end', listener: () => void): this
  on(event: 'error', listener: (error: unknown) => void): this
}

export interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): unknown
  end(body?: string | Buffer): void
}

export interface HttpContextLike {
  get(name: string, optional?: boolean): any
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export function sendJson(response: HttpResponseLike, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value)}\n`)
}

export function sendError(response: HttpResponseLike, error: HttpError): void {
  sendJson(response, error.status, { error: { code: error.code, message: error.message } })
}

export function guard(ctx: HttpContextLike, request: HttpRequestLike): void {
  const remote = request.socket.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) throw new HttpError(403, 'FORBIDDEN', '只接受本机回环请求')
  const host = request.headers.host
  const hostValue = Array.isArray(host) ? host[0] : host
  if (hostValue === undefined || !/^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(hostValue)) throw new HttpError(403, 'FORBIDDEN', 'Host 必须是本机回环地址')
  const origin = request.headers.origin
  const originValue = Array.isArray(origin) ? origin[0] : origin
  if (originValue !== undefined && originValue !== `http://${hostValue}` && originValue !== `https://${hostValue}`) throw new HttpError(403, 'FORBIDDEN', 'Origin 必须同源')
  const connection = ctx.get('connection', false)
  const rejection = connection ? connection.requestRejection(request) : 401
  if (rejection !== undefined) throw new HttpError(typeof rejection === 'number' ? rejection : 401, 'UNAUTHENTICATED', '需要桌面端登录态')
}

export async function readJsonBody(request: HttpRequestLike, limit: number): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>((resolve, reject) => {
    request.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > limit) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求体超过大小上限'))
        return
      }
      chunks.push(bytes)
    })
    request.on('end', resolve)
    request.on('error', reject)
  })
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求体必须是 JSON 对象')
  }
}
