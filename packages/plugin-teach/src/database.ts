import { Context, Meta, ParsedLine } from 'koishi-core'
import { arrayTypes } from 'koishi-database-mysql'
import { Observed, pick, difference, observe, isInteger } from 'koishi-utils'

arrayTypes.push('dialogue.groups', 'dialogue.predecessors')

declare module 'koishi-core/dist/context' {
  interface EventMap {
    'dialogue/before-modify' (argv: Dialogue.Argv): void | boolean | Promise<void | boolean>
    'dialogue/modify' (argv: Dialogue.Argv, dialogue: Dialogue): void
    'dialogue/after-modify' (argv: Dialogue.Argv): void | Promise<void>
    'dialogue/before-fetch' (test: DialogueTest, conditionals?: string[]): void
    'dialogue/fetch' (dialogue: Dialogue, test: DialogueTest): boolean | void
    'dialogue/permit' (argv: Dialogue.Argv, dialogue: Dialogue): boolean
  }
}

declare module 'koishi-core/dist/database' {
  interface TableMethods {
    dialogue: {}
  }

  interface TableData {
    dialogue: Dialogue
  }
}

type DialogueField = keyof Dialogue

export interface Dialogue {
  id?: number
  question: string
  answer: string
  original: string
  flag: number
  _weight?: number
  _capture?: RegExpExecArray
  _state?: 'created' | 'edited' | 'removed'
  _operator?: number
  _timestamp?: number
}

export interface DialogueTest {
  original?: string
  question?: string
  answer?: string
  regexp?: boolean
  activated?: boolean
  appellative?: boolean
  noRecursive?: boolean
}

export enum DialogueFlag {
  /** 冻结：只有 4 级以上权限者可修改 */
  frozen = 1,
  /** 正则：使用正则表达式进行匹配 */
  regexp = 2,
  /** 任意人：后继问答可以被上下文内任何人触发 */
  indefinite = 4,
  /** 代行者：由教学者完成回答的执行 */
  substitute = 8,
  /** 补集：上下文匹配时取补集 */
  complement = 16,
}

export namespace Dialogue {
  export const history: Record<number, Dialogue> = []

  export interface UpdateContext {
    skipped?: number[]
    updated?: number[]
  }

  export interface Config {}
  
  export interface Argv extends UpdateContext {
    ctx: Context
    meta: Meta<'authority' | 'id'>
    args: string[]
    config: Config
    target?: number[]
    options: Record<string, any>
    appellative?: boolean
  
    // modify status
    dialogues?: Dialogue[]
    dialogueMap?: Record<number, Dialogue>
    unknown?: number[]
    uneditable?: number[]
  }

  export async function fromIds <T extends DialogueField> (ids: number[], ctx: Context, fields?: T[]) {
    if (!ids.length) return []
    return ctx.database.mysql.select<Dialogue[]>('dialogue', fields, `\`id\` IN (${ids.join(',')})`)
  }

  export async function fromTest (ctx: Context, test: DialogueTest) {
    let query = 'SELECT * FROM `dialogue`'
    const conditionals: string[] = []
    ctx.emit('dialogue/before-fetch', test, conditionals)
    if (conditionals.length) query += ' WHERE ' + conditionals.join(' && ')
    const dialogues = await ctx.database.mysql.query<Dialogue[]>(query)
    return dialogues.filter((dialogue) => !ctx.bail('dialogue/fetch', dialogue, test))
  }

  export async function create (dialogue: Dialogue, argv: Dialogue.Argv) {
    const timestamp = Date.now()
    dialogue = await argv.ctx.database.mysql.create('dialogue', dialogue)
    history[dialogue.id] = dialogue
    dialogue._timestamp = timestamp
    dialogue._operator = argv.meta.userId
    dialogue._state = 'created'
    return dialogue
  }

  export async function update (dialogues: Observed<Dialogue>[], argv: Dialogue.Argv) {
    const data: Partial<Dialogue>[] = []
    const fields = new Set<DialogueField>(['id'])
    for (const { _diff } of dialogues) {
      for (const key in _diff) {
        fields.add(key as DialogueField)
      }
    }
    for (const dialogue of dialogues) {
      if (!Object.keys(dialogue._diff).length) {
        argv.skipped.push(dialogue.id)
      } else {
        dialogue._diff = {}
        argv.updated.push(dialogue.id)
        data.push(pick(dialogue, fields))
      }
    }
    await argv.ctx.database.mysql.update('dialogue', data)
  }

  export async function remove (ids: number[], argv: Dialogue.Argv) {
    const timestamp = Date.now()
    await argv.ctx.database.mysql.query(`DELETE FROM \`dialogue\` WHERE \`id\` IN (${ids.join(',')})`)
    for (const id of ids) {
      const dialogue = history[id] = argv.dialogueMap[id]
      dialogue._timestamp = timestamp
      dialogue._operator = argv.meta.userId
      dialogue._state = 'removed'
    }
  }
}

export function sendResult (argv: Dialogue.Argv, prefix?: string, suffix?: string) {
  const output = []
  if (prefix) output.push(prefix)
  if (argv.unknown.length) {
    output.push(`没有搜索到编号为 ${argv.unknown.join(', ')} 的问答。`)
  }
  if (argv.uneditable.length) {
    output.push(`问答 ${argv.uneditable.join(', ')} 因权限过低无法修改。`)
  }
  if (argv.skipped.length) {
    output.push(`问答 ${argv.skipped.join(', ')} 没有发生改动。`)
  }
  if (argv.updated.length) {
    output.push(`问答 ${argv.updated.join(', ')} 已成功修改。`)
  }
  if (suffix) output.push(suffix)
  return argv.meta.$send(output.join('\n'))
}

export function split (source: string) {
  if (!source) return []
  return source.split(',').flatMap((value) => {
    if (!value.includes('..')) return +value
    const capture = value.split('..')
    const start = +capture[0], end = +capture[1]
    if (end < start) return []
    return new Array(end - start + 1).fill(0).map((_, index) => start + index)
  })
}

export function equal (array1: (string | number)[], array2: (string | number)[]) {
  return array1.sort().join() === array2.sort().join()
}

export function prepareTargets (argv: Dialogue.Argv, dialogues: Dialogue[]) {
  const targets = dialogues.filter((dialogue) => {
    return !argv.ctx.bail('dialogue/permit', argv, dialogue)
  })
  argv.uneditable.unshift(...difference(dialogues, targets).map(d => d.id))
  return targets.map(data => observe(data, `dialogue ${data.id}`))
}

export function parseTeachArgs ({ args, options }: Partial<ParsedLine>) {
  function parseArgument () {
    if (!args.length) return
    const [arg] = args.splice(0, 1)
    if (!arg || arg === '~' || arg === '～') return
    return arg
  }

  options.question = parseArgument()
  options.answer = options.redirectDialogue || parseArgument()
}

export function isPositiveInteger (value: any) {
  return isInteger(value) && value > 0 ? '' : '应为正整数。'
}

export function isZeroToOne (value: number) {
  return value < 0 || value > 1 ? '应为不超过 1 的正数。' : ''
}

export function isGroupIdList (value: any) {
  return !/^\d+(,\d+)*$/.test(value)
}

export function isDialogueIdList (value: any) {
  return !/^\d+(\.\.\d+)?(,\d+(\.\.\d+)?)*$/.test(value)
}
