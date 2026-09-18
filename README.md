# dsh-tool-error-hints

给**失败的工具结果**追加一条可执行的提示，治"弱模型瞎猜路径"。

## 为什么需要（有真实数据）

2026-09-13 对真实会话 `session-7b9b38a1`（本地 27B 跑长任务）的 796 条 `tool/result` 取证：

- **失败 92 条（12%）**
- 最高频形态：`ls: cannot access '<path>': No such file or directory [exit code: 2]`

问题不在报错文案，而在**报错只说"不存在"、不说"哪儿存在"**：
本地模型反复瞎猜绝对路径（`/nas/dsh/docker/dsh`、`/home/ikta/bin/wake-v100.sh`），
而压缩之后它会**退回已经纠正过的错误写法**——同一个错路径能再错 4 次。

## 它做什么

挂在 `tools/post-execute`（waterfall），在失败结果之后注入一条 `source.kind='plugin'` 的提示：

| 识别到的失败 | 注入的提示 |
|---|---|
| 路径不存在 | **最近的已存在祖先目录**及其内容（模型据此即可改对）+ 工作区根提示 |
| 命令不存在 | 说明容器内没有该可执行文件，建议先 `command -v` 探测 |
| 权限不足 | 说明以非 root 运行，`sudo`/`apt-get`/写 `/var` 会失败 |
| 把目录当文件读 | 提示改用 `ls` |

## 误报防护（重要）

`grep 未找到匹配项`、`(无匹配)`、`no matches` 都是**合法的空结果**，不是错误。
自测时踩过这个坑，因此按证据强度分两级：

- **STRONG**（`No such file or directory` / `cannot access` / `文件不存在` …）→ 抽不到路径也给兜底提示
- **WEAK**（泛化的 `not found` / `未找到` / `找不到`）→ **必须先抽出像路径的 token** 才提示

自测用例 **10/10 通过**（5 类真报错都提示、5 类正常输出零误伤）。

## 配置

```yaml
- id: tool-error-hints
  name: 'dsh-tool-error-hints'
  config:
    enabled: true
    roots: [/nas/dsh]      # 解析相对路径、找"最近的已存在目录"时的根
    maxEntries: 24         # 列目录条数上限
    maxHintsPerPath: 2     # 同一路径本轮最多提示几次（防刷屏）
    include: []            # 只对哪些工具生效（空=全部）
    exclude: []            # 排除哪些工具
```

## 安装

```bash
bash /nas/dsh/工具/dsh-tool-error-hints/install.sh
dsh-restart
```

**激活方式**：`~/.dsh/profiles/web/cordis.patch.yml` 里的 `insert:` 条目。
**不要**写进 `package.json` 的 `dsh.profile.bundles` —— 实测 `dsh web` 每次启动
会把 `package.json` 还原成出厂版本，写进去的会被冲掉（见 `dsh-loop-breaker` 的同类记录）。

## 确证是否真的加载

`dump-config` 只组合配置树、**不 import 模块**，所以"配置里有"不等于"加载了"。
插件在 `apply()` 时写一行**加载心跳**：

```bash
tail -1 ~/.dsh-logs/tool-error-hints-loaded.log
# 2026-09-13T14:10:00.000Z pid=12345 roots=/nas/dsh maxEntries=24
```

## 设计约束

- **只读**：仅 `existsSync`/`readdirSync`/`statSync`，绝不执行命令、绝不写文件
- **不覆盖工具结果**：只通过 `additionalContexts` 追加，不改写工具输出本身
- **异常全吞**：提示插件绝不能影响正常工具流程
