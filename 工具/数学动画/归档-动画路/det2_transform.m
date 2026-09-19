1;
% ============================================================
%  2x2 矩阵变换教学动画 —— 行列式的几何意义
%  《工程数学基础》第 1 章：单位方格经 M 作用后变成平行四边形，
%  其有向面积 = det M。
%
%  运行（无显示器时必须 xvfb，且虚拟屏幕要够大）：
%    ANIM_OUT=/mnt/hdd/mathanim \
%      xvfb-run -a -s "-screen 0 1920x1080x24" \
%        octave-cli --no-gui --quiet det2_transform.m
%
%  产物：<outdir>/<name>_frames/frame_0001.png ...  + ffmpeg 合成 mp4/gif
%
%  架构（分层，别混）：
%    数学数据层  M, A(t), det        ← 只算数
%    几何层      line/patch           ← 只画几何
%    镜头层      固定 limits/aspect   ← 整段固定，不逐帧重算
%    HUD 文本层  **独立 overlay axes** ← 文字永不参与镜头计算
%    PNG         print -dpng -S宽,高   ← 显式像素尺寸，不用 -r(DPI)
%
%  以下实测结论已固化在代码里（细节见 技术方案与坑清单.md）：
%    - fltk 的 print 要求 figure 可见；headless 靠 xvfb
%    - -S 才严格得到指定像素；-r 是 DPI（默认 150），会差 1 像素
%    - HUD 用 overlay axes 叠加，主 axes 的 xlim/ylim 不受影响（已程序化验证）
%    - 箭头头部必须**固定尺寸**，否则 e2=(0,1) 的头部会侵入单位方格内部，
%      看起来像「方格左上角有个来路不明的小三角」
%    - 含文件内函数的脚本，第一行要写 1; 才会被当成脚本而非函数文件
% ============================================================

function draw_arrow(ax, p, q, col, lw, headLen, headWid)
  % 自己画箭头：quiver 在等比坐标下会按向量长度自动缩放头部，短向量几乎看不见箭头。
  % headLen/headWid 由调用方按 unitScale 固定给出 —— 不要随向量长度变化。
  plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
  d = q - p; L = norm(d);
  if L < 1e-9
    return;
  end
  u = d / L;
  n = [-u(2); u(1)];
  base = q - headLen * u;
  b1 = base + 0.5 * headWid * n;
  b2 = base - 0.5 * headWid * n;
  patch('parent', ax, 'xdata', [q(1) b1(1) b2(1)], ...
        'ydata', [q(2) b1(2) b2(2)], 'facecolor', col, 'edgecolor', col);
end

function draw_grid(ax, A, n, col, lw)
  % 整数网格在 A 作用下的像。注意：网格线可以超出视野，坐标轴会自动裁剪，
  % 不要把它算进镜头范围（否则视野会被撑爆）。
  for i = -n:n
    p = A * [i; -n]; q = A * [i; n];
    plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
    p = A * [-n; i]; q = A * [n; i];
    plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
  end
end

function [Lx, Ly] = fit_limits(ax, W, H, Ms)
  % 镜头：只按**教学内容**（单位方格、它的像、两条基向量）算范围，整段算一次。
  %
  % 为什么整段只算一次：若逐帧按当前 A 重算，镜头会跟着内容缩放，
  % 单位方格永远撑满同一个框 ——「方格被拉伸」这件事就完全看不出来了。
  %
  % 为什么不把网格角点算进来：±n 的网格经 M 映射后会跑很远，视野被撑爆，
  % 单位方格缩成一个小点，整张图看着像空的。
  %
  % 为什么端点就够：A(s) = (1-s)I + sM 的每个顶点都是 s 的线性函数，
  % 线性函数在区间上的极值必在端点取得 ⇒ 只需 s=0（单位方格）与 s=1（M 的像）。
  pts = [];
  for m = 1:numel(Ms)
    A = Ms{m};
    pts = [pts, A * [0 1 1 0; 0 0 1 1]];   % 单位方格的像
    pts = [pts, A * [1;0], A * [0;1]];     % 两条基向量
  end
  pts = [pts, [0;0], [1;0], [0;1]];        % 单位方格与 e1,e2 本身
  need_x = max(max(abs(pts(1, :))) * 1.28, 1.5);
  need_y = max(max(abs(pts(2, :))) * 1.28, 1.5);

  axpos = get(ax, 'position');
  asp = (axpos(3) * W) / (axpos(4) * H);
  if need_x / need_y > asp
    Lx = need_x; Ly = Lx / asp;
  else
    Ly = need_y; Lx = Ly * asp;
  end
