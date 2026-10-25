# dsh-live-docs

让若干「绝对路径的文件」改动后自动以**尾部追加**的方式到达模型。

## 与原生 AGENTS.md 的区别

跟原生 `@deepseek-ai/dsh-agent-instructions` 同等待遇，但**不绑工作区**：

| | 原生 | 本插件 |
|---|---|---|
| 锚点 | cwd 祖先链 | **绝对路径清单** |
| 换工作区 | 失效 | 照样跟着 |
| 配置 | 自动发现 | 显式列清单 |

## 机制（照抄原生，只换锚点）

- **四态**：没变 / 变了 / 删了 / 读不到（★ 读不到保留上一版，不当成删了）
- 状态写进消息 `source.changes`，重启后扫 surface 恢复
- 自己拼 `<system-reminder>` 框架，并转义内容里的闭合标签
- 五种措辞：baseline / additional / updated / removed / notice
- 一次多个变化合并进一个块
- 按字节算预算 + UTF-8 安全截断 + marker 报告

挂点：`agent/pre-step`（`decision.messages` 会被 append 成 user/message ⇒ 持久、留痕、尾部追加 ⇒ **不砍前缀缓存**）。

## 配置

写在 `cordis.patch.yml` 本 entry 的 `config` 里（0.2.1 起不再走 `settings.yaml`）。

```yaml
- insert:
    - id: live-docs
      name: 'dsh-live-docs'
      config:
        presets:
          - name: my-preset
            files:
              - { path: 'D:\notes\*.md', label: notes, mode: inline }
              - { path: 'D:\docs\spec.md',                mode: notice }
        maxInlineBytes: 262144
        maxBatchBytes: 524288
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `presets[].name` | 必须等于 `session.header.agentPreset` —— 只有列出来的 preset 才真的干活 |
| `files[].path` | 绝对路径；含 `*` 时按 glob 展开（Node 22+ 内建 `fs.glob`，零依赖） |
| `files[].label` | UI 显示名 |
| `files[].mode` | `inline`（默认，全文注入）/ `notice`（只提示有这份文件，需要时再读） |
| `maxInlineBytes` | 单份文件超过此大小 → 自动降级为 `notice` |
| `maxBatchBytes` | 一次注入总量上限 → 超过按顺序丢弃后面的并报告 |

### 一份清单多处引用

```yaml
sharedFiles:
  - name: core
    files:
      - { path: 'D:\notes\*', mode: inline }

presets:
  - name: preset-a
    include: [core]
  - name: preset-b
    include: [core]
```

消掉「两张卡各抄一遍同样的清单」造成的漂移风险。

## 生效方式

三个顶层字段标了 `.volatile()`：

- 只改它们 → Loader **不 remount**、直接提交到运行中的 `fiber.config`
- 每次 `agent/pre-step` 都用 `current()` 读最新值 ⇒ **改配置立刻生效、不拆会话**
- 只有改**插件代码**才需要重启 DSH

## 安装

### ① 通过插件市场（推荐）

在 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 的目录里找到本插件，
或在 dsh 的 **插件 → 发现** 里搜索 `dsh-live-docs`，点安装。

### ② 手动安装

任选一种，**不要两种同时用**：

**A. 复制 + 手写 insert（适合本地开发）**

1. 把本目录复制到 `$DSH_HOME/profiles/web/node_modules/dsh-live-docs/`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加：

   ```yaml
   - insert:
       - id: live-docs
         name: 'dsh-live-docs'
   ```

3. 重启 dsh，或让 Loader 重载配置

**B. `dsh plugin add`（需要包已发布到 npm）**

```sh
dsh plugin --profile web add dsh-live-docs
```

> ⚠ 用 B 之后，包名会进 `dsh.profile.bundles`，bundles 层会读本包自带的
> `cordis.patch.yml`；此时**不要**再做 A 的第 2 步 —— 同一个 id 会被插两次，
> DSH 启动会直接失败。

## 依赖

- DSH ≥ 0.2.1-rc.2
- `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`（harness 自带的私有包，npm 上不存在，运行时由 dsh 的解析器提供）
