import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ELEC_FIGS = path.join(ROOT, '课程总览/电子技术/作业/figures');

test('figures.mjs 已退役，电子技术静态 SVG 完整在位', () => {
  const svgs = fs.readdirSync(ELEC_FIGS).filter((f) => f.endsWith('.svg'));
  assert.ok(svgs.length >= 23);
  for (const f of svgs) {
    assert.ok(fs.readFileSync(path.join(ELEC_FIGS, f), 'utf8').includes('<svg'));
  }
});
