// CDP Accessibility.getFullAXTree → 紧凑的 ARIA YAML 快照（含 [ref=eN] 标记）
// 纯函数模块，不依赖 Electron / CDP；供 browser-manager.js 调用，也供 test/dropdown-test.mjs 单测

const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem',
])

const CONTENT_ROLES = new Set([
  'article', 'cell', 'columnheader', 'gridcell', 'heading', 'listitem',
  'main', 'navigation', 'region', 'rowheader',
  // `layouttablecell` is what Chrome's AX tree labels the <td> cells in AntD /
  // ElementUI month & year pickers (and any CSS display:table grid). Without this
  // they render as nameless cells with no ref, so the model can't click "5月" /
  // "2026" and is forced into fragile hand-written JS. Only text-bearing cells get
  // a ref (see walk: isContent && effectiveName), so empty layout spacers stay quiet.
  'layouttablecell',
])

const SKIP_ROLES = new Set([
  'generic', 'none', 'presentation', 'inlinetextbox', 'linebreak',
])

const VALUE_BEARING_ROLES = new Set([
  'textbox', 'combobox', 'searchbox', 'spinbutton',
])

function axVal(v) {
  if (!v || typeof v !== 'object') return ''
  const value = v.value
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

// data: URL（尤其内联 base64 图片）会被整段塞进快照文本，单个图标就能占掉成千上万
// token，几次快照就把上下文撑爆（表现为"大模型返回了空响应"/上下文溢出）。模型从这串
// 字符里也得不到任何有用信息，故统一压成占位符；其余超长 URL 也截断，避免同类污染。
const MAX_URL_LEN = 256
function sanitizeUrl(url) {
  if (typeof url !== 'string') return url
  if (url.startsWith('data:')) {
    const mime = url.slice(5, 64).split(/[;,]/)[0] || 'data'
    return `[inline ${mime} omitted, ${url.length} chars]`
  }
  return url.length > MAX_URL_LEN ? `${url.slice(0, MAX_URL_LEN - 1)}…` : url
}

// 从节点子树里抽出第一个非空 statictext 文本，作为容器（listitem / cell 等）的"派生 name"。
// 遇到 INTERACTIVE 子节点（自己会拿 ref）就跳过该子树，避免把按钮文字误当容器名。
function deriveNameFromDescendants(byId, rootId, maxLen) {
  const visited = new Set()
  const dfs = (nid) => {
    if (visited.has(nid)) return ''
    visited.add(nid)
    const n = byId.get(nid)
    if (!n) return ''
    const role = axVal(n.role).toLowerCase()
    if (nid !== rootId && INTERACTIVE_ROLES.has(role)) return ''
    if (role === 'statictext') {
      const t = axVal(n.name)
      if (t && t.trim()) return t.trim()
    }
    for (const cid of (n.childIds || [])) {
      const r = dfs(cid)
      if (r) return r
    }
    return ''
  }
  const text = dfs(rootId)
  if (!text) return ''
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

// 抽取节点子树内第一个非空 statictext 文本（跳过 INTERACTIVE 子树，避免误把按钮文字当成显示值）
function findInnerStaticText(byId, rootId, maxLen) {
  const visited = new Set()
  const dfs = (nid) => {
    if (visited.has(nid)) return ''
    visited.add(nid)
    const n = byId.get(nid)
    if (!n) return ''
    const role = axVal(n.role).toLowerCase()
    if (INTERACTIVE_ROLES.has(role)) return ''
    if (role === 'statictext') {
      const t = (axVal(n.name) || '').trim()
      if (t) return t
    }
    for (const cid of (n.childIds || [])) {
      const r = dfs(cid)
      if (r) return r
    }
    return ''
  }
  const text = dfs(rootId)
  if (!text) return ''
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text
}

function formatAriaToYaml(nodes, limit = 800) {
  const byId = new Map()
  for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n)

  const referenced = new Set()
  for (const n of nodes) for (const c of n.childIds || []) referenced.add(c)

  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) || nodes[0]
  if (!root?.nodeId) return { snapshot: '(empty page)', refs: {} }

  // value-bearing 节点（如 <el-select> 的 textbox 触发器）自身的 AX value 常为空，
  // 显示文本却落在前一个非空 statictext sibling 上。下面在 walk 父 children loop 里
  // 维护 lastNonEmptyStaticText，遇到 textbox/combobox 时把它派生过去作为 /value。
  const pendingValueHint = new Map()

  let refCounter = 0
  const refs = {}
  const lines = []
  let nodeCount = 0

  const walk = (nodeId, depth) => {
    if (nodeCount >= limit) return
    const n = byId.get(nodeId)
    if (!n) return

    const role = axVal(n.role).toLowerCase()
    const name = axVal(n.name)
    const value = axVal(n.value)
    const children = (n.childIds || []).filter((c) => byId.has(c))

    if (SKIP_ROLES.has(role) && !name) {
      walkChildren(children, depth)
      return
    }

    const isInteractive = INTERACTIVE_ROLES.has(role)
    const isContent = CONTENT_ROLES.has(role)

    let effectiveName = name
    if (!effectiveName && isContent) {
      effectiveName = deriveNameFromDescendants(byId, nodeId, 80)
    }

    nodeCount++
    const indent = '  '.repeat(depth)
    let line = `${indent}- ${role}`
    if (effectiveName) line += ` "${effectiveName}"`

    if (isInteractive || (isContent && effectiveName)) {
      refCounter++
      const ref = `e${refCounter}`
      line += ` [ref=${ref}]`
      refs[ref] = {
        role,
        name: effectiveName || '',
        backendDOMNodeId: typeof n.backendDOMNodeId === 'number' ? n.backendDOMNodeId : undefined,
      }
    }

    lines.push(line)

    const props = n.properties || []
    for (const prop of props) {
      const propName = prop.name
      let propVal = axVal(prop.value)
      if (propVal && ['placeholder', 'url', 'checked', 'disabled', 'required', 'value', 'description'].includes(propName)) {
        if (propName === 'url') propVal = sanitizeUrl(propVal)
        lines.push(`${indent}  - /${propName}: ${propVal}`)
      }
    }

    // value-bearing 节点的 effective value：优先用自身 AX value，否则用父 walker 派生的 hint
    let displayValue = (value || '').toString()
    if (VALUE_BEARING_ROLES.has(role)) {
      if (!displayValue) {
        const hint = pendingValueHint.get(nodeId)
        if (hint) displayValue = hint
      }
      if (displayValue) lines.push(`${indent}  - /value: ${displayValue}`)
    }

    walkChildren(children, depth + 1)
  }

  // 父级 children loop：递归 walk 之外，跟踪"前一个非空 statictext"作为下一个 value-bearing
  // 节点的派生值候选。labeltext / 其他 sibling 不会贡献（不会污染 lastNonEmptyStaticText）。
  const walkChildren = (children, childDepth) => {
    let lastNonEmptyStaticText = ''
    for (const childId of children) {
      const childNode = byId.get(childId)
      if (!childNode) continue
      const childRole = axVal(childNode.role).toLowerCase()

      if (VALUE_BEARING_ROLES.has(childRole) && lastNonEmptyStaticText) {
        // 仅当 child 自己 AX value 为空时才会被采用（在 walk 内部判断）
        pendingValueHint.set(childId, lastNonEmptyStaticText)
      }

      walk(childId, childDepth)

      // 收集这个 child 的"贡献文本"：
      //   - 直接是 statictext 取其 name
      //   - generic / none / presentation（被 SKIP_ROLES 跳过的容器）则下钻找内部第一段非空 statictext
      //   - 其它 role 不更新（避免 labeltext / button 等污染）
      let contribution = ''
      if (childRole === 'statictext') {
        contribution = (axVal(childNode.name) || '').trim()
      } else if (SKIP_ROLES.has(childRole) && !axVal(childNode.name)) {
        contribution = findInnerStaticText(byId, childId, 200)
      }
      if (contribution) lastNonEmptyStaticText = contribution
    }
  }

  walk(root.nodeId, 0)
  return { snapshot: lines.join('\n') || '(empty page)', refs }
}

