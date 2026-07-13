// src/App.tsx
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import { Mocu, MocuState } from './components/Mocu';
import { Settings } from './components/Settings';
import {
  TranscriptSpeaker,
} from './components/MocuTranscript';

import {
  transcribeAudio,
  generateSpeech,
} from './services/aiService';

import { chatWithMocu } from './services/ai/index';
import { useScheduleTrigger } from './hooks/useScheduleTrigger';
import { useMocuWindowSize } from './hooks/useMocuWindowSize';

type ActivityEvent = {
  text: string;
  isRunning: boolean;
};

// These values must match the main Tauri window configuration.
const MAIN_WINDOW_WIDTH = 250;
const MAIN_WINDOW_BASE_HEIGHT = 320;

// This space is added only below Mocu when the transcript is visible.
const TRANSCRIPT_EXTRA_HEIGHT = 170;

function App() {
  const [mocuState, setMocuState] =
    useState<MocuState>('idle');

  const [, setCurrentActivity] =
    useState<string | null>(null);

  const [transcriptText, setTranscriptText] =
    useState('');

  const [transcriptSpeaker, setTranscriptSpeaker] =
    useState<TranscriptSpeaker>('mocu');

  const mediaRecorderRef =
    useRef<MediaRecorder | null>(null);

  const audioChunksRef = useRef<Blob[]>([]);

  const typingTimeoutRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentAudioRef =
    useRef<HTMLAudioElement | null>(null);

  const currentAudioUrlRef =
    useRef<string | null>(null);

  const isSettingsWindow =
    window.location.hash === '#settings';

  const { resizeWindow } = useMocuWindowSize({
    width: MAIN_WINDOW_WIDTH,
    baseHeight: MAIN_WINDOW_BASE_HEIGHT,
    transcriptExtraHeight: TRANSCRIPT_EXTRA_HEIGHT,
    disabled: isSettingsWindow,
  });

  const stopCurrentAudio = () => {
    const currentAudio = currentAudioRef.current;

    if (currentAudio) {
      currentAudio.pause();
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudioRef.current = null;
    }

    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current);
      currentAudioUrlRef.current = null;
    }
  };

  const playSpeech = async (text: string) => {
    stopCurrentAudio();

    const speechBlob = await generateSpeech(text);
    const audioUrl = URL.createObjectURL(speechBlob);
    const audio = new Audio(audioUrl);

    currentAudioRef.current = audio;
    currentAudioUrlRef.current = audioUrl;

    const cleanUpAudio = () => {
      if (currentAudioRef.current === audio) {
        currentAudioRef.current = null;
      }

      if (currentAudioUrlRef.current === audioUrl) {
        URL.revokeObjectURL(audioUrl);
        currentAudioUrlRef.current = null;
      }
    };

    audio.onended = () => {
      cleanUpAudio();
      setMocuState('idle');
    };

    audio.onerror = () => {
      cleanUpAudio();
      setMocuState('idle');
    };

    setMocuState('speaking');

    try {
      await audio.play();
    } catch (error) {
      cleanUpAudio();
      throw error;
    }
  };

  /*
   * Resize only the native Tauri window.
   * Mocu remains inside a fixed-height area, so its position
   * does not depend on the expanded window height.
   */
  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const transcriptIsVisible =
      transcriptText.trim().length > 0;

    void resizeWindow(transcriptIsVisible);
  }, [
    isSettingsWindow,
    resizeWindow,
    transcriptText,
  ]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    const handleActivity = (event: Event) => {
      const customEvent =
        event as CustomEvent<ActivityEvent>;

      if (customEvent.detail.isRunning) {
        setCurrentActivity(customEvent.detail.text);
      } else {
        setCurrentActivity(null);
      }
    };

    window.addEventListener(
      'mocu-tool-status',
      handleActivity as EventListener,
    );

    return () => {
      window.removeEventListener(
        'mocu-tool-status',
        handleActivity as EventListener,
      );
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) {
      return;
    }

    let disposed = false;
    let unlistenTyping: (() => void) | undefined;

    const setupListener = async () => {
      try {
        const unlisten = await listen(
          'user_typing',
          () => {
            setMocuState((previousState) => {
              if (
                previousState !== 'typing' &&
                previousState !== 'listening' &&
                previousState !== 'thinking' &&
                previousState !== 'speaking'
              ) {
                return 'typing';
              }

              return previousState;
            });

            if (typingTimeoutRef.current) {
              clearTimeout(typingTimeoutRef.current);
            }

            typingTimeoutRef.current = setTimeout(() => {
              setMocuState((previousState) =>
                previousState === 'typing'
                  ? 'idle'
                  : previousState,
              );
            }, 1000);
          },
        );

        if (disposed) {
          unlisten();
          return;
        }

        unlistenTyping = unlisten;
      } catch (error) {
        console.error(
          'Failed to listen for user typing:',
          error,
        );
      }
    };

    void setupListener();

    return () => {
      disposed = true;
      unlistenTyping?.();

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    return () => {
      stopCurrentAudio();

      const mediaRecorder = mediaRecorderRef.current;

      if (
        mediaRecorder &&
        mediaRecorder.state !== 'inactive'
      ) {
        mediaRecorder.stop();
      }

      mediaRecorder?.stream
        .getTracks()
        .forEach((track) => track.stop());
    };
  }, []);

  const handleScheduleTrigger = async (
    ttsText: string,
  ) => {
    stopCurrentAudio();

    setTranscriptSpeaker('mocu');
    setTranscriptText(ttsText);
    setMocuState('thinking');

    try {
      await playSpeech(ttsText);
    } catch (error) {
      console.error(
        'Schedule Trigger TTS Error:',
        error,
      );

      setMocuState('idle');
    }
  };

  useScheduleTrigger(
    handleScheduleTrigger,
    isSettingsWindow,
  );

  const handleToggleRecording = async () => {
    if (mocuState === 'listening') {
      const mediaRecorder =
        mediaRecorderRef.current;

      if (
        mediaRecorder &&
        mediaRecorder.state !== 'inactive'
      ) {
        mediaRecorder.stop();
      }

      return;
    }

    if (
      mocuState !== 'idle' &&
      mocuState !== 'happy' &&
      mocuState !== 'typing' &&
      mocuState !== 'speaking'
    ) {
      return;
    }

    stopCurrentAudio();

    try {
      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

      const supportedMimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
      ];

      const mimeType = supportedMimeTypes.find((type) =>
        MediaRecorder.isTypeSupported(type),
      );

      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = (event) => {
        console.error(
          'MediaRecorder error:',
          event,
        );

        stream
          .getTracks()
          .forEach((track) => track.stop());

        mediaRecorderRef.current = null;
        setMocuState('idle');
      };

      mediaRecorder.onstop = async () => {
        stream
          .getTracks()
          .forEach((track) => track.stop());

        mediaRecorderRef.current = null;
        setMocuState('thinking');

        const recordedMimeType =
          mediaRecorder.mimeType ||
          audioChunksRef.current[0]?.type ||
          'audio/webm';

        const audioBlob = new Blob(
          audioChunksRef.current,
          {
            type: recordedMimeType,
          },
        );

        audioChunksRef.current = [];

        try {
          const transcribedText =
            await transcribeAudio(audioBlob);

          const userText =
            typeof transcribedText === 'string'
              ? transcribedText.trim()
              : '';

          console.log('Transcribed:', userText);

          if (!userText) {
            setMocuState('idle');
            return;
          }

          setTranscriptSpeaker('user');
          setTranscriptText(userText);

          const response =
            await chatWithMocu(userText);

          let botResponseText =
            typeof response === 'string'
              ? response.trim()
              : '';

          if (!botResponseText) {
            console.warn(
              'Received an empty response from the backend.',
            );

            botResponseText =
              'Understood, task completed.';
          }

          console.log(
            'Model Response:',
            botResponseText,
          );

          setTranscriptSpeaker('mocu');
          setTranscriptText(botResponseText);

          await playSpeech(botResponseText);
        } catch (error: unknown) {
          console.error(
            'AI Pipeline Error:',
            error,
          );

          setMocuState('idle');
        } finally {
          setCurrentActivity(null);
        }
      };

      mediaRecorder.start();
      setMocuState('listening');
    } catch (error) {
      console.error(
        'Microphone access denied:',
        error,
      );

      setMocuState('idle');
    }
  };

  if (isSettingsWindow) {
    return <Settings />;
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent select-none">
      {/*
       * This area always remains 320px high.
       * Expanding the native window therefore adds space only below it.
       */}
      <div
        className="absolute top-0 left-0 flex w-full items-center justify-center"
        style={{
          height: `${MAIN_WINDOW_BASE_HEIGHT}px`,
        }}
      >
        <Mocu
          state={mocuState}
          onClick={handleToggleRecording}
          transcriptText={transcriptText}
          transcriptSpeaker={transcriptSpeaker}
          transcriptEnabled={true}
          transcriptDelay={0}
          transcriptVisibleFor={7000}
          onTranscriptHidden={() => {
            setTranscriptText('');
          }}
        />
      </div>
    </div>
  );
}

export default App;