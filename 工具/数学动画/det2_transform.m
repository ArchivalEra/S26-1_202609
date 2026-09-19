1;
% ============================================================
%  2x2 矩阵变换动画 —— 行列式的几何意义
%  《工程数学基础》第 1 章：单位方格经 M 作用后变成平行四边形，
%  其有向面积 = det M。
%
%  用法（无显示器时靠 xvfb 提供虚拟 X）：
%    ANIM_OUT=/mnt/hdd/工程数学动画 xvfb-run -a octave-cli --no-gui --quiet det2_transform.m
%
%  版面原则（第一版在这里翻过车）：坐标范围必须由**内容包围盒反推**，
%  凭感觉给常数会把平行四边形裁到画面外。
%  文字必须先铺白底，否则网格线横穿文字像删除线。
% ============================================================

function draw_arrow(ax, p, q, col, lw)
  plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
  d = q - p; L = norm(d);
  if L < 1e-9, return; end
  u = d / L;
  hl = min(0.42, 0.16 + 0.07 * L);   % 短向量也要看得见箭头
  hw = 0.62 * hl;
  n = [-u(2) u(1)];
  b1 = q - hl * u + hw * n;
  b2 = q - hl * u - hw * n;
  patch('parent', ax, 'xdata', [q(1) b1(1) b2(1)], 'ydata', [q(2) b1(2) b2(2)], ...
        'facecolor', col, 'edgecolor', col);
end

function draw_grid(ax, A, n, col, lw)
  for i = -n:n
    p = A * [i; -n]; q = A * [i; n];
    plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
    p = A * [-n; i]; q = A * [n; i];
    plot(ax, [p(1) q(1)], [p(2) q(2)], '-', 'color', col, 'linewidth', lw);
  end
end

function [Lx, Ly] = fit_limits(ax, W, H, Ms, n)
  % 坐标范围只按**教学内容**算：单位方格、平行四边形、基向量。
  %
  % 曾经把「变换后网格的全部角点」也算进来，结果 ±4 的网格经 M=[2 1;1 2]
  % 映射到 ±12，视野被撑到 Lx=16.7，单位方格缩成一个小点，
  % 整张图看着就是「什么都没画出来」。
  % 网格线超出视野没关系——坐标轴会自动裁剪，不需要为它们留地方。
  pts = [];
  for m = 1:numel(Ms)
    A = Ms{m};
    pts = [pts, A * [0 1 1 0; 0 0 1 1]];   % 单位方格的像
    pts = [pts, A * [1;0], A * [0;1]];     % 两条基向量
  end
  pts = [pts, [0;0], [1;0], [0;1]];        % 单位方格与 e1,e2 本身
  need_x = max(max(abs(pts(1, :))) * 1.28, 1.5);   % 28% 边距，给标签留地方
  need_y = max(max(abs(pts(2, :))) * 1.28, 1.5);
  axpos = get(ax, 'position');
  asp = (axpos(3) * W) / (axpos(4) * H);
  if need_x / need_y > asp
    Lx = need_x; Ly = Lx / asp;
  else
    Ly = need_y; Lx = Ly * asp;
  end
end

