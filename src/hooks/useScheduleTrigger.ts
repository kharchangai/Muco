import { useEffect, useRef } from "react";
import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';

interface TimerItem {
  id: string;
  time: string; // ISO 8601 string (e.g., YYYY-MM-DDTHH:mm:ssZ)
  task: string;
  tts_text: string;
  status: string;
}

interface PlannerItem {
  id: string;
  time: string; // HH:mm:ssZ
  task: string;
  tts_text: string;
  status: string;
}

export function useScheduleTrigger(onTrigger: (ttsText: string) => void, disabled?: boolean) {
  const isChecking = useRef(false);

  useEffect(() => {
    if (disabled) return;

    const checkSchedules = async () => {
      if (isChecking.current) return;
      isChecking.current = true;

      try {
        const baseDir = await appDataDir();
        const scheduleRoot = await join(baseDir, "memory", "schedule");
        const plannerDir = await join(scheduleRoot, "planner");
        const timerPath = await join(scheduleRoot, "timer.json");

        const now = new Date();
        const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD (UTC date)
        const currentMonthStr = todayStr.substring(0, 7); // YYYY-MM

        // ==========================================
        // 1. CHECK AND TRIGGER TIMERS (TRANSIENT)
        // ==========================================
        if (await exists(timerPath)) {
          let timers: TimerItem[] = [];
          try {
            const rawTimers = await readTextFile(timerPath);
            timers = JSON.parse(rawTimers);
          } catch {}

          const activeTimers: TimerItem[] = [];
          let updated = false;

          for (const timer of timers) {
            const timerDate = new Date(timer.time);
            
            if (timerDate <= now && timer.status === "PENDING") {
              console.log(`[Trigger Engine] Timer Triggered: ${timer.task}`);
              onTrigger(timer.tts_text);
              updated = true;
            } else {
              activeTimers.push(timer);
            }
          }

          if (updated) {
            await writeTextFile(timerPath, JSON.stringify(activeTimers, null, 2));
          }
        }

        // ==========================================
        // 2. CHECK AND TRIGGER PLANNER (PERSISTENT)
        // ==========================================
        const plannerFile = `${currentMonthStr}.json`;
        const plannerFilePath = await join(plannerDir, plannerFile);

        if (await exists(plannerFilePath)) {
          let monthData: Record<string, PlannerItem[]> = {};
          try {
            const rawData = await readTextFile(plannerFilePath);
            monthData = JSON.parse(rawData);
          } catch {}

          if (monthData[todayStr]) {
            let updated = false;
            const todayPlans = monthData[todayStr];

            for (const plan of todayPlans) {
              if (plan.status === "PENDING") {
                const planDateTime = new Date(`${todayStr}T${plan.time}`);
                
                if (planDateTime <= now) {
                  console.log(`[Trigger Engine] Planner Event Triggered: ${plan.task}`);
                  onTrigger(plan.tts_text);
                  plan.status = "COMPLETED";
                  updated = true;
                }
              }
            }

            if (updated) {
              await writeTextFile(plannerFilePath, JSON.stringify(monthData, null, 2));
            }
          }
        }

      } catch (error) {
        console.error("[Trigger Engine] Error during schedule check:", error);
      } finally {
        isChecking.current = false;
      }
    };

    checkSchedules();
    const interval = setInterval(checkSchedules, 10000);

    return () => clearInterval(interval);
  }, [onTrigger, disabled]);
}