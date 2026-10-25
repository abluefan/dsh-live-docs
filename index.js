/**
 * dsh-live-docs —— 让若干「绝对路径的活文档」改动后自动以【尾部追加】的方式到达模型。
 *
 * 跟原生 AGENTS.md（@deepseek-ai/dsh-agent-instructions）同等待遇，但**不绑工作区**：
 * 原生锚「cwd 祖先链」，换个工作区就失效（files.ts:306）；
 * 本插件锚**绝对路径清单**，到哪个工作区都跟着。
 *
 * 机制全部照抄原生（见 README 的「机制」一节），只改锚点：
 *   · 四态：没变 / 变了 / 删了 / 读不到（★ 读不到保留上一版，不当成删了）
 *   · 状态写进消息 source 的 changes，重启后扫 surface 恢复
 *   · 自己拼 <system-reminder> 框架，并转义内容里的 </system-reminder>
 *   · 五种措辞（baseline / additional / updated / removed / notice）
 *   · 一次多个变化合并进一个块
 *   · 按字节算预算 + UTF-8 安全截断 + marker 报告
 *
 * 挂点：agent/pre-step（decision.messages 会被 append 成 user/message ⇒ 持久、
 *       留痕、尾部追加 ⇒ 不砍前缀缓存）。
 *
 * ── 0.2.1 迁移说明（2026-10-18）──────────────────────────────────────────
 * 1. `ctx.settings.register()` 在 0.2.1 已移除。配置改为写在当前 profile 的
 *    `cordis.patch.yml` 里本 entry 的 config；Loader 把它作为 `apply` 的第二参数。
 * 2. 三个顶层字段标了 `.volatile()`：只改它们时 Loader 不 remount，直接提交到
 *    运行中的 `fiber.config`，并 emit `loader/volatile-update`。
 *    所以每次 pre-step 都用 `current()` 读最新值 —— 改配置立刻生效、不拆会话。
 * 3. 消息 source 的 kind 改用本插件名（`live-docs`），并带
 *    `form: 'snapshot'` + `sections`；`changes` 仍挂在 source 内，
 *    因为持久化只保留 role/id/content/source 四个字段，source 内部不再细分。
 * 4. `session.surface.nodes` / `eventAt` 仍是可用的历史读取接口
 *    （官方 time-context 也在用），恢复逻辑保持不变。
 *
 * @module dsh-live-docs
 */
