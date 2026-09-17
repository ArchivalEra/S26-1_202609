---
id: okf.math.linear_algebra.2026_09_17_determinants_order_2_3
name: Evaluation of 2nd & 3rd Order Determinants, Sarrus' Rule, and Scratchwork Notation Standards
type: Concept
status: active
spec_version: "0.2"
last_updated: "2026-09-17"
date: "2026-09-17"
stewards:
  - team: Math Research & Personal Practice
tags:
  - linear-algebra
  - determinant
  - sarrus-rule
  - cramer-rule
  - notation-standards
---

# Evaluation of 2nd & 3rd Order Determinants, Sarrus' Rule, and Scratchwork Notation Standards (2026-09-17)

## 1. Core Definitions and Expansion Formulas

### 1.1 Second-Order Determinant
For a $2 \times 2$ matrix $A = \begin{pmatrix} a_{11} & a_{12} \\ a_{21} & a_{22} \end{pmatrix}$, its determinant is defined as the product of the main diagonal elements minus the product of the off-diagonal elements:
$$\begin{vmatrix} a_{11} & a_{12} \\ a_{21} & a_{22} \end{vmatrix} = a_{11}a_{22} - a_{12}a_{21}$$

### 1.2 Third-Order Determinant
For a $3 \times 3$ matrix:
$$\begin{vmatrix}
a_{11} & a_{12} & a_{13} \\
a_{21} & a_{22} & a_{23} \\
a_{31} & a_{32} & a_{33}
\end{vmatrix}$$
The full expansion consists of $3! = 6$ terms:
$$D = a_{11}a_{22}a_{33} + a_{12}a_{23}a_{31} + a_{13}a_{21}a_{32} - a_{13}a_{22}a_{31} - a_{12}a_{21}a_{33} - a_{11}a_{23}a_{32}$$

---

## 2. Computational Method: Sarrus' Rule

By appending the first two columns to the right:
$$\begin{array}{ccc|cc}
a_{11} & a_{12} & a_{13} & a_{11} & a_{12} \\
a_{21} & a_{22} & a_{23} & a_{21} & a_{22} \\
a_{31} & a_{32} & a_{33} & a_{31} & a_{32}
\end{array}$$
- **Main diagonal direction (top-left to bottom-right, positive sign)**:
  $+(a_{11}a_{22}a_{33}) + (a_{12}a_{23}a_{31}) + (a_{13}a_{21}a_{32})$
- **Anti-diagonal direction (top-right to bottom-left, negative sign)**:
  $-(a_{13}a_{22}a_{31}) - (a_{11}a_{23}a_{32}) - (a_{12}a_{21}a_{33})$

---

## 3. Scratchwork Notation Standards & Error Correction

In manual calculations, cross-cancellations and nested signs frequently induce compounding mistakes. The following standards are enforced:

### Standard 1: Two-Tier Explicit Expansion (No Unwritten Mental Arithmetic)
- **Anti-Pattern**: Directly writing ad-hoc sums and subtractions with heavy scribbles and crossing out (as observed in manual scribbles for Example 1.3).
- **Prescribed Form**:
  1. Explicitly record the 6 triple-product terms grouped by sign:
     $$D = (\text{Pos}_1 + \text{Pos}_2 + \text{Pos}_3) - [(\text{Neg}_1 + \text{Neg}_2 + \text{Neg}_3)]$$
  2. Compute products and signs separately before performing additions.

### Standard 2: Algebraic Factorization Direct Substitution
- **Scratch Mistake Observed** (Exercise 1.1, Problem 3):
  Expanding $(x-1)(x^2+x+1)$ by erroneous terms such as $(x-1)^2+3x$ resulting in confusion and crossing out.
- **Correction**:
  - Immediately invoke the difference-of-cubes identity $(x-1)(x^2+x+1) \equiv x^3 - 1$.
  - Evaluate directly as:
    $$\begin{vmatrix} x-1 & x^3 \\ 1 & x^2+x+1 \end{vmatrix} = (x-1)(x^2+x+1) - x^3 = (x^3 - 1) - x^3 = -1$$

### Standard 3: Rigorous Trigonometric Notation
- Write complete trigonometric identifiers ($\cos\alpha, \sin\alpha$) in formal derivations rather than abbreviations like $c^2 + s^2$, and explicitly write double negation $- (-\sin^2\alpha)$ to prevent sign slips.

---

## 4. Lecture Examples & Exercises Review (2026-09-17)

### 4.1 Examples Walkthrough
- **Example 1.3**:
  $$D = \begin{vmatrix} 1 & 2 & -4 \\ -2 & 2 & 1 \\ -3 & 4 & -2 \end{vmatrix} = (-4 - 6 + 32) - (24 + 4 + 8) = 22 - 36 = -14$$
- **Example 1.4 (Cramer's Rule)**:
  $$D = -5, \quad D_1 = -5 \implies x_1 = 1, \quad D_2 = -10 \implies x_2 = 2, \quad D_3 = -35 \implies x_3 = 7$$
- **Example 1.5 (Determinant Equation)**:
  $$x^2 - 5x + 6 = 0 \implies (x-2)(x-3) = 0 \implies x = 2 \text{ or } x = 3$$

### 4.2 Exercise 1.1 Review
1. $(1): D = a^2b^2 - a^2b^2 = 0$ (Correct).
2. $(2): D = \cos^2\alpha - (-\sin^2\alpha) = 1$ (Correct).
3. $(3): D = (x^3 - 1) - x^3 = -1$ (Corrected from scratch scribbles).
4. $(4): D = 23 - (-5) = 28$ (Correct).
5. $(5): D = 0$ (Correct).
6. $(6): D = (-3) - (-5) = 2$ (Correct).
