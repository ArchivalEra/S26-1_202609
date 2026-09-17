---
id: okf.math.algebra.group_axioms
name: Group Axioms and Fundamental Algebraic Structures
type: Concept
status: active
spec_version: "0.2"
last_updated: "2026-09-17"
stewards:
  - team: Mathematics Research & Knowledge Architecture Team
tags:
  - abstract-algebra
  - group-theory
  - algebraic-structures
sources:
  - title: "Abstract Algebra"
    authors: "Dummit, David S.; Foote, Richard M."
    year: 2004
    type: academic_book
    citation: "John Wiley & Sons, 3rd Edition, ISBN 978-0471433347"
  - title: "Algebra"
    authors: "Lang, Serge"
    year: 2002
    type: academic_book
    citation: "Springer Graduate Texts in Mathematics, Vol. 211, ISBN 978-0387953854"
verified: true
links:
  related: []
---

# Group Axioms and Fundamental Algebraic Structures

## 1. Formal Definition

Let $G$ be a non-empty set equipped with a binary operation $\cdot : G \times G \to G$. The algebraic structure $(G, \cdot)$ is called a **Group** if it satisfies the following axioms:

1. **Associativity**:
   For all $a, b, c \in G$:
   $$(a \cdot b) \cdot c = a \cdot (b \cdot c)$$

2. **Identity Element**:
   There exists an element $e \in G$ such that for every $a \in G$:
   $$e \cdot a = a \cdot e = a$$

3. **Inverse Element**:
   For each $a \in G$, there exists an element $b \in G$ (denoted by $a^{-1}$) such that:
   $$a \cdot b = b \cdot a = e$$

If $(G, \cdot)$ additionally satisfies commutativity ($a \cdot b = b \cdot a$ for all $a, b \in G$), $G$ is called an **Abelian Group**.

## 2. Elementary Properties

The following properties follow directly from the group axioms:
- **Uniqueness of Identity**: If $e, e' \in G$ are identities, then $e = e \cdot e' = e'$.
- **Uniqueness of Inverses**: For any $a \in G$, its inverse $a^{-1}$ is uniquely determined.
- **Cancellation Law**:
  - Left cancellation: $a \cdot b = a \cdot c \implies b = c$
  - Right cancellation: $b \cdot a = c \cdot a \implies b = c$
- **Involution**: $(a^{-1})^{-1} = a$, and $(a \cdot b)^{-1} = b^{-1} \cdot a^{-1}$.

## 3. Canonical Examples

| Group | Underlying Set | Operation | Classification |
| :--- | :--- | :--- | :--- |
| $(\mathbb{Z}, +)$ | Integers | Addition | Infinite cyclic abelian group |
| $(\mathbb{R}^*, \times)$ | Non-zero reals | Multiplication | Abelian group |
| $\mathrm{GL}_n(\mathbb{R})$ | $n \times n$ invertible real matrices | Matrix multiplication | Non-abelian Lie group ($n \ge 2$) |
| $S_n$ | Permutations on $n$ elements | Composition | Finite non-abelian group ($n \ge 3$) |
