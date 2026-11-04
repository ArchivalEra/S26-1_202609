---
name: adversarial-writing-autonomous
description: >-
  Concision and reader-facing checks for writing-class pages (unattended).
  Write short and exact: conclusion first, drop packaging, merge repeats,
  link out, and never drop numbers, conditions, negations, scope, or attribution.
  Use for exam-prep pages, Walkthroughs, course-index summaries, README
  fragments, issue bodies. Invoke on "咕噜话" "太长" "压一压".
  Solution steps and page skeletons go to `solution-production`;
  aesthetic judgement and baseline confirmation go to
  `adversarial-essay-sparring` (needs a human).
---

# Concision and reader-facing writing (unattended)

**The baseline is not asked for**: who the reader is, how deep to write, and which phrasings are banned are already pinned in this repo's sources of truth.
Read them before writing; do not restate them and do not invent new criteria here.

**This skill judges concision and reader-facing value, not taste.** It guarantees that after reading, the reader knows one more concrete fact — and that nothing was dropped on the way.
It does not judge whether a sentence sounds good. That needs a human.

## Sources of truth (the baseline lives there, not here)

| Question | Read |
| :--- | :--- |
| Who is the reader, what is this repo | `维护条例.md` §1 (仓库定位与读者) |
| Which phrasings are banned | `维护条例.md` §2 (真实性与溯源); the word blacklist in `human-first-solution` |
| One fact lives in one place | `维护条例.md` §2 item 4 (不重复维护) |
| Page skeleton | the matching file under `模板/`, plus the target page's existing shape |

**First step of every run**: read those four places, then write. Writing before reading means the baseline was a guess, and the work comes back.

---

## 1. Before writing: lock what the reader takes away

Readers of writing-class pages are **looking things up**: they arrive with one concrete question and want one usable criterion.

1. **Write the one fact the reader takes away** — one sentence containing something concrete (a number, a condition, an action, a criterion).
If you cannot write it, the page has no clear purpose: stop and ask rather than forcing prose.
2. **Fix the skeleton**: follow `模板/` and the target page's existing shape. **Do not move the skeleton or change the genre** — this skill works only at the sentence and paragraph level.
3. **List the material**: list every relevant fact you have in hand. **This list is the ledger for the fidelity test in step 3** — check it item by item later.

**Done when**: every item on the list is a reproducible fact, criterion, or action — no atmosphere, no musing.

## 2. Writing: density comes from repacking, not from deleting words

Most of the compression comes from **repacking**, not from trimming words. Work in this order:

| Move | What it does | Test |
| :--- | :--- | :--- |
| **Conclusion first** | Give the criterion or answer, then the reason | Does the opening stand alone: does a reader who stops there get the fact? |
| **Tabulate parallel items** | Three or more parallel pieces of information become a table or list | No parallel information left as prose |
| **Compress a case to one sentence** | Who + what they did + the key number | No case runs longer than one sentence |
| **Compress a derivation to its criterion** | Keep only the entry criterion and the branch points; link the middle steps out | Middle steps are reachable by anchor, not repeated |
| **Use the term directly** | Jargon the reader must know is used as-is, with an anchor | No unexplained term in use; no term in use without definition |
| **Link, do not repeat** | The same content is not written out in two places | Each fact appears at most once in the page; a second mention is a link |

**Done when**: all six moves hold, and every item on the material list has a landing place in the text.

## 3. After writing: three tests, each mechanically executable

### 3.1 Delete-sentence test (sentence by sentence)

Delete this sentence — **what concrete thing does the reader stop knowing**? If you cannot name it, delete the sentence.

### 3.2 Restate test (paragraph by paragraph)

After reading this paragraph, can you restate one fact, criterion, or action? If not, rewrite or delete it.

### 3.3 Fidelity test (item by item, never skipped)

Before compressing, copy down these seven — **numbers · proper nouns · conditions · negations · scope · time · who said it** — and check each one after compressing. A missing item goes back in.

**"Who said it" is the item this repo mixes up most**: teacher speaking / textbook text / student handwriting / the editor's inference.
**The four must not be mixed.** A student's draft is not the answer; the editor's inference must not be written as textbook text.

**Judge sentence by sentence, not by scanning the page.** The words "textbook" and "teacher" appearing in the same paragraph is normal — a page will quote both.
A page-wide scan cannot tell who said what. For **each sentence carrying attribution, decide its subject**:

