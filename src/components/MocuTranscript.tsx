// src/components/MocuTranscript.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

export type TranscriptSpeaker = 'user' | 'mocu';

interface MocuTranscriptProps {
  text: string;
  speaker?: TranscriptSpeaker;
  delay?: number;
  visibleFor?: number;
  enabled?: boolean;
  onHidden?: () => void;
}

const MIN_VISIBLE_TIME = 7000;
const MAX_VISIBLE_TIME = 30000;
const MILLISECONDS_PER_CHARACTER = 45;
const HIDE_AFTER_MOUSE_LEAVE = 2000;

export function MocuTranscript({
  text,
  speaker = 'mocu',
  delay = 800,
  visibleFor = MIN_VISIBLE_TIME,
  enabled = true,
  onHidden,
}: MocuTranscriptProps) {
  const [isVisible, setIsVisible] = useState(false);

  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const onHiddenRef = useRef(onHidden);
  const shouldNotifyHiddenRef = useRef(false);
  const isHoveredRef = useRef(false);

  useEffect(() => {
    onHiddenRef.current = onHidden;
  }, [onHidden]);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideTranscript = useCallback(() => {
    clearHideTimer();
    shouldNotifyHiddenRef.current = true;
    setIsVisible(false);
  }, [clearHideTimer]);

  const startHideTimer = useCallback(
    (duration: number) => {
      clearHideTimer();

      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;

        // Do not hide while the user is reading or scrolling the transcript.
        if (isHoveredRef.current) {
          return;
        }

        hideTranscript();
      }, duration);
    },
    [clearHideTimer, hideTranscript],
  );

  useEffect(() => {
    const clearTimers = () => {
      clearShowTimer();
      clearHideTimer();
    };

    clearTimers();

    setIsVisible(false);
    shouldNotifyHiddenRef.current = false;
    isHoveredRef.current = false;

    const normalizedText = text.trim();

    if (!enabled || !normalizedText) {
      return clearTimers;
    }

    const calculatedReadingTime =
      normalizedText.length * MILLISECONDS_PER_CHARACTER;

    const readingTime = Math.min(
      MAX_VISIBLE_TIME,
      Math.max(visibleFor, calculatedReadingTime),
    );

    showTimerRef.current = window.setTimeout(() => {
      showTimerRef.current = null;
      setIsVisible(true);
      startHideTimer(readingTime);
    }, delay);

    return clearTimers;
  }, [
    text,
    delay,
    visibleFor,
    enabled,
    clearShowTimer,
    clearHideTimer,
    startHideTimer,
  ]);

  const handleMouseEnter = () => {
    isHoveredRef.current = true;
    clearHideTimer();
  };

  const handleMouseLeave = () => {
    isHoveredRef.current = false;
    startHideTimer(HIDE_AFTER_MOUSE_LEAVE);
  };

  const isUser = speaker === 'user';

  return (
    <AnimatePresence
      onExitComplete={() => {
        if (shouldNotifyHiddenRef.current) {
          shouldNotifyHiddenRef.current = false;
          onHiddenRef.current?.();
        }
      }}
    >
      {isVisible && (
        <motion.div
          key="mocu-transcript"
          initial={{
            opacity: 0,
            y: -10,
            scale: 0.96,
            filter: 'blur(5px)',
          }}
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
            filter: 'blur(0px)',
          }}
          exit={{
            opacity: 0,
            y: -6,
            scale: 0.98,
            filter: 'blur(4px)',
          }}
          transition={{
            duration: 0.28,
            ease: [0.16, 1, 0.3, 1],
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="absolute left-1/2 top-full z-40 mt-3 w-[min(440px,calc(100vw-24px))] -translate-x-1/2"
        >
          <div
            className={[
              'relative overflow-hidden rounded-2xl border px-4 py-3',
              'bg-slate-950/72 backdrop-blur-xl',
              isUser
                ? 'border-violet-300/25'
                : 'border-cyan-200/25',
            ].join(' ')}
          >
            <div
              className={[
                'pointer-events-none absolute inset-0 opacity-70',
                isUser
                  ? 'bg-[radial-gradient(circle_at_top_left,rgba(139,92,246,0.20),transparent_58%)]'
                  : 'bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_58%)]',
              ].join(' ')}
            />

            <div className="relative flex items-center gap-2">
              <span
                className={[
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  isUser ? 'bg-violet-300' : 'bg-cyan-300',
                ].join(' ')}
              />

              <span
                className={[
                  'text-[10px] font-semibold uppercase tracking-[0.16em]',
                  isUser
                    ? 'text-violet-200/80'
                    : 'text-cyan-100/80',
                ].join(' ')}
              >
                {isUser ? 'You' : 'Mocu'}
              </span>
            </div>

            <div className="transcript-scroll relative mt-1.5 max-h-[140px] overflow-y-auto break-words pb-2 pr-2 text-center text-xs leading-5 text-slate-100">
              {text}
            </div>

            <div className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}