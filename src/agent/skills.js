/**
 * 技能装载。
 *
 * pi 原生支持 SKILL.md（Agent Skills 标准）：目录里有 SKILL.md 就当作技能根、不再递归；
 * frontmatter 只认 name / description / disable-model-invocation，其余键（我们的
 * `metadata.openclaw.*`）作为未知键被忽略，不报错。
 *
 * 所以 modules/ap/managed-skills/* 与用户自定义技能**格式不用改**。
 * 唯一要自己补的语义是 `metadata.openclaw.always`（常驻注入）—— pi 没有对应物，
 * 见 selectSkills() 里的处理。
 */
import { readFileSync } from 'node:fs'

import { loadSkillsFromDir, formatSkillsForPrompt } from '@mariozechner/pi-coding-agent'

/**
 * 补回 pi 丢掉的**展示用**元信息。
 *
 * pi 解析 frontmatter 时只认 name / description / disable-model-invocation，
 * 其余键（我们的 `metadata.openclaw.emoji`、老技能里的 `metadata.moltbot.emoji`）
 * 作为未知键被忽略。对模型没影响，但界面上想给每个技能配个图标就没得取了。
 *
 * 这里只做定点提取，不引 YAML 解析器：frontmatter 里的 metadata 在不同技能里
 * 一会儿是单行 JSON、一会儿是多行缩进块，为两个展示字段扛一个解析器不划算。
 * 提取失败就是没有图标，不影响技能本身可用。
 */
function readDisplayMeta(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
    if (!frontmatter) return {}
    /**
     * 同一个键有两种写法，都得认：
     *   displayName: 周报助手              ← 顶层 YAML 行（桌面端 skill-author 写的就是这个）
     *   metadata: { "openclaw": { "emoji": "📅" } }   ← JSON 块里带引号
     * 只认带引号的那种，中文展示名会静默丢掉、回退成英文 name —— 没有报错，
     * 只是界面上看着"没生效"。
     */
    const pick = (key) => {
      const plain = frontmatter.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'))?.[1]
      if (plain && !plain.startsWith('{')) return plain.replace(/^["']|["']$/g, '')
      return frontmatter.match(new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`))?.[1] || ''
    }
    return { emoji: pick('emoji'), displayName: pick('displayName') }
  } catch {
    return {}
  }
}

export function loadSkills({ dirs = [], logger }) {
  const skills = []
  const diagnostics = []

  for (const dir of dirs) {
    try {
      const result = loadSkillsFromDir({ dir, source: 'ap' })
      skills.push(...result.skills)
      diagnostics.push(...(result.diagnostics || []))
    } catch (error) {
      logger?.warn('技能目录加载失败', { dir, err: error?.message })
    }
  }

  // 展示字段直接挂在 pi 的 Skill 上：formatSkillsForPrompt 只读它认识的那几个字段，
  // 多挂的键既不会进系统提示，也不会跟着 toSandboxSkills 影响路径改写。
  for (const skill of skills) Object.assign(skill, readDisplayMeta(skill.filePath))

  if (diagnostics.length) logger?.warn('技能加载有告警', { count: diagnostics.length })
  return { skills, diagnostics }
}

/** 技能清单的对外形状：只回展示要用的字段，不回 filePath（那是服务端磁盘布局） */
export function describeSkills(skills = []) {
  return skills.map((skill) => ({
    name: skill.name,
    displayName: skill.displayName || skill.name,
    emoji: skill.emoji || '',
    description: skill.description || '',
  }))
}

/**
 * 按允许清单筛选技能。
 * allowlist 为空表示不限制；显式传空数组表示禁用全部技能。
 */
export function selectSkills({ skills, allowlist }) {
  if (!Array.isArray(allowlist)) return skills
  const allowed = new Set(allowlist)
  return skills.filter((skill) => allowed.has(skill.name))
}

/** 生成注入系统提示的技能清单（XML 格式，遵循 Agent Skills 标准） */
export function renderSkillsPrompt(skills) {
  if (!skills?.length) return ''
  return formatSkillsForPrompt(skills)
}