| The subject is | Write it as | Test |
| :--- | :--- | :--- |
| Textbook / the book | "Textbook p42: …" | Carries a page or book reference, and carries **no** of the teacher's spoken phrasing |
| Teacher | "The teacher said in class …" | Traceable to the class notes; **not** written as "the textbook says" |
| Student handwriting | "Student draft …" | Marked as draft; **not** adopted as the answer |
| Editor | "I read it as …", or no attribution at all | Not written as textbook text or the teacher's words |

**Two sources in one sentence = red**: a sentence that holds the teacher's wording, the textbook's wording, and an attribution must be split.

**Done when**: all seven items checked and restored where missing.
Every attributed sentence has exactly one subject.
The delete-sentence and restate tests have run sentence by sentence and paragraph by paragraph.

## 4. Four red lines (a hit means rework, not "close enough")

1. **Zero unfinished wording**: no "待核对 / 待补 / 待办"-style statements on the page.
Unfinished work is filed as a GitHub issue (`维护条例.md` §2 item 1). — **This is not "writing conservatively"; it is the work being unfinished.**
2. **No guessing**: values, subscripts, slips of the tongue, missing blackboard work are never guessed.
3. **Word blacklist at zero**: a full-text search for "巧妙 / 显然 / 容易看出 / 注意到 / 试探 / 凑 / 一眼" returns 0. A hit means rewriting that step per the template in `human-first-solution`.
4. **One fact, one home**: when the same content appears in both body and index, or in two pages, delete the duplicate and keep the link.

**Done when**: all four checked and the hits fixed.

## 5. Ablation: try deleting every paragraph and the title

When the draft is done, run the **ablation test** over the body, paragraph by paragraph: if this paragraph goes, does the structural chain break?

- **Breaks** → the paragraph stays.
- **Doesn't break** → delete it. **Material the user supplied goes the same way** — material is raw stock, not a finished product.

Then test the title: if the opening paragraphs are removed, does the title still hold? If it does, the title binds nothing — write one that binds every section.

**Ablation's boundary**: this layer only (paragraphs, titles, whole sections). Do not descend to the sentence level — sentence-level取舍 is the delete-sentence test in step 3.1.

**Done when**: every paragraph's fate has a stated reason, and the title binds every section.

## 6. Gate (red / green)

After the five steps above, judge each line:

| Gate | Green when | If red |
| :--- | :--- | :--- |
| **Baseline read** | All four sources read; reader, depth, and banned phrasings settled | Read them, then rewrite |
| **That one fact exists** | Can say in one sentence what the reader takes away | Stop and ask |
| **Delete-sentence test** | Deleting any sentence loses something concrete | Delete or rewrite |
| **Restate test** | Every paragraph restates a fact, criterion, or action | Rewrite or delete |
| **Fidelity test** | None of the seven items missing | Put the missing ones back |
| **Sources not mixed** | Every attributed sentence has one subject; no sentence mixes sources | Split the sentence or fix the attribution |
| **Four red lines** | Zero unfinished wording / no guessing / blacklist at zero / no duplicates | Fix each hit |
| **Ablation** | Every paragraph's fate is justified; title binds every section | Delete the paragraph or rewrite the title |
| **Anchors valid** | Every link opens and actually covers what it is cited for | Fix the anchor |

**All green before it lands.** One red line means this draft is not finished.

---

## Division of labour with the other skills

| Job | Which skill |
| :--- | :--- |
| Sentence- and paragraph-level concision, reader-facing value (**this skill**) | `adversarial-writing-autonomous` |
| Aesthetic judgement, baseline confirmation, personal narrative | `adversarial-essay-sparring` (**requires a human present**) |
| Solution steps, derivations, calculations | `solution-production` + human-first + double-sign + triple-sign |
| Page intake (indexes, whitelist, commit) | `repo-maintenance` |

**This skill does not replace the three gates.**
The three gates (human-first → double-sign → triple-sign) already run in independent
subagents and are already unattended.
This skill covers the **expression layer** they do not reach.

**This skill does not guarantee taste.** "Does this read like a human" and "should this metaphor stay" need a person.
What this skill guarantees is that after reading, the reader knows one more concrete fact and has lost none.

## Boundaries

- **Do not move the skeleton**: page structure follows `模板/` and the existing shape; this skill works only at the sentence and paragraph level.
- **Do not change values**: any numerical problem met here goes to `solution-production` or double-sign; do not fix it in passing.
- **Do not write outward-facing material beyond issue bodies**: external narrative and personal writing go to `adversarial-essay-sparring`.
