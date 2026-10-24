import assert from "node:assert/strict";
import { test } from "node:test";
import { throttle, windowEventStream, xcbEventKind, type EventWorker, type WindowEvent } from "../src/window-events.js";

test("a burst of moves goes through at most once per interval, and says how long to wait", () => {
  const pace = throttle(8);
  assert.equal(pace.take(1000), true);
  assert.equal(pace.take(1003), false);
  assert.equal(pace.wait(1003), 5);
  assert.equal(pace.take(1008), true);
  assert.equal(pace.wait(1100), 0);
});

test("xcb events: the active window property switches, configure/reparent/map move, the rest is ignored", () => {
  const ACTIVE = 300;
  assert.equal(xcbEventKind(28, ACTIVE, ACTIVE), "switched");
  assert.equal(xcbEventKind(28, 301, ACTIVE), null); // another root property
  assert.equal(xcbEventKind(22, 0, ACTIVE), "moved");
  assert.equal(xcbEventKind(22 | 0x80, 0, ACTIVE), "moved"); // the window manager's synthetic ConfigureNotify
  assert.equal(xcbEventKind(21, 0, ACTIVE), "moved");
  assert.equal(xcbEventKind(19, 0, ACTIVE), "moved");
  assert.equal(xcbEventKind(0, 0, ACTIVE), null); // an error (a window that has gone away)
  assert.equal(xcbEventKind(17, 0, ACTIVE), null);
});

function fakeWorker() {
  const listeners: Record<string, ((value: any) => void)[]> = {};
  let terminated = 0;
  const worker: EventWorker = { on(event: string, listener: (value: any) => void) { (listeners[event] ??= []).push(listener); return worker; }, terminate() { terminated++; } };
  return { worker, emit: (event: string, value: unknown) => listeners[event]?.forEach(l => l(value)), terminated: () => terminated };
}

test("the event stream forwards events and reports a failure once", () => {
  const fake = fakeWorker(), seen: WindowEvent[] = [], failures: string[] = [];
  windowEventStream(() => fake.worker, event => seen.push(event), reason => failures.push(reason));
  fake.emit("message", { type: "foreground", pid: 7 });
  fake.emit("error", new Error("koffi missing"));
  fake.emit("exit", 1);
  fake.emit("message", { type: "bounds", pid: 7, bounds: { x: 0, y: 0, width: 1, height: 1 } });
  assert.deepEqual(seen, [{ type: "foreground", pid: 7 }]);
  assert.deepEqual(failures, ["koffi missing"]);
});

test("closing the event stream is not a failure, and a worker that cannot start is one", () => {
  const fake = fakeWorker(), failures: string[] = [];
  const stream = windowEventStream(() => fake.worker, () => undefined, reason => failures.push(reason));
  stream.close();
  fake.emit("exit", 1);
  assert.equal(fake.terminated(), 1);
  assert.equal(failures.length, 0);
  windowEventStream(() => { throw new Error("no worker"); }, () => undefined, reason => failures.push(reason));
  assert.deepEqual(failures, ["no worker"]);
});
