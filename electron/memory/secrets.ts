// ─── 脱敏 ───

/** 覆盖常见密钥模式（对齐 oh-my-pi redactSecrets 常见集合） */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI 风格
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g, // npm tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:pk|rk)-[A-Za-z0-9_-]{20,}\b/g, // pixiv/raiden 等 pk-/rk- 前缀
  /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\s*[:=]\s*['"]?([A-Za-z0-9_\-+/=.]{16,})['"]?/gi // key=value 形式
];

/** 密钥脱敏：把疑似密钥替换为 [REDACTED]，防止从会话泄漏到记忆文件 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (match) => {
      // key=value 形式只替换 value 部分，保留键名可读性
      const m = /^(.*?[:=]\s*['"]?)(.*)$/.exec(match);
      if (m && m[1] && /[:=]/.test(m[1])) return `${m[1]}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}
