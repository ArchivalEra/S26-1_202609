% 教材《工程数学基础》1.4 与 2.5 节 MATLAB 输出的复现与自检
%
% 用法：octave-cli --no-gui --quiet 工程数学MATLAB复现.m
%
% 说明：
% - 期望值抄自原书 p20–p21（1.4 节）与 p46–p51（2.5 节），逐条内嵌。
% - 少数条目原书输出**不可复现**（随机数、奇异矩阵求逆、浮点残差），
%   脚本会把它们单列为「实现相关」，不当成失败。
% - 本脚本不修改任何仓库内容，只打印比对结果。

1;

function ok = approx(a, b, tol)
  ok = all(abs(double(a(:)) - double(b(:))) <= tol);
end

function report(name, pass, want, got)
  if pass
    printf('  PASS  %-26s\n', name);
  else
    printf('  FAIL  %-26s  书上: %s   实得: %s\n', name, want, got);
  end
end

function report_impl(name, want, got, why)
  printf('  实现相关  %-22s  书上: %-14s 实得: %-14s (%s)\n', name, want, got, why);
end

printf('复现环境：%s\n', version);
printf('\n');
printf('══ 1.4 用 MATLAB 计算行列式（原书 p20–p21）══\n');

% 例 1.18 书上 D = -32
D = det([1 -2 4;-5 2 0;1 0 3]);
report('例1.18  det', approx(D, -32, 1e-12), '-32', sprintf('%g', D));

% 例 1.19 书上 D = -48。注意 det 是浮点计算：本机实得 -48 减去约 7.1e-15
% （差 1 个 ULP），书上的 "-48" 是显示层四舍五入的结果，不是精确整数。
A19 = [1 2 3 2;1 2 0 -5;1 0 1 2;4 3 1 2];
D = det(A19);
report('例1.19  det（显示值）', approx(D, -48, 1e-12), '-48', sprintf('%g', D));
printf('  └─ 浮点细节：det - (-48) = %.3e  （精确值就是 -48，浮点差 1 ULP）\n', D + 48);

% 例 1.20 书上 D = -9.5162e-16；精确值 0（r3 = 2*r2 - r1）
M20 = [1 2 3;4 5 6;7 8 9];
D = det(M20);
report_impl('例1.20  det 浮点残差', '-9.5162e-16', sprintf('%.4e', D), ...
            '取决于 LU 分解/BLAS 实现，连符号都可能相反');
report('例1.20  精确值为 0', approx(M20(3,:) - (2*M20(2,:) - M20(1,:)), 0, 0), '[0 0 0]', ...
       mat2str(M20(3,:) - (2*M20(2,:) - M20(1,:))));
report('例1.20  rank', rank(M20) == 2, '2', sprintf('%d', rank(M20)));

printf('\n══ 2.5 用 MATLAB 进行矩阵运算（原书 p46–p51）══\n');

% 例 2.16
A = [3 5 9;9 10 1;7 9 4;3 8 7];
report('例2.16  A 直接输入', approx(A, [3 5 9;9 10 1;7 9 4;3 8 7], 0), '4x3 原样', 'ok');
B = [sin(pi/3),cos(pi/4);log(3),tanh(5)];
report('例2.16  B 含函数', approx(B, [0.8660 0.7071;1.0986 0.9999], 5e-5), ...
       '0.8660/0.7071/1.0986/0.9999', mat2str(B, 5));

% 例 2.17
report('例2.17  zeros(3,4)', approx(zeros(3,4), zeros(3,4), 0), '3x4 全零', 'ok');
report('例2.17  ones(3)', approx(ones(3), ones(3), 0), '3x3 全一', 'ok');
report('例2.17  eye(4)', approx(eye(4), eye(4), 0), '4x4 单位', 'ok');
report('例2.17  magic(3)', approx(magic(3), [8 1 6;3 5 7;4 9 2], 0), '[8 1 6;3 5 7;4 9 2]', mat2str(magic(3)));
report('例2.17  diag(magic(3))', approx(diag(magic(3)), [8;5;2], 0), '[8;5;2]', mat2str(diag(magic(3))));
R = rand(2,3);
report_impl('例2.17  rand(2,3)', '0.8147 0.1270 …', sprintf('%.4f …', R(1,1)), ...
            '取决于随机数发生器与种子，MATLAB 默认种子值在 Octave 下取不到');

