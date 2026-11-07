import { EmailUi, NotificationSetting, ProductUi } from "./product/ProductUi";
import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Frame, Title, clamp, move, shadow } from "./Frame";

export const MailScene = () => {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  return (
    <Frame
      chapter="04 / 邮件提醒"
      caption="开启通知后，同步发现安排变化时发送邮件"
    >
      <Title style={{ top: 278, fontSize: 94 }}>
        安排变了，
        <br />
        邮件告诉你。
      </Title>
      <Interactive.P
        name="邮件提醒范围"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 100,
          top: 537,
          margin: 0,
          fontSize: 32,
          lineHeight: 1.8,
          color: "#777",
          opacity: interpolate(t, [0.5, 1.7], [0, 1], clamp),
        }}
      >
        新增、取消、调课、换教室。
        <br />
        原安排与调整后，清楚对照。
      </Interactive.P>
      <Interactive.Div
        name="原页面通知开关"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 96,
          top: 727,
          width: 650,
          height: 130,
          opacity: interpolate(t, [1, 2.2], [0, 1], clamp),
          translate: `0 ${interpolate(t, [1, 2.4], [30, 0], { ...clamp, easing: move })}px`,
        }}
      >
        <ProductUi width={325} zoom={2}>
          <NotificationSetting />
        </ProductUi>
      </Interactive.Div>
      <Interactive.Div
        name="工程中的实际变更邮件模板"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1010,
          top: 162,
          width: 720,
          borderRadius: 12,
          overflow: "hidden",
          background: "white",
          boxShadow: shadow,
          border: "1px solid #e5e5e5",
          opacity: interpolate(t, [0.1, 1.5, 3.4, 4.8], [0, 1, 1, 0.4], clamp),
          translate: `${interpolate(t, [0.1, 1.7, 2.4, 4, 6.5, 8.8], [85, 0, 0, 60, 60, 45], { ...clamp, easing: move })}px ${interpolate(t, [0.1, 1.7, 2.4, 4], [55, 0, 0, -20], { ...clamp, easing: move })}px`,
          rotate: interpolate(
            t,
            [0.1, 1.7, 2.4, 4],
            ["3deg", "0deg", "0deg", "1deg"],
            { ...clamp, easing: move },
          ),
        }}
      >
        <ProductUi width={600} zoom={1.2}>
          <EmailUi />
        </ProductUi>
      </Interactive.Div>
      <Interactive.Div
        name="从实际邮件展开新旧安排对照"
        premountFor={fps}
        style={{
          position: "absolute",
          left: interpolate(t, [3.5, 5.1], [1108, 770], {
            ...clamp,
            easing: move,
          }),
          top: interpolate(t, [3.5, 5.1], [372, 465], {
            ...clamp,
            easing: move,
          }),
          transformOrigin: "top left",
          scale: interpolate(t, [3.5, 5.1], [0.618, 1], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [3.5, 4.2], [0, 1], clamp),
          borderRadius: 18,
          overflow: "hidden",
          boxShadow: "0 24px 70px rgba(20,24,32,.16)",
        }}
      >
        <ProductUi width={536} zoom={1040 / 536}>
          <EmailUi comparison />
        </ProductUi>
        <svg
          viewBox="0 0 1040 342"
          width="1040"
          height="342"
          style={{ position: "absolute", inset: 0 }}
        >
          <path
            d="M584 198 C673 194 767 194 837 197"
            fill="none"
            stroke="#2864ba"
            strokeWidth="4"
            strokeLinecap="round"
            pathLength="1"
            strokeDasharray="1"
            strokeDashoffset={interpolate(t, [5.2, 6.6], [1, 0], {
              ...clamp,
              easing: move,
            })}
          />
        </svg>
      </Interactive.Div>
      <Interactive.P
        name="变更后的阅读落点"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1050,
          top: 850,
          padding: "14px 24px",
          background: "#fafafa",
          borderRadius: 12,
          margin: 0,
          fontSize: 29,
          color: "#555",
          opacity: interpolate(t, [6.1, 7.4], [0, 1], clamp),
          translate: `0 ${interpolate(t, [6.1, 7.6], [24, 0], { ...clamp, easing: move })}px`,
        }}
      >
        从 C103 到 C205，变化一目了然。
      </Interactive.P>
    </Frame>
  );
};