import { createHash } from 'node:crypto'
import { readFile, glob, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-live-docs'

/** 消息来源标记，同时也用来从 surface 认回自己的消息。 */
const SOURCE_KIND = 'live-docs'

const OPEN = '<system-reminder>'
const CLOSE = '</system-reminder>'

/** 一份文件的声明。`path` 含 `*` 时按 glob 展开（见 expandFiles）。 */
const FileEntry = z.object({
  path: z.string().required(),
  label: z.string(),
  mode: z.union(['inline', 'notice']).default('inline'),
})

/**
 * 配置 schema（schemastery）。数组而非字典：顺序天然表达优先级。
 *
 * ── 0.3 扩展（2026-10-20）──────────────────────────────────────────────
 * · `path` 含 `*` → 按 glob 展开成多份文件（Node 22+ 内建 fs.glob，
 *   零依赖）。Windows 文件名不允许 `*`，所以不会误判。
 * · `sharedFiles` + preset 的 `include` → 一份清单一处定义、多张卡引用，
 *   消掉「ptc 与 create 两份一模一样的清单各抄一遍」的漂移风险。
 * · 展开/去重都在 pre-step 里做，四态与预算逻辑一行都没动。
 *
 * 三个顶层字段仍是 `.volatile()`：改配置立刻生效、不拆会话。
 * 只有改**本文件代码**才需要重启 dsh。
 */
export const Config = z.object({
  /** 每个 preset 一份文件清单；没列出的 preset 什么都不挂。 */
  presets: z.array(z.object({
    name: z.string().required(),
    /** 引用 `sharedFiles` 里的清单名；先展开引用的，再接自己的 files。 */
    include: z.array(z.string()).default([]),
    files: z.array(FileEntry).default([]),
  })).default([]).volatile(),
  /** 具名共享清单，供各 preset 用 `include` 引用。 */
  sharedFiles: z.array(z.object({
    name: z.string().required(),
    files: z.array(FileEntry).default([]),
  })).default([]).volatile(),
  /** 单个 inline 文件超过这个字节数 → 自动降级成 notice。 */
  maxInlineBytes: z.number().default(65536).volatile(),
  /** 一次追加总量的上限；超了按顺序丢前面的并写进 marker。 */
  maxBatchBytes: z.number().default(131072).volatile(),
  /** ★ 0.3.2：顯示用嘅基準目錄。設定咗就只顯示相對路徑（例如 infos\doc-editing.md）。 */
  displayBase: z.string().default('').volatile(),
})

// ============================================================================
// 工具函数
// ============================================================================

const byteLength = (s) => Buffer.byteLength(s, 'utf8')
const sha1 = (s) => createHash('sha1').update(s).digest('hex')

/** ★ 安全：把内容里的闭合标签转义掉，否则文件内容可以越狱出框架。 */
export function escapeFrame(body) {
  return body.replaceAll(CLOSE, '<\\/system-reminder>')
}

/** ★ 按字节截断，且绝不切穿多字节码点（照抄 render.ts:69-79）。 */
export function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** 路徑 + 可選嘅中文名（給**訊息內容**用——永遠係完整絕對路徑）。
 *  ★ 0.3.1：label 同檔名一樣時唔顯示括號。 */
export function displayOf(file) {
  const norm = file.path.replaceAll('/', '\\')
  const baseName = norm.split('\\').pop() ?? ''
  if (file.label === undefined || file.label === '' || file.label === baseName) return norm
  return `${norm} （${file.label}）`
}

/** ★ 0.3.2：**UI 標題**用嘅短名（相對 displayBase）。
 *  同 displayOf 分工：sections[].name 用呢個，訊息 text 用 displayOf。 */
export function shortNameOf(file, base = '') {
  const norm = file.path.replaceAll('/', '\\')
  const b = base.replace(/[\\/]+$/, '')
  const rel = b !== '' && norm.toLowerCase().startsWith(b.toLowerCase() + '\\')
    ? norm.slice(b.length + 1)
    : norm
  const baseName = norm.split('\\').pop() ?? ''
  if (file.label === undefined || file.label === '' || file.label === baseName) return rel
  return `${rel} （${file.label}）`
}

// ============================================================================
// 五种措辞（前四种照抄原生 render.ts，notice 是本插件加的）
// ============================================================================

function baselineText(file, content, base = '') {
  return `指示嚟自：${displayOf(file)}\n\n${content}`
}

function additionalText(file, content, base = '') {
  return [
    `補充指示嚟自：${displayOf(file)}`,
    '',
    '本文件由 live-docs 附加注入；更具體的指示優先，兩者衝突時以更具體者為準。',
    '',
    content,
  ].join('\n')
}

function updatedText(file, content, base = '') {
  return [
    `指示已更新：${displayOf(file)}`,
    '',
    '呢個檔案喺載入之後改過。用以下內容代替之前從呢個檔案載入嘅指示。',
    '',
    content,
  ].join('\n')
}

function noticeText(file, base = '') {
  return [
    `指示已更新：${displayOf(file)}`,
    '',
    '呢個檔案喺載入之後改過；之前嘅內容已經唔適用，有需要時再讀一次。',
  ].join('\n')
}

function additionalNoticeText(file, base = '') {
  return [
    `補充指示嚟自：${displayOf(file)}`,
    '',
    '呢份活文件而家開始被追蹤；有需要時讀佢。',
  ].join('\n')
}

function removedText(file, base = '') {
  return [
    `指示已移除：${displayOf(file)}`,
    '',
    '之前從呢個檔案載入嘅指示已經唔再適用。',
  ].join('\n')
}

/** 预算报告（照抄原生 markerText 的精神：不静默丢弃）。 */
function markerText(maxBytes, dropped) {
  if (dropped.length === 0) return ''
  return `活文件預算 ${maxBytes} 字節：已省略 ${dropped.join('、')}`
}

// ============================================================================
// 状态：WeakMap<Session, Map<path, {digest}>>，从 surface 恢复
// ============================================================================

const STATE = new WeakMap()

/** 扫会话的 surface，把自己以前发过的 changes 拼回状态（照抄 state.ts:136-144）。 */
export function recoverState(session) {
  const map = new Map()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message') continue
    const src = event.data?.source
    if (src?.kind !== SOURCE_KIND) continue
    for (const ch of src.changes ?? []) {
      if (ch.action === 'remove') map.delete(ch.path)
      else map.set(ch.path, { digest: ch.digest })
    }
  }
  return map
}

