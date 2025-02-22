import { coerce, escapeRegExp, makeArray } from '@koishijs/utils'
import { Awaitable, defineProperty, Dict } from 'cosmokit'
import { Context, Fragment, segment, Session } from '@satorijs/core'
import { Computed } from './session'
import { Channel, User } from './database'

declare module '@satorijs/core' {
  interface Context {
    $internal: Internal
    middleware(middleware: Middleware, prepend?: boolean): () => boolean
  }

  interface Events {
    'before-attach-channel'(session: Session, fields: Set<Channel.Field>): void
    'attach-channel'(session: Session): Awaitable<void | boolean>
    'before-attach-user'(session: Session, fields: Set<User.Field>): void
    'attach-user'(session: Session): Awaitable<void | boolean>
    'before-attach'(session: Session): void
    'attach'(session: Session): void
    'middleware'(session: Session): void
  }
}

export class SessionError extends Error {
  constructor(public path: string | string[], public param?: Dict) {
    super(makeArray(path)[0])
  }
}

function createLeadingRE(patterns: string[], prefix = '', suffix = '') {
  return patterns.length ? new RegExp(`^${prefix}(${patterns.map(escapeRegExp).join('|')})${suffix}`) : /$^/
}

export type Next = (next?: Next.Callback) => Promise<void | Fragment>
export type Middleware = (session: Session, next: Next) => Awaitable<void | Fragment>

export namespace Next {
  export const MAX_DEPTH = 64

  export type Queue = ((next?: Next) => Awaitable<void | Fragment>)[]
  export type Callback = void | string | ((next?: Next) => Awaitable<void | Fragment>)

  export async function compose(callback: Callback, next?: Next) {
    return typeof callback === 'function' ? callback(next) : callback
  }
}

export namespace Internal {
  export interface Config {
    nickname?: string | string[]
    prefix?: Computed<string | string[]>
  }
}

export class Internal {
  static readonly methods = ['middleware']

  _hooks: [Context, Middleware][] = []
  _nameRE: RegExp
  _sessions: Dict<Session> = Object.create(null)
  _userCache = new SharedCache<User.Observed<any>>()
  _channelCache = new SharedCache<Channel.Observed<any>>()

  constructor(private ctx: Context, private config: Internal.Config) {
    defineProperty(this, Context.current, ctx)
    this.prepare()

    // bind built-in event listeners
    this.middleware(this._process.bind(this))
    ctx.on('message', this._handleMessage.bind(this))

    ctx.before('attach-user', (session, fields) => {
      session.collect('user', session.argv, fields)
    })

    ctx.before('attach-channel', (session, fields) => {
      session.collect('channel', session.argv, fields)
    })

    this.middleware((session, next) => {
      // execute command
      if (!session.resolve(session.argv)) return next()
      return session.execute(session.argv, next)
    })
  }

  protected get caller() {
    return this[Context.current]
  }

  middleware(middleware: Middleware, prepend = false) {
    return this.caller.lifecycle.register('middleware', this._hooks, middleware, prepend)
  }

  prepare() {
    this._nameRE = createLeadingRE(makeArray(this.config.nickname), '@?', '([,，]\\s*|\\s+)')
  }

  private _resolvePrefixes(session: Session) {
    const value = session.resolveValue(this.config.prefix)
    const result = Array.isArray(value) ? value : [value || '']
    return result.map(source => segment.escape(source))
  }

  private _stripNickname(content: string) {
    if (content.startsWith('@')) content = content.slice(1)
    for (const nickname of makeArray(this.config.nickname)) {
      if (!content.startsWith(nickname)) continue
      const rest = content.slice(nickname.length)
      const capture = /^([,，]\s*|\s+)/.exec(rest)
      if (!capture) continue
      return rest.slice(capture[0].length)
    }
  }

