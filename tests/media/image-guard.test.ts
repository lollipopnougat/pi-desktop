import { describe, expect, it } from 'vitest';
import {
  hasInvalidImages,
  installImageGuard,
  isUsableImageData,
  sanitizeContentBlocks,
  sanitizeMessages
} from '../../electron/media/image-guard';

/** 1×1 PNG 的 base64（合法，长度是 4 的倍数） */
const VALID_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('isUsableImageData', () => {
  it('rejects the empty payload that broke the session', () => {
    // 事故形态：capturePage() 返回空 NativeImage，toPNG().toString('base64') === ''
    expect(isUsableImageData('')).toBe(false);
    expect(isUsableImageData('   ')).toBe(false);
    expect(isUsableImageData(undefined)).toBe(false);
    expect(isUsableImageData(null)).toBe(false);
    expect(isUsableImageData(123)).toBe(false);
  });

  it('rejects malformed base64 that upstream cannot decode', () => {
    expect(isUsableImageData('iVBORw0KGgo')).toBe(false); // 截断，长度 % 4 !== 0
    expect(isUsableImageData('not base64!!')).toBe(false);
    expect(isUsableImageData('iVBORw0KGg$')).toBe(false);
  });

  it('accepts real image base64', () => {
    expect(isUsableImageData(VALID_PNG)).toBe(true);
  });
});

describe('sanitizeContentBlocks', () => {
  it('returns the same reference when nothing needs dropping', () => {
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'image', data: VALID_PNG, mimeType: 'image/png' }
    ];
    expect(sanitizeContentBlocks(content)).toBe(content);
  });

  it('drops empty images and leaves a note for the model', () => {
    const content = [
      { type: 'text', text: '截图结果' },
      { type: 'image', data: '', mimeType: 'image/png' }
    ];
    const result = sanitizeContentBlocks(content) as Array<Record<string, unknown>>;
    expect(result.some((block) => block.type === 'image')).toBe(false);
    expect(result).toContainEqual({ type: 'text', text: '截图结果' });
    expect(result.at(-1)?.text).toMatch(/invalid image dropped/);
  });

  it('passes through non-array content (string user message)', () => {
    expect(sanitizeContentBlocks('hello')).toBe('hello');
    expect(sanitizeContentBlocks(undefined)).toBe(undefined);
  });
});

describe('sanitizeMessages', () => {
  it('keeps identity when there is nothing to fix', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] }
    ];
    expect(sanitizeMessages(messages)).toBe(messages);
  });

  it('rewrites only the messages that carry invalid images', () => {
    const clean = { role: 'user', content: 'hi' };
    const broken = {
      role: 'toolResult',
      content: [{ type: 'image', data: '', mimeType: 'image/png' }]
    };
    const messages = [clean, broken];
    const result = sanitizeMessages(messages);
    expect(result).not.toBe(messages);
    expect(result[0]).toBe(clean);
    expect(result[1]).not.toBe(broken);
    expect(result[1].content).toEqual([
      { type: 'text', text: expect.stringMatching(/invalid image dropped/) }
    ]);
  });
});

describe('hasInvalidImages', () => {
  it('detects empty image blocks and ignores healthy ones', () => {
    expect(hasInvalidImages([{ role: 'user', content: [{ type: 'image', data: '' }] }])).toBe(true);
    expect(
      hasInvalidImages([{ role: 'user', content: [{ type: 'image', data: VALID_PNG }] }])
    ).toBe(false);
    expect(hasInvalidImages([])).toBe(false);
    expect(hasInvalidImages(null)).toBe(false);
  });
});

describe('installImageGuard', () => {
  function createAgent(messages: unknown[]) {
    const calls: unknown[][] = [];
    const agent = {
      messages,
      convertToLlm(input: unknown[]) {
        calls.push(input);
        return input as Array<Record<string, unknown>>;
      },
      calls
    };
    return agent;
  }

  it('repairs the agent transcript in memory and reports it', () => {
    const agent = createAgent([
      { role: 'toolResult', content: [{ type: 'image', data: '', mimeType: 'image/png' }] }
    ]);
    expect(installImageGuard({ agent })).toBe(true);
    expect(
      (agent.messages[0] as { content: Array<Record<string, unknown>> }).content.some(
        (block) => block.type === 'image'
      )
    ).toBe(false);
  });

  it('returns false when the history is already clean', () => {
    const agent = createAgent([{ role: 'user', content: 'hi' }]);
    expect(installImageGuard({ agent })).toBe(false);
  });

  it('wraps convertToLlm so every request is filtered (covers rewind)', async () => {
    const agent = createAgent([]);
    installImageGuard({ agent });
    const result = (await agent.convertToLlm([
      { role: 'user', content: [{ type: 'image', data: '', mimeType: 'image/png' }] }
    ])) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(result[0].content.some((block) => block.type === 'image')).toBe(false);
  });

  it('is idempotent (does not wrap twice)', () => {
    const agent = createAgent([]);
    installImageGuard({ agent });
    const wrapped = agent.convertToLlm;
    installImageGuard({ agent });
    expect(agent.convertToLlm).toBe(wrapped);
  });

  it('never throws on sessions without a usable agent', () => {
    expect(installImageGuard(null)).toBe(false);
    expect(installImageGuard({})).toBe(false);
    expect(installImageGuard({ agent: {} })).toBe(false);
  });
});
