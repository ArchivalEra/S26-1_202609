"""zcode-reflect —— 让 agent 的每句「现在如此」都能被复跑证明。"""

__version__ = "0.1.0"

# 新版 registry 的 `suite_file_without_declaration` 判据要求套件目录里每个
# .py 都有 `MODULE =` 或 `GATE =` 声明（declares_itself）；包标记文件不是
# 闸门也不是平台模块，用 MODULE 显式声明「这是套件自己的文件」。
from gate import module_meta  # noqa: E402
MODULE = module_meta("suite", "zreflect 包标记（版本号 + 套件身份）", selftest=False)
