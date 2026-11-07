import {
  AccountPage,
  BindingCard,
  CalendarUi,
  ProductUi,
} from "./product/ProductUi";
import {
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Frame, Title, clamp, move, shadow } from "./Frame";
import { Pointer } from "./Pointer";

export const AccountScene = () => {
  const t = useCurrentFrame() / useVideoConfig().fps;
  const { fps } = useVideoConfig();
  return (
    <Frame
      chapter="01 / 连接账号"
      caption="登录 CQU Moe 后，绑定重庆大学统一认证账号"
    >
      <Title
        style={{
          top: 300,
          fontSize: 94,
          opacity: interpolate(t, [0, 1.2], [0, 1], clamp),
          translate: `0 ${interpolate(t, [0, 1.4], [28, 0], { ...clamp, easing: move })}px`,
        }}
      >
        连接账号，
        <br />
        这一学期就绪。
      </Title>
      <Interactive.P
        name="开场说明"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 100,
          top: 557,
          margin: 0,
          fontSize: 32,
          lineHeight: 1.7,
          color: "#777",
          opacity: interpolate(t, [0.7, 1.7], [0, 1], clamp),
        }}
      >
        绑定重庆大学统一认证账号。
        <br />
        把课程和考试，交给日历。
      </Interactive.P>
      <Interactive.Div
        name="实际订阅页面"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 790,
          top: 210,
          width: 1040,
          height: 710,
          overflow: "hidden",
          borderRadius: 16,
          border: "1px solid #ddd",
          boxShadow: shadow,
          opacity: interpolate(t, [0, 1.5], [0, 0.45], clamp),
          rotate: "-1.5deg",
          translate: `${interpolate(t, [0, 5.3], [60, -15], { ...clamp, easing: move })}px 0`,
        }}
      >
        <ProductUi width={1440} zoom={1040 / 1440}>
          <AccountPage />
        </ProductUi>
      </Interactive.Div>
      <Interactive.Div
        name="原页面账号绑定提示"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 785,
          top: 440,
          width: 1050,
          borderRadius: 20,
          overflow: "hidden",
          boxShadow: shadow,
          scale: interpolate(t, [0.15, 1.65], [0.95, 1], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [0.15, 1.4], [0, 1], clamp),
          translate: `0 ${interpolate(t, [0.15, 1.65, 2.9, 4.4], [45, 0, 0, -85], { ...clamp, easing: move })}px`,
        }}
      >
        <ProductUi width={565} zoom={1050 / 565}>
          <BindingCard />
        </ProductUi>
      </Interactive.Div>
      <Pointer
        clickAt={2.75}
        style={{
          left: interpolate(t, [1.55, 2.75], [1320, 1050], {
            ...clamp,
            easing: move,
          }),
          top: interpolate(t, [1.55, 2.75], [790, 597], {
            ...clamp,
            easing: move,
          }),
          opacity: interpolate(t, [1.55, 1.9, 3.1, 3.6], [0, 1, 1, 0], clamp),
        }}
      />
      <Interactive.Div
        name="绑定后进入课表"
        premountFor={fps}
        style={{
          position: "absolute",
          left: 895,
          top: 660,
          borderRadius: 16,
          overflow: "hidden",
          boxShadow: shadow,
          opacity: interpolate(t, [3.2, 4.6], [0, 1], clamp),
          translate: `0 ${interpolate(t, [3.2, 5.1], [80, -15], { ...clamp, easing: move })}px`,
        }}
      >
        <div style={{ width: 850, height: 260, overflow: "hidden" }}>
          <ProductUi width={850}>
            <CalendarUi />
          </ProductUi>
        </div>
      </Interactive.Div>
    </Frame>
  );
};
