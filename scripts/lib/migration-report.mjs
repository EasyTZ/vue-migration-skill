import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintFiles } from './source-state.mjs';

const stages = new Set(['pending', 'in-progress', 'migrated', 'verified', 'accepted', 'blocked']);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const isInside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
export function validateSnapshot(snapshot, source) {
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.files) || typeof snapshot.fingerprint !== 'string'
    || !same(snapshot.sourceRoot ?? '', source)) throw new Error('源快照格式/版本/源路径不匹配，请重新生成有效快照');
  const seen = new Set();
  for (const file of snapshot.files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || path.posix.isAbsolute(file.path)
      || file.path.split('/').some(part => ['..', '.', ''].includes(part)) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      || seen.has(file.path)) throw new Error('源快照含重复或非法文件记录');
    seen.add(file.path);
  }
  if (snapshot.fingerprint !== fingerprintFiles(snapshot.files)) throw new Error('源快照整体指纹不匹配');
  return snapshot;
}

export async function readControlJson(project, relative) {
  const file = await existingInside(project.control, relative);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function existingInside(root, relative) {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)
    || relative.includes('\\') || relative.includes(':') || !isInside(root, path.resolve(root, relative))) {
    throw new Error('路径必须为目录内的相对路径，使用 / 分隔');
  }
  const actual = await fs.realpath(path.resolve(root, relative));
  if (!isInside(root, actual) || !(await fs.stat(actual)).isFile()) throw new Error(`文件越界或非普通文件：${relative}`);
  return actual;
}

