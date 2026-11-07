import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Composition, staticFile, useVideoConfig } from "remotion";
import { move } from "./Frame";
import { AccountScene } from "./AccountScene";
import { CalendarScene } from "./CalendarScene";
import { SubscribeScene } from "./SubscribeScene";
import { MailScene } from "./MailScene";
import { ClosingScene } from "./ClosingScene";

export const ScheduleIntro = () => {
  const { fps } = useVideoConfig();
  return (
    <>
      <Audio
        src={staticFile("soundtrack.wav")}
        premountFor={fps}
        volume={0.65}
      />
      <TransitionSeries>
        <TransitionSeries.Sequence
          name="01 连接账号"
          durationInFrames={159}
          premountFor={fps}
        >
          <AccountScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 24, easing: move })}
        />
        <TransitionSeries.Sequence
          name="02 课表日历"
          durationInFrames={249}
          premountFor={fps}
        >
          <CalendarScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 24, easing: move })}
        />
        <TransitionSeries.Sequence
          name="03 日历订阅"
          durationInFrames={204}
          premountFor={fps}
        >
          <SubscribeScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 24, easing: move })}
        />
        <TransitionSeries.Sequence
          name="04 邮件提醒"
          durationInFrames={264}
          premountFor={fps}
        >
          <MailScene />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 24, easing: move })}
        />
        <TransitionSeries.Sequence
          name="05 课表之外还有生活"
          durationInFrames={120}
          premountFor={fps}
        >
          <ClosingScene />
        </TransitionSeries.Sequence>
      </TransitionSeries>
    </>
  );
};

export const MyComposition = () => (
  <Composition
    id="ScheduleIntro"
    component={ScheduleIntro}
    durationInFrames={900}
    fps={30}
    width={1920}
    height={1080}
  />
);
