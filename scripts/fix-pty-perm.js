/**
 * 修复 node-pty spawn-helper 的执行权限。
 *
 * 两种调用场景：
 * 1. postinstall（npm install 后）：直接运行，修复 node_modules 中的二进制
 * 2. electron-builder afterPack（打包后）：传入 buildResult，修复解包到
 *    app.asar.unpacked 的二进制
 *
 * 背景：node-pty 在 macOS 的预编译 spawn-helper 在 npm tarball 中权限为 644
 * （缺执行位），导致 posix_spawnp 失败。
 */
const fs = require('fs');
const path = require('path');

const PTY_PACKAGE = path.join('node_modules', 'node-pty');

/** 递归遍历目录，对 spawn-helper / *.node 文件 chmod 755 */
function fixDir(dir, label) {
  if (!fs.existsSync(dir)) {
    console.log(`[${label}] not found, skip: ${dir}`);
    return 0;
  }
  let fixed = 0;
  const visit = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        visit(full);
      } else if (name === 'spawn-helper' || name.endsWith('.node')) {
        try {
          fs.chmodSync(full, 0o755);
          fixed++;
        } catch (e) {
          console.warn(`[${label}] chmod failed: ${full} ${e.message}`);
        }
      }
    }
  };
  visit(dir);
  console.log(`[${label}] fixed ${fixed} native files in ${dir}`);
  return fixed;
}

/**
 * 定位打包产物里的 Resources 目录。
 *
 * 注意：mac 上 buildResult.appOutDir 是 `release/mac-arm64` 这一层，
 * `.app` 包还在它里面（win/linux 的 appOutDir 本身就是应用目录）。
 */
function resolveResourcesDir(buildResult) {
  const { appOutDir, electronPlatformName } = buildResult;
  const isMac = (electronPlatformName ?? process.platform) === 'darwin';

  if (!isMac) {
    return path.join(appOutDir, 'resources');
  }

  // 优先用 packager 暴露的 productName，取不到就扫 appOutDir 下的 .app
  let bundleName = buildResult.packager?.appInfo?.productFilename;
  if (!bundleName) {
    const bundle = fs.readdirSync(appOutDir).find((name) => name.endsWith('.app'));
    if (!bundle) {
      return null;
    }
    bundleName = bundle.slice(0, -'.app'.length);
  }
  return path.join(appOutDir, `${bundleName}.app`, 'Contents', 'Resources');
}

// electron-builder afterPack 调用：导出函数
module.exports = function afterPack(buildResult) {
  const resourcesDir = resolveResourcesDir(buildResult);
  if (resourcesDir == null) {
    console.warn(`[afterPack] no .app bundle found in ${buildResult.appOutDir}, skip`);
    return;
  }
  // 直接修整个 node-pty：运行时优先加载 build/Release/pty.node，
  // 只有它不存在才回退到 prebuilds/<platform>-<arch>/（见 node-pty/lib/utils.js），
  // 两处的 spawn-helper 都需要执行位。
  const ptyDir = path.join(resourcesDir, 'app.asar.unpacked', PTY_PACKAGE);
  if (fixDir(ptyDir, 'afterPack') === 0) {
    console.warn(`[afterPack] WARNING: no native binaries fixed under ${ptyDir}`);
  }
};

// postinstall 直接运行：修复项目本地 node_modules
if (require.main === module) {
  fixDir(path.join(__dirname, '..', PTY_PACKAGE), 'postinstall');
}