  private async _process(session: Session, next: Next) {
    let atSelf = false, appel = false, prefix: string = null
    let content = session.content.trim()
    session.elements ??= segment.parse(content)

    // strip mentions
    let hasMention = false
    const elements = session.elements.slice()
    while (elements[0]?.type === 'at') {
      const { attrs } = elements.shift()
      if (attrs.id === session.selfId) {
        atSelf = appel = true
      }
      hasMention = true
      content = elements.join('').trimStart()
      // @ts-ignore
      if (elements[0]?.type === 'text' && !elements[0].attrs.content.trim()) {
        elements.shift()
      }
    }

    if (!hasMention || atSelf) {
      // strip nickname
      const result = this._stripNickname(content)
      if (result) {
        appel = true
        content = result
      }

      // strip prefix
      for (const _prefix of this._resolvePrefixes(session)) {
        if (!content.startsWith(_prefix)) continue
        prefix = _prefix
        content = content.slice(_prefix.length)
      }
    }

    // store parsed message
    defineProperty(session, 'parsed', { content, appel, prefix })
    this.ctx.emit(session, 'before-attach', session)

    if (this.ctx.database) {
      if (session.subtype === 'group') {
        // attach group data
        const channelFields = new Set<Channel.Field>(['flag', 'assignee', 'guildId', 'locale'])
        this.ctx.emit('before-attach-channel', session, channelFields)
        const channel = await session.observeChannel(channelFields)
        // for backwards compatibility (TODO remove in v5)
        channel.guildId = session.guildId

        // emit attach event
        if (await this.ctx.serial(session, 'attach-channel', session)) return

        // ignore some group calls
        if (channel.flag & Channel.Flag.ignore) return
        if (channel.assignee !== session.selfId && !atSelf) return
      }

      // attach user data
      // authority is for suggestion
      const userFields = new Set<User.Field>(['flag', 'authority', 'locale'])
      this.ctx.emit('before-attach-user', session, userFields)
      const user = await session.observeUser(userFields)

      // emit attach event
      if (await this.ctx.serial(session, 'attach-user', session)) return

      // ignore some user calls
      if (user.flag & User.Flag.ignore) return
    }

    this.ctx.emit(session, 'attach', session)
    return next()
  }

  private async _handleMessage(session: Session) {
    // ignore self messages
    if (session.selfId === session.userId) return

    // preparation
    this._sessions[session.id] = session
    const queue: Next.Queue = this._hooks
      .filter(([context]) => context.filter(session))
      .map(([, middleware]) => middleware.bind(null, session))

    // execute middlewares
    let index = 0
    const next: Next = async (callback) => {
      try {
        if (!this._sessions[session.id]) {
          throw new Error('isolated next function detected')
        }
        if (callback !== undefined) {
          queue.push(next => Next.compose(callback, next))
          if (queue.length > Next.MAX_DEPTH) {
            throw new Error(`middleware stack exceeded ${Next.MAX_DEPTH}`)
          }
        }
        return await queue[index++]?.(next)
      } catch (error) {
        if (error instanceof SessionError) {
          return session.text(error.path, error.param)
        }
        const stack = coerce(error)
        this.ctx.logger('session').warn(`${session.content}\n${stack}`)
      }
    }

    try {
      const result = await next()
      if (result) await session.send(result)
    } finally {
      // update session map
      delete this._sessions[session.id]
      this.ctx.emit(session, 'middleware', session)

      // flush user & group data
      this._userCache.delete(session.id)
      this._channelCache.delete(session.id)
      await session.user?.$update()
      await session.channel?.$update()
      await session.guild?.$update()
    }
  }
}

Context.service('$internal', Internal)

export namespace SharedCache {
  export interface Entry<T> {
    value: T
    key: string
    refs: Set<string>
  }
}

export class SharedCache<T> {
  #keyMap: Dict<SharedCache.Entry<T>> = Object.create(null)

  get(ref: string, key: string) {
    const entry = this.#keyMap[key]
    if (!entry) return
    entry.refs.add(ref)
    return entry.value
  }

  set(ref: string, key: string, value: T) {
    let entry = this.#keyMap[key]
    if (entry) {
      entry.value = value
    } else {
      entry = this.#keyMap[key] = { value, key, refs: new Set() }
    }
    entry.refs.add(ref)
  }

  delete(ref: string) {
    for (const key in this.#keyMap) {
      const { refs } = this.#keyMap[key]
      refs.delete(ref)
      if (!refs.size) {
        delete this.#keyMap[key]
      }
    }
  }
}