function stateFor(session) {
  let map = STATE.get(session)
  if (map === undefined) {
    map = recoverState(session)
    STATE.set(session, map)
  }
  return map
}

// ============================================================================
// 四态检测
// ============================================================================

/**
 * @returns {Promise<Array>} 待追加的条目
 */
export async function reconcile(files, state) {
  const items = []
  for (const file of files) {
    const prev = state.get(file.path)
    let content
    try {
      content = await readFile(file.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // 文件真的不在了
        if (prev === undefined) { state.delete(file.path); continue }   // 从没发过 → 静默
        items.push({ action: 'remove', file })
        state.delete(file.path)
        continue
      }
      // ★ 读不到（EACCES / EIO…）→ 什么都不发，保留上一版
      //   "看不到 ≠ 删掉了"（照抄 state.ts:354-356 的设计）
      continue
    }
    const digest = sha1(content.trim())        // ★ trimmed digest：只改首尾空白不算变化
    if (prev?.digest === digest) continue      // 没变
    items.push({
      action: prev === undefined ? 'set' : 'replace',
      file,
      content,
      digest,
    })
  }
  return items
}

// ============================================================================
// 渲染
// ============================================================================

export function renderItems(items, config) {
  const sections = []
  // 每份文件单独一份 section，供 UI 逐行展示（模型看到的仍是拼接后的 text）
  const parts = []
  const changes = []
  const dropped = []
  let used = 0

  for (const item of items) {
    const { action, file } = item
    if (action === 'remove') {
      const removed = removedText(file, config.displayBase)
      sections.push(removed)
      parts.push({ name: shortNameOf(file, config.displayBase), text: removed })
      changes.push({ action, path: file.path })
      continue
    }

    const raw = item.content
    const wantsInline = (file.mode ?? 'inline') === 'inline' && byteLength(raw) <= config.maxInlineBytes
    let section
    if (wantsInline) {
      section = action === 'set' ? additionalText(file, raw, config.displayBase) : updatedText(file, raw, config.displayBase)
    } else {
      section = action === 'set' ? additionalNoticeText(file, config.displayBase) : noticeText(file, config.displayBase)
    }

    // 批次预算：超了就丢（连 notice 都不发），并记进 marker
    if (used + byteLength(section) > config.maxBatchBytes) {
      dropped.push(displayOf(file, config.displayBase))
      continue
    }
    used += byteLength(section)
    sections.push(section)
    parts.push({ name: shortNameOf(file, config.displayBase), text: section })
    changes.push({ action, path: file.path, digest: item.digest })
  }

  if (sections.length === 0 && dropped.length === 0) return null

  const marker = markerText(config.maxBatchBytes, dropped)
  const body = [marker, ...sections].filter(part => part.length > 0).join('\n\n')
  let text = [OPEN, escapeFrame(body), CLOSE].join('\n')
  if (byteLength(text) > config.maxBatchBytes) text = truncateUtf8(text, config.maxBatchBytes)
  return { text, changes, parts }
}

// ============================================================================
// 清单解析：include 合并 → glob 展开 → 去重
// ============================================================================

