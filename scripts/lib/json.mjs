import fs from 'node:fs/promises';

/** Windows 工程里常见的 UTF-8 BOM 不应让验收工具误判 JSON 损坏。 */
export function parseJson(text, label = 'JSON') {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`);
  }
}

export async function readJsonFile(file) {
  return parseJson(await fs.readFile(file, 'utf8'), file);
}
