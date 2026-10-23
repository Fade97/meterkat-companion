// Relay registration off the main thread: the proof of work is a few seconds of hashing that would freeze the window.
import { parentPort, workerData } from "node:worker_threads";
import { registerWithRelay } from "../../src/registration.js";

registerWithRelay((workerData as { relay: string }).relay)
  .then(() => parentPort!.postMessage({ ok: true }))
  .catch((error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : "Registration failed" }));
