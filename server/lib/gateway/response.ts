import { classifyFailure, type UpstreamFailure } from './errors'

export const MAX_RESPONSE_LOG_BYTES = 8 * 1024 * 1024
const MAX_SSE_FRAME = 2 * 1024 * 1024
type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
}
function nonempty(value: unknown) { return typeof value === 'string' && value.trim().length > 0 }

export class ResponseInspection {
  usage: ObjectValue | null = null
  failure: UpstreamFailure | null = null
  hasOutput = false
  completed = false
  incomplete = false
  inspectionTruncated = false
  private frame = ''
  private droppingFrame = false
  private decoder = new TextDecoder()

  private captureUsage(value: unknown) {
    const current = object(value)
    if (current) this.usage = { ...(this.usage || {}), ...current }
  }
  private inspectContent(value: unknown) {
    if (nonempty(value)) this.hasOutput = true
    if (!Array.isArray(value)) return
    for (const item of value) {
      const part = object(item)
      if (!part) continue
      if (nonempty(part.text) || nonempty(part.thinking) || nonempty(part.refusal)) this.hasOutput = true
      if (part.type === 'tool_use' || part.type === 'function_call' || part.type === 'custom_tool_call') this.hasOutput = true
      this.inspectContent(part.content)
      this.inspectContent(part.summary)
    }
  }
  observe(value: unknown, httpStatus = 200) {
    const data = object(value)
    if (!data) return
    if (data.error || data.type === 'error') this.failure = classifyFailure(httpStatus >= 400 ? httpStatus : 502, data)
    this.captureUsage(data.usage)
    const response = object(data.response)
    if (response) this.observe(response, httpStatus)
    if (data.status === 'failed' || data.type === 'response.failed') {
      this.failure = classifyFailure(502, response || data)
    }
    if (data.status === 'incomplete' || data.type === 'response.incomplete') this.incomplete = true
    if (data.status === 'completed' || data.type === 'response.completed') this.completed = true
    this.inspectContent(data.output)
    this.inspectContent(data.content)
    if (nonempty(data.output_text)) this.hasOutput = true

    const message = object(data.message)
    if (message) { this.captureUsage(message.usage); this.inspectContent(message.content) }
    if (data.type === 'message_stop') this.completed = true
    if (data.type === 'content_block_start') this.inspectContent([data.content_block])
    const delta = object(data.delta)
    if (delta) {
      if (nonempty(delta.text) || nonempty(delta.thinking) || nonempty(delta.partial_json)) this.hasOutput = true
      if (delta.stop_reason) {
        this.completed = true
        if (delta.stop_reason === 'max_tokens') this.incomplete = true
      }
    }
    if (['response.output_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta',
      'response.function_call_arguments.delta', 'response.custom_tool_call_input.delta'].includes(String(data.type)) && nonempty(data.delta))
      this.hasOutput = true
    if (data.type === 'response.output_item.done' || data.type === 'response.output_item.added') this.inspectContent([data.item])
    if (Array.isArray(data.choices)) {
      for (const choiceValue of data.choices) {
        const choice = object(choiceValue)
        if (!choice) continue
        const msg = object(choice.message) || object(choice.delta)
        if (msg) {
          this.inspectContent(msg.content)
          if (nonempty(msg.reasoning_content) || nonempty(msg.reasoning) || nonempty(msg.refusal)) this.hasOutput = true
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) this.hasOutput = true
        }
        if (choice.finish_reason) {
          this.completed = true
          if (choice.finish_reason === 'length') this.incomplete = true
        }
      }
    }
    if (data.stop_reason) {
      this.completed = true
      if (data.stop_reason === 'max_tokens') this.incomplete = true
    }
  }
  private consumeFrame(frame: string) {
    const payload = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n')
    if (payload === '[DONE]') { this.completed = true; return }
    if (!payload) return
    try { this.observe(JSON.parse(payload)) } catch { /* Pass through unknown protocol extensions unchanged. */ }
  }
  push(chunk: Uint8Array) {
    this.frame += this.decoder.decode(chunk, { stream: true })
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.frame))) {
      const frame = this.frame.slice(0, boundary.index)
      this.frame = this.frame.slice(boundary.index + boundary[0].length)
      if (!this.droppingFrame) this.consumeFrame(frame)
      this.droppingFrame = false
    }
    if (this.frame.length > MAX_SSE_FRAME) {
      this.frame = this.frame.slice(-4)
      this.droppingFrame = true
      this.inspectionTruncated = true
    }
  }
  end() {
    this.frame += this.decoder.decode()
    if (this.frame.trim() && !this.droppingFrame) this.consumeFrame(this.frame)
    this.frame = ''
  }
}

export class ResponseCapture {
  private parts: Buffer[] = []
  private bytes = 0
  truncated = false
  constructor(private limit = MAX_RESPONSE_LOG_BYTES) {}
  push(chunk: Uint8Array) {
    const remaining = this.limit - this.bytes
    if (chunk.byteLength > remaining) this.truncated = true
    if (remaining > 0) {
      const part = Buffer.from(chunk.subarray(0, remaining))
      this.parts.push(part)
      this.bytes += part.byteLength
    }
  }
  text() { return Buffer.concat(this.parts).toString('utf8') }
  value(streaming: boolean): unknown {
    const raw = this.text()
    if (!streaming && !this.truncated) {
      try { return JSON.parse(raw) } catch { /* Non-JSON upstream errors remain readable. */ }
    }
    return { format: streaming ? 'sse' : 'text', raw, truncated: this.truncated }
  }
}