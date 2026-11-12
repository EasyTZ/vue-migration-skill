/** 小工具：统一各脚本的参数解析与 JSON 参数校验。 */
export function parseArgs(argv, { valued = [], flags = [] } = {}) {
  const valuedKeys = new Set(valued);
  const flagKeys = new Set(flags);
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    let key = argument.slice(2);
    let value;
    const equals = key.indexOf('=');
    if (equals >= 0) { value = key.slice(equals + 1); key = key.slice(0, equals); }
    if (flagKeys.has(key)) { options[key] = true; continue; }
    if (!valuedKeys.has(key)) throw new Error(`未知参数：--${key}`);
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
      if (value === undefined) throw new Error(`--${key} 缺少取值`);
    }
    options[key] = value;
  }
  return { options, positional };
}

export function parseJsonArgument(value, name) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`--${name} 必须是合法 JSON：${error.message}`);
  }
}

/** 命令行文本分词：支持空格分隔与单双引号，不做反斜杠转义（Windows 路径按字面保留）。 */
export function splitCommandLine(value, name = '命令') {
  const tokens = [];
  let current = '';
  let quote = null;
  for (const character of String(value)) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += character;
  }
  if (quote) throw new Error(`${name} 的引号未闭合：${value}`);
  if (current) tokens.push(current);
  return tokens;
}

/**
 * 同时接受 JSON 数组与普通命令行文本。Windows PowerShell 会吞掉 JSON 中的双引号，
 * 因此日常使用写成 --command "npm run dev" 更稳妥。
 */
export function parseCommandArgument(value, name) {
  const text = String(value).trim();
  if (!text) throw new Error(`--${name} 不能为空`);
  if (text.startsWith('[')) {
    const parsed = parseJsonArgument(text, name);
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`--${name} 的 JSON 必须是非空字符串数组`);
    }
    return parsed;
  }
  return splitCommandLine(text, name);
}

export function parsePositiveInteger(value, name, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} 必须是正整数`);
  return parsed;
}

export function parseUnitInterval(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`--${name} 必须在 0~1 之间`);
  return parsed;
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

