import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // 忽略目录
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "node_modules/**",
      "release/**",
      "resources/**",
      "*.tsbuildinfo",
      "vite.config.js",
      "vite.config.d.ts",
      "postcss.config.js",
      "tailwind.config.js",
      "vitest.config.ts"
    ],
  },

  // 基础规则
  js.configs.recommended,

  // TypeScript 规则
  ...tseslint.configs.recommended,

  // React + Hooks
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLDivElement: "readonly",
        React: "readonly",
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // 允许使用 any（项目对接 SDK 动态结构较多，逐步收紧）
      "@typescript-eslint/no-explicit-any": "off",
      // 未使用变量仅警告
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // React 17+ 不需要 import React
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      // 允许空 catch（项目中大量用于忽略错误）
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 暂时关闭 immutability 检查（噪音较多，后续逐步修复）
      "react-hooks/immutability": "off",
      // 以下为性能优化建议，先降为 warn 避免阻断 lint
      "react-hooks/set-state-in-effect": "warn",
    },
  },

  // Electron 主进程 / preload / 配置文件
  {
    files: ["electron/**/*.ts", "preload.ts", "tailwind.config.ts", "vite.config.ts"],
    languageOptions: {
      globals: {
        require: "readonly",
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // 配置文件用 require 加载插件
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // 测试文件
  {
    files: ["tests/**/*.ts"],
    rules: {
      // 测试中大量使用 any 模拟 SDK 动态结构
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // vi.hoisted 回调中用 require 获取 node 模块
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // 根目录脚本（CommonJS / 构建脚本，用 require/process/module）
  {
    files: ["scripts/**/*.{js,mjs}", "electron/**/*.ts"],
    languageOptions: {
      globals: {
        require: "readonly",
        process: "readonly",
        __dirname: "readonly",
        module: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // 关闭与 prettier 冲突的格式化规则
  prettier,
);
