import { acctFetch, acctJson, jsonBody } from "../../lib/session";

/** What GET /api/recordings/:id (and every input call) answers. */
export interface RecState {
  id: string;
  projectId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  frameSeq: number;
  checkMode: boolean;
  steps: { id: string; text: string }[];
  pendingSelect: { options: { value: string; label: string }[] } | null;
  notices: string[];
}

export type RecInput =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number; dx?: number }
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "select"; value: string };

const base = (id: string) => `/api/recordings/${encodeURIComponent(id)}`;

export const startRecording = (projectId: string, url: string) =>
  acctJson<{ recordingId: string }>("/api/recordings", jsonBody("POST", { projectId, url }));
export const getState = (id: string) => acctJson<RecState>(base(id));
export const sendInput = (id: string, events: RecInput[]) => acctJson<RecState>(`${base(id)}/input`, jsonBody("POST", { events }));
export const setCheckMode = (id: string, on: boolean) => acctJson<RecState>(`${base(id)}/check-mode`, jsonBody("POST", { on }));
export const undoStep = (id: string) => acctJson<RecState>(`${base(id)}/undo`, jsonBody("POST", {}));
export const saveRecording = (id: string, body: { title: string; suiteId?: string; steps: string[] }) =>
  acctJson<{ id: string; projectId: string }>(`${base(id)}/save`, jsonBody("POST", body));
export const stopRecording = (id: string) =>
  acctFetch(base(id), { method: "DELETE", keepalive: true }).catch(() => null);

/** The newest screen after `after`, as an object URL the caller must revoke; null when unchanged. */
export async function fetchFrame(id: string, after: number): Promise<{ url: string; seq: number } | null> {
  const res = await acctFetch(`${base(id)}/frame?after=${after}`);
  if (res.status === 204 || !res.ok) return null;
  const seq = Number(res.headers.get("X-Frame-Seq") ?? after + 1);
  return { url: URL.createObjectURL(await res.blob()), seq };
}
