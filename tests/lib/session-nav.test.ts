import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 会话导航历史（标题栏前进/后退）。
 *
 * 只测「历史怎么记、下标怎么动」这层；真正的切换事务由 transitionSession 负责（它自己的用例在
 * tests/session/load-session.test.ts）。这里把 transitionSession 换成桩，断言两件关键事情：
 * 1. 前进/后退调用 switchSession 时必须带 recordNav:false（否则历史会记成环）
 * 2. 只有切换成功（返回 true）才挪下标
 */
vi.mock('../../src/hooks/loadSession', () => ({
  // 桩会真的执行传入的 operation（里面是 window.pi.switchSession），这样能断言参数
  transitionSession: vi.fn(async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  })
}));

const { transitionSession } = await import('../../src/hooks/loadSession');
const { MAX_SESSION_NAV, recordCurrentSessionNav, usePiStore } =
  await import('../../src/store/pi-store');
const { canGoBack, canGoForward, jumpToSessionNav, navigateSessionHistory } =
  await import('../../src/lib/session-nav');

const transition = vi.mocked(transitionSession);
const nav = () => usePiStore.getState().sessionNav;
const navIndex = () => usePiStore.getState().sessionNavIndex;
const record = (target: string, label = target) =>
  usePiStore.getState().recordSessionNav({ target, label });
const targets = () => nav().map((e) => e.target);

let switchSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  switchSession = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('window', { pi: { switchSession } });
  usePiStore.setState(usePiStore.getInitialState(), true);
  transition.mockReset();
  transition.mockImplementation(async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('recordSessionNav', () => {
  it('初始没有历史，按下标 -1 表示「还没开始记」', () => {
    expect(nav()).toEqual([]);
    expect(navIndex()).toBe(-1);
  });

  it('逐条压入，下标停在最新一条', () => {
    record('A');
    expect(targets()).toEqual(['A']);
    expect(navIndex()).toBe(0);
    record('B');
    record('C');
    expect(targets()).toEqual(['A', 'B', 'C']);
    expect(navIndex()).toBe(2);
  });

  it('同一条会话重复记录只更新标题，不新增历史', () => {
    record('A', '标题一');
    record('A', '标题二');
    expect(nav()).toEqual([{ target: 'A', label: '标题二' }]);
    expect(navIndex()).toBe(0);
  });

  it('同一条会话且标题相同时不产生任何变更（保持引用稳定）', () => {
    record('A', '标题');
    const before = nav();
    record('A', '标题');
    expect(nav()).toBe(before);
  });

  it('从历史中间再打开新会话时丢掉「前进」分支（浏览器语义）', () => {
    record('A');
    record('B');
    record('C');
    usePiStore.getState().setSessionNavIndex(0); // 退回到 A
    record('D');
    expect(targets()).toEqual(['A', 'D']);
    expect(navIndex()).toBe(1);
  });

  it(`超过 ${MAX_SESSION_NAV} 条时丢掉最早的，下标指向末尾`, () => {
    for (let i = 0; i < MAX_SESSION_NAV + 5; i += 1) record(`S${i}`);
    expect(nav()).toHaveLength(MAX_SESSION_NAV);
    expect(navIndex()).toBe(MAX_SESSION_NAV - 1);
    expect(targets()[0]).toBe('S5');
    expect(targets().at(-1)).toBe(`S${MAX_SESSION_NAV + 4}`);
  });

  it('setSessionNavIndex 会夹在合法范围内', () => {
    record('A');
    record('B');
    usePiStore.getState().setSessionNavIndex(99);
    expect(navIndex()).toBe(1);
    usePiStore.getState().setSessionNavIndex(-99);
    expect(navIndex()).toBe(0);
  });
});

describe('recordCurrentSessionNav', () => {
  it('已落盘的会话用文件路径作 target', () => {
    usePiStore.setState({ sessionFile: '/x/a.jsonl', sessionId: 'id-a', sessionLabel: '甲' });
    recordCurrentSessionNav();
    expect(nav()).toEqual([{ target: '/x/a.jsonl', label: '甲' }]);
  });

  it('还没落盘的新会话退回 sessionId（switchSession 两种入参都认）', () => {
    usePiStore.setState({ sessionFile: null, sessionId: 'id-b', sessionName: '乙' });
    recordCurrentSessionNav();
    expect(nav()).toEqual([{ target: 'id-b', label: '乙' }]);
  });

  it('没有会话身份时什么都不做', () => {
    usePiStore.setState({ sessionFile: null, sessionId: null });
    recordCurrentSessionNav();
    expect(nav()).toEqual([]);
  });
});

describe('canGoBack / canGoForward', () => {
  it('两端边界', () => {
    expect(canGoBack(-1)).toBe(false);
    expect(canGoBack(0)).toBe(false);
    expect(canGoBack(1)).toBe(true);
    expect(canGoForward(-1, 0)).toBe(false);
    expect(canGoForward(0, 1)).toBe(false);
    expect(canGoForward(0, 2)).toBe(true);
    expect(canGoForward(1, 2)).toBe(false);
  });
});

describe('navigateSessionHistory', () => {
  it('后退：切到上一个会话，且切换事务带 recordNav:false（不把自己记成新一步）', async () => {
    record('A');
    record('B');
    const ok = await navigateSessionHistory(-1);
    expect(ok).toBe(true);
    expect(switchSession).toHaveBeenCalledWith('A');
    expect(transition).toHaveBeenCalledTimes(1);
    expect(transition.mock.calls[0][2]).toEqual({ recordNav: false });
    expect(navIndex()).toBe(0);
    expect(targets()).toEqual(['A', 'B']); // 历史没有被改写
  });

  it('前进：回到下一个会话', async () => {
    record('A');
    record('B');
    usePiStore.getState().setSessionNavIndex(0);
    const ok = await navigateSessionHistory(1);
    expect(ok).toBe(true);
    expect(switchSession).toHaveBeenCalledWith('B');
    expect(navIndex()).toBe(1);
  });

  it('已在两端时不发起切换', async () => {
    record('A');
    expect(await navigateSessionHistory(-1)).toBe(false);
    expect(await navigateSessionHistory(1)).toBe(false);
    expect(switchSession).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('切换失败（会话已被删等）时下标不动', async () => {
    record('A');
    record('B');
    transition.mockResolvedValue(false);
    expect(await navigateSessionHistory(-1)).toBe(false);
    expect(navIndex()).toBe(1);
  });

  it('把 target 原样交给 switchSession（路径或 sessionId 都直接透传）', async () => {
    record('/x/a.jsonl', '甲');
    record('id-b', '乙');
    await navigateSessionHistory(-1);
    expect(switchSession).toHaveBeenCalledWith('/x/a.jsonl');
  });
});

describe('jumpToSessionNav（最近会话菜单直接跳）', () => {
  it('跳到历史里任意一条', async () => {
    record('A');
    record('B');
    record('C');
    const ok = await jumpToSessionNav(0);
    expect(ok).toBe(true);
    expect(switchSession).toHaveBeenCalledWith('A');
    expect(navIndex()).toBe(0);
    expect(targets()).toEqual(['A', 'B', 'C']); // 历史不被改写
  });

  it('点当前项不做任何事', async () => {
    record('A');
    record('B');
    expect(await jumpToSessionNav(1)).toBe(false);
    expect(switchSession).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('下标越界 / 负数直接返回 false', async () => {
    record('A');
    expect(await jumpToSessionNav(5)).toBe(false);
    expect(await jumpToSessionNav(-1)).toBe(false);
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('切换失败时下标不动', async () => {
    record('A');
    record('B');
    record('C');
    transition.mockResolvedValue(false);
    expect(await jumpToSessionNav(0)).toBe(false);
    expect(navIndex()).toBe(2);
  });
});