end

function out = scalar_text(x)
  % 用于矩阵显示：整数不带小数点
  if abs(x - round(x)) < 1e-12
    out = sprintf('%d', round(x));
  else
    out = sprintf('%.6g', x);
  end
end

function out = det_text(x, tol)
  % 教学显示：小于 tol 的浮点残差显示为 0。
  % 注意：**不修改底层计算值** —— 教材 1.4 节实测过，det 对奇异矩阵会给出
  % ±1e-16 量级的残差（书页 -9.5162e-16 / 本机 +6.6613e-16，连符号都相反），
  % 精确值是 0。显示上归零是教学处理，不是伪造 Octave 的输出。
  if abs(x) < tol
    out = '0';
  elseif abs(x - round(x)) < 1e-12
    out = sprintf('%d', round(x));
  else
    out = sprintf('%.3f', x);
  end
end

function render(outdir, M, opts)
  fps    = opt(opts, 'fps', 30);
  W      = opt(opts, 'width', 1920);
  H      = opt(opts, 'height', 1080);
  n      = opt(opts, 'ngrid', 4);
  name   = opt(opts, 'name', 'det2');
  CJK    = 'Noto Sans CJK SC';   % 本机已装，实测可渲染中文
  tol    = opt(opts, 'det_tol', 1e-10);

  % ─ 时间表（秒）─────────────────────────────────────────────────
  % 显式阶段表，不用「一个 ease 扫完全程」——那样说不清哪段在干什么。
  T_IDLE  = opt(opts, 't_idle',  1.0);   % 停在单位阵，看清方格与基向量
  T_MORPH = opt(opts, 't_morph', 3.0);   % 渐变 I → M（主段）
  T_HOLD  = opt(opts, 't_hold',  1.8);   % 停在 M，读 det
  T_TOTAL = T_IDLE + T_MORPH + T_HOLD;
  N = round(fps * T_TOTAL);
  ease = @(u) (u < 0.5) .* (4*u.^3) + (u >= 0.5) .* (1 - (-2*u + 2).^3 / 2);

  fdir = fullfile(outdir, [name '_frames']);
  if ~exist(fdir, 'dir'), mkdir(fdir); end
  % 清旧帧，避免旧编号混进编码序列
  old = dir(fullfile(fdir, 'frame_*.png'));
  for i = 1:numel(old), unlink(fullfile(fdir, old(i).name)); end

  % ─ 配色 ────────────────────────────────────────────────────────
  c_grid0 = [0.84 0.84 0.88];  c_grid = [0.38 0.45 0.88];
  c_sq0   = [0.87 0.89 0.99];  c_sq   = [0.99 0.82 0.55];
  c_face  = [0.66 0.71 0.96];  c_edge = [0.88 0.48 0.06];
  c_e     = [0.72 0.72 0.76];
  c_v1    = [0.16 0.28 0.82];  c_v2   = [0.84 0.20 0.32];
  c_ax    = [0.55 0.55 0.60];
  c_txt   = [0.12 0.12 0.18];
  c_sub   = [0.35 0.35 0.40];

  fig = figure('visible', 'on', 'position', [0 0 W H], 'color', 'w', ...
               'menubar', 'none', 'toolbar', 'none');

  % ─ 几何层 axes ─────────────────────────────────────────────────
  ax = axes('parent', fig, 'position', [0.05 0.07 0.58 0.86], ...
            'color', 'w', 'box', 'on', 'layer', 'top', ...
            'xtick', [], 'ytick', [], ...
            'xcolor', [0.86 0.86 0.89], 'ycolor', [0.86 0.86 0.89]);
  hold(ax, 'on');
  % 显式锁定等比：否则等比性只是「按坐标框宽高比反推 Lx/Ly」碰巧成立
  set(ax, 'dataaspectratio', [1 1 1]);

  S = [0 1 1 0; 0 0 1 1];          % 单位方格
  unitScale = norm([1;0]);          % 箭头头部尺寸的基准，不随 M 变

  [Lx, Ly] = fit_limits(ax, W, H, {eye(2), M});

  % ─ HUD 文本层：独立 overlay axes，铺满整个 figure，坐标 0..1 ────
  hud = axes('parent', fig, 'position', [0 0 1 1], ...
             'color', 'none', 'xlim', [0 1], 'ylim', [0 1], ...
             'xtick', [], 'ytick', [], 'xcolor', 'none', 'ycolor', 'none', ...
             'box', 'off', 'handlevisibility', 'off');
  hold(hud, 'on');

  % HUD 底板：右侧信息栏（画在 overlay 里，所以不会影响主 axes 镜头）
  patch('parent', hud, 'xdata', [0.655 0.985 0.985 0.655], ...
        'ydata', [0.05 0.05 0.95 0.95], ...
        'facecolor', [0.975 0.975 0.98], 'edgecolor', [0.84 0.84 0.87], ...
        'linewidth', 1.2);

  % 静态 HUD 文本：**创建时**就指定字体（比最后 findobj 全局补不易漏）
  % HUD 文本：**左对齐 + 按字号反推行距**。
  %
  % 为什么不用「凭感觉给 y 间距 + 居中」：上一版就是这么干的，结果
  %   - 30pt 标题只留 0.05 行距 → 压住下面那行
  %   - 居中在 x=0.82 的长行（2.704）超出右边界被切
  %   - 左下角居中在 x=0.06 的长说明句左端跑到负坐标被裁
  % 现在：左边界 x0 固定、行距由字号算出、右边界只用于判断是否需要缩字号。
  HUD_X0 = 0.700;          % 信息栏内文字左边界
  HUD_X1 = 0.975;          % 右边界（用于防溢出）
  pt2line = @(pt) pt * 1.333 * 1.55 / H;   % 字号(pt) → 行距(figure 归一化)

  y = 0.895;
  hud_text(hud, HUD_X0, y, '2×2 矩阵变换', CJK, 30, 'bold', c_txt, 'left');
  y = y - pt2line(30);
  hud_text(hud, HUD_X0, y, sprintf('M = [%s  %s;  %s  %s]', ...
          scalar_text(M(1,1)), scalar_text(M(1,2)), ...
          scalar_text(M(2,1)), scalar_text(M(2,2))), CJK, 20, 'normal', c_txt, 'left');
  y = y - pt2line(20) * 1.35;
  hud_text(hud, HUD_X0, y, '有向面积 = det', CJK, 18, 'normal', c_sub, 'left');
  y = y - pt2line(18) * 1.15;
  h_det = hud_text(hud, HUD_X0, y, '', CJK, 34, 'bold', c_edge, 'left');
  y = y - pt2line(34) * 1.35;
  hud_text(hud, HUD_X0, y, 'A(t) = (1-s)I + sM', CJK, 18, 'normal', c_sub, 'left');
  y = y - pt2line(18) * 1.15;
  hud_text(hud, HUD_X0, y, 's = 0 → 1', CJK, 17, 'normal', [0.5 0.5 0.55], 'left');
  y = y - pt2line(17) * 1.45;
  h_stage = hud_text(hud, HUD_X0, y, '', CJK, 20, 'normal', c_txt, 'left');
  y = y - pt2line(20) * 1.15;
  h_pct = hud_text(hud, HUD_X0, y, '', CJK, 17, 'normal', [0.5 0.5 0.55], 'left');

  % 左下角说明：同样左对齐，从 x=0.03 起，绝不会跑到负坐标
  hud_text(hud, 0.035, 0.035, ...
           '单位方格经 M 作用后变成平行四边形，', CJK, 19, 'normal', c_sub, 'left');
  hud_text(hud, 0.035, 0.035 - pt2line(19), ...
           '其有向面积就是 det M（矩阵行列式）', CJK, 19, 'normal', c_sub, 'left');

  printf('渲染 %d 帧 = %.1fs @ %dfps  (%dx%d)\n', N, T_TOTAL, fps, W, H);
  printf('  静止 %.1fs + 渐变 %.1fs + 收尾 %.1fs\n', T_IDLE, T_MORPH, T_HOLD);
  printf('  镜头范围 Lx=%.2f Ly=%.2f（整段固定）\n', Lx, Ly);
  printf('  det(M) = %s\n', det_text(det(M), tol));

  for k = 1:N
    tnow = (k - 1) / fps;
    if tnow <= T_IDLE
      s = 0; stage = '初始状态：单位方格';
    elseif tnow <= T_IDLE + T_MORPH
      u = (tnow - T_IDLE) / T_MORPH;
      s = ease(u); stage = '矩阵作用中';
    else
      s = 1; stage = '最终状态：平行四边形';
    end
    A = (1 - s) * eye(2) + s * M;
    P = A * S;
    dA = det(A);   % 每帧由实际矩阵算，不硬编码

    % ── 先画几何，**再**设 limits ─────────────────────────────────
    % 顺序很重要：Octave 的高层绘图函数会重置 axes 属性，
    % 若先设 xlim 再 plot，镜头可能被重新自动缩放。
    cla(ax);
    hold(ax, 'on');

    plot(ax, [-Lx Lx], [0 0], '-', 'color', c_ax, 'linewidth', 1.8);
    plot(ax, [0 0], [-Ly Ly], '-', 'color', c_ax, 'linewidth', 1.8);

    draw_grid(ax, eye(2), n, c_grid0, 0.9);
    patch('parent', ax, 'xdata', S(1,:), 'ydata', S(2,:), ...
          'facecolor', c_sq0, 'edgecolor', c_face, 'linewidth', 2.0);
    draw_grid(ax, A, n, c_grid, 1.5);
    patch('parent', ax, 'xdata', P(1,:), 'ydata', P(2,:), ...
          'facecolor', c_sq, 'edgecolor', c_edge, 'linewidth', 3.0);

    % 箭头头部固定尺寸（按 unitScale），不随向量长度变化
    hl = 0.18 * unitScale;  hw = 0.10 * unitScale;
    draw_arrow(ax, [0;0], [1;0], c_e, 1.8, hl, hw);
    draw_arrow(ax, [0;0], [0;1], c_e, 1.8, hl, hw);
    draw_arrow(ax, [0;0], A(:,1), c_v1, 3.4, hl, hw);
    draw_arrow(ax, [0;0], A(:,2), c_v2, 3.4, hl, hw);

    % 几何层不放文字：向量标签也移到 HUD 层（用数据坐标换算到 0..1）。
    %
    % 标签偏移必须**沿各自方向分开**：上一版把 e1 和 e2 都往右上偏移，两个标签
    % 几乎重合、叠死读不出来。现在沿自身方向 + 法向分开，法向符号按序号取反。
    for c = 1:2
      v = A(:,c);
      Lv = norm(v); if Lv < 1e-9, Lv = 1; end
      uu = v / Lv; nn = [-uu(2) uu(1)];
      off = 0.34 * uu + 0.20 * nn * (2*c - 3);   % c=1 偏一侧，c=2 偏另一侧
      xy = data_to_hud(ax, fig, v + off);
      col = c_v1; if c == 2, col = c_v2; end
      delete_if_exists(sprintf('veclabel%d', c));
      if ~isempty(xy)
        text('parent', hud, 'units', 'normalized', 'position', xy, ...
             'string', sprintf('Me%d', c), 'fontname', CJK, 'fontsize', 20, ...
             'fontweight', 'bold', 'interpreter', 'none', 'color', col, ...
             'horizontalalignment', 'center', 'tag', sprintf('veclabel%d', c));
      end
    end
    % 原始基向量标签：e1 往右下偏、e2 往左上偏，方向不同才不会叠
    for c = 1:2
      e = [0;0]; e(c) = 1;
      if c == 1, off = [0.20; -0.26]; else, off = [-0.28; 0.22]; end
      xy = data_to_hud(ax, fig, e + off);
      delete_if_exists(sprintf('elabel%d', c));
      if ~isempty(xy)
        text('parent', hud, 'units', 'normalized', 'position', xy, ...
             'string', sprintf('e%d', c), 'fontname', CJK, 'fontsize', 17, ...
             'interpreter', 'none', 'color', c_sub, ...
             'horizontalalignment', 'center', 'tag', sprintf('elabel%d', c));
      end
    end

    % ── 镜头：**每帧都重新锁一次**（防止任何对象触发自动缩放）────
    xlim(ax, [-Lx Lx]); ylim(ax, [-Ly Ly]);
    axis(ax, 'manual');
    set(ax, 'dataaspectratio', [1 1 1]);

    % ── HUD 数值（只 set string，不重建对象）──────────────────────
    set(h_det, 'string', sprintf('det A(t) = %s', det_text(dA, tol)));
    set(h_stage, 'string', stage);
    set(h_pct, 'string', sprintf('已完成 %.0f%%', 100*s));

    drawnow();   % 确保渲染提交后再 print（3D 尤其重要，2D 也保险）

    print(fig, fullfile(fdir, sprintf('frame_%04d.png', k)), ...
          '-dpng', sprintf('-S%d,%d', W, H));

    if mod(k, 15) == 0 || k == N
      printf('  帧 %d / %d  (t=%.2fs, s=%.2f)\n', k, N, tnow, s); fflush(stdout);
    end
  end
  printf('  → 关闭 figure…\n'); fflush(stdout);
  close(fig);
  printf('  → figure 已关闭\n'); fflush(stdout);
  printf('完成：%d 帧 → %s\n', N, fdir);
