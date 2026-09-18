/**
 * dsh-tool-error-hints —— 给失败的工具结果追加**可执行的**提示。
 *
 * ## 为什么需要
 *
 * 2026-09-13 对真实会话 `session-7b9b38a1` 取证（796 条 tool/result）：
 *   失败 92 条（12%），其中最高频的是
 *     `ls: cannot access '<path>': No such file or directory [exit code: 2]`
 *   —— 本地 27B 反复**瞎猜绝对路径**，而 shell 的报错只说"不存在"，
 *      不告诉它"哪儿存在"。实测压缩之后它会退回已经纠正过的错误写法，
 *      于是同一个错路径能错 4 次以上。
 *
 * 本插件在工具结果之后注入一条 plugin 来源的提示，内容包括：
 *   · 路径不存在 → 给出**最近的已存在祖先目录**及其内容（模型据此即可改对）
 *   · 命令不存在 → 说明容器里没有这个可执行文件，别假设它存在
 *   · 权限不足   → 说明以非 root 运行，sudo/apt 会失败
 *
 * ## 为什么用插件而不是改工具实现
 *
 * DSH 的工具报错多数来自**子进程自身**（bash 的 stderr），改不了；
 * 且改 node_modules 会被 dsh 升级覆盖。用 `tools/post-execute` 钩子
 * 在结果之后追加提示，既不重写工具输出，也能扛住升级。
 *
 * ## 安全约束
 *
 * · 只读文件系统探测（existsSync/readdirSync），绝不执行命令、绝不写文件
 * · 任何异常都吞掉——提示插件绝不能影响正常工具流程
 * · 不覆盖工具结果本身，只通过 additionalContexts 追加
 *
 * @module dsh-tool-error-hints
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, resolve, dirname, sep, join } from 'node:path';

export const name = 'tool-error-hints';

/**
 * 加载心跳目录。与 dsh-loop-breaker 同样的动机与位置约束：
 * `dump-config` 只组合配置树、**不 import 模块**，所以"配置里有"不等于"加载了"；
 * 而 ~/.dsh 被 chokidar 监视、/nas 是 noatime，都不能用来判断，只能显式落盘。
 * ⚠️ 刻意放在 `~/.dsh/` 之外。
 */
const HEARTBEAT_DIR = process.env.DSH_TOOL_HINTS_LOG_DIR || '/home/dsh/.dsh-logs';

/** 注入提示的来源标记（必须带 kind:'plugin'，否则会在派生历史里被当成用户消息）。 */
const SOURCE = { kind: 'plugin', plugin: 'tool-error-hints' };

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 解析**相对路径**时依次尝试的根目录。 */
  roots: z.array(z.string()).default(['/nas/dsh']),
  /** 列最近目录时最多显示多少个条目。 */
  maxEntries: z.number().default(24),
  /** 单个路径在本轮内最多提示几次（防刷屏）。 */
  maxHintsPerPath: z.number().default(2),
  /** 参与的工具名通配（空 = 全部）。 */
  include: z.array(z.string()).default([]),
  /** 排除的工具名通配。 */
  exclude: z.array(z.string()).default([]),
});

