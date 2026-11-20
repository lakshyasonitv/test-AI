import { useState } from "react";

/** Final screenshot, recording, and the "no video" reason. Keyed by URL by the parent, so a new
 *  run's media is a new element — a <video> never re-reads a changed <source> by itself. */
export function ResultMedia({ data }: { data: any }) {
  const [shotOk, setShotOk] = useState(true);
  const shot: string | undefined = data?.screenshotUrl;
  const vid: string | undefined = data?.videoUrl;
  return (
    <>
      {shot && shotOk && (
        <figure>
          <img src={shot} alt="Final state of the page at the end of the test" onError={() => setShotOk(false)} />
          <figcaption>Final state at the end of the test</figcaption>
        </figure>
      )}
      {vid && (
        <figure className="case-video">
          <video controls preload="none" poster={shot || undefined}>
            <source src={vid} type="video/webm" />
          </video>
          <figcaption>Recording of the run — nothing downloads until you press play</figcaption>
        </figure>
      )}
      {!vid && data?.videoUnavailable && <p className="tree-empty">{data.videoUnavailable}</p>}
    </>
  );
}
