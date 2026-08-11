const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')

const ORIGIN_MANIFEST_FILE = '.ap-origins.json'
const USER_SKILL_SCOPE_CREATED = 'created'
const USER_SKILL_SCOPE_INSTALLED = 'installed'

const REWRITE_TEXT_EXTENSIONS = new Set([
  '.md', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx',
  '.json', '.yml', '.yaml', '.sh', '.txt', '.toml', '.ini',
])
const REWRITE_MAX_BYTES = 2 * 1024 * 1024
const REWRITE_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv'])
const SKILL_PACKAGE_IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep'])
const SKILL_PACKAGE_IGNORE_DIRS = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv', '.idea', '.vscode'])

function resolveUserSkillsRoot(explicitRoot = '') {
  const root = String(explicitRoot || process.env.AP_USER_SKILLS_DIR || '').trim()
  if (!root) {
    throw new Error('AP_USER_SKILLS_DIR is required')
  }
  return path.resolve(root)
}

function ensureDirName(name) {
  const normalized = String(name || '').trim()
  if (!normalized) throw new Error('skill directory is required')
  const unixPath = normalized.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const parts = unixPath.split('/').filter(Boolean)
  if (parts.length === 0) throw new Error('skill directory is required')
  for (const part of parts) {
    if (part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part)) {
      throw new Error('skill 目录名仅允许字母、数字、点、连字符、下划线')
    }
  }
  return parts.join('/')
}

function sanitizeSkillName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48)
  return normalized || 'custom-skill'
}

function scopedSkillDirName(scope, dirName) {
  const safeScope = ensureDirName(scope)
  const safeDir = ensureDirName(dirName)
  if (safeDir.includes('/')) {
    throw new Error('skill 目录名不能包含子目录')
  }
  if (safeScope !== USER_SKILL_SCOPE_CREATED && safeScope !== USER_SKILL_SCOPE_INSTALLED) {
    throw new Error(`未知 skill 目录范围：${safeScope}`)
  }
  return `${safeScope}/${safeDir}`
}