/** 把通配符串编译成正则。 */
function wildcardToRegExp(pattern) {
  return new RegExp(
    '^' + String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
}

/** 从工具结果里提取纯文本。 */
function textOf(result) {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

/** 从报错文本里找出候选路径（优先引号内的，其次以 / 或 ./ 开头的裸路径）。 */
function candidatePaths(text) {
  const out = [];
  for (const m of text.matchAll(/['"‘’“”]([^'"‘’“”\s]{1,300})['"‘’“”]/g)) {
    out.push(m[1]);
  }
  for (const m of text.matchAll(/(?:^|[\s:=])((?:\.{1,2}\/|\/)[^\s:'"]{1,300})/g)) {
    out.push(m[1]);
  }
  return out;
}

/** 找出最近的已存在祖先目录，并返回其条目。 */
function describeNearest(root, p, maxEntries) {
  let ap;
  try {
    ap = isAbsolute(p) ? p : resolve(root, p);
  } catch {
    return undefined;
  }
  // 逐级上溯，找到第一个存在的路径
  let cur = ap;
  let became = false;
  for (let i = 0; i < 40 && cur && cur !== sep; i += 1) {
    if (existsSync(cur)) {
      became = cur !== ap;
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (!cur || !existsSync(cur)) return undefined;
  try {
    const st = statSync(cur);
    if (!st.isDirectory()) {
      return { ancestor: cur, entries: [], isFile: true, target: ap, existed: !became };
    }
    const entries = readdirSync(cur, { withFileTypes: true })
      .slice(0, maxEntries)
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    return { ancestor: cur, entries, isFile: false, target: ap, existed: !became };
  } catch {
    return undefined;
  }
}

/** 组装一条路径类提示。 */
function pathHintText(info, roots) {
  const lines = [`💡 路径不存在：\`${info.target}\``];
  if (info.ancestor && info.ancestor !== info.target) {
    lines.push(`最近的**已存在**目录是 \`${info.ancestor}\`，其中包含：`);
    if (info.entries.length) {
      lines.push(info.entries.map((e) => `  ${e}`).join('\n'));
    } else {
      lines.push('  (空目录)');
    }
  }
  lines.push(`提示：工作区根为 \`${roots[0] ?? '/nas/dsh'}\`；相对路径请以它为基准，或先 \`ls\` 确认再读取。`);
  return lines.join('\n');
}

/** 分析一段失败文本，返回提示内容或 undefined。 */
function analyze(text, cfg) {
  if (!text) return undefined;
  const t = text.slice(0, 4000);

  // ① 命令不存在（优先于路径判断：'ssh': No such file or directory 指的是命令）
  const cmd = /failed to run command\s*['"‘’“”]([^'"‘’“”]+)['"‘’“”]/.exec(t);
  if (cmd) {
    return `💡 容器内没有可执行文件 \`${cmd[1]}\`，不要假设它存在。可先用 \`command -v ${cmd[1]}\` 探测，或改用其它方式。`;
  }

  // ② 权限不足
  if (/Permission denied|not permitted|EACCES/i.test(t)) {
    return [
      '💡 权限不足。容器内以非 root 用户（dsh）运行：',
      '- `sudo` / `apt-get` / 写 `/var`、`/etc`、`/usr` 都会失败，不要重试；',
      '- 改用用户可写路径（工作区 `/nas/dsh`、家目录 `/home/dsh`）。',
    ].join('\n');
  }

  // ③ 路径不存在。
  //    ⚠️ 误报防护（2026-09-13 自测踩到）：`grep 未找到匹配项` / `no matches` 是
  //    **合法的空结果**，不是路径错误。所以按证据强度分两级：
  //      STRONG（明确说文件/目录不存在）→ 抽不到路径也给兜底提示
  //      WEAK（泛化的"没找到"）        → **必须先抽出像路径的 token** 才提示
  const NOMATCH = /no matches|no match|无匹配|未找到匹配|没有匹配|未匹配/i;
  const STRONG = /No such file or directory|cannot access|does not exist|文件不存在|没有那个文件|目录不存在|文件或目录不存在|找不到该文件/i;
  const WEAK = /not found|未找到|找不到|不存在/i;

  if (STRONG.test(t) || (WEAK.test(t) && !NOMATCH.test(t))) {
    const strong = STRONG.test(t);
    for (const p of candidatePaths(t)) {
      // 排除明显不是路径的（如 command not found 的裸命令名）
      if (!p.includes('/') && !p.startsWith('.')) continue;
      for (const root of cfg.roots) {
        const info = describeNearest(root, p, cfg.maxEntries);
        if (info) return pathHintText(info, cfg.roots);
      }
    }
    // 只有强证据（明确说不存在）才给无路径的兜底；弱证据抽不到路径就**不提示**，避免误报
    if (strong) {
      return '💡 目标不存在。请先用 `ls` 确认路径真实存在再操作，不要凭空假设目录结构。';
    }
    return undefined;
  }

  // ④ 把目录当文件读（弱模型高频错误）
  if (/Is a directory|是一个目录|是目录/i.test(t)) {
    for (const p of candidatePaths(t)) {
      if (!p.includes('/') && !p.startsWith('.')) continue;
      return `💡 \`${p}\` 是**目录**不是文件。用 \`ls\`（或 list_dir）列内容，不要用 cat/read 直接读。`;
    }
    return `💡 目标是目录不是文件。用 \`ls\` 列内容，不要用 cat/read 直接读。`;
  }

  return undefined;
}

/**
 * 安装提示注入。
 * @param ctx - 插件上下文；监听器随其销毁。
 * @param config - 经 Config 校验后的配置。
 */
export function apply(ctx, config) {
  // DSH 传入的 config 已过 Config 校验并套用默认值；这里仍做防御式兜底，
  // 保证任何字段缺失时插件都能工作（与 dsh-loop-breaker 的写法一致）。
  const cfg = {
    enabled: config?.enabled !== false,
    roots: Array.isArray(config?.roots) && config.roots.length > 0 ? config.roots : ['/nas/dsh'],
    maxEntries: Math.max(4, Number(config?.maxEntries) || 24),
    maxHintsPerPath: Math.max(1, Number(config?.maxHintsPerPath) || 2),
    include: Array.isArray(config?.include) ? config.include : [],
    exclude: Array.isArray(config?.exclude) ? config.exclude : [],
  };
  if (!cfg.enabled) return;

  // 加载心跳：证明插件确实被 import 并 apply（异常必须吞掉）
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    appendFileSync(
      join(HEARTBEAT_DIR, 'tool-error-hints-loaded.log'),
      `${new Date().toISOString()} pid=${process.pid} roots=${cfg.roots.join(',')} maxEntries=${cfg.maxEntries}\n`,
    );
  } catch {
    /* 心跳失败不影响提示功能 */
  }

  const include = cfg.include.map(wildcardToRegExp);
  const exclude = cfg.exclude.map(wildcardToRegExp);
  /** agent -> Map<path, 已提示次数> */
  const seen = new WeakMap();

  function tracked(toolName) {
    if (typeof toolName !== 'string' || !toolName) return false;
    if (include.length > 0 && !include.some((p) => p.test(toolName))) return false;
    return !exclude.some((p) => p.test(toolName));
  }

  function shouldEmit(agent, key) {
    if (!agent) return true;
    let m = seen.get(agent);
    if (!m) {
      m = new Map();
      seen.set(agent, m);
    }
    const n = (m.get(key) ?? 0) + 1;
    m.set(key, n);
    return n <= cfg.maxHintsPerPath;
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    try {
      if (!tracked(exec.name)) return downstream;
      // 失败也可能 isError === false（bash 的非零退出就是这种情况），所以只看文本
      const hint = analyze(textOf(result), cfg);
      if (!hint) return downstream;
      if (!shouldEmit(exec.agent, hint.slice(0, 120))) return downstream;

      const notice = createUserMessage({ content: [{ type: 'text', text: hint }], source: SOURCE });
      if (downstream.kind === 'block') {
        return {
          kind: 'block',
          feedback: downstream.feedback,
          additionalContexts: [...(downstream.additionalContexts ?? []), notice],
        };
      }
      return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), notice] };
    } catch {
      // 提示插件绝不能影响正常流程
      return downstream;
    }
  });

  // 真实用户消息 = 新一轮 → 清空计数
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user')) seen.delete(agent);
    return next();
  });
}