const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export async function buildReport(project, baseline, current, ledger) {
  validateSnapshot(baseline, project.source);
  if (ledger?.schemaVersion !== 1) throw new Error('不支持的迁移状态格式版本');
  for (const key of ['files', 'entries', 'architecture', 'checks', 'bugs']) {
    if (!Array.isArray(ledger[key])) throw new Error(`迁移状态的 ${key} 必须为数组`);
  }
  const problems = [];
  const currentMap = new Map(current.files.map(file => [file.path, file.sha256]));
  const baselineMap = new Map(baseline.files.map(file => [file.path, file.sha256]));
  const changed = [...currentMap].filter(([file, hash]) => baselineMap.get(file) !== hash).map(([file]) => file);
  const deleted = [...baselineMap.keys()].filter(file => !currentMap.has(file));
  const sourceChanged = changed.length > 0 || deleted.length > 0;
  if (sourceChanged) problems.push('源工程已变化：需分析增量、更新覆盖及证据，再显式采用新基线');
  if (!baseline.files.length) problems.push('源快照为空，不能判定迁移覆盖完成');
  if (ledger.entriesReviewed !== true) problems.push('尚未确认动态及隐蔽入口普查范围');
  if (ledger.architectureReviewed !== true) problems.push('尚未确认实际架构层普查范围');

  async function evidence(list, label) {
    if (!Array.isArray(list) || !list.length) { problems.push(`${label} 缺少证据引用`); return false; }
    let valid = true;
    for (const ref of list) {
      try { await existingInside(project.control, ref); }
      catch { valid = false; problems.push(`${label} 证据不存在或越界：${String(ref)}`); }
    }
    return valid;
  }
  async function targets(list, label) {
    if (!Array.isArray(list) || !list.length || !project.target) { problems.push(`${label} 缺少可检查的目标文件`); return false; }
    let valid = true;
    for (const ref of list) {
      try { await existingInside(project.target, ref); }
      catch { valid = false; problems.push(`${label} 目标文件不存在或越界：${String(ref)}`); }
    }
    return valid;
  }

  const fileRows = [];
  const seen = new Set();
  for (const row of ledger.files) {
    const label = `源文件 ${String(row?.source)}`;
    if (!row || typeof row.source !== 'string' || seen.has(row.source)) { problems.push('文件覆盖记录缺少源路径或存在重复'); continue; }
    seen.add(row.source);
    let supported = true;
    const stale = row.sourceSha256 !== baselineMap.get(row.source) || row.sourceSha256 !== currentMap.get(row.source);
    if (!baselineMap.has(row.source)) { problems.push(`${label} 不在所选基线内，请核对删除/增量记录`); supported = false; }
    if (stale) { problems.push(`${label} 的源指纹已过期`); supported = false; }
    if (!stages.has(row.stage)) { problems.push(`${label} 状态非法`); supported = false; }
    if (!['mapped', 'omitted', 'pending'].includes(row.disposition)) { problems.push(`${label} 处置类型非法`); supported = false; }
    if (row.disposition === 'omitted') {
      if (!['verified', 'accepted'].includes(row.stage)) { problems.push(`${label} 的不迁移决定尚未验证`); supported = false; }
      if (!nonempty(row.reason)) { problems.push(`${label} 未提供不迁移理由`); supported = false; }
      supported = await evidence(row.evidence, label) && supported;
    } else if (['migrated', 'verified', 'accepted'].includes(row.stage)) {
      if (row.disposition !== 'mapped') { problems.push(`${label} 未映射到目标`); supported = false; }
      supported = await targets(row.targets, label) && supported;
      if (['verified', 'accepted'].includes(row.stage)) supported = await evidence(row.evidence, label) && supported;
    }
    const complete = supported && (row.disposition === 'omitted' || ['verified', 'accepted'].includes(row.stage));
    if (!complete) problems.push(`${label} 尚未形成有效覆盖闭环`);
    fileRows.push({ source: row.source, stage: row.stage, disposition: row.disposition, targets: Array.isArray(row.targets) ? row.targets : [], stale, complete });
  }
  const uncovered = [...baselineMap.keys()].filter(file => !seen.has(file));
  for (const file of uncovered) problems.push(`源文件未登记：${file}`);

  async function reviewRows(rows, kind) {
    const ids = new Set();
    const result = [];
    for (const row of rows) {
      if (!nonempty(row?.id) || ids.has(row.id)) { problems.push(`${kind} 编号缺失或重复`); continue; }
      ids.add(row.id);
      const label = `${kind} ${row.id}`;
      let complete = false;
      if (row.status === 'not-applicable') {
        complete = nonempty(row.reason) && await evidence(row.evidence, label);
      } else if (['verified', 'accepted'].includes(row.status)) {
        complete = await evidence(row.evidence, label);
        if (kind === '入口') {
          complete = await targets(row.targets, label) && complete;
          if (!Array.isArray(row.sourceFiles) || !row.sourceFiles.length || row.sourceFiles.some(file => !baselineMap.has(file))) {
            complete = false; problems.push(`${label} 未关联有效源文件`);
          }
          if (Array.isArray(row.sourceFiles) && row.sourceFiles.some(file => fileRows.find(item => item.source === file)?.complete !== true)) complete = false;
        }
      }
      if (!complete) problems.push(`${label} 待完成或缺少有效依据`);
      result.push({ id: row.id, status: row.status, complete });
    }
    return result;
  }
  const entries = await reviewRows(ledger.entries, '入口');
  const architecture = await reviewRows(ledger.architecture, '架构层');
  if (!architecture.length) problems.push('架构层覆盖清单为空');
  if (!ledger.checks.length) problems.push('自动检查清单为空');
  for (const kind of ['lint', 'static', 'test', 'build']) {
    if (!ledger.checks.some(row => row?.kind === kind)) problems.push(`缺少 ${kind} 检查或适用性说明`);
  }
  const checkIds = new Set();
  const checks = [];
  for (const row of ledger.checks) {
    if (!nonempty(row?.id) || checkIds.has(row.id)) { problems.push('检查编号缺失或重复'); continue; }
    checkIds.add(row.id);
    let complete = false;
    if (row.status === 'not-applicable') complete = nonempty(row.reason) && await evidence(row.evidence, `检查 ${row.id}`);
    if (row.status === 'passed') complete = nonempty(row.command) && row.exitCode === 0 && nonempty(row.executedAt)
      && !Number.isNaN(Date.parse(row.executedAt)) && await evidence(row.evidence, `检查 ${row.id}`);
    if (row.kind === 'test' && row.status === 'passed' && !(Number.isInteger(row.testCount) && row.testCount > 0)) complete = false;
    if (!complete) problems.push(`检查 ${row.id} 尚未通过或缺少执行证据`);
    checks.push({ id: row.id, status: row.status, complete });
  }
  const bugs = [];
  const bugIds = new Set();
  for (const row of ledger.bugs) {
    if (!nonempty(row?.id) || bugIds.has(row.id)) { problems.push('缺陷编号缺失或重复'); continue; }
    bugIds.add(row.id);
    const complete = row.status === 'fixed' && nonempty(row.expected) && nonempty(row.basis)
      && await evidence(row.evidence, `缺陷 ${row.id}`);
    if (!complete) problems.push(`缺陷 ${row.id} 待确认、修复或验证`);
    bugs.push({ id: row.id, status: row.status, complete });
  }
  const summary = {
    sourceFiles: baseline.files.length, recordedFiles: fileRows.length,
    completedFiles: fileRows.filter(row => row.complete).length, uncoveredFiles: uncovered.length,
    staleFiles: fileRows.filter(row => row.stale).length,
    entries: entries.length, completedEntries: entries.filter(row => row.complete).length,
    architecture: architecture.length, completedArchitecture: architecture.filter(row => row.complete).length,
    checks: checks.length, completedChecks: checks.filter(row => row.complete).length,
    bugs: bugs.length, completedBugs: bugs.filter(row => row.complete).length,
    declaredStages: Object.fromEntries([...stages].map(stage => [stage, fileRows.filter(row => row.stage === stage).length])),
  };
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), sourceRoot: project.source,
    baselineFingerprint: baseline.fingerprint, currentFingerprint: current.fingerprint,
    sourceChanged, delta: { changed, deleted }, summary,
    excluded: current.excluded ?? [], policy: current.policy ?? null,
    reviewReady: problems.length === 0, problems: [...new Set(problems)],
    note: '报告检查文件存在性、源指纹和声明所需的证据引用；不验证证据内容真伪、不绑定目标/证据文件的执行时指纹，不证明当前目标版本测试已通过，也不代替入口发现或人工验收。',
    files: fileRows, uncovered, entries, architecture, checks, bugs,
  };
}

