% ratfmt(M, tol) —— 把数值矩阵按精确分数打印（Octave 双精度 → 有理数逼近）
%
% 用途：双签验算时核对含分数的答案（求逆、解方程、代数余子式）。
% Octave 默认只打印浮点（-6.5 而不是 -13/2），直接比对会漏掉「分数对不对」。
% 做法：用内置 rat() 求有理逼近 [N,D]（D 是公共分母），再打印 N/D。
% tol 是逼近容差（默认 1e-10）；整数矩阵用 1e-12 更稳。
%
% 用法：
%   A=[1 2 -1;3 4 -2;5 -4 1];
%   ratfmt(inv(A))          % → -2  1  0 ; -13/2  3  -1/2 ; -16  7  -1
%
% 注意（skill 里也写了）：Octave 是双精度浮点，整数超过 2^53 就失精，
% 大整数/精确分数矩阵请回 Python 的 fractions.Fraction，别用本函数。

function ratfmt(M, tol)
  if nargin < 2, tol = 1e-10; end
  [N, D] = rat(M, tol);
  D = round(D);
  [r, c] = size(M);
  for i = 1:r
    cells = cell(1, c);
    for j = 1:c
      n = round(N(i, j)); d = D(i, j);
      if d == 1
        cells{j} = sprintf("%8d", n);
      else
        cells{j} = sprintf("%8s", sprintf("%d/%d", n, d));
      end
    end
    printf("%s\n", strjoin(cells, ""));
  end
end
