// src/hooks/useMocuWindowSize.ts
import { useCallback, useEffect, useRef } from 'react';
import {
  getCurrentWindow,
  LogicalSize,
} from '@tauri-apps/api/window';

type UseMocuWindowSizeOptions = {
  width: number;
  baseHeight: number;
  transcriptExtraHeight: number;
  disabled?: boolean;
};

export function useMocuWindowSize({
  width,
  baseHeight,
  transcriptExtraHeight,
  disabled = false,
}: UseMocuWindowSizeOptions) {
  const isExpandedRef = useRef(false);
  const resizeRequestRef = useRef(0);

  const resizeWindow = useCallback(
    async (showTranscript: boolean) => {
      if (disabled) {
        return;
      }

      if (isExpandedRef.current === showTranscript) {
        return;
      }

      isExpandedRef.current = showTranscript;

      const requestId = ++resizeRequestRef.current;
      const targetHeight = showTranscript
        ? baseHeight + transcriptExtraHeight
        : baseHeight;

      try {
        const appWindow = getCurrentWindow();

        await appWindow.setSize(
          new LogicalSize(width, targetHeight),
        );

        if (requestId !== resizeRequestRef.current) {
          return;
        }
      } catch (error) {
        console.error('Failed to resize Mocu window:', error);
      }
    },
    [
      baseHeight,
      disabled,
      transcriptExtraHeight,
      width,
    ],
  );

  useEffect(() => {
    if (disabled) {
      return;
    }

    return () => {
      resizeRequestRef.current += 1;

      const appWindow = getCurrentWindow();

      void appWindow
        .setSize(new LogicalSize(width, baseHeight))
        .catch((error) => {
          console.error(
            'Failed to restore Mocu window size:',
            error,
          );
        });
    };
  }, [baseHeight, disabled, width]);

  return {
    resizeWindow,
  };
}