/**
 * 路径含 `*` 就当 glob。
 * Windows 文件名不允许 `*`，所以正常路径永远不会被误判成 pattern。
 * （`[` 在 Windows 是合法文件名字符，所以只认 `*`。）
 */
export function isGlob(path) {
  return path.includes('*')
}

/**
 * ★ 只收「常見文字文件」後綴（0.3.1）。
 * 目的：就算有人把 .exe / .png / .zip 掉進目錄，也不會被當成活文件讀進來。
 * 白名單制 —— 沒列出的後綴一律跳過（默認拒絕）。
 */
export const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst',
  '.yaml', '.yml', '.json', '.jsonl', '.toml', '.ini', '.conf', '.cfg',
  '.csv', '.tsv', '.log',
])

export function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/**
 * 合并 preset 的 include（共享清单）与自己的 files。
 * 只做顺序合并，不展开 glob、不去重 —— 两者留给后面的步骤。
 */
export function collectFiles(entry, config) {
  const warnings = []
  const shared = Array.isArray(config.sharedFiles) ? config.sharedFiles : []
  const merged = []

  for (const name of entry.include ?? []) {
    const list = shared.find(candidate => candidate.name === name)
    if (list === undefined) {
      warnings.push(`include 指向不存在的共享清单：${name}`)
      continue
    }
    merged.push(...(list.files ?? []))
  }
  merged.push(...(entry.files ?? []))
  return { files: merged, warnings }
}

/**
 * 把 glob 条目展开成实际文件。
 *   · 展开后每份的 label 变成 `原label/文件名`（没 label 就只用文件名）
 *   · 按路径排序，保证每次 pre-step 的顺序稳定
 *   · 展开 0 份 → 大声 warn（不静默），但不算错误
 */
export async function expandFiles(files) {
  const warnings = []
  const out = []

  for (const file of files) {
    if (!isGlob(file.path)) {
      out.push(file)
      continue
    }

    const matches = []
    try {
      for await (const match of glob(file.path)) matches.push(match)
    } catch (error) {
      warnings.push(`glob 展开失败：${file.path}（${error?.message ?? error}）`)
      continue
    }

    if (matches.length === 0) {
      warnings.push(`glob 没有匹配：${file.path}`)
      continue
    }

    // ★ glob 會連目錄一齊回；只收「真正檔案 + 文字後綴」（0.3.1）
    //   咁就可以安全咁寫 `path: '...\\wardrobe\\*'`——
    //   唔使綁死 .md，又唔會誤讀 .exe / .png / .zip。
    const filesOnly = []
    const skipped = []
    for (const match of matches) {
      if (!isTextFile(match)) {
        skipped.push(basename(match))
        continue
      }
      try {
        if ((await stat(match)).isFile()) filesOnly.push(match)
      } catch {
        // 讀唔到就跳過（例如權限問題）
      }
    }
    if (skipped.length > 0) {
      const head = skipped.slice(0, 5).join(', ')
      warnings.push(`已跳過非文字檔：${head}${skipped.length > 5 ? ` 等 ${skipped.length} 個` : ''}`)
    }
    if (filesOnly.length === 0) {
      warnings.push(`glob 冇匹配到可用文字檔：${file.path}`)
      continue
    }

    filesOnly.sort((a, b) => a.localeCompare(b, 'zh'))
    for (const match of filesOnly) {
      out.push({
        path: match,
        // ★ 0.3.1：展開後 label 直接用檔名（唔再砌 `原label/檔名`——
        //   嗰個會令 displayOf 顯示成「長路徑 （本身檔名）」，好長好多餘）
        label: basename(match),
        mode: file.mode,
      })
    }
  }

  return { files: out, warnings }
}

/**
 * 同一 path 只留第一个（include 的先、自己 files 的後）。
 * 去重必须在 glob 展开之后 —— 否则 `a.txt` 与 `*.txt` 这种写法会漏。
 */