// selectOption 在弹层里按文本定位 option 的 JS 表达式生成器。
// 返回的字符串可直接喂给 CDP Runtime.evaluate（或 Playwright page.evaluate）。
// 结果是 JSON 字符串：{ ok:true, matchedText, cx, cy, candidateCount } 或 { ok:false, candidateCount, containerCount, sample }
function buildSelectOptionLocatorExpr(text, exact) {
  const targetJson = JSON.stringify(text)
  const exactJson = exact ? 'true' : 'false'
  return `(function(){
    var target = ${targetJson};
    var exact = ${exactJson};
    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      var r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      var s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) return false;
      return true;
    }
    function getText(el) { return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); }
    var containerSelectors = [
      '.el-select-dropdown:not([style*="display: none"])',
      '.el-cascader-panel',
      '.el-autocomplete-suggestion',
      '.el-popper:not([style*="display: none"])',
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
      '.ant-cascader-menus',
      '.ant-dropdown:not(.ant-dropdown-hidden)',
      '[role=listbox]',
      '[role=menu]',
      '.dropdown-menu.show',
    ];
    var optionSelectors = [
      '.el-select-dropdown__item',
      '.el-cascader-node',
      '.ant-select-item-option',
      '.ant-cascader-menu-item',
      '[role=option]',
      '[role=menuitem]',
      'li',
    ];
    var containers = [];
    for (var i = 0; i < containerSelectors.length; i++) {
      var found = document.querySelectorAll(containerSelectors[i]);
      for (var j = 0; j < found.length; j++) {
        if (isVisible(found[j])) containers.push(found[j]);
      }
    }
    var candidates = [];
    function collect(root) {
      for (var k = 0; k < optionSelectors.length; k++) {
        var items = root.querySelectorAll(optionSelectors[k]);
        for (var m = 0; m < items.length; m++) {
          if (isVisible(items[m])) candidates.push(items[m]);
        }
        if (candidates.length > 0) break;
      }
    }
    if (containers.length > 0) {
      for (var c = 0; c < containers.length; c++) collect(containers[c]);
    }
    if (candidates.length === 0) collect(document.body);

    var matched = null, matchedText = '';
    for (var t = 0; t < candidates.length; t++) {
      var txt = getText(candidates[t]);
      if (txt === target) { matched = candidates[t]; matchedText = txt; break; }
    }
    if (!matched && !exact) {
      for (var u = 0; u < candidates.length; u++) {
        var txt2 = getText(candidates[u]);
        if (txt2 && txt2.indexOf(target) !== -1) { matched = candidates[u]; matchedText = txt2; break; }
      }
    }
    if (!matched) {
      var sample = [];
      for (var v = 0; v < Math.min(8, candidates.length); v++) sample.push(getText(candidates[v]));
      return JSON.stringify({
        ok: false,
        candidateCount: candidates.length,
        containerCount: containers.length,
        sample: sample,
      });
    }
    matched.scrollIntoView({ block: 'center', inline: 'center' });
    var rect = matched.getBoundingClientRect();
    return JSON.stringify({
      ok: true,
      matchedText: matchedText,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      candidateCount: candidates.length,
    });
  })()`
}

export {
  INTERACTIVE_ROLES,
  CONTENT_ROLES,
  SKIP_ROLES,
  VALUE_BEARING_ROLES,
  axVal,
  deriveNameFromDescendants,
  formatAriaToYaml,
  buildSelectOptionLocatorExpr,
}
