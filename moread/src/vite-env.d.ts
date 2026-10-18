/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module '*.md?raw' {
  const content: string;
  export default content;
}

/**
 * Shiki 的细粒度语言/主题包（shiki/langs/xxx.mjs、shiki/themes/xxx.mjs）
 * 在 exports map 里没有单独挂类型，这里补上通配声明，
 * 避免 tsc / svelte-check 报 "找不到声明文件"。
 */
declare module 'shiki/langs/*.mjs' {
  const mod: { default: unknown };
  export default mod;
}
declare module 'shiki/themes/*.mjs' {
  const mod: { default: unknown };
  export default mod;
}
