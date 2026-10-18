import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { devFsPlugin } from './tools/dev-fs';

// Tauri 期望固定端口，且不要清屏（会盖掉 Rust 侧日志）
export default defineConfig({
  // Tauri 打包后从自定义协议加载，必须用相对路径
  base: './',
  plugins: [
    svelte(),
    // 仅 dev 生效：把宿主文件系统的「读目录 / 读文件 / 监听」暴露给浏览器预览，
    // 这样文件树与外部改动重载不必等 Rust 工具链就能验证。生产构建不含它。
    devFsPlugin(),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  // 预览也钉死端口：一键启动脚本、文档、测试脚本里都写的是 1421，
  // 让它在任何机器上都指向同一个地址，省掉「先看终端里那行 URL」这一步
  preview: {
    port: 1421,
    strictPort: true,
  },
  build: {
    // WebView2 随 Edge 更新，可直接用较新的语法目标
    target: 'chrome110',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
