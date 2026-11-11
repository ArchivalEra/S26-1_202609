# 106 交付：通用电气 batch4 八张概念图

接 103 委托、按 104/105 口径执行，八张全部完成并交付。

## 交付位置与 md5

目录：`/mnt/hdd/kimicode-projects/multisim-mcp/deliverables/figures-batch4/`

| 文件 | 内容 | md5 |
| --- | --- | --- |
| fig-ge-01.png | 三种脸（波形/旋转箭头/相量） | f7e9242ab477b8ace86ac7fde3ad1d29 |
| fig-ge-02.png | 相量加减首尾相接 | 06886869210585c062a55305cec6d943 |
| fig-ge-03.png | RLC 相量伏安 | aec951af89f747e2541aacbc5f6a2de6 |
| fig-ge-04.png | 阻抗三角形 | 7eec2a1bc486cf2333decdfa7bf75889 |
| fig-ge-05.png | 三相对称分量 | 70f18e7261568dba1e85e42c9224705d |
| fig-ge-06.png | 三次谐波同相位 | 5d1616c1ec0bc1824b0a6de88adc74df |
| fig-ge-07.png | 555 RC 充电（暂缓入库） | 3ed998ae38090461d755800aa52f82e2 |
| fig-ge-08.png | 共射直交流分离 | f48af0cc437c1518e35fe0d1c9d8076d |

## 执行 104/105 口径的情况

- 图内文字全中文，只保留变量符号与单位（u i t ω φ Z R X Re Im V A Ω）；度数一律 °，无 deg 残留。
- fig-ge-02 用页面算例 U1=3+j4、U2=3−j4：和 6+j0 落 Re 正轴（平行四边形补边），差 0+j8 竖直向上（−U2 指左上，「首尾相接」标注，不写「同向」）。
- fig-ge-03 拆成「I 滞后 U 90°」「I 超前 U 90°」两个 text 节点。
- fig-ge-01：峰值高度对应虚线从波形峰值 (T/4, 311) 起贯穿中栏圆顶直到右栏相量端点，三处同一水平线；旋转箭头画在实轴正半轴标 t=0，与波形初相一致。
- fig-ge-05：正序 A→B→C 顺时针、负序逆时针，标注与箭头几何一致；零序三支平行同向。
- fig-ge-08：三极管/电阻/电容/受控源全部取自 schemdraw 标准符号库，无手搓图形；左栏标准竖直 NPN；右栏输入顶轨止于 rbe，B、C 只靠受控源耦合，输出侧 ro 与交流接地的 Rc 并联，ri 测量区间与 Ib 方向已标出。
- fig-ge-07（555）按你的更正暂不入库，文件留在 batch4，需要时直接取用。

## 机检证据

全部 8 张通过三条判据（判据脚本在 deliverables/figures-src/）：

- collide3.py --all → crossed_texts=0（零文字压线，墨迹差分法）
- overlaptext.py --all → overlaps=0（零文字互压，包围盒相交法）
- whiten.py --check → 8 张全部不透明白底 RGB，无 alpha

另由独立读图代理逐张复核工程规范性与中文完整性（器件形状、箭头方向、标签可读）。

有打回请逐张报文件名与位置，我按单张修。

## 环境说明（防复发）

本轮 /tmp 被清理导致 figvenv 丢失一次，已在 /mnt/hdd/figvenv 重建并软链 /tmp/figvenv，路径不变。
