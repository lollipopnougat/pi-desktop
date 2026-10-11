/**
 * 从 build/icons/icon.svg 生成各平台所需的图标文件：
 *   - icon.png        (Linux / 通用，源: icon.svg，macOS Big Sur 式留白)
 *   - icon.ico        (Windows，源: icon-win.svg，满幅无留白 —— Windows 直接
 *                      显示原始内容，留白版会显得小一圈；macOS 会自动套圆角壳
 *                      所以继续用留白版 icon.svg)
 *   - icon.icns       (macOS，源: icon.svg)
 *
 * 用法: node scripts/generate-icons.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import svg2img from 'svg2img';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SVG_PATH = join(ROOT, 'build/icons/icon.svg');
const SVG_WIN_PATH = join(ROOT, 'build/icons/icon-win.svg');
const OUT_DIR = join(ROOT, 'build/icons');

const svgBuffer = readFileSync(SVG_PATH);
const svgString = svgBuffer.toString('utf-8');
// Windows 满幅变体（无 macOS Big Sur 式 padding）
const svgWinString = readFileSync(SVG_WIN_PATH).toString('utf-8');

mkdirSync(OUT_DIR, { recursive: true });

/** 将 SVG 渲染为指定尺寸的 PNG Buffer */
function renderPNG(size, format = 'png', svg = svgString) {
  return new Promise((resolve, reject) => {
    svg2img(
      svg,
      {
        format,
        quality: 100,
        resvg: {
          fitTo: { mode: 'width', value: size }
        }
      },
      (err, buffer) => {
        if (err) return reject(err);
        resolve(buffer);
      }
    );
  });
}

/** 生成 ICO 文件（包含多个尺寸的 PNG 拼接） */
function buildICO(pngs) {
  // ICO 文件头: 6 bytes
  // ICONDIR: reserved(2) + type(2) + count(2)
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (icon)
  header.writeUInt16LE(count, 4);

  // ICONDIRENTRY: 16 bytes each
  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const entries = [];
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(data.length, 8); // bytes in res
    entry.writeUInt32LE(offset, 12); // image offset
    entries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/** 生成 ICNS 文件（macOS） */
function buildICNS(pngs) {
  // ICNS magic: "icns"
  const magic = Buffer.from('icns', 'ascii');
  const entries = [];
  for (const { size, data } of pngs) {
    let ostype;
    if (size === 16) ostype = 'icp4';
    else if (size === 32) ostype = 'icp5';
    else if (size === 64) ostype = 'icp6';
    else if (size === 128) ostype = 'ic07';
    else if (size === 256) ostype = 'ic08';
    else if (size === 512) ostype = 'ic09';
    else if (size === 1024) ostype = 'ic10';
    else continue;
    const typeBuf = Buffer.from(ostype, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length + 8, 0);
    entries.push(Buffer.concat([typeBuf, lenBuf, data]));
  }
  const body = Buffer.concat(entries);
  const totalLen = Buffer.alloc(4);
  totalLen.writeUInt32BE(body.length + 8, 0);
  return Buffer.concat([magic, totalLen, body]);
}

async function main() {
  console.log('🎨 Generating icons from SVG...');

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  const pngs = [];
  for (const size of sizes) {
    const data = await renderPNG(size);
    pngs.push({ size, data });
    console.log(`  ✓ PNG ${size}x${size} (${data.length} bytes)`);
  }

  // 保存 512x512 PNG (Linux / 通用)
  const png512 = pngs.find((p) => p.size === 512);
  writeFileSync(join(OUT_DIR, 'icon.png'), png512.data);
  console.log(`  ✓ Saved icon.png`);

  // 生成 ICO (Windows) - 包含 16/32/48/64/128/256，用满幅变体（视觉上更大）
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoPngs = [];
  for (const size of icoSizes) {
    const data = await renderPNG(size, 'png', svgWinString);
    icoPngs.push({ size, data });
  }
  const ico = buildICO(icoPngs);
  writeFileSync(join(OUT_DIR, 'icon.ico'), ico);
  console.log(`  ✓ Saved icon.ico (Windows 满幅变体)`);

  // 生成 ICNS (macOS)
  const icns = buildICNS(pngs);
  writeFileSync(join(OUT_DIR, 'icon.icns'), icns);
  console.log(`  ✓ Saved icon.icns`);

  console.log('✅ All icons generated successfully!');
}

main().catch((err) => {
  console.error('❌ Icon generation failed:', err);
  process.exit(1);
});
