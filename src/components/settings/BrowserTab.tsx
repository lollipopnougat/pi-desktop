import { useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import Switch from '../common/Switch';
import Icon from '../common/Icon';
import ConfirmDialog from '../common/ConfirmDialog';
import { t } from '../../i18n/zh';

export default function BrowserTab() {
  const browserEnabled = usePiStore((state) => state.browserEnabled);
  const setBrowserEnabled = usePiStore((state) => state.setBrowserEnabled);
  const browserDevtoolsEnabled = usePiStore((state) => state.browserDevtoolsEnabled);
  const setBrowserDevtoolsEnabled = usePiStore((state) => state.setBrowserDevtoolsEnabled);
  const showToast = usePiStore((state) => state.showToast);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearData = async () => {
    setClearing(true);
    try {
      await window.pi.browser.clearData();
      showToast(t.browserDataCleared, { variant: 'success' });
      setConfirmClear(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <div className="mb-4">
        <h3 className="mb-2 text-xs font-semibold text-od-text">{t.browserSettings}</h3>
        <div className="space-y-3 rounded border border-od-border bg-od-bg-alt px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.browserEnabled}</div>
              <div className="text-xs text-od-text-dim">{t.browserEnabledDesc}</div>
            </div>
            <Switch
              checked={browserEnabled}
              onChange={setBrowserEnabled}
              ariaLabel={t.browserEnabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-od-border pt-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.browserDevtoolsEnabled}</div>
              <div className="text-xs text-od-text-dim">{t.browserDevtoolsEnabledDesc}</div>
            </div>
            <Switch
              checked={browserDevtoolsEnabled}
              onChange={setBrowserDevtoolsEnabled}
              ariaLabel={t.browserDevtoolsEnabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-od-border pt-3">
            <div className="min-w-0">
              <div className="text-sm text-od-text-bright">{t.browserData}</div>
              <div className="text-xs text-od-text-dim">{t.browserDataDesc}</div>
            </div>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="flex shrink-0 items-center gap-1.5 rounded border border-od-border-light px-2.5 py-1.5 text-xs text-od-text hover:bg-od-bg-hover hover:text-od-text-bright"
            >
              <Icon name="delete" className="w-3" />
              {t.browserClearData}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t.browserClearTitle}
        message={t.browserClearMessage}
        confirmText={t.browserClearConfirm}
        danger
        loading={clearing}
        onConfirm={() => void clearData()}
        onClose={() => setConfirmClear(false)}
      />
    </>
  );
}
