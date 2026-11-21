export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface BrowserState {
  enabled: boolean;
  tabs: BrowserTabState[];
  activeTabId: string | null;
}

export interface BrowserViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role: string;
  name: string;
  value?: string;
}

export interface BrowserSnapshot {
  title: string;
  url: string;
  text: string;
  elements: BrowserSnapshotElement[];
}

/** 「标记元素」选中的页面元素（结构与 picker.ts 的 PickedElement 对齐） */
export interface BrowserPickedElement {
  tagName: string;
  selector: string;
  text: string;
  html: string;
  rect: { x: number; y: number; width: number; height: number };
  clip: { x: number; y: number; width: number; height: number };
  styles: { color: string; background: string; font: string; fontSize: string };
  url: string;
  title: string;
  viewport: { width: number; height: number };
}

export interface BrowserPickResult {
  /** null = 用户取消了选择 */
  element: BrowserPickedElement | null;
  /** 元素矩形截图（base64 PNG，不带 data: 前缀）；截不到时为 undefined */
  image?: { data: string; mimeType: string };
}