end

function h = hud_text(hud, x, y, str, font, size, weight, col, align)
  if nargin < 9, align = 'center'; end
  h = text('parent', hud, 'units', 'normalized', 'position', [x y], ...
           'string', str, 'fontname', font, 'fontsize', size, ...
           'fontweight', weight, 'interpreter', 'none', ...
           'horizontalalignment', align, 'verticalalignment', 'middle', ...
           'color', col);
end

function xy = data_to_hud(ax, fig, pt)
  % 把主 axes 的数据坐标换算成 overlay axes 的 0..1 归一化坐标，
  % 这样文字可以「跟着几何走」却又完全不参与主 axes 的镜头计算。
  xy = [];
  try
    axpos = get(ax, 'position');          % [left bottom width height]（figure 归一化）
    xl = xlim(ax); yl = ylim(ax);
    if xl(2) == xl(1) || yl(2) == yl(1), return; end
    fx = (pt(1) - xl(1)) / (xl(2) - xl(1));   % 在 axes 内的 0..1
    fy = (pt(2) - yl(1)) / (yl(2) - yl(1));
    xy = [axpos(1) + fx * axpos(3), axpos(2) + fy * axpos(4)];
    % 落在 figure 之外就不画（避免标签被边缘裁成半个字）
    if xy(1) < 0.01 || xy(1) > 0.99 || xy(2) < 0.01 || xy(2) > 0.99
      xy = [];
    end
  catch
    xy = [];
  end
end

function delete_if_exists(tag)
  h = findobj('tag', tag);
  if ~isempty(h), delete(h); end
end

function v = opt(s, f, d)
  if isfield(s, f), v = getfield(s, f); else v = d; end
end

if exist('OCTAVE_VERSION', 'builtin')
  graphics_toolkit('fltk');
end

% ── 驱动 ────────────────────────────────────────────────────────────
outdir = getenv('ANIM_OUT');
if isempty(outdir), outdir = '/mnt/hdd/mathanim'; end
if ~exist(outdir, 'dir'), mkdir(outdir); end

if ~isempty(getenv('ANIM_SMOKE'))
  % 烟测：4 帧跨过渐变段，看得到方格被拉成平行四边形的过程
  render(outdir, [2 1; 1 2], struct('name', 'smoke', 'fps', 30, ...
         't_idle', 0.0, 't_morph', 0.1, 't_hold', 0.0));
else
  render(outdir, [2 1; 1 2], struct('name', 'det2', 'fps', 30));
end
