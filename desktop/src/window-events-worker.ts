// Window events (window-events.ts) off the main thread: the Win32 hooks need a thread that pumps messages, and the
// xcb connection a thread that waits on its socket. Posts WindowEvent objects; stops by being terminated.
import { parentPort } from "node:worker_threads";
import { win32WindowEvents, x11WindowEvents, type WindowEvent } from "./window-events.js";

const post = (event: WindowEvent) => parentPort!.postMessage(event);
const koffi = require("koffi");
if (process.platform === "win32") win32WindowEvents(koffi, post);
else x11WindowEvents(koffi, post);