export function renderReport(report) {
  const s = report.summary;
  return `# 迁移覆盖与状态报告\n\n生成时间：${report.generatedAt}\n\n` +
    `提交复核条件：${report.reviewReady ? '记录条件满足，仍需审查证据及必要人工验收' : '尚未满足'}\n\n` +
    `${report.note}\n\n| 范围 | 已闭环 / 总数 |\n|---|---|\n` +
    `| 源文件 | ${s.completedFiles} / ${s.sourceFiles} |\n| 已登记入口 | ${s.completedEntries} / ${s.entries} |\n` +
    `| 架构层 | ${s.completedArchitecture} / ${s.architecture} |\n| 检查 | ${s.completedChecks} / ${s.checks} |\n` +
    `| 已登记缺陷 | ${s.completedBugs} / ${s.bugs} |\n\n` +
    `源变化：${report.sourceChanged ? '存在，需处理增量' : '所选扫描范围内未变化'}；过期文件记录：${s.staleFiles}。\n\n` +
    `## 待处理\n\n${report.problems.length ? report.problems.map(item => `- ${cell(item)}`).join('\n') : '- 无机器检查缺口；请继续复核证据内容。'}\n\n` +
    `## 文件覆盖\n\n| 源文件 | 状态 | 处置 | 目标 | 指纹过期 | 闭环 |\n|---|---|---|---|---|---|\n` +
    report.files.map(row => `| ${cell(row.source)} | ${cell(row.stage)} | ${cell(row.disposition)} | ${cell(row.targets.join(', '))} | ${row.stale ? '是' : '否'} | ${row.complete ? '是' : '否'} |`).join('\n') + '\n' +
    [['入口', report.entries], ['架构层', report.architecture], ['检查', report.checks], ['缺陷', report.bugs]].map(([title, rows]) =>
      `\n## ${title}状态\n\n| 编号 | 声明状态 | 记录闭环 |\n|---|---|---|\n` +
      rows.map(row => `| ${cell(row.id)} | ${cell(row.status)} | ${row.complete ? '是' : '否'} |`).join('\n') + '\n').join('');
}
