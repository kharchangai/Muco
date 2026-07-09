// src/components/Mocu.tsx
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { StatusBubble } from './StatusBubble';

export type MocuState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'typing';

interface MocuProps {
  state?: MocuState;
  onClick?: () => void; // Click handler passed to the cube body
}

// Fixed vertical layout budget, explicitly tied to the real Tauri
// window height defined in tauri.conf.json. No more guessing.
//
// TOP_SPACE    -> reserved room above the cube for the floating StatusBubble + glow
// CUBE_SIZE    -> the black cube itself (fixed size)
// BOTTOM_SPACE -> reserved room below the cube for the drop shadow
//                 (shadow offset -24px + shadow height 14px + blur bleed + safety margin)
//
// Required window height = TOP_SPACE + CUBE_SIZE + BOTTOM_SPACE
// 100 + 150 + 60 = 310 -> use 320+ in tauri.conf.json for extra safety.
const TOP_SPACE = 100;
const CUBE_SIZE = 150;
const BOTTOM_SPACE = 60;

export const Mocu: React.FC<MocuProps> = ({ state = 'idle', onClick }) => {
  const [isBlinking, setIsBlinking] = useState(false);

  useEffect(() => {
    const blink = () => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 150);
      setTimeout(blink, 3000 + Math.random() * 5000);
    };
    const timer = setTimeout(blink, 2000);
    return () => clearTimeout(timer);
  }, []);

  const springConfig = { type: "spring", damping: 16, stiffness: 180, mass: 0.9 };

  const eyeVariants = {
    idle: { scaleY: isBlinking ? 0.05 : 1, scaleX: 1, x: 0, y: 0 },
    listening: { scaleY: isBlinking ? 0.05 : 1.3, scaleX: 1.1, x: 0, y: -4 },
    thinking: { scaleY: 0.6, scaleX: 1.1, x: [0, 6, 6, 0], y: -6, transition: { duration: 3, repeat: Infinity, ease: "easeInOut" } },
    speaking: { scaleY: isBlinking ? 0.05 : [1, 1.1, 0.9, 1], transition: { repeat: Infinity, duration: 1.5 } },
    happy: { scaleY: 0.15, scaleX: 1.2, x: 0, y: -4 },
    typing: {
      scaleY: isBlinking ? 0.05 : 0.85,
      scaleX: 1,
      x: [-5, 5, 5, -5, -5],
      y: 3,
      transition: {
        x: { repeat: Infinity, duration: 2.5, ease: "easeInOut" },
        default: springConfig
      }
    }
  };

  const mouthVariants = {
    idle: { height: 4, width: 20, borderRadius: 2, x: 0, y: 0 },
    listening: { height: 14, width: 14, borderRadius: 2, x: 0, y: 0 },
    thinking: { height: 3, width: 12, borderRadius: 2, x: 8, y: -2 },
    speaking: {
      height: [4, 18, 8, 14, 4],
      width: [20, 14, 22, 16, 20],
      borderRadius: [2, 2, 2, 2, 2],
      transition: { repeat: Infinity, duration: 0.5, ease: "easeInOut" }
    },
    happy: { height: 12, width: 32, borderRadius: "0 0 16px 16px", x: 0, y: 2 },
    typing: {
      height: 4,
      width: 16,
      borderRadius: 2,
      x: 0,
      y: 4
    }
  };

  const bodyVariants = {
    idle: {
      y: [0, -10, 0],
      scaleX: [1, 0.98, 1.02, 1],
      scaleY: [1, 1.02, 0.98, 1],
      transition: { repeat: Infinity, duration: 3.5, ease: "easeInOut" }
    },
    thinking: {
      y: -5,
      transition: { repeat: Infinity, duration: 4, ease: "easeInOut" }
    },
    typing: {
      y: [5, 7, 5],
      scaleY: [1, 0.99, 1],
      transition: { repeat: Infinity, duration: 2, ease: "easeInOut" }
    },
    default: { y: 0, scaleX: 1, scaleY: 1 }
  };

  return (
    // Fills the FULL real window height (h-screen), instead of a
    // hardcoded fixed-size box. TOP_SPACE / BOTTOM_SPACE are reserved
    // via explicit padding, so nothing gets clipped as long as the
    // Tauri window height >= TOP_SPACE + CUBE_SIZE + BOTTOM_SPACE.
    // overflow-visible here is now safe because html/body/#root in
    // index.css are sized to 100% of the real window (see CSS fix).
    <div
      className="relative flex flex-col items-center w-full h-screen overflow-visible"
      style={{ paddingTop: TOP_SPACE, paddingBottom: BOTTOM_SPACE }}
    >
      {/* Anchor wrapper: exactly the same size as the cube (150x150).
          All absolute children (bubble, shadow, cube) are positioned
          relative to this anchor instead of the larger outer container. */}
      <div
        className="relative overflow-visible"
        style={{ width: CUBE_SIZE, height: CUBE_SIZE }}
      >

        {/* Floating status bubble with animated icons, anchored to the cube's top */}
        <StatusBubble state={state} />

        {/* Natural shadow under the cube - now has guaranteed room below it
            thanks to BOTTOM_SPACE padding on the parent, plus the fact that
            html/body/#root now span the full real window height. */}
        <motion.div
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-[100px] h-[14px] bg-black/50 rounded-[100%] blur-md z-10 pointer-events-none"
          animate={{
            scale: state === 'idle' ? [1, 0.8, 1] : (state === 'typing' ? 1.1 : 0.9),
            opacity: state === 'idle' ? [0.5, 0.3, 0.5] : 0.6
          }}
          transition={{ repeat: Infinity, duration: 3.5, ease: "easeInOut" }}
        />

        {/* Fully black cube body with rounded corners and character personality */}
        <motion.div
          onClick={onClick}
          data-tauri-drag-region
          className="absolute top-0 left-0 flex items-center justify-center w-[150px] h-[150px] bg-[#050505] rounded-[12px] z-20 overflow-hidden cursor-pointer active:scale-95 transition-transform"
          style={{
            boxShadow: `
              inset 0 2px 10px rgba(255, 255, 255, 0.15),
              inset 0 -10px 20px rgba(0, 0, 0, 0.8),
              0 15px 30px rgba(0, 0, 0, 0.5)
            `,
            border: '1px solid rgba(255, 255, 255, 0.05)'
          }}
          animate={bodyVariants[state === 'idle' || state === 'typing' || state === 'thinking' ? state : 'default']}
          whileHover={{ scale: 1.05, rotate: -2 }}
          whileTap={{ scale: 0.95, rotate: 0 }}
        >
          {/* Soft reflection on the top surface */}
          <div className="absolute top-0 left-3 w-[110px] h-[40px] bg-gradient-to-b from-white/10 to-transparent rounded-t-[12px] rounded-b-[24px] pointer-events-none" />

          {/* Character face */}
          <div className="flex flex-col items-center gap-4 z-30 translate-y-1 pointer-events-none">
            {/* Eyes - soft square design for a minimalist robotic character */}
            <div className="flex justify-center gap-6 w-full">
              <motion.div
                className="w-[18px] h-[20px] bg-white rounded-[4px] shadow-[0_0_12px_rgba(255,255,255,0.5)]"
                animate={state}
                variants={eyeVariants}
                transition={springConfig}
              />
              <motion.div
                className="w-[18px] h-[20px] bg-white rounded-[4px] shadow-[0_0_12px_rgba(255,255,255,0.5)]"
                animate={state}
                variants={eyeVariants}
                transition={springConfig}
              />
            </div>

            {/* Mouth - minimalist straight line */}
            <motion.div
              className="bg-white shadow-[0_0_12px_rgba(255,255,255,0.5)]"
              animate={state}
              variants={mouthVariants}
              transition={springConfig}
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
};