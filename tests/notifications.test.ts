import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  Notification: class {
    on(): void {}
    show(): void {}
  }
}));

const { buildMacFallbackScript } = await import('../electron/notifications');

describe('buildMacFallbackScript', () => {
  it('带正文时生成完整 osascript 脚本', () => {
    expect(buildMacFallbackScript('回合完成', '本轮共 3 条新增消息')).toBe(
      'display notification "本轮共 3 条新增消息" with title "回合完成" sound name "default"'
    );
  });

  it('正文为空时退化为单文本通知', () => {
    expect(buildMacFallbackScript('只有标题', '')).toBe(
      'display notification "只有标题" sound name "default"'
    );
  });

  it('转义标题/正文中的引号与反斜杠，避免越出字符串字面量', () => {
    expect(buildMacFallbackScript('He said "hi"', 'C:\\path\\to\\file')).toBe(
      'display notification "C:\\\\path\\\\to\\\\file" with title "He said \\"hi\\"" sound name "default"'
    );
  });

  it('换行折叠为空格', () => {
    expect(buildMacFallbackScript('t', 'line1\nline2\r\nline3')).toBe(
      'display notification "line1 line2 line3" with title "t" sound name "default"'
    );
  });

  it('AppleScript 注入尝试被留在字符串内', () => {
    expect(buildMacFallbackScript('x" & do shell script "echo pwned', 'body')).toBe(
      'display notification "body" with title "x\\" & do shell script \\"echo pwned" sound name "default"'
    );
  });
});