function resolveCustomSkillPath(userSkillsRoot, dirName, relativePath = '') {
  const rootBase = resolveUserSkillsRoot(userSkillsRoot)
  const safe = ensureDirName(dirName)
  const root = path.join(rootBase, safe)
  if (!relativePath) return root
  const normalized = String(relativePath).replace(/\\/g, '/')
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error('non-relative path is not allowed')
  }
  const target = path.normalize(path.join(root, normalized))
  if (!target.startsWith(root + path.sep) && target !== root) {
    throw new Error('path escapes skill directory')
  }
  return target
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function allocateSkillDirName(userSkillsRoot, name, scope = USER_SKILL_SCOPE_CREATED) {
  const base = ensureDirName(sanitizeSkillName(name))
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`
    const scoped = scopedSkillDirName(scope, candidate)
    const root = resolveCustomSkillPath(userSkillsRoot, scoped)
    if (!(await pathExists(root))) {
      return scoped
    }
  }
  throw new Error(`无法为 skill 分配可用目录名：${base}`)
}

async function ensureUserCustomSkillsLayout(userSkillsRoot) {
  const root = resolveUserSkillsRoot(userSkillsRoot)
  const createdDir = path.join(root, USER_SKILL_SCOPE_CREATED)
  const installedDir = path.join(root, USER_SKILL_SCOPE_INSTALLED)
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(createdDir, { recursive: true })
  await fs.mkdir(installedDir, { recursive: true })
  return { userSkillsRoot: root, createdDir, installedDir }
}

async function preparePendingSkillDir({ userSkillsRoot = '' } = {}) {
  const root = resolveUserSkillsRoot(userSkillsRoot)
  await ensureUserCustomSkillsLayout(root)
  const placeholderName = `pending-${crypto.randomBytes(4).toString('hex')}`
  const dirName = await allocateSkillDirName(root, placeholderName, USER_SKILL_SCOPE_CREATED)
  const targetDir = resolveCustomSkillPath(root, dirName)
  await fs.mkdir(targetDir, { recursive: true })
  return { dirName, targetDir, userSkillsRoot: root }
}

function parseSkillFrontmatter(raw) {
  const text = String(raw || '')
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return {}
  const yaml = match[1]
  const result = {}
  const nameMatch = yaml.match(/^name:\s*(.+)$/m)
  if (nameMatch) result.name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  const descMatch = yaml.match(/^description:\s*(.+)$/m)
  if (descMatch) result.description = descMatch[1].trim().replace(/^["']|["']$/g, '')
  // displayName：可选中文展示名。优先取顶层 displayName，再退而求其次从 metadata JSON 里抠
  const displayNameMatch =
    yaml.match(/^displayName:\s*(.+)$/m) ||
    yaml.match(/["']displayName["']\s*:\s*["']([^"'\n]+)["']/m)
  if (displayNameMatch) result.displayName = displayNameMatch[1].trim().replace(/^["']|["']$/g, '')
  const emojiMatch =
    yaml.match(/emoji:\s*["']?([^"'\n]+)["']?/m) ||
    yaml.match(/["']emoji["']\s*:\s*["']([^"'\n]+)["']/m)
  if (emojiMatch) result.emoji = emojiMatch[1].trim()
  return result
}

function stripSkillFrontmatter(raw) {
  return String(raw || '').replace(/^---\s*\n[\s\S]*?\n---\s*/, '')
}

function normalizeGeneratedRelativePath(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!rel || rel.includes('..')) return ''
  if (rel.split('/').some((part) => !part || part === '.' || part.startsWith('.'))) return ''
  if (!/^[a-zA-Z0-9_./-]+$/.test(rel)) return ''
  return rel
}

async function listSkillFiles(root) {
  const entries = []
  async function walk(dir, prefix) {
    let items
    try {
      items = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const dirent of items) {
      const full = path.join(dir, dirent.name)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        if (SKILL_PACKAGE_IGNORE_DIRS.has(dirent.name)) continue
        await walk(full, rel)
      } else if (dirent.isFile()) {
        if (SKILL_PACKAGE_IGNORE_FILES.has(dirent.name)) continue
        const content = await fs.readFile(full, 'utf8')
        entries.push({ relativePath: rel, content })
      }
    }
  }
  await walk(root, '')
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return entries
}

async function readSkillPackage(root) {
  if (!(await pathExists(root))) {
    throw new Error(`skill 目录不存在：${root}`)
  }
  const files = await listSkillFiles(root)
  const skillMdEntry = files.find((file) => file.relativePath === 'SKILL.md')
  if (!skillMdEntry) throw new Error('skill 缺少 SKILL.md')
  const meta = parseSkillFrontmatter(skillMdEntry.content)
  const skillName = meta.name || path.basename(root)
  return { root, files, skillMdEntry, meta, skillName }
}

function validateGeneratedSkillPackage({ name, description, bodyMarkdown, files }, { throwOnError = true } = {}) {
  const errors = []
  const warnings = []
  const body = String(bodyMarkdown || '')
  const normalizedFiles = Array.isArray(files) ? files : []

  if (!/^[a-z0-9][a-z0-9_-]{1,46}[a-z0-9]$/.test(String(name || ''))) {
    errors.push('name 必须是 3-48 位小写字母、数字、连字符或下划线，且首尾不能是分隔符')
  }
  if (!String(description || '').trim()) {
    errors.push('description 不能为空')
  }
  if (!body.trim()) {
    errors.push('SKILL.md 正文不能为空')
  }

  const expectedSections = ['适用场景', '执行流程', '输出规则']
  for (const section of expectedSections) {
    if (!body.includes(section)) warnings.push(`SKILL.md 建议包含「${section}」`)
  }
  if (body.length > 5000) {
    warnings.push('SKILL.md 正文超过 5000 字符，建议把长文档拆到 references/')
  }
  if (/(python3scripts|cd\/path|envpython|fromap_httpimporthttp)/i.test(body)) {
    errors.push('SKILL.md 中包含常见坏命令片段，请保留空格和完整路径引号')
  }

  const seen = new Set()
  for (const file of normalizedFiles) {
    const relativePath = normalizeGeneratedRelativePath(file?.relativePath)
    const content = String(file?.content ?? '')
    if (!relativePath) {
      errors.push(`文件路径非法：${file?.relativePath || ''}`)
      continue
    }
    if (seen.has(relativePath)) {
      errors.push(`文件路径重复：${relativePath}`)
      continue
    }
    seen.add(relativePath)
    if (relativePath === 'SKILL.md') {
      errors.push('files 中不能包含 SKILL.md')
    }
    if (!/^(scripts|references|assets)\//.test(relativePath)) {
      warnings.push(`辅助文件建议放在 scripts/、references/ 或 assets/ 下：${relativePath}`)
    }
    if (relativePath.endsWith('.py')) {
      validateGeneratedPythonScript(relativePath, content, errors, warnings)
    }
  }

  if (errors.length > 0 && throwOnError) {
    const error = new Error(`生成的 skill 未通过校验：${errors.join('；')}`)
    error.validation = { ok: false, errors, warnings }
    throw error
  }
  return { ok: errors.length === 0, errors, warnings }
}

function validateGeneratedPythonScript(relativePath, content, errors, warnings) {
  const source = String(content || '')
  if (!source.trim()) {
    errors.push(`${relativePath} 为空`)
    return
  }
  const badPatterns = [
    [/^#!\/usr\/bin\/envpython3/m, 'shebang 缺少 env 与 python3 之间的空格'],
    [/\bfromap_httpimporthttp\b/, 'ap_http import 语句缺少空格'],
    [/\bimport(os|sys|json)\b/, 'import 语句疑似缺少空格'],
  ]
  for (const [pattern, message] of badPatterns) {
    if (pattern.test(source)) errors.push(`${relativePath}: ${message}`)
  }
  if (source.includes('ap_http') && !source.includes('from ap_http import http')) {
    warnings.push(`${relativePath}: 使用 ap_http 时建议写成 "from ap_http import http"`)
  }
}

async function validateSkillDir(root, { throwOnError = false } = {}) {
  const skillPackage = await readSkillPackage(root)
  const bodyMarkdown = stripSkillFrontmatter(skillPackage.skillMdEntry.content)
  const result = validateGeneratedSkillPackage({
    name: skillPackage.skillName,
    description: skillPackage.meta.description || '',
    bodyMarkdown,
    files: skillPackage.files.filter((file) => file.relativePath !== 'SKILL.md'),
  }, { throwOnError: false })
  const combined = {
    ok: result.ok,
    errors: [...result.errors],
    warnings: [...result.warnings],
    fileCount: skillPackage.files.length,
    skillName: skillPackage.skillName,
    description: skillPackage.meta.description || '',
    checkedAt: new Date().toISOString(),
  }
  if (throwOnError && !combined.ok) {
    const error = new Error(`skill 校验失败：${combined.errors.join('；')}`)
    error.validation = combined
    throw error
  }
  return combined
}

async function replaceInSkillTextFiles(root, oldStr, newStr) {
  if (!oldStr || oldStr === newStr) return
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (REWRITE_SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!REWRITE_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      let stat
      try { stat = await fs.stat(full) } catch { continue }
      if (stat.size > REWRITE_MAX_BYTES) continue
      let content
      try { content = await fs.readFile(full, 'utf8') } catch { continue }
      if (!content.includes(oldStr)) continue
      const updated = content.split(oldStr).join(newStr)
      try { await fs.writeFile(full, updated, 'utf8') } catch {
        /* keep finalization best-effort for auxiliary rewrites */
      }
    }
  }
}

async function rewriteSkillFrontmatterName(skillMdPath, nextName) {
  const raw = await fs.readFile(skillMdPath, 'utf8')
  const updated = raw.replace(/^(name:\s*).+$/m, `$1${nextName}`)
  if (updated !== raw) {
    await fs.writeFile(skillMdPath, updated, 'utf8')
  }
}

async function readOriginManifest(userSkillsRoot) {
  try {
    const raw = await fs.readFile(path.join(resolveUserSkillsRoot(userSkillsRoot), ORIGIN_MANIFEST_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return {}
  }
}

async function writeOriginManifest(userSkillsRoot, manifest) {
  const root = resolveUserSkillsRoot(userSkillsRoot)
  await ensureUserCustomSkillsLayout(root)
  await fs.writeFile(path.join(root, ORIGIN_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8')
}

async function patchOriginManifest(userSkillsRoot, skillDirName, patch) {
  const manifest = await readOriginManifest(userSkillsRoot)
  const existing = manifest[skillDirName] || {}
  if (patch === null) {
    delete manifest[skillDirName]
  } else {
    manifest[skillDirName] = { ...existing, ...patch }
  }
  await writeOriginManifest(userSkillsRoot, manifest)
  return manifest[skillDirName] || null
}

function deriveDirNameFromTarget(userSkillsRoot, targetDir) {
  const root = resolveUserSkillsRoot(userSkillsRoot)
  const target = path.resolve(String(targetDir || ''))
  const rel = path.relative(root, target).replace(/\\/g, '/')
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error(`targetDir must be inside AP_USER_SKILLS_DIR: ${target}`)
  }
  return ensureDirName(rel)
}

async function finalizeCreatedSkill({
  targetDir,
  userSkillsRoot = '',
  sessionKey = '',
  writeManifest = true,
  validate = true,
} = {}) {
  const root = resolveUserSkillsRoot(userSkillsRoot)
  await ensureUserCustomSkillsLayout(root)
  const target = path.resolve(String(targetDir || ''))
  if (!target) throw new Error('targetDir is required')
  const createdRoot = path.join(root, USER_SKILL_SCOPE_CREATED)
  if (!isInside(createdRoot, target)) {
    throw new Error(`targetDir must be inside ${createdRoot}`)
  }
  if (validate) {
    await validateSkillDir(target, { throwOnError: true })
  }

  const initialDirName = deriveDirNameFromTarget(root, target)
  const oldBasename = path.basename(initialDirName)
  const skillPackage = await readSkillPackage(target)
  const desiredBasename = sanitizeSkillName(skillPackage.skillName)
  if (desiredBasename !== skillPackage.skillName) {
    throw new Error('SKILL.md frontmatter name 必须已经是规范化后的英文 skill name')
  }

  let finalDirName = initialDirName
  let finalRoot = target
  if (oldBasename !== desiredBasename) {
    finalDirName = await allocateSkillDirName(root, desiredBasename, USER_SKILL_SCOPE_CREATED)
    finalRoot = resolveCustomSkillPath(root, finalDirName)
    await fs.rename(target, finalRoot)
    await replaceInSkillTextFiles(finalRoot, oldBasename, path.basename(finalDirName))
  }

  const finalBasename = path.basename(finalDirName)
  if (finalBasename !== skillPackage.skillName) {
    await rewriteSkillFrontmatterName(path.join(finalRoot, 'SKILL.md'), finalBasename)
  }

  const finalValidation = await validateSkillDir(finalRoot, { throwOnError: Boolean(validate) })
  if (writeManifest) {
    await patchOriginManifest(root, finalDirName, {
      origin: 'created',
      skillName: finalBasename,
      generated: true,
      agentGenerated: true,
      agentSessionKey: sessionKey || '',
      pendingDirName: initialDirName,
      createdAt: new Date().toISOString(),
      validation: finalValidation,
    })
  }

  return {
    status: 'completed',
    userSkillsRoot: root,
    dirName: finalDirName,
    targetDir: finalRoot,
    skillName: finalBasename,
    validation: finalValidation,
  }
}

module.exports = {
  ORIGIN_MANIFEST_FILE,
  USER_SKILL_SCOPE_CREATED,
  USER_SKILL_SCOPE_INSTALLED,
  resolveUserSkillsRoot,
  ensureDirName,
  sanitizeSkillName,
  scopedSkillDirName,
  resolveCustomSkillPath,
  allocateSkillDirName,
  ensureUserCustomSkillsLayout,
  preparePendingSkillDir,
  parseSkillFrontmatter,
  stripSkillFrontmatter,
  normalizeGeneratedRelativePath,
  readSkillPackage,
  validateGeneratedSkillPackage,
  validateSkillDir,
  replaceInSkillTextFiles,
  readOriginManifest,
  writeOriginManifest,
  patchOriginManifest,
  deriveDirNameFromTarget,
  finalizeCreatedSkill,
}
