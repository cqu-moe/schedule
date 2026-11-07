import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Frame, Title, clamp, move } from "./Frame";
import { ProductUi, SubscriptionCard } from "./product/ProductUi";
import { Pointer } from "./Pointer";

export const SubscribeScene = () => {
  const { fps } = useVideoConfig();
  const t = useCurrentFrame() / fps;
  return (
    <Frame
      chapter="03 / 日历订阅"
      caption="通过网址订阅；更新节奏由日历客户端决定"
    >
      <Title>复制链接，放进常用日历。</Title>
      <Interactive.Div
        name="原订阅卡片重新排布"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 210,
          top: 340,
          transformOrigin: "top left",
          scale: interpolate(t, [2.2, 3.8], [1, 0.76], {
            ...clamp,
            easing: move,
          }),
          translate: `${interpolate(t, [2.2, 3.8], [0, -110], { ...clamp, easing: move })}px 0`,
        }}
      >
        <Interactive.Div
          name="全部课表原卡片"
          premountFor={fps}
          style={{
            opacity: interpolate(t, [0.05, 1.3], [0, 1], clamp),
            translate: `0 ${interpolate(t, [0.05, 1.5], [55, 0], { ...clamp, easing: move })}px`,
          }}
        >
          <ProductUi width={944} zoom={1500 / 944}>
            <SubscriptionCard index={0} copied={t >= 3.95} />
          </ProductUi>
        </Interactive.Div>
        <Interactive.Div
          name="课程原卡片"
          premountFor={fps}
          style={{
            position: "absolute",
            top: 210,
            opacity: interpolate(t, [0.3, 1.55], [0, 1], clamp),
            translate: `0 ${interpolate(t, [0.3, 1.75], [55, 0], { ...clamp, easing: move })}px`,
          }}
        >
          <ProductUi width={944} zoom={1500 / 944}>
            <SubscriptionCard index={1} />
          </ProductUi>
        </Interactive.Div>
        <Interactive.Div
          name="考试原卡片"
          premountFor={fps}
          style={{
            position: "absolute",
            top: 420,
            opacity: interpolate(t, [0.55, 1.8], [0, 1], clamp),
            translate: `0 ${interpolate(t, [0.55, 2], [55, 0], { ...clamp, easing: move })}px`,
          }}
        >
          <ProductUi width={944} zoom={1500 / 944}>
            <SubscriptionCard index={2} />
          </ProductUi>
        </Interactive.Div>
      </Interactive.Div>
      <Pointer
        clickAt={3.95}
        style={{
          left: interpolate(t, [2.65, 3.95], [1410, 930], {
            ...clamp,
            easing: move,
          }),
          top: interpolate(t, [2.65, 3.95], [720, 405], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [2.65, 3, 4.2, 4.7], [0, 1, 1, 0], clamp),
        }}
      />
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      >
        <path
          d="M970 433 C1280 433 1190 810 1360 810 L1775 810"
          fill="none"
          stroke="#2864ba"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength="1"
          strokeDasharray="1"
          strokeDashoffset={interpolate(t, [4, 5.8], [1, 0], {
            ...clamp,
            easing: move,
          })}
        />
      </svg>
      <Interactive.P
        name="Apple 日历"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1390,
          top: 385,
          fontSize: 42,
          fontWeight: 550,
          margin: 0,
          opacity: interpolate(t, [4, 5.1], [0, 1], clamp),
          translate: `${interpolate(t, [4, 5.3], [35, 0], { ...clamp, easing: move })}px 0`,
        }}
      >
        Apple 日历
      </Interactive.P>
      <Interactive.P
        name="Google Calendar"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1390,
          top: 525,
          fontSize: 42,
          fontWeight: 550,
          margin: 0,
          opacity: interpolate(t, [4.35, 5.45], [0, 1], clamp),
          translate: `${interpolate(t, [4.35, 5.65], [35, 0], { ...clamp, easing: move })}px 0`,
        }}
      >
        Google Calendar
      </Interactive.P>
      <Interactive.P
        name="Outlook"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 1390,
          top: 665,
          fontSize: 42,
          fontWeight: 550,
          margin: 0,
          opacity: interpolate(t, [4.7, 5.8], [0, 1], clamp),
          translate: `${interpolate(t, [4.7, 6], [35, 0], { ...clamp, easing: move })}px 0`,
        }}
      >
        Outlook
      </Interactive.P>
    </Frame>
  );
};
