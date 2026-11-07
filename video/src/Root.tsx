import { MyComposition } from "./Composition";
import { Composition, Folder } from "remotion";
import { AccountScene } from "./AccountScene";
import { CalendarScene } from "./CalendarScene";
import { SubscribeScene } from "./SubscribeScene";
import { MailScene } from "./MailScene";
import { ClosingScene } from "./ClosingScene";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
      <Folder name="Scenes">
        <Composition
          id="Account"
          component={AccountScene}
          durationInFrames={159}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Calendar"
          component={CalendarScene}
          durationInFrames={249}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Subscribe"
          component={SubscribeScene}
          durationInFrames={204}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Mail"
          component={MailScene}
          durationInFrames={264}
          fps={30}
          width={1920}
          height={1080}
        />
        <Composition
          id="Closing"
          component={ClosingScene}
          durationInFrames={120}
          fps={30}
          width={1920}
          height={1080}
        />
      </Folder>
    </>
  );
};
