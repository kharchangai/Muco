// src/App.tsx
import { useEffect, useRef, useState } from 'react';
import { Mocu, MocuState } from './components/Mocu';
import { Settings } from './components/Settings';
import { listen } from '@tauri-apps/api/event';


// Import AI services
import { transcribeAudio, generateSpeech } from './services/aiService';
// Import the LangGraph brain
import { chatWithMocu } from './services/ai/index'; 
// Import the custom schedule trigger hook
import { useScheduleTrigger } from './hooks/useScheduleTrigger';

// Define the custom event type for the Event Bus
type ActivityEvent = {
  text: string;
  isRunning: boolean;
};

function App() {
  const [mocuState, setMocuState] = useState<MocuState>('idle');
  const [currentActivity, setCurrentActivity] = useState<string | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const isSettingsWindow = window.location.hash === '#settings';

  // 👈 Event Bus Listener: Listen for real-time tool statuses
  useEffect(() => {

    if (isSettingsWindow) return;

    const handleActivity = (e: Event) => {
      const customEvent = e as CustomEvent<ActivityEvent>;
      if (customEvent.detail.isRunning) {
        setCurrentActivity(customEvent.detail.text);
      } else {
        setCurrentActivity(null); // Clear activity when tool finishes
      }
    };

    // Listen to our custom events (you can name it 'mocu-activity' as we discussed)
    window.addEventListener('mocu-tool-status', handleActivity as EventListener);

    return () => {
      window.removeEventListener('mocu-tool-status', handleActivity as EventListener);
    };
  }, [isSettingsWindow]);

  useEffect(() => {
    if (isSettingsWindow) return;

    const setupListener = async () => {
      const unlisten = await listen('user_typing', () => {
        setMocuState((prevState) => {
          if (prevState !== 'typing' && prevState !== 'listening' && prevState !== 'thinking' && prevState !== 'speaking') {
            return 'typing';
          }
          return prevState;
        });

        if (typingTimeoutRef.current) {
          clearTimeout(typingTimeoutRef.current);
        }
        
        typingTimeoutRef.current = setTimeout(() => {
          setMocuState((prevState) => (prevState === 'typing' ? 'idle' : prevState));
        }, 1000);
      });

      return unlisten;
    };

    const unlistenPromise = setupListener();

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [isSettingsWindow]);

  const handleScheduleTrigger = async (ttsText: string) => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    setMocuState('thinking');

    try {
      const speechBlob = await generateSpeech(ttsText);
      const audioUrl = URL.createObjectURL(speechBlob);
      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      setMocuState('speaking');
      audio.play();

      audio.onended = () => {
        setMocuState('idle');
        URL.revokeObjectURL(audioUrl);
      };
    } catch (error) {
      console.error("❌ Schedule Trigger TTS Error:", error);
      setMocuState('idle');
    }
  };

  useScheduleTrigger(handleScheduleTrigger, isSettingsWindow);

  const handleToggleRecording = async () => {
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
      setMocuState('idle');
    }

    if (mocuState === 'idle' || mocuState === 'happy' || mocuState === 'typing' || mocuState === 'speaking') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          setMocuState('thinking');
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });

          try {
            const userText = await transcribeAudio(audioBlob);
            console.log("🎤 Transcribed:", userText);

            if (!userText) {
              setMocuState('idle');
              return;
            }

            // Call the LangGraph brain (chatWithMocu)
            // The tools inside this will trigger events that 'mocu-tool-status' catches!
            let botResponseText = await chatWithMocu(userText);
            
            // CRITICAL English Fallback
            if (!botResponseText || typeof botResponseText !== 'string' || botResponseText.trim() === "") {
                console.warn("⚠️ Received empty string from backend, using generic fallback.");
                botResponseText = "Understood, task completed.";
            }

            console.log("🤖 Model Response:", botResponseText);

            const speechBlob = await generateSpeech(botResponseText);
            const audioUrl = URL.createObjectURL(speechBlob);
            const audio = new Audio(audioUrl);
            currentAudioRef.current = audio;

            setMocuState('speaking');
            audio.play();

            audio.onended = () => {
              setMocuState('idle');
              URL.revokeObjectURL(audioUrl);
            };

          } catch (error: any) {
            console.error("❌ AI Pipeline Error:", error);
            setMocuState('idle');
          } finally {
            // Ensure activity is cleared if backend didn't send a complete event
            setCurrentActivity(null);
          }
        };

        mediaRecorder.start();
        setMocuState('listening');

      } catch (err) {
        console.error("❌ Microphone access denied:", err);
      }
    } 
    else if (mocuState === 'listening') {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      }
    }
  };

  if (isSettingsWindow) {
    return <Settings />;
  }

  return (
    <div className="w-screen h-screen bg-transparent flex items-center justify-center select-none">
      {/* Pass the dynamic activity to Mocu so the StatusBubble can show it */}
      <Mocu 
        state={mocuState} 
        onClick={handleToggleRecording} 
        activityText={currentActivity}
      />
    </div>
  );
}

export default App;