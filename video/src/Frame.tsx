import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Img,
  Easing,
  Interactive,
  staticFile,
  useVideoConfig,
} from "remotion";

export const move = Easing.bezier(0.45, 0, 0.25, 1);
export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const shadow =
  "0 24px 70px rgba(20, 24, 32, 0.10), 0 2px 8px rgba(20, 24, 32, 0.04)";

export function Frame({
  children,
  chapter,
  caption,
}: {
  children: ReactNode;
  chapter: string;
  caption?: string;
}) {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        background: "#fafafa",
        color: "#343434",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div
        style={{
          position: "absolute",
          zIndex: 20,
          left: 96,
          top: 58,
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Img
          src={staticFile("logo.svg")}
          premountFor={fps}
          style={{ width: 44, height: 44 }}
        />
        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.8 }}>
          CQU Schedule
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          zIndex: 20,
          right: 96,
          top: 70,
          fontSize: 22,
          color: "#777",
        }}
      >
        为重庆大学的每个上课日
      </div>
      {children}
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 47,
          borderTop: "1px solid #dedede",
          paddingTop: 22,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 23,
          color: "#777",
        }}
      >
        <span>{chapter}</span>
        <span>{caption ?? "画面中的课表为演示数据"}</span>
      </div>
    </AbsoluteFill>
  );
}

export function Title({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  const { fps } = useVideoConfig();
  return (
    <Interactive.H1
      name="镜头标题"
      premountFor={fps}
      style={{
        position: "absolute",
        left: 96,
        top: 150,
        margin: 0,
        fontSize: 80,
        lineHeight: 1.2,
        fontWeight: 650,
        letterSpacing: -4,
        ...style,
      }}
    >
      {children}
    </Interactive.H1>
  );
}
