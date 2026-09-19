// External regression checks of the historical bug contracts; never copied into the real project.
import { describe, expect, it, vi } from "vitest";

vi.mock("cc", () => ({
  sys: { OS: { ANDROID: "Android", IOS: "iOS" }, os: "test", isNative: false },
}));
const root = process.env.CODING_COPY;
const caseId = process.env.CODING_CASE;
if (caseId === "cocos-event-listeners") {
  describe("EventBus listener isolation", () => {
    it("continues after throwing listeners and keeps listener removal semantics", async () => {
      const { EventBus } = await import(`${root}/assets/bundles/app/core/EventBus.ts`);
      const bus = new EventBus();
      const calls: number[] = [];
      const removed = () => calls.push(3);
      bus.on("event", () => {
        calls.push(1);
        bus.off("event", removed);
        throw new Error("listener failed");
      });
      bus.on("event", () => calls.push(2));
      bus.on("event", removed);
      expect(() => bus.emit("event", {})).not.toThrow();
      expect(calls).toEqual([1, 2]);
    });
    it("observes async rejection and still dispatches subsequent listeners", async () => {
      const { EventBus } = await import(`${root}/assets/bundles/app/core/EventBus.ts`);
      const bus = new EventBus();
      const after = vi.fn();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      bus.on("event", async () => {
        throw new Error("async rejection");
      });
      bus.on("event", after);
      bus.emit("event", null);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(after).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalled();
      log.mockRestore();
    });
  });
} else {
  describe("StoryRequestQueue retry lifecycle", () => {
    it("stops after three retries and releases the same-session successor", async () => {
      vi.useFakeTimers();
      try {
        const { StoryRequestQueue } = await import(
          `${root}/assets/bundles/app/core/StoryRequestQueue.ts`
        );
        const queue = new StoryRequestQueue();
        const run = vi.fn().mockRejectedValue(new TypeError("offline"));
        const outcome = queue.enqueue({ sessionId: "a", label: "failing", run }).then(
          () => "unexpected",
          () => "rejected",
        );
        const next = vi.fn().mockResolvedValue("next");
        const successor = queue.enqueue({ sessionId: "a", label: "next", run: next });
        await vi.advanceTimersByTimeAsync(15000);
        expect(run).toHaveBeenCalledTimes(4);
        expect(await outcome).toBe("rejected");
        expect(await successor).toBe("next");
        await queue.barrier("a");
        expect(queue.getStats("a")).toEqual({ pending: 0, running: false, blocked: false });
      } finally {
        vi.useRealTimers();
      }
    });
    it("preserves successful retries and independent sessions", async () => {
      vi.useFakeTimers();
      try {
        const { StoryRequestQueue } = await import(
          `${root}/assets/bundles/app/core/StoryRequestQueue.ts`
        );
        const queue = new StoryRequestQueue();
        const run = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue("ok");
        const retried = queue.enqueue({ sessionId: "a", label: "retry", run });
        expect(
          await queue.enqueue({ sessionId: "b", label: "independent", run: async () => "b" }),
        ).toBe("b");
        await vi.advanceTimersByTimeAsync(500);
        expect(await retried).toBe("ok");
        expect(run).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
    it("does not retry cancellation or business failures", async () => {
      const { StoryRequestQueue } = await import(
        `${root}/assets/bundles/app/core/StoryRequestQueue.ts`
      );
      const { ApiError } = await import(`${root}/assets/bundles/app/api/ApiTypes.ts`);
      for (const error of [
        new ApiError("cancelled", "CANCELLED", 503),
        new ApiError("bad", "BAD_REQUEST", 400),
      ]) {
        const run = vi.fn().mockRejectedValue(error);
        const queue = new StoryRequestQueue();
        await expect(queue.enqueue({ sessionId: "a", label: "final", run })).rejects.toBe(error);
        expect(run).toHaveBeenCalledTimes(1);
      }
    });
  });
}