% 例 2.18
A = [1 2 3;4 5 6;7 8 9]; B = [1 3 5;7 9 11;13 15 17];
report('例2.18  B-A', approx(B - A, [0 1 2;3 4 5;6 7 8], 0), '[0 1 2;3 4 5;6 7 8]', mat2str(B - A));
report('例2.18  B+A', approx(B + A, [2 5 8;11 14 17;20 23 26], 0), '[2 5 8;11 14 17;20 23 26]', mat2str(B + A));

% 例 2.19
report('例2.19  A*B', approx(A * B, [54 66 78;117 147 177;180 228 276], 0), ...
       '[54 66 78;117 147 177;180 228 276]', mat2str(A * B));
report('例2.19  A*60', approx(A * 60, [60 120 180;240 300 360;420 480 540], 0), ...
       '60 的倍数', mat2str(A * 60));

% 例 2.20 左除
A = [1 2 3;4 5 6;7 8 10];
B = [54 66 75;117 147 171;193 243 283];
report('例2.20  A\\B', approx(A \ B, [1 3 5;7 9 11;13 15 16], 1e-9), ...
       '[1 3 5;7 9 11;13 15 16]', mat2str(A \ B, 5));

% 例 2.21 右除
A = [54 66 75;117 147 171;193 243 283];
B = [1 3 5;7 9 11;13 15 16];
report('例2.21  A/B', approx(A / B, [1 2 3;4 5 6;7 8 10], 1e-9), ...
       '[1 2 3;4 5 6;7 8 10]', mat2str(A / B, 5));

% 例 2.22 逆
report('例2.22  inv([1,2;3,4])', approx(inv([1,2;3,4]), [-2 1;1.5 -0.5], 1e-9), ...
       '[-2 1;1.5 -0.5]', mat2str(inv([1,2;3,4]), 5));

% 例 2.23 奇异矩阵求逆：书上给了警告 + 1.0e+16 量级的结果
A = [1,2,3;4,5,6;7,8,9];
report_impl('例2.23  rcond', '2.202823e-18', sprintf('%.6e', rcond(A)), ...
            '取决于范数与算法，量级同但数值不同');
Inv = inv(A);
report_impl('例2.23  inv 量级', '1.0e+16 *', sprintf('%.2e', max(abs(Inv(:)))), ...
            '奇异矩阵的逆在数值上无意义，方向对（正比于伴随阵）但尺度任意');
% 方向自检：结果应正比于伴随阵 [-1 2 -1] 的排布
P = reshape(Inv / max(abs(Inv(:))), 3, 3);
report('例2.23  inv 方向 ∝ adj(A)', approx(P, [-1 2 -1;2 -4 2;-1 2 -1] / 4, 0.01), ...
       '比值 1:-2:1', mat2str(P, 3));

% 例 2.24 初等变换求逆
C = rref([1,2,1,0;3,4,0,1]);
report('例2.24  rref', approx(C, [1 0 -2 1;0 1 1.5 -0.5], 1e-9), ...
       '[1 0 -2 1;0 1 1.5 -0.5]', mat2str(C, 5));
report('例2.24  C(:,3:4)', approx(C(:,3:4), [-2 1;1.5 -0.5], 1e-9), ...
       '[-2 1;1.5 -0.5]', mat2str(C(:,3:4), 5));

% 例 2.25 秩
report('例2.25  rank(2x3)', rank([1 2 3;4 5 6]) == 2, '2', sprintf('%d', rank([1 2 3;4 5 6])));
report('例2.25  rank(3x3)', rank([1 2 3;4 5 6;7 8 9]) == 2, '2', sprintf('%d', rank([1 2 3;4 5 6;7 8 9])));

printf('\n完成。PASS 表示与书上输出一致；「实现相关」表示原书数值取决于\n');
printf('MATLAB 版本/随机种子/浮点实现，本机无法也不应逐字复现。\n');