export function dedupeFiles(files) {
  const warnings = []
  const seen = new Set()
  const unique = []
  for (const file of files) {
    if (seen.has(file.path)) {
      warnings.push(`重复路径已跳过：${file.path}`)
      continue
    }
    seen.add(file.path)
    unique.push(file)
  }
  return { files: unique, warnings }
}

/** 一次跑完三个步骤：合并 → 展开 → 去重。 */
export async function prepareFiles(entry, config) {
  const collected = collectFiles(entry, config)
  const expanded = await expandFiles(collected.files)
  const deduped = dedupeFiles(expanded.files)
  return {
    files: deduped.files,
    warnings: [...collected.warnings, ...expanded.warnings, ...deduped.warnings],
  }
}

// ============================================================================
// apply
// ============================================================================

export function apply(ctx, config) {
  console.log('[dsh-live-docs] apply() called, config keys:', Object.keys(config ?? {}))

  /**
   * 配置由 profile patch 的本 entry config 提供。
   * volatile 字段被修改时 Loader 直接提交到 `fiber.config`（不 remount），
   * 所以这里每次都读最新值，而不是闭包捕获初始 config。
   *
   * ★ schemastery 把 volatile 字段包成 `Volatile<T>`（`{ get(): T }`），
   *   不是裸值；这里统一解包，否则 `presets.find` 会作用在包装对象上。
   */
  const unwrap = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value)
  const current = () => {
    const raw = ctx.fiber?.config ?? config ?? {}
    return {
      presets: unwrap(raw.presets) ?? [],
      // ★ 0.3：新增的 volatile 字段同样要解包，否则 prepareFiles 收不到共享清单
      sharedFiles: unwrap(raw.sharedFiles) ?? [],
      maxInlineBytes: unwrap(raw.maxInlineBytes) ?? 65536,
      maxBatchBytes: unwrap(raw.maxBatchBytes) ?? 131072,
      displayBase: unwrap(raw.displayBase) ?? '',
    }
  }

  // 只在 pre-step 的第一次尝试追加（agent.ts:373-377 的 firstAttempt 保证不重复）
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()

    const settings = current()
    // 0.2.1：header.agentPreset 是 Session 创建时的值；UI 切换卡只 append
    // `agent-preset/selected`，不会改 header。当前卡要从 session projection 读，
    // 否则切到别的卡后这里仍然看到创建时的 preset。
    const projections = ctx.get('sessionProjections')
    const preset = (projections?.stateOf?.(agent.session, 'agentPreset')) ?? agent.session.header.agentPreset
    if (preset === undefined) return decision

    const list = Array.isArray(settings.presets) ? settings.presets : []
    console.log('[dsh-live-docs] pre-step preset=' + String(preset) + ' presets=' + list.map(p => p.name).join(',') + ' files=' + list.reduce((n, p) => n + (p.files ?? []).length, 0))
    const entry = list.find(p => p.name === preset)
    if (entry === undefined) return decision   // 这张卡不管

    // 合并 include → 展开 glob → 去重（0.3 新增；老配置行为不变）
    const prepared = await prepareFiles(entry, settings)
    for (const warning of prepared.warnings) {
      console.warn('[dsh-live-docs] ' + warning)
    }
    if (prepared.files.length === 0) return decision

    const state = stateFor(agent.session)
    const items = await reconcile(prepared.files, state)
    console.log('[dsh-live-docs] reconcile files=' + prepared.files.length + ' items=' + items.length + ' state=' + state.size)
    if (items.length === 0) return decision

    const rendered = renderItems(items, settings)
    if (rendered === null) return decision

    // ★ 状态只在"真的渲染进消息"之后才更新（照抄 represented 语义）
    for (const change of rendered.changes) {
      if (change.action === 'remove') state.delete(change.path)
      else state.set(change.path, { digest: change.digest })
    }

    const message = createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: {
        kind: SOURCE_KIND,
        form: 'snapshot',
        sections: rendered.parts.length > 0 ? rendered.parts : [{ name: SOURCE_KIND, text: rendered.text }],
        changes: rendered.changes,
      },
    })
    return { ...decision, messages: [...decision.messages, message] }
  })
}
