import { useEffect } from 'react';
import { loadUiSettings } from '../store/pi-store';
import { transitionSession } from './loadSession';

export function useSessionInit(_initialized: boolean, setInitialized: (v: boolean) => void) {
  useEffect(() => {
    let active = true;
    void transitionSession(async () => {
      await loadUiSettings();
    }).finally(() => {
      if (active) setInitialized(true);
    });
    return () => {
      active = false;
    };
  }, [setInitialized]);
}
