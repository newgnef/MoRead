#!/usr/bin/env node
/**
 * 生成用于压力测试的长 Markdown。
 *
 * 刻意做成混合内容（标题 / 长段落 / 列表 / 代码块 / 表格 / 引用），
 * 因为虚拟滚动最容易翻车的地方恰恰是「不同块的高度差异极大」——
 * 纯段落文档的估高误差很小，测得再好看也不能说明问题。
 *
 * 用法：node tools/make-big-doc.mjs <输出文件> [目标 MB]
 */

import fs from 'node:fs';

const out = process.argv[2];
const targetMB = Number(process.argv[3] ?? 3);

if (!out) {
  console.error('用法：node tools/make-big-doc.mjs <输出文件> [目标 MB]');
  process.exit(2);
}

const SENTENCE =
  '复卷上机逻辑需要按产品代码与规格型号汇总未预留吨数，为 0 则不赋给生产计划单据体，' +
  '这一口径必须与复卷报表保持一致，否则车间看到的数字会相互矛盾。';

const codeOf = (n) => [
  '```java',
  `public class Section${n}Plugin extends AbstractBillPlugin {`,
  '    @Override',
  '    public void afterDoOperation(AfterOperationEventArgs e) {',
  `        log.info("第 ${n} 节：{} 未预留 {} t", productCode, tonnage);`,
  '    }',
  '}',
  '```',
].join('\n');

const limit = targetMB * 1024 * 1024;
const fd = fs.openSync(out, 'w');

let n = 0;
let bytes = 0;

const head = [
  '# 大文档压力测试',
  '',
  '这个文件由 `tools/make-big-doc.mjs` 生成，用于验证长文档虚拟滚动。',
  '它包含大量标题、长段落、列表、代码块与表格，块高度差异明显。',
  '',
  '## 阅读提示',
  '',
  '正文只渲染视口附近的块，左侧大纲可以跳转到任意一节。',
  '',
].join('\n');

fs.writeSync(fd, head);
bytes += Buffer.byteLength(head);

while (bytes < limit) {
  n++;
  const grammage = 100 + (n % 50);
  const tonnage = ((n % 37) * 1.25).toFixed(2);

  const chunk = [
    `## 第 ${n} 节 · 生产计划汇总`,
    '',
    `${SENTENCE}${SENTENCE}${SENTENCE}`,
    '',
    '### 明细',
    '',
    `- 产品代码：\`PC-${n}\``,
    `- 规格型号：${grammage} g/m²`,
    `- 未预留吨数：${tonnage} t`,
    `- 归属机台：PM${1 + (n % 3)}`,
    '',
    codeOf(n),
    '',
    '| 字段 | 说明 | 取值 |',
    '|---|---|---|',
    `| productCode | 产品代码 | PC-${n} |`,
    `| grammage | 克重 | ${grammage} |`,
    `| tonnage | 未预留吨数 | ${tonnage} |`,
    '',
    `> 第 ${n} 节的口径与复卷报表保持一致，汇总键为「产品代码 + 规格型号 + 合格证打印模版」。`,
    '',
  ].join('\n');

  fs.writeSync(fd, chunk);
  bytes += Buffer.byteLength(chunk);
}

fs.closeSync(fd);

console.log(JSON.stringify({
  file: out,
  sections: n,
  bytes,
  mb: Number((bytes / 1024 / 1024).toFixed(2)),
}, null, 2));
