import { useEffect, useState } from 'react';
import { usePiStore } from '../../store/pi-store';
import Icon from '../common/Icon';
import { t } from '../../i18n/zh';

export default function CompactionToast() {
  const isCompacting = usePiStore((s) => s.isCompacting);
  const [showToast, setShowToast] = useState(false);
  const [justFinished, setJustFinished] = useState(false);

  useEffect(() => {
    if (isCompacting) {
      setShowToast(true);
      setJustFinished(false);
    } else if (showToast && !justFinished) {
      // Compaction just finished
      setJustFinished(true);
      const timer = setTimeout(() => {
        setShowToast(false);
        setJustFinished(false);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isCompacting]);

  if (!showToast) return null;

  return (
    <div className="fixed top-12 left-1/2 -translate-x-1/2 z-50">
      <div
        className={`rounded-lg border px-4 py-2 text-xs shadow-xl ${
          isCompacting
            ? 'border-od-yellow bg-od-yellow/20 text-yellow-200'
            : 'border-od-green bg-od-green/20 text-green-200'
        }`}
      >
        {isCompacting ? (
          <span className="flex items-center gap-2">
            <Icon name="spinner" spin className="w-3" />
            {t.compactingContext}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Icon name="check" className="w-3" />
            {t.compacted}
          </span>
        )}
      </div>
    </div>
  );
}
