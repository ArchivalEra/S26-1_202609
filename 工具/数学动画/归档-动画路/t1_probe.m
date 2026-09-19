1;
% ============================================================
%  T1 · 地基实测：中文能否真的画进 PNG
%
%  背景：Octave help 警告 OpenGL 系工具包（fltk 是）"limited support for text
%  ... only ASCII characters ... Any other font will be replaced by Helvetica"
%  （原文针对 eps/ps）。中文能不能进 PNG 决定整个 HUD 怎么写，必须先过。
%
%  本测同时试三件事：
%    A. text 用 fontname='Noto Sans CJK SC' + interpreter='none'
%    B. 用 axes 的 fontname 统一指定（看是否会被单个 text 继承）
%    C. **overlay axes**（T3）是否可行：第二 axes 叠加、不参与主 axes 的镜头
%
%  运行：
%    xvfb-run -a -s "-screen 0 1920x1080x24" octave-cli --no-gui --quiet t1_probe.m
%  产物：/mnt/hdd/工程数学动画/probe/t1_中文.png
% ============================================================

if exist('OCTAVE_VERSION', 'builtin')
  graphics_toolkit('fltk');
end

outdir = getenv('ANIM_OUT');
if isempty(outdir), outdir = '/mnt/hdd/工程数学动画'; end
pdir = fullfile(outdir, 'probe');
if ~exist(pdir, 'dir'), mkdir(pdir); end

CJK = 'Noto Sans CJK SC';   % 本机已装（fonts-noto-cjk 1:20240730，fc-match 真命中）
W = 1920; H = 1080;

fig = figure('visible', 'on', 'position', [0 0 W H], 'color', 'w');

% ── 主 axes：只负责几何，文字一律不放这里（GPT 架构要求）────────────
ax = axes('parent', fig, 'position', [0.05 0.06 0.60 0.88]);
hold(ax, 'on');
set(ax, 'dataaspectratio', [1 1 1], 'xlim', [-3 3], 'ylim', [-3 3], ...
        'xtick', [], 'ytick', [], 'box', 'on', 'layer', 'top');

patch('parent', ax, 'xdata', [0 1 1 0], 'ydata', [0 0 1 1], ...
      'facecolor', [0.87 0.89 0.99], 'edgecolor', [0.66 0.71 0.96], 'linewidth', 2);
patch('parent', ax, 'xdata', [0 2 3 1], 'ydata', [0 0 2 2], ...
      'facecolor', [0.99 0.82 0.55], 'edgecolor', [0.88 0.48 0.06], 'linewidth', 2.6);

% ── overlay axes：整个 figure 铺满，坐标 0..1 ────────────────────────
hud = axes('parent', fig, 'position', [0 0 1 1], ...
           'color', 'none', 'xlim', [0 1], 'ylim', [0 1], ...
           'xtick', [], 'ytick', [], 'xcolor', 'none', 'ycolor', 'none', ...
           'box', 'off', 'handlevisibility', 'off');
hold(hud, 'on');

% 右侧信息栏底板（也是 HUD 的一部分，画在 overlay 里）
patch('parent', hud, 'xdata', [0.70 0.98 0.98 0.70], 'ydata', [0.06 0.06 0.94 0.94], ...
      'facecolor', [0.97 0.97 0.97], 'edgecolor', [0.82 0.82 0.82], 'linewidth', 1.2);

% ── 中文测试文本：逐条标注用的字体设置，便于判断哪条生效 ─────────────
rows = {
  '矩阵作用中',                     CJK,  'none';
  '有向面积 = 3.000',               CJK,  'none';
  '初始状态 / 最终状态',             CJK,  'none';
  'det A(t) = 1.000',               CJK,  'none';
  'ABCDEFGHIJKLM abcdefg 0123456789', CJK, 'none';
};

y = 0.86;
for k = 1:size(rows, 1)
  text('parent', hud, 'units', 'normalized', 'position', [0.86 y], ...
       'string', rows{k,1}, 'fontname', rows{k,2}, 'fontsize', 20, ...
       'interpreter', rows{k,3}, 'horizontalalignment', 'center', ...
       'verticalalignment', 'middle', 'color', [0.1 0.1 0.15]);
  y = y - 0.085;
end

% 标题（中文）与一行 ASCII 对照，方便一眼看出中文有没有变成方块/被替换
text('parent', hud, 'units', 'normalized', 'position', [0.86 0.93], ...
     'string', '中文渲染实测', 'fontname', CJK, 'fontsize', 26, ...
     'fontweight', 'bold', 'interpreter', 'none', ...
     'horizontalalignment', 'center', 'color', [0.1 0.1 0.15]);
text('parent', hud, 'units', 'normalized', 'position', [0.15 0.06], ...
     'string', 'ASCII baseline: The quick brown fox 0123', ...
     'fontname', CJK, 'fontsize', 16, 'interpreter', 'none', ...
     'color', [0.35 0.35 0.40]);

% 字体回退探针：若系统真找不到 CJK 字体，这两个会渲染成同样的样子
text('parent', hud, 'units', 'normalized', 'position', [0.15 0.92], ...
     'string', 'CJK 字体: 矩阵变换 (fontname=Noto Sans CJK SC)', ...
     'fontname', CJK, 'fontsize', 18, 'interpreter', 'none', 'color', [0.2 0.2 0.25]);
text('parent', hud, 'units', 'normalized', 'position', [0.15 0.87], ...
     'string', '对照字体: 矩阵变换 (fontname=Helvetica)', ...
     'fontname', 'Helvetica', 'fontsize', 18, 'interpreter', 'none', 'color', [0.6 0.2 0.2]);

drawnow();

% ── 输出：用 -S 指定像素尺寸（不用 -r DPI）───────────────────────────
f1 = fullfile(pdir, 't1_中文.png');
print(fig, f1, '-dpng', sprintf('-S%d,%d', W, H));

% 再出一张不带 -S 的，用以对比尺寸控制手段
f2 = fullfile(pdir, 't1_无S参数.png');
print(fig, f2, '-dpng', '-r100');

close(fig);

printf('已输出：\n  %s\n  %s\n', f1, f2);
printf('请求尺寸：%dx%d；-r100 那张的尺寸请自行比对（应不同）\n', W, H);