function render(outdir, M, opts)
  fps   = opt(opts, 'fps', 30);
  W     = opt(opts, 'width', 820);
  H     = opt(opts, 'height', 660);
  dpi   = opt(opts, 'dpi', 100);
  n     = opt(opts, 'ngrid', 4);
  name  = opt(opts, 'name', 'det2');

  % ─ 时间表（秒）────────────────────────────────────────────────
  % 原来是「一个 ease 从头扫到尾」，太快也说不清哪段在干什么。
  % 现在拆成显式阶段：先让学生看清单位方格，再渐变，最后停住读 det。
  T_IDLE  = opt(opts, 't_idle',  1.0);   % 停在单位阵，看清方格与基向量
  T_MORPH = opt(opts, 't_morph', 3.0);   % 渐变 I → M（这是主段）
  T_HOLD  = opt(opts, 't_hold',  1.8);   % 停在 M，读 det
  T_TOTAL = T_IDLE + T_MORPH + T_HOLD;

  fdir = fullfile(outdir, [name '_frames']);
  if ~exist(fdir, 'dir'), mkdir(fdir); end
  old = dir(fullfile(fdir, 'f*.png'));
  for i = 1:numel(old), unlink(fullfile(fdir, old(i).name)); end

  N = round(fps * T_TOTAL);
  ease = @(u) (u < 0.5) .* (4*u.^3) + (u >= 0.5) .* (1 - (-2*u + 2).^3 / 2);

  c_grid0 = [0.84 0.84 0.88];  c_grid = [0.38 0.45 0.88];
  c_sq0   = [0.87 0.89 0.99];  c_sq   = [0.99 0.82 0.55];
  c_face  = [0.66 0.71 0.96];  c_edge = [0.88 0.48 0.06];
  c_e     = [0.72 0.72 0.76];
  c_v1    = [0.16 0.28 0.82];  c_v2   = [0.84 0.20 0.32];
  c_ax    = [0.55 0.55 0.60];

  fig = figure('visible', 'on', 'position', [0 0 W H], 'color', 'w');
  ax = axes('parent', fig, 'position', [0.04 0.04 0.92 0.92]);
  hold(ax, 'on');
  % dataaspectratio 必须显式锁成 1:1：否则等比性只是「按坐标框宽高比反推
  % Lx/Ly」碰巧成立，一旦坐标框尺寸或 xlim 设置顺序变化，方块就会被拉成长方形。
  set(ax, 'dataaspectratio', [1 1 1], ...
          'xtick', [], 'ytick', [], 'box', 'on', ...
          'xcolor', [0.86 0.86 0.89], 'ycolor', [0.86 0.86 0.89]);

  S = [0 1 1 0; 0 0 1 1];
  total = N;

  % 坐标范围整段固定：按 I 与 M 的最大范围算一次，之后不再变动
  [Lx, Ly] = fit_limits(ax, W, H, {eye(2), M}, n);

  for k = 0:total
    tnow = k / fps;
    % 阶段 → 进度 s
    if tnow <= T_IDLE
      s = 0;
    elseif tnow <= T_IDLE + T_MORPH
      s = ease((tnow - T_IDLE) / T_MORPH);
    else
      s = 1;
    end
    A = (1 - s) * eye(2) + s * M;

    cla(ax);
    xlim(ax, [-Lx Lx]); ylim(ax, [-Ly Ly]);

    plot(ax, [-Lx Lx], [0 0], '-', 'color', c_ax, 'linewidth', 1.6);
    plot(ax, [0 0], [-Ly Ly], '-', 'color', c_ax, 'linewidth', 1.6);

    draw_grid(ax, eye(2), n, c_grid0, 0.9);
    patch('parent', ax, 'xdata', S(1,:), 'ydata', S(2,:), ...
          'facecolor', c_sq0, 'edgecolor', c_face, 'linewidth', 1.8);
    draw_grid(ax, A, n, c_grid, 1.5);

    P = A * S;
    patch('parent', ax, 'xdata', P(1,:), 'ydata', P(2,:), ...
          'facecolor', c_sq, 'edgecolor', c_edge, 'linewidth', 2.6);

    draw_arrow(ax, [0;0], [1;0], c_e, 1.6);
    draw_arrow(ax, [0;0], [0;1], c_e, 1.6);
    draw_arrow(ax, [0;0], A(:,1), c_v1, 3.2);
    draw_arrow(ax, [0;0], A(:,2), c_v2, 3.2);

    for c = 1:2
      v = A(:,c);
      L = norm(v); if L < 1e-9, L = 1; end
      uu = v / L; nn = [-uu(2) uu(1)];
      off = 0.26 * uu + 0.16 * nn * (2*c - 3);
      col = c_v1; if c == 2, col = c_v2; end
      text(ax, v(1) + off(1), v(2) + off(2), sprintf('Me_%d', c), ...
           'color', col, 'fontsize', 12, 'fontweight', 'bold', 'interpreter', 'tex');
    end
    text(ax, 0.16, -0.30, 'e_1', 'color', [0.55 0.55 0.58], 'fontsize', 10);
    text(ax, -0.42, 0.22, 'e_2', 'color', [0.55 0.55 0.58], 'fontsize', 10);

    % 读数底板：先铺白底，否则网格线横穿文字像删除线
    dA = A(1,1)*A(2,2) - A(1,2)*A(2,1);
    bw = 0.66 * 2 * Lx;  bh = 0.20 * 2 * Ly;
    x0 = -Lx + 0.02 * 2 * Lx;  y0 = Ly - 0.02 * 2 * Ly - bh;
    patch('parent', ax, 'xdata', [x0 x0+bw x0+bw x0], ...
          'ydata', [y0 y0 y0+bh y0+bh], ...
          'facecolor', 'w', 'edgecolor', [0.86 0.86 0.89], 'linewidth', 1.0);
    text(ax, x0 + 0.03*bw, y0 + bh*0.66, ...
         sprintf('M(t) = [ %.3f  %.3f ;  %.3f  %.3f ]', A(1,1), A(1,2), A(2,1), A(2,2)), ...
         'fontsize', 13, 'fontweight', 'bold', 'color', [0.12 0.12 0.18], ...
         'interpreter', 'none');
    text(ax, x0 + 0.03*bw, y0 + bh*0.22, ...
         sprintf('det = signed area = %.3f', dA), ...
         'fontsize', 13, 'fontweight', 'bold', 'color', c_edge, 'interpreter', 'none');

    print(fig, fullfile(fdir, sprintf('f%04d.png', k)), '-dpng', sprintf('-r%d', dpi));
    if mod(k, 15) == 0
      printf('  帧 %d / %d  (t=%.2fs, 进度 %.2f)\n', k, total, tnow, s); fflush(stdout);
    end
  end
  close(fig);
  printf('完成：%d 帧 = %.1fs @ %dfps  → %s\n', total + 1, T_TOTAL, fps, fdir);
  printf('  其中：静止 %.1fs + 渐变 %.1fs + 收尾 %.1fs\n', T_IDLE, T_MORPH, T_HOLD);
  printf('  坐标范围：Lx=%.2f  Ly=%.2f（整段固定）\n', Lx, Ly);
end

function v = opt(s, f, d)
  if isfield(s, f), v = getfield(s, f); else v = d; end
end

if exist('OCTAVE_VERSION', 'builtin')
  graphics_toolkit('fltk');
end

% ── 驱动 ────────────────────────────────────────────────────────────
outdir = getenv('ANIM_OUT');
if isempty(outdir), outdir = pwd; end
if ~exist(outdir, 'dir'), mkdir(outdir); end

if ~isempty(getenv('ANIM_SMOKE'))
  % 烟测：4 帧刚好跨过渐变段，能看到方格被拉成平行四边形的过程
  render(outdir, [2 1; 1 2], struct('name', 'smoke', 'fps', 30, ...
         't_idle', 0.0, 't_morph', 0.1, 't_hold', 0.0));
else
  % 正式：静止 1.0s → 渐变 3.0s → 收尾 1.8s，共 5.8s @30fps = 175 帧
  render(outdir, [2 1; 1 2], struct('name', 'det2', 'fps', 30));
end
