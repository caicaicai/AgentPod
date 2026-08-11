/**
 * skill_save —— 把工作区里做好的技能存进用户自己的「我的技能」目录。
 *
 * ── 名字为什么不叫 publish ──────────────────────────────────────────
 *
 * 它曾经叫 `skill_publish`。这个词把事情说大了：模型会在任务清单里写"发布技能"、
 * 收尾时说"已发布成功"，用户看到的是"我的技能被推到某个云端仓库/共享技能库了"，
 * 于是开始担心可见范围。实际发生的事情只有一件 —— 文件从沙盒工作区落到
 * `<root>/users/<username>/skills/created/<name>/`，**只有这个用户自己能看到**。
 *
 * 真正的"发布"（推到共享技能库给别人装）是另一件还没做的事（见 skill-manager.js
 * 里 `skill.remote.*` 那几个没做的方法）。两件事必须用不同的词，否则等那个功能
 * 真的做出来时，没有词可用了。
 *
 * ── 为什么必须有这一步 ──────────────────────────────────────────────
 *
 * 沙盒工作区是**每 run 全新**的（租约释放 = 整个 slot 销毁重建）。模型在
 * `workspace/` 下写出 SKILL.md 和 scripts/ 之后，如果不做这一下，成果会随
 * slot 一起蒸发 —— "帮我做个技能"在云端就永远只是"帮我写一遍然后扔掉"。
 *
 * ── 为什么是显式动作，而不是自动同步 ────────────────────────────────
 *
 * `workspace/` 会自动回写，但**技能目录不会**：读写语义跟目录对齐，
 * `skills/` 是只读的。否则一个跑歪的脚本改掉你已经装好的技能，你不会知道。
 * 所以"我做好了，收下它"必须由模型明确说出来。
 *
 * ── 为什么在这里校验 frontmatter ────────────────────────────────────
 *
 * pi 装载技能时，frontmatter 缺 name 或 description 会**静默跳过**。等到下一轮
 * 用户问"我的技能呢"，表现是模型说不知道有这个技能 —— 没有任何报错可查。
 * 与其把这种失败推到下一轮，不如在保存这一刻就顶回去，让模型当场改。
 */
import { jsonResult } from './plugin-api.js'

/** 与 pi / 桌面端一致：技能名是目录名，也是唯一标识 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

const MAX_FILES = 100
const MAX_TOTAL_BYTES = 4 * 1024 * 1024

const DESCRIPTION = [
  '把你在工作区里做好的一个技能存进这个用户自己的「我的技能」，之后每一轮对话都能用它。',
  '用法：先在 `workspace/<目录名>/` 下写好 SKILL.md（必须有 frontmatter 的 name 与 description）和需要的 scripts/，再调用本工具。',
  '**只有调用了本工具，技能才会被保存下来** —— 工作区里的技能目录本身不会自动成为技能。',
  // 说清边界：不然模型会在收尾话术里说成"已发布"，用户以为自己的技能被公开了
  '这只是存到该用户的个人技能目录，**不会分享给任何其他人**，也不会推到共享技能库 —— 所以对用户描述这一步时说"已保存"，不要说"已发布"。',
  'name 是技能的唯一标识，只能是小写字母、数字和连字符；同名会覆盖这个用户自己的同名技能。',
  'description 要写清楚"用户说什么话时该用这个技能"，因为下一轮是靠它来判断要不要用的。',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    dir: {
      type: 'string',
      description: '技能在工作区里的目录名，相对 `workspace/`，例如传 `my-skill` 表示 `workspace/my-skill/`。',
    },
  },
  required: ['dir'],
}

/** 解析 SKILL.md 的 frontmatter。只取我们要校验的两个键，不引 YAML 解析器 */
function readFrontmatter(text) {
  const block = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!block) return null
  const pick = (key) => block.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'))?.[1]?.trim() || ''
  return { name: pick('name'), description: pick('description') }
}

export function registerSkillSaveTool(api) {
  const skills = api.ctx.skills

  api.registerTool({
    name: 'skill_save',
    label: '保存技能',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_toolCallId, params) {
      let base
      let files
      try {
        const listed = await skills.readWorkspaceDir(params?.dir)
        base = listed.base
        files = listed.entries
      } catch (error) {
        return jsonResult({ ok: false, error: `读不到 workspace/${params?.dir || ''}/：${error.message}` })
      }

      if (!files.length) return jsonResult({ ok: false, error: `${base}/ 里没有文件` })
      if (files.length > MAX_FILES) {
        return jsonResult({ ok: false, error: `技能文件数 ${files.length} 超过上限 ${MAX_FILES}` })
      }
      const totalBytes = files.reduce((sum, item) => sum + (item.size || 0), 0)
      if (totalBytes > MAX_TOTAL_BYTES) {
        return jsonResult({ ok: false, error: `技能体积 ${totalBytes} 字节超过上限 ${MAX_TOTAL_BYTES}` })
      }

      const skillMd = files.find((item) => item.path === `${base}/SKILL.md`)
      if (!skillMd) {
        return jsonResult({ ok: false, error: `${base}/SKILL.md 不存在。技能必须有这个文件，它是入口说明` })
      }

      const read = await skills.readFiles(files.map((item) => item.path))
      const failed = read.filter((item) => !item.ok)
      if (failed.length) {
        return jsonResult({ ok: false, error: `有 ${failed.length} 个文件读不出来：${failed[0].error}` })
      }

      const md = read.find((item) => item.path === `${base}/SKILL.md`)
      const meta = readFrontmatter(md.content.toString('utf8'))
      if (!meta?.name || !meta?.description) {
        return jsonResult({
          ok: false,
          // 说清楚为什么 —— 缺了它 pi 会静默跳过，下一轮表现成"模型不知道有这个技能"
          error: 'SKILL.md 的 frontmatter 必须同时有 name 和 description，缺一个技能就装不进来（而且不会报错，只是永远不出现）',
        })
      }
      if (!SKILL_NAME_RE.test(meta.name)) {
        return jsonResult({ ok: false, error: `技能名 ${meta.name} 不合法：只能是小写字母、数字和连字符，且以字母或数字开头` })
      }

      try {
        await skills.save({
          name: meta.name,
          files: read.map((item) => ({
            relPath: item.path.slice(base.length + 1),
            content: item.content,
          })),
        })
      } catch (error) {
        return jsonResult({ ok: false, error: `保存失败：${error.message}` })
      }

      return jsonResult({
        ok: true,
        skill: { name: meta.name, description: meta.description, files: read.length, bytes: totalBytes },
        // 两件事都要说明白：什么时候生效（免得模型在同一轮里反复找它为什么还没出现），
        // 以及存到哪儿（免得收尾话术说成"已发布到云端"）
        note: '已保存到这个用户自己的「我的技能」，仅本人可见，未分享给其他人。技能清单在每轮对话开始时装载，所以它会从**下一轮**起可用。',
      })
    },
  })
}

export const skillSavePlugin = {
  id: 'ap-skill-save',
  register: registerSkillSaveTool,
}
