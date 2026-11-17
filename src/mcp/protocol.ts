import { createInterface } from 'node:readline'

/**
 * Transport MCP « stdio » minimal : JSON-RPC 2.0, un message par ligne sur
 * l'entrée et la sortie standard. La sortie standard est réservée au
 * protocole ; tout journal va sur la sortie d'erreur.
 *
 * Seule la partie « outils » du protocole est servie : `initialize`, `ping`,
 * `tools/list`, `tools/call`, et les notifications de progression.
 */

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
/** Taille maximale d'un message reçu (1 Mio) : au-delà, il est refusé. */
const MAX_MESSAGE = 1024 * 1024

export interface ToolContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface CallContext {
  /** Notifie la progression d'un appel long (si le client a fourni un jeton de progression). */
  progress(progress: number, total: number | undefined, message: string): void
}

export interface McpHandlers {
  serverInfo: { name: string; version: string }
  instructions: string
  tools: ToolDefinition[]
  call(name: string, args: Record<string, unknown>, context: CallContext): Promise<ToolResult>
}

interface Request {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export class ToolError extends Error {}

export function serveMcp(
  handlers: McpHandlers,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const send = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`)
  }
  const reply = (id: Request['id'], result: unknown) => send({ jsonrpc: '2.0', id, result })
  const fail = (id: Request['id'], code: number, message: string) =>
    send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  const handle = async (request: Request): Promise<void> => {
    const { id, method } = request
    const isNotification = id === undefined
    if (request.jsonrpc !== '2.0' || typeof method !== 'string') {
      if (!isNotification) fail(id, -32600, 'Requête JSON-RPC invalide.')
      return
    }
    const params = request.params && typeof request.params === 'object' ? request.params : {}
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        reply(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: handlers.serverInfo,
          instructions: handlers.instructions,
        })
        return
      }
      case 'ping':
        if (!isNotification) reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools: handlers.tools })
        return
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const args =
          params.arguments &&
          typeof params.arguments === 'object' &&
          !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {}
        if (!handlers.tools.some((tool) => tool.name === name)) {
          fail(id, -32602, `Outil inconnu : ${name.slice(0, 80)}`)
          return
        }
        const meta = params._meta as Record<string, unknown> | undefined
        const token = meta?.progressToken
        const context: CallContext = {
          progress: (progress, total, message) => {
            if (typeof token !== 'string' && typeof token !== 'number') return
            send({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken: token, progress, total, message },
            })
          },
        }
        try {
          reply(id, await handlers.call(name, args, context))
        } catch (error) {
          // Erreur métier (argument refusé, audit déjà en cours…) : rendue à l'IA comme résultat.
          const message = error instanceof Error ? error.message : String(error)
          reply(id, { content: [{ type: 'text', text: message }], isError: true })
        }
        return
      }
      default:
        // Notifications (initialized, cancelled…) : rien à répondre.
        if (!isNotification)
          fail(id, -32601, `Méthode non prise en charge : ${method.slice(0, 80)}`)
    }
  }

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    const running = new Set<Promise<void>>()
    lines.on('line', (line) => {
      if (!line.trim()) return
      if (line.length > MAX_MESSAGE) {
        fail(null, -32600, 'Message trop volumineux.')
        return
      }
      let request: Request
      try {
        request = JSON.parse(line) as Request
      } catch {
        fail(null, -32700, 'JSON illisible.')
        return
      }
      if (Array.isArray(request)) {
        fail(null, -32600, 'Les lots JSON-RPC ne sont pas pris en charge.')
        return
      }
      const task = handle(request).catch((error: unknown) => {
        fail(request.id, -32603, error instanceof Error ? error.message : String(error))
      })
      running.add(task)
      void task.finally(() => running.delete(task))
    })
    lines.on('close', () => {
      void Promise.allSettled(Array.from(running)).then(() => resolve())
    })
  })
}
