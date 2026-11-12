import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 8 位、非隔行 PNG（浏览器截图的常见输出）。只用 Node 内置 zlib，
 * 不引入图像库：验收工具不应为了对比截图给目标工程增加运行依赖。
 */
export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 文件（签名不符）');
  let offset = 8;
  let header = null;
  let palette = null;
  const chunks = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) throw new Error(`PNG ${type} 数据块不完整`);
    const data = bytes.subarray(offset + 8, end);
    offset = end + 4;
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8],
        colorType: data[9], compression: data[10], filter: data[11], interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
  }
  if (!header) throw new Error('PNG 缺少 IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (!width || !height) throw new Error('PNG 尺寸无效');
  if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG，实际为 ${bitDepth} 位`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`不支持的 PNG 颜色类型：${colorType}`);
  if (colorType === 3 && !palette) throw new Error('调色板 PNG 缺少 PLTE');
  if (!chunks.length) throw new Error('PNG 缺少 IDAT');
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error('PNG 像素数据长度不足');
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let position = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[position];
    position += 1;
    const line = Uint8Array.from(raw.subarray(position, position + stride));
    position += stride;
    unfilterLine(filter, line, previous, channels);
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      let red;
      let green;
      let blue;
      let alpha = 255;
      if (colorType === 0) { red = green = blue = line[source]; }
      else if (colorType === 4) { red = green = blue = line[source]; alpha = line[source + 1]; }
      else if (colorType === 2) { [red, green, blue] = [line[source], line[source + 1], line[source + 2]]; }
      else if (colorType === 6) { [red, green, blue, alpha] = [line[source], line[source + 1], line[source + 2], line[source + 3]]; }
      else {
        const index = line[source] * 3;
        if (index + 2 >= palette.length) throw new Error('调色板索引越界');
        [red, green, blue] = [palette[index], palette[index + 1], palette[index + 2]];
      }
      data[target] = red; data[target + 1] = green; data[target + 2] = blue; data[target + 3] = alpha;
    }
    previous = line;
  }
  return { width, height, data };
}

function unfilterLine(filter, line, previous, channels) {
  const length = line.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let index = channels; index < length; index++) line[index] = (line[index] + line[index - channels]) & 0xff;
      return;
    case 2:
      for (let index = 0; index < length; index++) line[index] = (line[index] + previous[index]) & 0xff;
      return;
    case 3:
      for (let index = 0; index < length; index++) {
        const left = index >= channels ? line[index - channels] : 0;
        line[index] = (line[index] + ((left + previous[index]) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let index = 0; index < length; index++) {
        const left = index >= channels ? line[index - channels] : 0;
        const upLeft = index >= channels ? previous[index - channels] : 0;
        line[index] = (line[index] + paeth(left, previous[index], upLeft)) & 0xff;
      }
      return;
    default:
      throw new Error(`不支持的 PNG 行过滤类型：${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

/** 双线性区域平均缩放到固定网格，抵消视口/字体取整带来的几个像素偏差。 */
function resizeToGrid(image, size) {
  const grid = new Float64Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    const startY = Math.floor((y * image.height) / size);
    const endY = Math.max(startY + 1, Math.floor(((y + 1) * image.height) / size));
    for (let x = 0; x < size; x++) {
      const startX = Math.floor((x * image.width) / size);
      const endX = Math.max(startX + 1, Math.floor(((x + 1) * image.width) / size));
      let red = 0;
      let green = 0;
      let blue = 0;
      let count = 0;
      for (let sourceY = startY; sourceY < Math.min(endY, image.height); sourceY++) {
        for (let sourceX = startX; sourceX < Math.min(endX, image.width); sourceX++) {
          const index = (sourceY * image.width + sourceX) * 4;
          red += image.data[index];
          green += image.data[index + 1];
          blue += image.data[index + 2];
          count += 1;
        }
      }
      const target = (y * size + x) * 3;
      grid[target] = red / count;
      grid[target + 1] = green / count;
      grid[target + 2] = blue / count;
    }
  }
  return grid;
}

/**
 * 截图相似度：缩到 32×32 网格后比较 RGB 平均绝对差，返回 0~1。
 * 这是“有没有明显视觉差异”的信号，不替代人工查看截图与业务判断。
 */
export function imageSimilarity(bufferA, bufferB, { size = 32 } = {}) {
  const first = decodePng(bufferA);
  const second = decodePng(bufferB);
  const gridA = resizeToGrid(first, size);
  const gridB = resizeToGrid(second, size);
  let total = 0;
  for (let index = 0; index < gridA.length; index++) total += Math.abs(gridA[index] - gridB[index]);
  const mean = total / (gridA.length * 255);
  return {
    similarity: round(1 - mean), meanAbsoluteDifference: round(mean),
    a: { width: first.width, height: first.height }, b: { width: second.width, height: second.height }, grid: size,
  };
}

const round = value => Math.round(value * 10000) / 10000;
