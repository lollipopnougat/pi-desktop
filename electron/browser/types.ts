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
