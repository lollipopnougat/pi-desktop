import { useEffect, useRef, useState } from 'react';
import type { BrowserTabState } from '../../types/pi';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

interface BrowserContentProps {
  tab: BrowserTabState;
  browserId: string;
  obscured: boolean;
}

export default function BrowserContent({ tab, browserId, obscured }: BrowserContentProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [addressDraft, setAddressDraft] = useState<string | null>(null);
  const [fixedOverlayOpen, setFixedOverlayOpen] = useState(false);
  const address = addressDraft ?? tab.url;

  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hasOverlay = Array.from(document.querySelectorAll<HTMLElement>('.fixed')).some(
          (element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          }
        );
        setFixedOverlayOpen(hasOverlay);
      });
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateBounds = () => {
      const rect = element.getBoundingClientRect();
      window.pi.browser
        .setViewport({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .catch(() => {});
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(element);
    window.addEventListener('resize', updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [browserId]);

  useEffect(() => {
    window.pi.browser.setVisible(!obscured && !fixedOverlayOpen && !!tab.url).catch(() => {});
    return () => {
      window.pi.browser.setVisible(false).catch(() => {});
    };
  }, [browserId, fixedOverlayOpen, obscured, tab.url]);

  const navigate = async () => {
    const next = address.trim();
    if (!next) return;
    await window.pi.browser.navigate(browserId, next);
    setAddressDraft(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-od-bg-dark">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-od-border bg-od-bg-alt px-2">
        <button
          type="button"
          onClick={() => window.pi.browser.back(browserId)}
          disabled={!tab.canGoBack}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserBack}
        >
          <Icon name="back" className="w-3" />
        </button>
        <button
          type="button"
          onClick={() => window.pi.browser.forward(browserId)}
          disabled={!tab.canGoForward}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserForward}
        >
          <Icon name="forward" className="w-3" />
        </button>
        <button
          type="button"
          onClick={() =>
            tab.loading ? window.pi.browser.stop(browserId) : window.pi.browser.reload(browserId)
          }
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright"
          title={tab.loading ? t.browserStop : t.browserReload}
        >
          <Icon name={tab.loading ? 'stop' : 'refresh'} className="w-3" />
        </button>
        <form
          className="flex min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
        >
          <input
            value={address}
            onChange={(event) => setAddressDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder={t.browserAddressPlaceholder}
            className="h-7 w-full rounded border border-od-border-light bg-od-bg-dark px-2 text-xs text-od-text-bright"
          />
        </form>
        <button
          type="button"
          disabled={!tab.url}
          onClick={() => tab.url && window.pi.openExternal(tab.url)}
          className="flex h-7 w-7 items-center justify-center rounded text-od-text-dim hover:bg-od-bg-hover hover:text-od-text-bright disabled:opacity-30"
          title={t.browserOpenExternal}
        >
          <Icon name="external" className="w-3" />
        </button>
      </div>

      <div ref={viewportRef} className="relative flex-1 min-h-0 overflow-hidden bg-od-bg">
        {!tab.url && (
          <form
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate();
            }}
          >
            <Icon name="browser" className="w-7 text-od-text-dim" />
            <div className="text-sm text-od-text-bright">{t.browserEmptyTitle}</div>
            <input
              value={address}
              onChange={(event) => setAddressDraft(event.target.value)}
              placeholder={t.browserEmptyHint}
              autoFocus
              className="h-8 w-full max-w-md rounded border border-od-border-light bg-od-bg-alt px-3 text-xs text-od-text-bright"
            />
          </form>
        )}
      </div>
    </div>
  );
}
