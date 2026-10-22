# 01: frontmatter 解析失败是静默的（构建不报错、字段全空）

**What to build:** 构建期（或钩子）对每个内容页做一次「frontmatter 能解析」校验；解析失败就报错并指出文件。
本仓 `站点/build.mjs` 里 frontmatter 的 `yaml.load` 被 `catch(_) {}` 静默吞掉——**字段全部变空、页面照常生成、钩子照常绿**。

**为什么挂这条**（2026-10-12 实弹）：符号系统的页面级排除靠 frontmatter 的 `符号排除: [...]` 驱动。
一次编辑在 frontmatter 里写进了非 YAML 行（`注：…`），整块解析抛异常被吞——排除清单静默失效、
页面里选项字母又被包成符号气泡，而构建与全部闸门都是绿的，**只有在浏览器里逐页点才看得出来**。

**Settling:** 不存在 —— 本工单的第一交付物是校验脚本（对 `课程/**/*.md` 逐文件解析 frontmatter，rc=0 ⇒ 全部可解析；rc≠0 ⇒ 仍有静默失败风险）

**Status:** resolved

**结算记录（2026-10-22）：** 校验以构建内联形式交付：`站点/build.mjs` 两处 `yaml.load`
（Step 3 元数据遍 + Step 4 渲染遍）的 catch 从静默吞掉（`console.warn` / `catch(_){}`）升级为
硬失败——坏 frontmatter 使 `node build.mjs` rc≠0 并指出文件与错误信息，等效满足 Settling 判据
「校验脚本 rc=0 ⇒ 全部可解析」（构建对全部目标文件逐个走到解析，范围 ⊇ `课程/**/*.md`）。
实测：临时喂一个坏 frontmatter 的 md，构建以非零退出码拒绝（试完已删）。
