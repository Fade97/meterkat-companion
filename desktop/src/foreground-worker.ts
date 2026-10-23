// The Win32 foreground probe off the main thread. GetPixel on the screen and the process snapshot can block for long
// enough that the island's pointer tracking stalls, and a click on the drop meanwhile goes to the window below.
// Works in screen pixels; the main process converts to DIP (Electron's screen module is not available here).
import { parentPort } from "node:worker_threads";
import { windowsProbe, type KoffiModule, type ProbeRequest, type ProbeResponse } from "./foreground.js";

const same = <T>(value: T) => value;
const probe = windowsProbe(require("koffi") as KoffiModule, same, same);

parentPort!.on("message", (request: ProbeRequest) => {
  const work = request.op === "read" ? probe.read() : probe.luminance(request.points, 0);
  work.then(
    result => parentPort!.postMessage({ id: request.id, ok: true, result } satisfies ProbeResponse),
    (error: unknown) => parentPort!.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ProbeResponse),
  );
});
