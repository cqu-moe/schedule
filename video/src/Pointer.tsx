import type { CSSProperties } from "react";
import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { clamp, move } from "./Frame";

export function Pointer({
  style,
  clickAt,
}: {
  style: CSSProperties;
  clickAt: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Interactive.Div
      name="操作指引光标"
      premountFor={fps}
      style={{
        position: "absolute",
        width: 54,
        height: 64,
        pointerEvents: "none",
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -25,
          top: -25,
          width: 50,
          height: 50,
          borderRadius: "50%",
          border: "2px solid #2864ba",
          scale: interpolate(
            frame,
            [clickAt * fps, (clickAt + 0.7) * fps],
            [0.7, 1.7],
            { ...clamp, easing: move },
          ),
          opacity: interpolate(
            frame,
            [clickAt * fps, (clickAt + 0.1) * fps, (clickAt + 0.7) * fps],
            [0, 0.6, 0],
            clamp,
          ),
        }}
      />
      <svg
        viewBox="0 0 40 48"
        width="40"
        height="48"
        style={{
          filter: "drop-shadow(0 3px 3px #0003)",
          scale: interpolate(
            frame,
            [clickAt * fps, (clickAt + 0.12) * fps, (clickAt + 0.3) * fps],
            [1, 0.94, 1],
            { ...clamp, easing: move },
          ),
          transformOrigin: "0 0",
        }}
      >
        <path
          d="M3 3 L3 35 L12 27 L20 43 L27 39 L19 24 L32 24 Z"
          fill="#262626"
          stroke="white"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
    </Interactive.Div>
  );
}
